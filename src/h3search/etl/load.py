"""Isolated, recoverable full loads with shared source staging and atomic publication."""

from base64 import b64decode, b64encode
from collections import Counter
from concurrent.futures import FIRST_EXCEPTION, ThreadPoolExecutor, wait
from contextlib import ExitStack, contextmanager, nullcontext
from copy import copy
from dataclasses import replace
from hashlib import sha256
import json
import logging
import os
from pathlib import Path
import shutil
import socket
from threading import Event, Thread
from time import monotonic
from uuid import UUID

import duckdb
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq
from h3ronpy.vector import coordinates_to_cells

from h3search.control import ConflictError
from h3search.models import new_id, utc_now
from . import spool
from .lake import LocalLake
from .layout import SEARCH_SCHEMA, transform
from .single_file import ResourceBounds, SINGLE_FILE_SCHEMA, SORT_ORDER, _copy, _write_sorted
from .source import ReloadRequired
from .local_work import LocalWorkGuard, local_work_guard, local_bounds


class LoadStopped(Exception):
    """A cooperative stop left the load journal available for resumption."""


ENCODING_FIELDS = ('fetch_batch_rows', 'prepared_read_batch_rows', 'parquet_row_group_rows',
                   'initial_search_sort_row_group_rows', 'single_file_row_group_rows', 'wide_bucket_count',
                   'prepared_max_open_writers', 'prepared_carry_mb', 'batch_max_mb', 'target_file_mb',
                   'bulk_max_footer_mb')


def _encoding_view(engine, root, entry):
    """Freeze file boundaries without mutating shared service or process configuration."""
    if set(entry['settings']) != set(ENCODING_FIELDS):
        raise ConflictError('The frozen output encoding plan has unsupported settings. Resume with its original build.')
    if entry['writer'] != {'pyarrow': pa.__version__, 'duckdb': duckdb.__version__}:
        raise ConflictError('The frozen output plan requires its original Arrow and DuckDB versions.')
    view = copy(engine)
    view.settings = replace(engine.settings, **entry['settings'])
    view._encoding_frozen = True
    return view, ResourceBounds(view, root)


def clean_completed_load_stages(engine, guard=lambda: None):
    """Drain this staging owner's durable cleanup queue after committed publications."""
    pending = engine._pending()
    pending_id = pending["id"] if pending else None
    owner, location = engine.settings.bulk_owner_id or socket.gethostname(), str(engine.stage.resolve())
    with engine.registry.connect() as connection:
        completed = connection.execute("SELECT id FROM etl_completed_loads WHERE stage_owner=? AND stage_root=?", (owner, location)).fetchall()
    root = engine.stage.resolve()
    for row in completed:
        if row["id"] == pending_id:
            continue
        identity = str(UUID(row["id"]))
        path = engine.stage / f"load-{identity}"
        if path.is_symlink() or path.is_junction() or path.resolve() != root / f"load-{identity}":
            raise ValueError("A completed load staging directory is outside its owned path.")
        if path.exists():
            guard()
            shutil.rmtree(path)
        with engine.registry.connect() as connection:
            connection.execute("DELETE FROM etl_completed_loads WHERE id=? AND stage_owner=? AND stage_root=?", (row["id"], owner, location))


def slim_schema(schema):
    """Keep canonical join identities and every original source attribute."""
    return pa.schema([field for field in schema if field.name in ("table_id", "object_id") or field.name.startswith("src_")])


@contextmanager
def query_batches(sql, parameters, schema, bounds, guard):
    """Run an external query with bounded memory, spill, duration and decoded batches."""
    settings = bounds.settings
    bounds.check()
    sort_memory = min(settings.initial_search_sort_memory_mb,
                      (settings.memory_budget_mb * 1048576 - bounds.process.memory_info().rss) // (2 * 1048576))
    if sort_memory < 1:
        raise MemoryError("The load sort has insufficient process memory headroom.")
    with duckdb.connect(config={
        "memory_limit": f"{sort_memory}MiB",
        "threads": settings.initial_search_sort_threads,
        "temp_directory": str(bounds.root / "load-spill"),
        "max_temp_directory_size": f"{settings.initial_search_sort_temp_mb}MiB",
    }) as connection:
        deadline = monotonic() + settings.initial_search_sort_timeout_sec
        stopped, failures = Event(), []

        def monitor():
            while not stopped.wait(0.25):
                try:
                    bounds.check()
                    guard()
                    if monotonic() >= deadline:
                        raise TimeoutError("The load sort reached its configured time budget.")
                except Exception as error:
                    failures.append(error)
                    connection.interrupt()
                    return

        thread = Thread(target=monitor, daemon=True)
        thread.start()
        try:
            # Reserve room for decoded arrays, casts, partition indexes and writer carry. The configured
            # reader ceiling remains authoritative; a small decode batch is not a Parquet row-group size.
            byte_budget = min(settings.batch_max_mb * 1048576, settings.prepared_carry_mb * 1048576)
            if not getattr(bounds.engine, '_encoding_frozen', False):
                byte_budget = min(byte_budget, bounds.engine._memory_limit())
            estimated_row_bytes = max(512, len(schema) * 64)
            read_rows = max(1, min(settings.fetch_batch_rows, settings.prepared_read_batch_rows,
                                   byte_budget // estimated_row_bytes))
            reader = connection.execute(sql, parameters).to_arrow_reader(batch_size=read_rows)
            with reader:
                def batches():
                    for batch in reader:
                        guard()
                        bounds.check()
                        table = pa.Table.from_batches([batch]).cast(schema)
                        if table.nbytes > bounds.engine._memory_limit():
                            raise MemoryError("A decoded load batch exceeds its configured memory budget.")
                        yield table
                yield batches()
        except duckdb.InterruptException:
            if failures:
                raise failures[0] from None
            raise
        finally:
            stopped.set()
            thread.join()
        if failures:
            raise failures[0]
        if monotonic() >= deadline:
            raise TimeoutError("The load sort reached its configured time budget.")


def _row_groups(tables, row_limit, byte_limit):
    """Combine fragmented decoded batches into bounded, contiguous Parquet row groups."""
    carry, rows, size = [], 0, 0
    for table in tables:
        offset = 0
        while offset < len(table):
            room = min(row_limit - rows, len(table) - offset)
            low, high = 0, room
            while low < high:
                middle = (low + high + 1) // 2
                if table.slice(offset, middle).nbytes <= byte_limit - size:
                    low = middle
                else:
                    high = middle - 1
            if not low:
                if not carry:
                    raise MemoryError("One load row exceeds its decoded row-group byte budget.")
                yield pa.concat_tables(carry)
                carry, rows, size = [], 0, 0
                continue
            piece = table.slice(offset, low)
            carry.append(piece)
            rows += low; size += piece.nbytes; offset += low
            if rows == row_limit or low < room:
                yield pa.concat_tables(carry)
                carry, rows, size = [], 0, 0
    if carry:
        yield pa.concat_tables(carry)


def _write_query(path, sql, parameters, schema, bounds, guard, *, identity_counts=None):
    temporary = path.with_suffix(".tmp")
    rows = 0
    try:
        with pq.ParquetWriter(temporary, schema, compression="zstd") as writer:
            with query_batches(sql, parameters, schema, bounds, guard) as batches:
                byte_limit = min(bounds.settings.prepared_carry_mb * 1048576,
                                 bounds.settings.batch_max_mb * 1048576, bounds.engine._memory_limit())
                group_rows = bounds.settings.initial_search_sort_row_group_rows
                for table in _row_groups(batches, group_rows, byte_limit):
                    guard(); bounds.check()
                    writer.write_table(table, row_group_size=group_rows)
                    rows += len(table)
                    if identity_counts is not None:
                        for entry in table["table_id"].value_counts().to_pylist():
                            key = entry["values"]
                            identity_counts[key] = identity_counts.get(key, 0) + entry["counts"]
        with temporary.open("rb+") as stream:
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    return rows


def verify_keys(expected_paths, actual_paths, bounds, guard):
    """Compare the exact UUID/OBJECTID multiset and reject duplicate lookup identities."""
    from .key_verify import verify
    verify(list(map(str, expected_paths)), list(map(str, actual_paths)), bounds, guard, query_batches)


def _partition_files(paths, schema, kind, prefix, bounds, guard, *, ordered_batches=None):
    """Create bounded bucket files or globally contiguous R3 files across datasets."""
    from .prepared import _Budget, _Limits, _Writers, _size

    settings = bounds.settings
    output_root = bounds.root.resolve()
    if Path(prefix).name != prefix:
        raise ValueError("A prepared load prefix must be a local filename prefix.")
    limits = _Limits.read(settings)
    # The bulk writer already provides bounded aggregate carry, reserved footer bytes, and
    # rotation before accumulated row-group metadata can exhaust the footer budget.
    class Output:
        root = output_root
        kind = prefix
        indices = Counter()
        files = []
        metadata = 0

        def seal(self, entry):
            charge = _size(entry)
            if len(self.files) >= limits.files or self.metadata + charge > limits.metadata:
                raise MemoryError("The load output exceeds its configured file or metadata budget.")
            self.files.append(entry)
            self.metadata += charge
            self.indices[entry['partition'][0]] += 1

    output = Output()
    output.schema = schema
    budget = _Budget(output_root, limits, bounds.check)
    writers = _Writers(output, budget, limits)
    arrow_bucket = None
    if kind == "wide":
        from pyiceberg.exceptions import NotInstalledError
        from pyiceberg.transforms import BucketTransform
        from pyiceberg.types import LongType
        transform = BucketTransform(settings.wide_bucket_count)
        try:
            arrow_bucket = transform.pyarrow_transform(LongType())
        except (ImportError, NotInstalledError):
            bucket = transform.transform(LongType())
        if settings.wide_bucket_count > settings.prepared_max_open_writers:
            raise ValueError("Wide buckets exceed the configured open writer budget.")

    sql = f"SELECT {', '.join(schema.names)} FROM read_parquet(?) ORDER BY "
    sql += "object_id" if kind == "wide" else "h3_r3, h3_r15, table_id, object_id"
    try:
        source = (query_batches(sql, [list(map(str, paths))], schema, bounds, guard)
                  if ordered_batches is None else nullcontext(ordered_batches))
        with source as batches:
            for table in batches:
                if not len(table):
                    continue
                if kind == 'wide':
                    keys = (arrow_bucket(table['object_id']) if arrow_bucket else
                            pa.array([bucket(value.as_py()) for value in table['object_id']], pa.int32()))
                    order = pc.sort_indices(pa.table({'partition': keys, 'object_id': table['object_id']}),
                                            sort_keys=[('partition', 'ascending'), ('object_id', 'ascending')])
                    table, keys = table.take(order), pc.take(keys, order)
                else:
                    keys = table['h3_r3']
                # R3 is already contiguous; bucket ordering above makes the wide groups contiguous too.
                # Materialize only boundary positions, rather than a Python key and index for every row.
                changes = pc.indices_nonzero(pc.not_equal(keys.slice(1), keys.slice(0, len(keys) - 1))).to_pylist() if len(keys) > 1 else []
                boundaries = [0, *(index + 1 for index in changes), len(table)]
                for start, end in zip(boundaries, boundaries[1:]):
                    key = keys[start].as_py()
                    if kind == "r3":
                        for previous in set(writers.writers) | set(writers.carry):
                            if previous != key:
                                writers.close_partition(previous)
                    writers.add(key, table.slice(start, end - start), [key])
        for key in sorted(set(writers.writers) | set(writers.carry)):
            writers.close_partition(key)
    finally:
        writers.abort()
    return [{**entry, 'path': str(output_root / entry['path'])} for entry in output.files]


class _ProjectionSink:
    """Coalesce projected columns without retaining their full-width source arrays."""
    def __init__(self, writer, bounds, guard):
        self.writer, self.bounds, self.guard = writer, bounds, guard
        self.row_limit = bounds.settings.initial_search_sort_row_group_rows
        self.byte_limit = min(bounds.settings.prepared_carry_mb * 1048576, bounds.settings.batch_max_mb * 1048576)
        if not getattr(bounds.engine, '_encoding_frozen', False):
            self.byte_limit = min(self.byte_limit, bounds.engine._memory_limit())
        self.parts, self.rows, self.size = [], 0, 0

    def flush(self):
        for group in _row_groups(self.parts, self.row_limit, self.byte_limit):
            self.guard(); self.bounds.check()
            self.writer.write_table(group, row_group_size=self.row_limit)
        self.parts, self.rows, self.size = [], 0, 0

    def add(self, table):
        if not len(table):
            return
        if self.rows + len(table) > self.row_limit or self.size + table.nbytes > self.byte_limit:
            self.flush()
        self.parts.append(table)
        self.rows += len(table); self.size += table.nbytes
        if self.rows >= self.row_limit or self.size >= self.byte_limit:
            self.flush()


def _ordered_ids(ids, previous):
    if ids.null_count or (len(ids) and previous is not None and ids[0].as_py() <= previous):
        raise RuntimeError("Frozen base OBJECTIDs must be strictly increasing across sealed chunks.")
    if len(ids) > 1 and not pc.all(pc.greater(ids.slice(1), ids.slice(0, len(ids) - 1))).as_py():
        raise RuntimeError("Frozen base OBJECTIDs must be strictly increasing without duplicates.")
    return ids[-1].as_py() if len(ids) else previous


def _frozen_base_outputs(root, table_id, state, schema, bounds, guard, check_file):
    """Project a validated base-only stream directly to narrow and ordered bucket files."""
    if state.get('reuse') or state.get('skip') or state['phase'] != 'complete':
        raise ConflictError("Frozen output requires a complete base-only source without reuse.")
    narrow, rejected = root / f'{table_id}-narrow.parquet', root / f'{table_id}-rejected.parquet'
    narrow_temp, rejected_temp = narrow.with_suffix('.tmp'), rejected.with_suffix('.tmp')
    event_schema = pa.schema([pa.field('object_id', pa.int64()), pa.field('__batch', pa.int64()),
                             pa.field('__valid', pa.bool_()), pa.field('__reason', pa.string())])
    reject_schema = pa.schema([event_schema.field('object_id'), event_schema.field('__reason')])
    data_schema = schema.append(pa.field('__batch', pa.int64()))
    byte_limit = min(bounds.settings.batch_max_mb * 1048576, bounds.settings.prepared_carry_mb * 1048576)
    if not getattr(bounds.engine, '_encoding_frozen', False):
        byte_limit = min(byte_limit, bounds.engine._memory_limit())
    batch_rows = max(1, min(bounds.settings.fetch_batch_rows, bounds.settings.prepared_read_batch_rows,
                             byte_limit // max(512, len(data_schema) * 64)))
    count, event_previous, data_previous = 0, None, None

    def batches(narrow_sink, reject_sink):
        nonlocal count, event_previous, data_previous
        for number, chunk in enumerate(state['chunks']):
            guard(); bounds.check()
            data_path, event_path = (check_file(chunk[name], guard) for name in ('data', 'events'))
            expected, actual = sha256(), sha256()
            accepted = rows = 0
            with pq.ParquetFile(event_path) as source:
                if source.schema_arrow != event_schema or source.metadata.num_rows != chunk['events']['rows']:
                    raise RuntimeError("A frozen base event file differs from its sealed schema or count.")
                for batch in source.iter_batches(batch_size=batch_rows, use_threads=False):
                    guard(); bounds.check()
                    events = pa.Table.from_batches([batch])
                    event_previous = _ordered_ids(events['object_id'], event_previous)
                    valid, reason = events['__valid'], events['__reason']
                    if (valid.null_count or events['__batch'].null_count or not pc.all(pc.equal(events['__batch'], number)).as_py()
                            or not pc.all(pc.equal(pc.is_null(reason), valid)).as_py()):
                        raise RuntimeError("Frozen base events contain non-base batches, deletes or inconsistent rejects.")
                    keys = pc.filter(events['object_id'], valid)
                    expected.update(keys.to_numpy().astype('<i8', copy=False).tobytes())
                    accepted += len(keys)
                    reject_sink.add(events.filter(pc.invert(valid)).select(reject_schema.names))
            with pq.ParquetFile(data_path) as source:
                if source.schema_arrow != data_schema or source.metadata.num_rows != chunk['data']['rows']:
                    raise RuntimeError("A frozen base data file differs from its sealed schema or count.")
                for batch in source.iter_batches(batch_size=batch_rows, use_threads=False):
                    guard(); bounds.check()
                    table = pa.Table.from_batches([batch])
                    if table.nbytes > bounds.engine._memory_limit():
                        raise MemoryError("A frozen base batch exceeds its decoded memory budget.")
                    if (table['table_id'].null_count or table['__batch'].null_count
                            or not pc.all(pc.equal(table['table_id'], table_id)).as_py()
                            or not pc.all(pc.equal(table['__batch'], number)).as_py()):
                        raise RuntimeError("A frozen base batch has a different dataset UUID or source batch.")
                    data_previous = _ordered_ids(table['object_id'], data_previous)
                    actual.update(table['object_id'].to_numpy().astype('<i8', copy=False).tobytes())
                    rows += len(table); count += len(table)
                    narrow_sink.add(table.select(SEARCH_SCHEMA.names))
                    yield table.select(slim_schema(schema).names)
            if rows != accepted or actual.digest() != expected.digest():
                raise RuntimeError("Frozen base accepted identities differ from their sealed event accounting.")
        if event_previous != state.get('key') or (event_previous is not None and
                (state.get('cutoff') is None or event_previous > state['cutoff'])):
            raise RuntimeError("Frozen base OBJECTID accounting differs from its durable source cursor or cutoff.")

    try:
        with pq.ParquetWriter(narrow_temp, SEARCH_SCHEMA, compression='zstd') as narrow_writer, \
                pq.ParquetWriter(rejected_temp, reject_schema, compression='zstd') as reject_writer:
            narrow_sink, reject_sink = (_ProjectionSink(narrow_writer, bounds, guard), _ProjectionSink(reject_writer, bounds, guard))
            output = _partition_files([], slim_schema(schema), 'wide', f'wide-{table_id}', bounds, guard,
                                      ordered_batches=batches(narrow_sink, reject_sink))
            narrow_sink.flush(); reject_sink.flush()
        for temporary, target in ((narrow_temp, narrow), (rejected_temp, rejected)):
            with temporary.open('rb+') as stream:
                os.fsync(stream.fileno())
            temporary.replace(target)
        if sum(entry['rows'] for entry in output) != count:
            raise RuntimeError("Frozen base bucket counts differ from accepted staging rows.")
        return narrow, rejected, output, count
    finally:
        narrow_temp.unlink(missing_ok=True); rejected_temp.unlink(missing_ok=True)


def _upload_files(table, files, bounds, guard, generation):
    """Upload a bounded batch while the coordinator alone touches lease/resource state."""
    settings = bounds.settings
    allowance = settings.bulk_max_footer_mb * 1048576 + 3 * 1048576
    workers = max(1, min(settings.bulk_upload_workers, 4, bounds.engine._memory_limit() // allowance))
    cancelled = Event()

    def check_cancel():
        if cancelled.is_set():
            raise LoadStopped()

    def upload(index, entry):
        check_cancel()
        path = Path(entry['path'])
        size = path.stat().st_size
        if spool.checksum(path, check_cancel) != entry['sha256']:
            raise RuntimeError("An isolated load output changed before upload.")
        uri = f"{table.location().rstrip('/')}/data/{generation}-{index}.parquet"
        with path.open('rb') as source, table.io.new_output(uri).create(overwrite=True) as target:
            while block := source.read(1048576):
                check_cancel()
                target.write(block)
        check_cancel()
        if len(table.io.new_input(uri)) != size:
            raise RuntimeError("An uploaded load file differs from its staged size.")
        content = sha256()
        with table.io.new_input(uri).open() as source:
            while block := source.read(1048576):
                check_cancel()
                content.update(block)
        if content.hexdigest() != entry['sha256']:
            raise RuntimeError("An uploaded load file differs from its staged content identity.")
        if path.stat().st_size != size or spool.checksum(path, check_cancel) != entry['sha256']:
            raise RuntimeError("An isolated load output changed during upload.")
        metadata = pq.read_metadata(path)
        if metadata.serialized_size > settings.bulk_max_footer_mb * 1048576:
            raise ValueError("A prepared load footer exceeded its configured byte limit.")
        return uri, size, metadata

    with ThreadPoolExecutor(max_workers=workers) as pool:
        try:
            for start in range(0, len(files), workers):
                guard(); bounds.check()
                batch = files[start:start + workers]
                futures = [pool.submit(upload, start + offset, entry) for offset, entry in enumerate(batch)]
                pending = set(futures)
                while pending:
                    guard(); bounds.check()
                    done, pending = wait(pending, timeout=0.1, return_when=FIRST_EXCEPTION)
                    for future in done:
                        if future.exception() is not None:
                            future.result()
                # Preserve sealed staging order independent of transfer completion order.
                for entry, future in zip(batch, futures, strict=True):
                    guard(); bounds.check()
                    yield entry, future.result()
        finally:
            cancelled.set()


def commit_output(engine, name, schema, kind, files, bounds, guard, generation):
    """Commit a complete isolated physical table; replay verifies the generation marker."""
    local = local_work_guard(guard, engine.settings)
    if isinstance(local, LocalWorkGuard):
        guard = local.full_check
    guard()
    bounds.check(force_inventory=True)
    lake = engine.lake
    total = sum(entry["rows"] for entry in files)
    if len(files) > engine.settings.bulk_max_files:
        raise ValueError("The load output exceeds its configured file inventory limit.")
    identities = [(entry["sha256"], entry["rows"], entry["partition"]) for entry in files]
    sealed = json.dumps(identities, separators=(",", ":")).encode()
    if len(sealed) > engine.settings.bulk_max_manifest_mb * 1048576:
        raise ValueError("The load output exceeds its configured manifest byte limit.")
    content = sha256(schema.serialize().to_pybytes() + kind.encode() + sealed).hexdigest()
    if isinstance(lake, LocalLake):
        head = lake._head(name)
        if head:
            if head["batch"] != generation:
                raise ConflictError("An isolated load table belongs to another operation.")
            entries = lake._manifest(name, head["snapshot"])
            actual = [(entry.get("sha256"), entry["count"], [entry["cell"]] if entry["cell"] is not None else []) for entry in entries]
            if actual != identities:
                raise ConflictError("A committed generation has a different sealed encoding or input identity. Resume with the original build release, or use discard-load before a fresh load; existing outputs were not replaced.")
            for entry in entries:
                if spool.checksum(lake._directory(name) / "data" / entry["file"], local) != entry["sha256"]:
                    raise RuntimeError("A committed load file differs from its sealed content identity.")
            guard()
            return head["snapshot"]
        directory = lake._directory(name) / "data"
        directory.mkdir(parents=True, exist_ok=True)
        entries = []
        for index, entry in enumerate(files):
            guard()
            source = Path(entry["path"])
            if spool.checksum(source, guard) != entry["sha256"]:
                raise RuntimeError("An isolated load output changed before commit.")
            target = directory / f"{generation}-{index}.parquet"
            with target.open("wb") as stream:
                _copy(source, stream, bounds, guard)
            if spool.checksum(target, guard) != entry["sha256"]:
                raise RuntimeError("A copied load file differs from its staged content identity.")
            entries.append({"file": target.name, "table_id": None, "cell": entry["partition"][0] if entry["partition"] else None, "count": entry["rows"], "sha256": entry["sha256"]})
        guard()
        return lake._commit(name, entries, generation)

    from pyiceberg.io.pyarrow import (_pyarrow_to_schema_without_ids, compute_statistics_plan,
                                    data_file_statistics_from_parquet_metadata, parquet_path_to_id_mapping)
    from pyiceberg.manifest import DataFile, DataFileContent, FileFormat
    from pyiceberg.partitioning import PartitionField, PartitionSpec
    from pyiceberg.schema import assign_fresh_schema_ids
    from pyiceberg.table.sorting import SortField, SortOrder
    from pyiceberg.transforms import BucketTransform, IdentityTransform
    from pyiceberg.typedef import Record
    from .offsets import without_offsets

    expected = assign_fresh_schema_ids(_pyarrow_to_schema_without_ids(schema))
    if kind == "r3":
        spec = PartitionSpec(PartitionField(expected.find_field("h3_r3").field_id, 1000, IdentityTransform(), "h3_r3"))
        order = ("h3_r3", "h3_r15", "table_id", "object_id")
    elif kind == "wide":
        spec = PartitionSpec(PartitionField(expected.find_field("object_id").field_id, 1000, BucketTransform(engine.settings.wide_bucket_count), "object_bucket"))
        order = ("object_id",)
    else:
        spec, order = PartitionSpec(), SORT_ORDER
    sort = SortOrder(*(SortField(expected.find_field(column).field_id, IdentityTransform()) for column in order))
    table = lake._load(name)
    if table is None:
        guard()
        lake.catalog.create_namespace_if_not_exists(lake.namespace)
        guard()
        properties = {key: value for key, value in lake.properties.items()
                      if not key.startswith("write.metadata.metrics.column.")
                      or key.removeprefix("write.metadata.metrics.column.") in schema.names}
        # Staged Parquet uses original physical names without embedded Iceberg
        # field IDs; readers resolve those names using this explicit mapping.
        properties["schema.name-mapping.default"] = expected.name_mapping.model_dump_json()
        guard()
        table = lake.catalog.create_table_if_not_exists(lake._id(name), expected, location=lake._location(name), partition_spec=spec, sort_order=sort,
            properties={**properties, "commit.num-retries": "0", "read.split.target-size": str(engine.settings.single_file_read_split_mb * 1048576)} if kind == "single-file" else properties)
        guard()
    if (table.schema().fields != expected.fields or not table.spec().compatible_with(spec) or len(table.specs()) != 1
            or table.metadata.name_mapping() != expected.name_mapping or table.sort_order().fields != sort.fields
            or (lake.warehouse and table.location().rstrip("/") != lake._location(name))):
        raise ConflictError("An isolated load target has incompatible schema, mapping, sort order, location or partitions.")
    head = table.current_snapshot()
    if head:
        if head.summary.get("h3search.load-id") != generation:
            raise ConflictError("An isolated load table belongs to another operation.")
        if head.summary.get("h3search.load-content") != content:
            raise ConflictError("A committed generation has a different sealed encoding or input identity. Resume with the original build release, or use discard-load before a fresh load; existing outputs were not replaced.")
        rows, count = _inventory(lake, table, head, engine.settings.bulk_max_files, local)
        if rows != total or count != len(files):
            raise RuntimeError("The committed load inventory differs from staging.")
        guard()
        return head.snapshot_id
    admitted = []
    for entry, (uri, size, metadata) in _upload_files(table, files, bounds, guard, generation):
        statistics = data_file_statistics_from_parquet_metadata(metadata, compute_statistics_plan(table.schema(), table.properties), parquet_path_to_id_mapping(table.schema())).to_serialized_dict()
        file = DataFile.from_args(content=DataFileContent.DATA, file_path=uri, file_format=FileFormat.PARQUET,
            partition=Record(*entry["partition"]), file_size_in_bytes=size, sort_order_id=table.sort_order().order_id,
            equality_ids=None, key_metadata=None, **statistics)
        file.spec_id = table.spec().spec_id
        admitted.append(without_offsets(file))
        bounds.check()
    guard()
    with table.transaction() as transaction:
        with transaction.update_snapshot(snapshot_properties={"h3search.load-id": generation, "h3search.load-content": content}).fast_append() as update:
            for file in admitted:
                local()
                update.append_data_file(file)
            guard()
        guard()
    guard()
    table.refresh()
    head = table.current_snapshot()
    rows, count = _inventory(lake, table, head, engine.settings.bulk_max_files, local)
    if head.summary.get("h3search.load-id") != generation or rows != total or count != len(files):
        raise RuntimeError("The committed load inventory differs from staging.")
    guard()
    return head.snapshot_id


def _inventory(lake, table, snapshot, limit, guard):
    rows = count = 0
    for file in lake._data_files(table, snapshot):
        guard()
        count += 1
        if count > limit:
            raise ValueError("The committed snapshot exceeds its configured file inventory limit.")
        rows += file.record_count
    return rows, count


def _write_single_narrow(paths, output, bounds, guard):
    """Project and externally sort the immutable narrow inputs in one read pass."""
    settings = bounds.settings
    group_rows = min(settings.single_file_row_group_rows, settings.batch_max_mb * 1048576 // 512)
    byte_limit = min(settings.prepared_carry_mb * 1048576, settings.batch_max_mb * 1048576,
                     bounds.engine._memory_limit())
    columns = pq.SortingColumn.from_ordering(SINGLE_FILE_SCHEMA, [(name, "ascending") for name in SORT_ORDER])
    sql = (f"SELECT {', '.join(SINGLE_FILE_SCHEMA.names)} FROM read_parquet(?) "
           f"ORDER BY {', '.join(SORT_ORDER)}")
    temporary = output.with_suffix(".tmp")
    rows = 0
    try:
        with pq.ParquetWriter(temporary, SINGLE_FILE_SCHEMA, compression="zstd", sorting_columns=columns) as writer:
            with query_batches(sql, [list(map(str, paths))], SINGLE_FILE_SCHEMA, bounds, guard) as batches:
                for table in _row_groups(batches, group_rows, byte_limit):
                    guard()
                    bounds.check()
                    writer.write_table(table, row_group_size=group_rows)
                    rows += len(table)
        bounds.check(force_inventory=True)
        guard()
        with temporary.open("rb+") as stream:
            os.fsync(stream.fileno())
            stream.seek(-8, 2)
            footer = stream.read(8)
        if footer[4:] != b"PAR1" or int.from_bytes(footer[:4], "little") > settings.bulk_max_footer_mb * 1048576:
            raise RuntimeError("The single-file Parquet footer exceeded its configured byte limit.")
        metadata = pq.read_metadata(temporary)
        if metadata.num_rows != rows:
            raise RuntimeError("The single-file output row count differs from its sorted input.")
        temporary.replace(output)
        return metadata
    finally:
        temporary.unlink(missing_ok=True)


def build_lookups(engine, root, narrow_paths, generation, lookup, guard):
    """Build selected lookups from shared immutable canonical narrow Parquet inputs."""
    bounds = ResourceBounds(engine, Path(root))
    local = local_work_guard(guard, engine.settings)
    local_bounds(bounds, local)
    result = {}
    suffix = UUID(generation).hex
    if lookup in ("r3", "both"):
        files = _partition_files(narrow_paths, SEARCH_SCHEMA, "r3", "r3", bounds, local)
        verify_keys(narrow_paths, [entry["path"] for entry in files], bounds, local)
        name = f"search_r3_{suffix}"
        snapshot = commit_output(engine, name, SEARCH_SCHEMA, "r3", files, bounds, guard, generation)
        if hasattr(engine.lake, "regroup_search"):
            try:
                candidate = engine.lake.regroup_search(snapshot, lambda: True, bounds.check, guard, name=name)
            except TimeoutError as error:
                # Locality is optional: a valid sealed load must not fail a smaller maintenance cap.
                logging.getLogger(__name__).warning("R3 manifest locality deferred: %s", error)
            else:
                if candidate is not None:
                    snapshot = candidate
        result["r3"] = {"search_table_name": name, "search_snapshot_id": snapshot}
    if lookup in ("single-file", "both"):
        # The same frozen narrow rows drive both layouts; no second source connection.
        output = bounds.root / "single-ordered.parquet"
        if lookup == "both":
            metadata = _write_single_narrow(narrow_paths, output, bounds, local)
        else:
            projected = bounds.root / "single-input.parquet"
            _write_query(projected, f"SELECT {', '.join(SINGLE_FILE_SCHEMA.names)} FROM read_parquet(?)", [list(map(str, narrow_paths))], SINGLE_FILE_SCHEMA, bounds, local)
            metadata = _write_sorted(projected, output, SINGLE_FILE_SCHEMA, bounds)
        files = [{"path": str(output), "rows": metadata.num_rows, "partition": [], "sha256": spool.checksum(output, local)}]
        verify_keys(narrow_paths, [output], bounds, local)
        name = f"search_single_{suffix}"
        snapshot = commit_output(engine, name, SINGLE_FILE_SCHEMA, "single-file", files, bounds, guard, generation)
        result["single-file"] = {"search_table_name": name, "search_snapshot_id": snapshot}
    return result


def _frozen_batches(engine, name, snapshot_id, bounds, guard):
    """Read immutable owned snapshot files without querying mutable SQL source rows."""
    lake = engine.lake
    if isinstance(lake, LocalLake):
        entries = lake.files(name, snapshot_id)
        open_file = lambda entry: entry.open("rb")
    else:
        table = lake._load(name)
        snapshot = table.snapshot_by_id(int(snapshot_id)) if table else None
        if snapshot is None:
            raise RuntimeError("A published snapshot required for incremental loading is unavailable.")
        entries = lake._data_files(table, snapshot)
        open_file = lambda entry, io=table.io: io.new_input(entry.file_path).open()
    for index, entry in enumerate(entries):
        if index >= engine.settings.bulk_max_files:
            raise ValueError("The frozen snapshot exceeds its configured file inventory limit.")
        guard()
        bounds.check()
        with open_file(entry) as stream:
            stream.seek(-8, 2)
            footer = stream.read(8)
            if footer[4:] != b"PAR1" or int.from_bytes(footer[:4], "little") > engine.settings.bulk_max_footer_mb * 1048576:
                raise ValueError("A frozen Parquet footer is invalid or exceeds its configured byte limit.")
            stream.seek(0)
            with pq.ParquetFile(stream) as source:
                for batch in source.iter_batches(batch_size=min(256, engine.settings.prepared_read_batch_rows), use_threads=False):
                    guard()
                    bounds.check()
                    table = pa.Table.from_batches([batch])
                    if table.nbytes > engine._memory_limit():
                        raise MemoryError("A frozen decoded batch exceeds its configured memory budget.")
                    yield table


def _stage_frozen_narrow(engine, base, path, bounds, guard):
    selected = base.get("lookup_publications", {}).get("r3") or base
    rows = 0
    with pq.ParquetWriter(path, SEARCH_SCHEMA, compression="zstd") as writer:
        for table in _frozen_batches(engine, selected["search_table_name"], selected["search_snapshot_id"], bounds, guard):
            if not all(name in table.column_names for name in SEARCH_SCHEMA.names):
                for resolution in range(16):
                    name = f"h3_r{resolution}"
                    if name not in table.column_names:
                        table = table.append_column(name, pa.array(coordinates_to_cells(table["lat"], table["lon"], resolution)).cast(pa.int64()))
            table = table.select(SEARCH_SCHEMA.names).cast(SEARCH_SCHEMA)
            writer.write_table(table, row_group_size=engine.settings.parquet_row_group_rows)
            rows += len(table)
    if rows != sum(base["counts"].values()):
        raise RuntimeError("The frozen lookup count differs from its publication.")


def _stage_baseline(engine, base, dataset, state, root, bounds, guard):
    """Join the frozen slim wide and canonical narrow into one version-zero staging batch."""
    table_id = dataset["id"]
    schema = pa.ipc.read_schema(pa.BufferReader(b64decode(state["arrow"])))
    slim = slim_schema(schema)
    narrow = root / "frozen-narrow.parquet"
    wide = root / f"{table_id}-frozen-wide.parquet"
    with pq.ParquetWriter(wide, slim, compression="zstd") as writer:
        for table in _frozen_batches(engine, base["wide_table_names"][table_id], base["wide_snapshots"][table_id], bounds, guard):
            writer.write_table(table.select(slim.names).cast(slim), row_group_size=engine.settings.parquet_row_group_rows)
    baseline = root / f"{table_id}-baseline.parquet"
    versioned = schema.append(pa.field("__batch", pa.int64()))
    columns = ["w." + name if name.startswith("src_") else "n." + name for name in schema.names]
    rows = _write_query(baseline, f"SELECT {', '.join(columns)}, 0::BIGINT AS __batch FROM read_parquet(?) n JOIN read_parquet(?) w USING(table_id,object_id) WHERE n.table_id=? ORDER BY n.object_id",
                        [str(narrow), str(wide), table_id], versioned, bounds, guard)
    if rows != base["counts"][table_id]:
        raise RuntimeError("The frozen wide join differs from its published dataset count.")
    events_path = root / f"{table_id}-baseline-events.parquet"
    event_schema = pa.schema([pa.field("object_id", pa.int64()), pa.field("__batch", pa.int64()), pa.field("__valid", pa.bool_()), pa.field("__reason", pa.string())])
    _write_query(events_path, "SELECT object_id, __batch, true AS __valid, NULL::VARCHAR AS __reason FROM read_parquet(?)", [str(baseline)], event_schema, bounds, guard)
    # Rejected source keys have no searchable baseline row but remain part of the checkpoint.
    rejects = root / f"{table_id}-baseline-rejects.parquet"
    with pq.ParquetWriter(rejects, event_schema, compression="zstd") as writer:
        with engine.registry.connect() as connection:
            cursor = connection.execute("SELECT object_id,reason FROM etl_rejects WHERE table_id=? ORDER BY object_id", (table_id,))
            while page := cursor.fetchmany(engine.settings.fetch_batch_rows):
                guard()
                table = pa.Table.from_pylist([{"object_id": row["object_id"], "__batch": 0, "__valid": False, "__reason": row["reason"]} for row in page], schema=event_schema)
                writer.write_table(table)
    merged = root / f"{table_id}-baseline-all-events.parquet"
    event_rows = _write_query(merged, "SELECT * FROM read_parquet(?)", [[str(events_path), str(rejects)]], event_schema, bounds, guard)
    return {"data": spool.seal(baseline, rows, guard), "events": spool.seal(merged, event_rows, guard)}


class Load:
    """Journal a full configured-set load without changing published source data."""

    def __init__(self, engine):
        self.engine, self.registry, self.settings = engine, engine.registry, engine.settings
        self._frozen_ready = False
        self._sources = ExitStack()
        self._source_id = None

    @contextmanager
    def _source(self, dataset):
        # One connection remains open across the bounded pages of a dataset.
        if self._source_id != dataset["id"]:
            self._sources.close()
            self._source_id = None
            self._source_value = self._sources.enter_context(self.engine._source(dataset, {"kind": "sql"}))
            self._source_id = dataset["id"]
        yield self._source_value

    def _frozen(self, bounds, guard):
        path = self.root / "frozen-narrow.parquet"
        if not self._frozen_ready:
            temporary = path.with_suffix(".tmp")
            try:
                _stage_frozen_narrow(self.engine, self.base, temporary, bounds, guard)
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)
            self._frozen_ready = True
        return path

    def _save(self, run, guard, **changes):
        guard()
        updated = {**run, **changes, "revision": run["revision"] + 1}
        payload = json.dumps(updated)
        if len(payload.encode()) > self.settings.bulk_max_manifest_mb * 1048576:
            raise ValueError("The load journal exceeds its configured manifest byte limit.")
        with self.registry.connect() as conn:
            result = conn.execute("UPDATE etl_pending SET revision=?,payload=? WHERE singleton=1 AND id=? AND revision=?", (updated["revision"], payload, run["id"], run["revision"]))
            if result.rowcount != 1:
                raise ConflictError("The load work lease changed. Retry the operation.")
        return updated

    def _check_file(self, entry, guard):
        path = self.root / entry["file"]
        if Path(entry["file"]).name != entry["file"] or not path.is_file() or path.is_symlink() or spool.checksum(path, guard) != entry["sha256"]:
            raise RuntimeError("A durable load staging file is missing or changed. Restore it before retrying.")
        return path

    def _output_encoding(self, run, key, source, names, guard):
        """Journal encoding before opening output files; a restart may tune unstarted outputs."""
        plan = run.get('output_encoding_plan', {'version': 1, 'generation': run['id'], 'outputs': {}})
        if plan.get('version') != 1 or plan.get('generation') != run['id']:
            raise ConflictError('The output encoding plan belongs to another generation or build.')
        fingerprint = sha256(json.dumps(source, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        entry = plan['outputs'].get(key)
        if entry:
            if entry.get('source') != fingerprint:
                raise ConflictError('The sealed source changed after its output encoding was frozen.')
            return run, *_encoding_view(self.engine, self.root, entry)
        settings = {name: getattr(self.settings, name) for name in ENCODING_FIELDS}
        windows = run.get('output_read_window_overrides', {})
        requested = windows.get(key)
        existing = []
        for name in names:
            if isinstance(self.engine.lake, LocalLake):
                head = self.engine.lake._head(name)
                if head:
                    if head['batch'] != run['id']:
                        raise ConflictError('An output encoding target belongs to another generation.')
                    existing.append(name)
            else:
                table = self.engine.lake._load(name)
                if table:
                    head = table.current_snapshot()
                    if head and head.summary.get('h3search.load-id') != run['id']:
                        raise ConflictError('An output encoding target belongs to another generation.')
                    existing.append(name)
        if existing and requested is None:
            raise ConflictError('Existing generation outputs lack an encoding plan. Supply --output-read-plan with their original read windows; no files were replaced.')
        if requested is not None:
            settings['prepared_read_batch_rows'] = requested
        entry = {'source': fingerprint, 'settings': settings,
                 'writer': {'pyarrow': pa.__version__, 'duckdb': duckdb.__version__}}
        plan = {**plan, 'outputs': {**plan['outputs'], key: entry}}
        run = self._save(run, guard, output_encoding_plan=plan)
        return run, *_encoding_view(self.engine, self.root, entry)

    def execute(self, lookup="r3", *, max_batches=None, stop_file=None, incremental=False, table_ids=None,
                initial_only=False, source_frozen=False, output_read_plan=None):
        if lookup not in ("r3", "single-file", "both"):
            raise ValueError("Lookup must be r3, single-file or both.")
        if max_batches is not None and (type(max_batches) is not int or max_batches < 1):
            raise ValueError("Batch limit must be a positive integer.")
        if initial_only != source_frozen:
            raise ValueError("Initial-only loading requires the explicit source-frozen confirmation.")
        if initial_only and incremental:
            raise ConflictError("Initial-only loading cannot reuse or incrementally refresh published data.")
        stop_file = Path(stop_file) if stop_file is not None else None
        self._source_id = None
        with self.registry.writer_lease() as lease, self._sources:
            lease = lease or (lambda: None)
            clean_completed_load_stages(self.engine, lease)
            if self.registry.bulk_activation() or self.registry.bulk_preparations():
                raise ConflictError("Resolve bulk work before loading lookup layouts.")
            run = self.engine._pending()
            if output_read_plan is not None and run is None:
                raise ConflictError('An output read plan must match this frozen initial generation; no pending generation exists.')
            if run and (run["operation"] != "load" or run["lookup"] != lookup):
                raise ConflictError("Resume the pending ETL operation with its original lookup selection first.")
            if run is None:
                if self.settings.datasets:
                    from .configured import register_configured
                    datasets = register_configured(self.settings, self.registry)
                else:
                    datasets = self.registry.list_datasets()
                if not datasets:
                    raise ValueError("Register at least one SQL Server dataset before loading.")
                previous = self.registry.current_publication()
                if initial_only and previous is not None:
                    raise ConflictError("Initial-only loading requires an unpublished cold load.")
                if incremental and table_ids is not None and previous:
                    datasets = [dataset for dataset in datasets if dataset["id"] in previous["counts"] or dataset["id"] in table_ids]
                ids = {dataset["id"] for dataset in datasets}
                if previous and set(previous["counts"]) - ids:
                    raise ConflictError("The configured load omits published datasets. Remove them explicitly before loading.")
                if any(dataset["status"] == "removing" for dataset in datasets):
                    raise ConflictError("Finish dataset removal before loading.")
                run = {"id": new_id(), "revision": 0, "operation": "load", "table_id": datasets[0]["id"], "lookup": lookup,
                       "datasets": datasets, "index": 0, "states": {}, "base_publication_id": previous["id"] if previous else None,
                       "rows": 0, "batches": 0, "phase": "fetch", "incremental": bool(incremental and previous and previous.get("layout_version") == 2),
                       "initial_only": bool(initial_only), "source_frozen": bool(source_frozen),
                       "table_ids": sorted(table_ids) if table_ids is not None else None,
                       "stage_owner": self.settings.bulk_owner_id or socket.gethostname(), "stage_root": str(self.engine.stage.resolve())}
                lease()
                with self.registry.connect() as conn:
                    conn.execute("INSERT INTO etl_pending (singleton,id,table_id,revision,payload) VALUES (1,?,?,0,?)", (run["id"], run["table_id"], json.dumps(run)))
            if run.get("stage_owner") != (self.settings.bulk_owner_id or socket.gethostname()) or run.get("stage_root") != str(self.engine.stage.resolve()):
                raise ConflictError("Resume the load with its original staging owner and directory.")
            if table_ids is not None and run.get("table_ids") is not None and sorted(table_ids) != run["table_ids"]:
                raise ConflictError("Resume the pending load with its original dataset selection.")
            self.root = self.engine.stage / f"load-{run['id']}"
            self.root.mkdir(parents=True, exist_ok=True)
            if self.root.is_symlink() or self.root.is_junction():
                raise ValueError("Load staging cannot use symbolic links or junctions.")
            if output_read_plan is not None:
                if not initial_only or output_read_plan.get('generation') != run['id']:
                    raise ConflictError('An output read plan must match this frozen initial generation.')
                windows = output_read_plan.get('wide_read_batch_rows_by_dataset', {})
                if not isinstance(windows, dict) or set(windows) - {dataset['id'] for dataset in run['datasets']}:
                    raise ConflictError('The output read plan names datasets outside this generation.')
                overrides = {'wide:' + key: value for key, value in windows.items()}
                if 'lookup_read_batch_rows' in output_read_plan:
                    overrides['lookups'] = output_read_plan['lookup_read_batch_rows']
                if any(type(value) is not int or value < 1 for value in overrides.values()):
                    raise ValueError('Output read windows must be positive integers.')
                previous = run.get('output_read_window_overrides')
                if previous is not None and previous != overrides:
                    raise ConflictError('This generation already has different durable output read windows.')
                if previous is None:
                    for key, entry in run.get('output_encoding_plan', {}).get('outputs', {}).items():
                        if key in overrides and entry['settings']['prepared_read_batch_rows'] != overrides[key]:
                            raise ConflictError('An output read plan cannot change an encoding already frozen in this generation.')
                    run = self._save(run, lease, output_read_window_overrides=overrides)
            bounds = ResourceBounds(self.engine, self.root)
            self.base = self.registry.current_publication()
            if (self.base["id"] if self.base else None) != run["base_publication_id"]:
                raise ConflictError("The published data changed while a load was pending.")
            if run.get("initial_only") and not initial_only:
                raise ConflictError("Resume the initial-only load with its source-frozen confirmation.")
            if initial_only:
                if run.get("incremental") or run["base_publication_id"] is not None:
                    raise ConflictError("Initial-only loading requires an unpublished cold load without reuse.")
                states = {}
                for dataset in run["datasets"]:
                    state = run["states"].get(dataset["id"])
                    if state is None:
                        continue
                    if state.get("reuse") or state["phase"] not in ("base", "fence", "cdc", "complete"):
                        raise ConflictError("The pending source state cannot be resumed as initial-only.")
                    if dataset["mode"] == "cdc":
                        if state.get("baseline") is None or (not run.get("initial_only") and state["phase"] in ("cdc", "complete") and state["cursor"] is not None):
                            raise ConflictError("The pending load may contain staged CDC changes; initial-only adoption is unsafe.")
                        if run.get("initial_only") and state["phase"] in ("fence", "cdc"):
                            raise ConflictError("The initial-only journal contains an incompatible CDC phase.")
                        if state["phase"] != "base":
                            if not state.get("marker"):
                                raise ConflictError("A completed base scan is missing its durable source-time marker.")
                            state = {**state, "phase": "complete"}
                    elif state["phase"] not in ("base", "complete"):
                        raise ConflictError("An insert-only source has an incompatible CDC phase.")
                    states[dataset["id"]] = state
                if not run.get("initial_only"):
                    run = self._save(run, lease, initial_only=True, source_frozen=True, states=states, index=0)
            initial = run["batches"]

            def local_check():
                if stop_file is not None and stop_file.exists():
                    raise LoadStopped()

            def guard():
                lease()
                local_check()

            guard.local_check = local_check

            try:
                while run["index"] < len(run["datasets"]):
                    guard()
                    if max_batches is not None and run["batches"] - initial >= max_batches:
                        return self._paused(run, "max_batches", initial)
                    dataset = run["datasets"][run["index"]]
                    table_id = dataset["id"]
                    if run.get("incremental") and run.get("table_ids") is not None and table_id not in run["table_ids"]:
                        state = {"reuse": True, "phase": "complete", "chunks": [], "columns": self.base["columns"][table_id], "skip": True}
                        run = self._save(run, lease, states={**run["states"], table_id: state}, index=run["index"] + 1)
                        continue
                    with self._source(dataset) as source:
                        state = run["states"].get(table_id)
                        if state is None:
                            fingerprint = source.layout.fingerprint
                            if dataset["schema_fingerprint"] and fingerprint != dataset["schema_fingerprint"]:
                                raise ReloadRequired("The source schema changed. Remove and reload the dataset.")
                            reuse = run.get("incremental", False) and table_id in self.base["counts"]
                            checkpoint = self.engine._checkpoint(table_id) if reuse else None
                            if reuse and (not checkpoint or checkpoint.get("source") != {"kind": "sql"}):
                                raise ConflictError("The published dataset is missing its SQL source checkpoint.")
                            baseline = checkpoint["lsn"] if reuse and dataset["mode"] == "cdc" else (source.max_lsn() if dataset["mode"] == "cdc" else None)
                            state = {"schema": fingerprint, "arrow": b64encode(source.layout.schema.serialize().to_pybytes()).decode(), "columns": source.layout.fields,
                                     "cutoff": source.cutoff(), "baseline": baseline,
                                     "phase": "cdc" if reuse and dataset["mode"] == "cdc" else "base",
                                     "cursor": checkpoint.get("key") if reuse and dataset["mode"] == "insert" else None, "chunks": [], "reuse": reuse}
                            if reuse and dataset["mode"] == "cdc":
                                if checkpoint.get("bootstrap_marker"):
                                    state.update(phase="fence", marker=checkpoint["bootstrap_marker"])
                                else:
                                    state["high"] = source.max_lsn()
                            if reuse and dataset["mode"] == "insert" and state["cursor"] is not None and (state["cutoff"] is None or state["cutoff"] < state["cursor"]):
                                raise ReloadRequired("The insert-only source key range moved backward. Remove and reload the dataset.")
                            # CDC baseline must precede the base scan; no row reads occur above.
                            run = self._save(run, lease, states={**run["states"], table_id: state})
                        self.engine._validate_source(source, state)
                        if state["phase"] == "fence":
                            state = {**state, "high": source.fence(state["marker"]), "phase": "cdc", "cursor": None}
                            run = self._save(run, lease, states={**run["states"], table_id: state})
                        if state["phase"] == "complete":
                            run = self._save(run, lease, index=run["index"] + 1)
                            continue
                        limit = bounds.check()
                        native_batch = None
                        if state["phase"] == "base":
                            if run.get("initial_only") and self.settings.initial_source_reader == "arrow":
                                from .source_arrow import frozen_base
                                native_batch = frozen_base(source, self.settings, dataset, state["cursor"],
                                                           state["cutoff"], self.settings.fetch_batch_rows, limit)
                            if native_batch is not None:
                                changes, cursor = native_batch.rows, native_batch.cursor
                            else:
                                changes, cursor = source.read_base(state["cursor"], state["cutoff"], self.settings.fetch_batch_rows, limit)
                        else:
                            changes, cursor = source.read_changes(state["baseline"], state["high"], state["cursor"], min(self.settings.fetch_batch_rows, self.settings.cdc_batch_rows), limit)
                        self.engine._validate_source(source, state)
                        if not changes:
                            if state["phase"] == "base" and dataset["mode"] == "cdc":
                                state = {**state, "phase": "complete" if run.get("initial_only") else "fence",
                                         "marker": source.scan_marker(), "key": state["cursor"]}
                            else:
                                state = {**state, "phase": "complete", "key": state["cursor"] if dataset["mode"] == "insert" else state.get("key")}
                            run = self._save(run, lease, states={**run["states"], table_id: state})
                            continue
                        if cursor == state["cursor"]:
                            raise RuntimeError("The source batch did not advance its durable cursor.")
                        if state["reuse"] and not state["chunks"]:
                            self._frozen(bounds, guard)
                            chunk = _stage_baseline(self.engine, self.base, dataset, state, self.root, bounds, guard)
                            state = {**state, "chunks": [chunk]}
                            run = self._save(run, lease, states={**run["states"], table_id: state})
                        if run.get('initial_only') and native_batch is None:
                            previous = state['cursor']
                            for operation, values in changes:
                                key = int(values[source.layout.key])
                                if operation != 2 or (previous is not None and key <= previous):
                                    raise RuntimeError("Frozen base source rows must be unique inserts in increasing OBJECTID order.")
                                previous = key
                            if cursor != previous:
                                raise RuntimeError("The frozen base source cursor differs from its final OBJECTID.")
                        if native_batch is not None:
                            wide, keys, rejects = native_batch.wide, native_batch.keys, native_batch.rejects
                        else:
                            wide, keys, rejects = transform(table_id, source.layout, changes, self.settings.transform_workers)
                        number = len(state["chunks"])
                        wide = wide.append_column("__batch", pa.repeat(pa.scalar(number, pa.int64()), len(wide)))
                        valid = set(wide["object_id"].to_pylist())
                        reasons = dict(rejects)
                        events = pa.table({"object_id": pa.array(keys, pa.int64()), "__batch": pa.array([number] * len(keys), pa.int64()),
                                           "__valid": pa.array([key in valid for key in keys], pa.bool_()), "__reason": pa.array([reasons.get(key) for key in keys], pa.string())})
                        chunk = {}
                        for kind, table in (("data", wide), ("events", events)):
                            path = self.root / f"{table_id}-{number}-{kind}-{new_id()}.parquet"
                            spool.write_parquet(path, table, self.settings.parquet_row_group_rows)
                            chunk[kind] = spool.seal(path, len(table), guard)
                        if 2 * (sum(len(item["chunks"]) for item in run["states"].values()) + 1) > self.settings.bulk_max_files:
                            raise ValueError("The load source staging exceeds its configured file inventory limit.")
                        state = {**state, "cursor": cursor, "chunks": [*state["chunks"], chunk]}
                        run = self._save(run, lease, states={**run["states"], table_id: state}, batches=run["batches"] + 1, rows=run["rows"] + len(wide))
                guard()
                if run.get("incremental") and not run["batches"] and all(state.get("reuse") for state in run["states"].values()):
                    return self._publish_noop(run, guard, lease)
                return self._publish(run, bounds, guard, lease)
            except LoadStopped:
                return self._paused(run, "stop_file", initial)

    @staticmethod
    def _paused(run, reason, initial):
        return {"status": "paused", "lookup": run["lookup"], "reason": reason, "rows": run["rows"], "batches": run["batches"] - initial}

    def _publish_noop(self, run, guard, lease):
        """Advance empty captured intervals without creating new lake snapshots."""
        with self.registry.write_lease():
            guard()
            with self.registry.connect() as connection:
                for dataset in run["datasets"]:
                    state = run["states"][dataset["id"]]
                    if state.get("skip"):
                        continue
                    checkpoint = self._checkpoint_payload(run, dataset, state)
                    connection.execute("UPDATE etl_checkpoints SET payload=? WHERE table_id=?", (json.dumps(checkpoint), dataset["id"]))
                result = connection.execute("DELETE FROM etl_pending WHERE singleton=1 AND id=? AND revision=?", (run["id"], run["revision"]))
                if result.rowcount != 1:
                    raise ConflictError("The load work lease changed. Retry the operation.")
                connection.execute("INSERT INTO etl_completed_loads (id,stage_owner,stage_root) VALUES (?,?,?) ON CONFLICT DO NOTHING", (run["id"], run["stage_owner"], run["stage_root"]))
        clean_completed_load_stages(self.engine, lease)
        return self.base

    @staticmethod
    def _checkpoint_payload(run, dataset, state):
        if dataset["mode"] != "cdc":
            return {"source": {"kind": "sql"}, "key": state["key"]}
        if run.get("initial_only"):
            return {"source": {"kind": "sql"}, "lsn": state["baseline"], "bootstrap_marker": state["marker"]}
        return {"source": {"kind": "sql"}, "lsn": state["high"]}

    def _publish(self, run, bounds, guard, lease):
        generation = UUID(run["id"]).hex
        local = local_work_guard(guard, self.engine.settings)
        local_bounds(bounds, local)
        narrow_paths, counts, columns, wide_names, wide_snapshots, reject_paths = [], {}, {}, {}, {}, {}
        if run.get("incremental"):
            self._frozen(bounds, guard)
        unchanged = [table_id for table_id, state in run["states"].items() if state.get("reuse") and not state["chunks"]]
        if unchanged:
            narrow = self.root / "unchanged-narrow.parquet"
            actual_counts = {}
            _write_query(narrow, "SELECT * FROM read_parquet(?) WHERE table_id IN (SELECT unnest(?))",
                         [str(self.root / "frozen-narrow.parquet"), unchanged], SEARCH_SCHEMA, bounds, guard, identity_counts=actual_counts)
            for table_id in unchanged:
                count = actual_counts.get(table_id, 0)
                if count != self.base["counts"][table_id]:
                    raise RuntimeError("The frozen lookup count differs from its published dataset count.")
                wide_names[table_id] = self.base["wide_table_names"][table_id]
                wide_snapshots[table_id] = self.base["wide_snapshots"][table_id]
                counts[table_id], columns[table_id] = count, self.base["columns"][table_id]
            narrow_paths.append(narrow)
        for dataset in run["datasets"]:
            guard()
            table_id = dataset["id"]
            state = run["states"][table_id]
            # Dataset-scoped runs do not connect to unrelated sources.
            if not state.get("skip"):
                with self._source(dataset) as source:
                    self.engine._validate_source(source, state)
            if state.get("reuse") and not state["chunks"]:
                continue
            schema = pa.ipc.read_schema(pa.BufferReader(b64decode(state["arrow"])))
            output_engine, output_bounds = self.engine, bounds
            name = f"wide_{UUID(table_id).hex}_{generation}"
            if run.get('initial_only'):
                source = {'dataset_id': table_id, 'schema': state['arrow'], 'chunks': state['chunks']}
                run, output_engine, output_bounds = self._output_encoding(run, 'wide:' + table_id, source, [name], guard)
                local_bounds(output_bounds, local)
            full = self.root / f"{table_id}-final.parquet"
            rejected = self.root / f"{table_id}-rejected.parquet"
            if run.get('initial_only'):
                from .prepared_outputs import load_prepared, save_prepared
                prepared = load_prepared(self.root, run['id'], table_id, state, schema,
                                         output_bounds, local, self._check_file)
                if prepared is None:
                    prepared = _frozen_base_outputs(self.root, table_id, state, schema,
                                                    output_bounds, local, self._check_file)
                    save_prepared(self.root, run['id'], table_id, state, schema, output_bounds, local, prepared)
                narrow, rejected, files, count = prepared
                reject_paths[table_id] = rejected
            elif state["chunks"]:
                data = [str(self._check_file(chunk["data"], guard)) for chunk in state["chunks"]]
                events = [str(self._check_file(chunk["events"], guard)) for chunk in state["chunks"]]
                latest = "SELECT * FROM read_parquet(?) QUALIFY row_number() OVER (PARTITION BY object_id ORDER BY __batch DESC)=1"
                sql = f"SELECT {', '.join('d.' + name for name in schema.names)} FROM read_parquet(?) d JOIN ({latest}) e USING(object_id,__batch) WHERE e.__valid ORDER BY d.object_id"
                count = _write_query(full, sql, [data, events], schema, bounds, guard)
                reject_schema = pa.schema([pa.field("object_id", pa.int64()), pa.field("__reason", pa.string())])
                _write_query(rejected, f"SELECT object_id,__reason FROM ({latest}) WHERE __reason IS NOT NULL", [events], reject_schema, bounds, guard)
                reject_paths[table_id] = rejected
            else:
                pq.write_table(schema.empty_table(), full)
                count = 0
            if not run.get('initial_only'):
                narrow = self.root / f"{table_id}-narrow.parquet"
                _write_query(narrow, f"SELECT {', '.join(SEARCH_SCHEMA.names)} FROM read_parquet(?)", [str(full)], SEARCH_SCHEMA, bounds, guard)
                files = _partition_files([full], slim_schema(schema), "wide", f"wide-{table_id}", bounds, guard)
            narrow_paths.append(narrow)
            slim = slim_schema(schema)
            verify_keys([narrow if run.get('initial_only') else full], [entry["path"] for entry in files], output_bounds, local)
            wide_snapshots[table_id] = commit_output(output_engine, name, slim, "wide", files, output_bounds, guard, run["id"])
            if run.get('initial_only'):
                from .prepared_outputs import record_commit
                identities = [(entry['sha256'], entry['rows'], entry['partition']) for entry in files]
                sealed = json.dumps(identities, separators=(',', ':')).encode()
                content = sha256(slim.serialize().to_pybytes() + b'wide' + sealed).hexdigest()
                record_commit(self.root, table_id, name, wide_snapshots[table_id], content)
            wide_names[table_id], counts[table_id], columns[table_id] = name, count, state["columns"]
        lookup_engine = self.engine
        if run.get('initial_only'):
            names = [f'search_{kind}_{generation}' for key, kind in (('r3', 'r3'), ('single-file', 'single'))
                     if run['lookup'] in (key, 'both')]
            source = {'lookup': run['lookup'], 'states': {key: {'schema': state['arrow'], 'chunks': state['chunks']}
                                                       for key, state in run['states'].items()}}
            run, lookup_engine, _ = self._output_encoding(run, 'lookups', source, names, guard)
        lookups = build_lookups(lookup_engine, self.root, narrow_paths, run["id"], run["lookup"], guard)
        publication = {"id": run["id"], "created_at": utc_now(), "layout_version": 2, "lookup_mode": run["lookup"], "lookup_publications": lookups,
                       "wide_table_names": wide_names, "wide_snapshots": wide_snapshots, "counts": counts, "columns": columns,
                       "dataset_sources": {dataset["id"]: {key: dataset[key] for key in ("source_schema", "source_table")} for dataset in run["datasets"]},
                       **lookups["r3" if "r3" in lookups else "single-file"]}
        with self.registry.write_lease():
            guard()
            current = self.registry.current_publication()
            if (current["id"] if current else None) != run["base_publication_id"]:
                raise ConflictError("The published data changed before the load could be published.")
            with self.registry.connect() as conn:
                for dataset in run["datasets"]:
                    table_id = dataset["id"]
                    state = run["states"][table_id]
                    if state.get("skip"):
                        continue
                    checkpoint = self._checkpoint_payload(run, dataset, state)
                    conn.execute("INSERT INTO etl_checkpoints (table_id,payload) VALUES (?,?) ON CONFLICT(table_id) DO UPDATE SET payload=excluded.payload", (table_id, json.dumps(checkpoint)))
                    if state.get("reuse") and not state["chunks"]:
                        continue
                    conn.execute("DELETE FROM etl_rejects WHERE table_id=?", (table_id,))
                    if table_id in reject_paths:
                        with pq.ParquetFile(reject_paths[table_id]) as file:
                            for batch in file.iter_batches(batch_size=self.settings.fetch_batch_rows):
                                conn.executemany("INSERT INTO etl_rejects (table_id,object_id,reason) VALUES (?,?,?)", ((table_id, row["object_id"], row["__reason"]) for row in batch.to_pylist())).close()
                    conn.execute("UPDATE datasets SET schema_fingerprint=? WHERE id=?", (state["schema"], table_id))
                self.registry.publish(publication, conn)
                conn.execute("INSERT INTO etl_completed_loads (id,stage_owner,stage_root) VALUES (?,?,?) ON CONFLICT DO NOTHING", (run["id"], run["stage_owner"], run["stage_root"]))
                result = conn.execute("DELETE FROM etl_pending WHERE singleton=1 AND id=? AND revision=?", (run["id"], run["revision"]))
                if result.rowcount != 1:
                    raise ConflictError("The load work lease changed. Retry the operation.")
        clean_completed_load_stages(self.engine, lease)
        return publication
