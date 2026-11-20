"""Build a one-file search index from verified SQL Server lookup rows."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager
import logging
from pathlib import Path
from queue import Empty, Full, Queue
from shutil import disk_usage, rmtree
from tempfile import TemporaryDirectory
from threading import Event, Lock, Thread
from time import monotonic
from urllib.parse import urlsplit

import duckdb
from h3ronpy.vector import coordinates_to_cells
import psutil
import pyarrow as pa
import pyarrow.parquet as pq

from h3search.control import ConflictError, SINGLE_FILE_SEARCH_TABLE
from h3search.models import new_id, utc_now

from .lake import LocalLake
from .layout import SEARCH_SCHEMA, position, search_name


log = logging.getLogger(__name__)
TABLE_NAME = SINGLE_FILE_SEARCH_TABLE
KEY_ORDER = ("table_id", "object_id")
SORT_ORDER = ("h3_r15", *KEY_ORDER)
SINGLE_FILE_SCHEMA = pa.schema([SEARCH_SCHEMA.field(name) for name in (*KEY_ORDER, "lat", "lon", "h3_r15")])
MIB = 1024 ** 2
PROGRESS_ROWS = 5_000_000
PROGRESS_FILES = 1_000


class SingleFileError(RuntimeError):
    """Safe diagnostic for a one-file build that cannot publish."""


class ResourceBounds:
    def __init__(self, engine, root):
        self.engine = engine
        self.root = root
        self.settings = engine.settings
        self.process = psutil.Process()
        self.inventory_lock = Lock()
        self.next_inventory = 0.0
        self.batch_rows = min(
            self.settings.initial_search_sort_row_group_rows,
            self.settings.batch_max_mb * MIB // 512,
        )

    def check(self, *, force_inventory=False):
        available = psutil.virtual_memory().available
        if available < self.settings.bulk_host_reserve_mb * MIB:
            raise MemoryError("The single-file build reached its configured available host memory reserve.")
        if disk_usage(self.root).free < self.settings.bulk_disk_reserve_mb * MIB:
            raise SingleFileError("The single-file build reached its configured free staging disk reserve.")
        with self.inventory_lock:
            if force_inventory or monotonic() >= self.next_inventory:
                stage_bytes = 0
                for path in self.root.rglob("*"):
                    try:
                        if path.is_file():
                            stage_bytes += path.stat().st_size
                    except FileNotFoundError:
                        continue  # A sorter may have just released its spill file.
                if stage_bytes > self.settings.bulk_stage_quota_mb * MIB:
                    raise SingleFileError("The build exceeded its configured staging quota.")
                self.next_inventory = monotonic() + self.settings.prepared_inventory_interval_sec
        return self.engine._memory_limit()

    @contextmanager
    def sorted_batches(self, path, order, *, batch_rows=None):
        settings = self.settings
        self.check()
        memory = min(settings.initial_search_sort_memory_mb,
                     (settings.memory_budget_mb * MIB - self.process.memory_info().rss) // (2 * MIB))
        if memory < 1:
            raise MemoryError("The single-file sort has insufficient process memory headroom.")
        deadline = monotonic() + settings.initial_search_sort_timeout_sec
        spill = self.root / "sort-spill"
        with duckdb.connect(config={
            "memory_limit": f"{memory}MiB",
            "threads": settings.initial_search_sort_threads,
            "temp_directory": str(spill),
            "max_temp_directory_size": f"{settings.initial_search_sort_temp_mb}MiB",
        }) as connection:
            stopped = Event()
            failure = []

            def monitor():
                while not stopped.wait(0.25):
                    try:
                        if monotonic() >= deadline:
                            raise TimeoutError("The single-file sort reached its configured time budget.")
                        self.check()
                    except Exception as error:
                        failure.append(error)
                        connection.interrupt()
                        return

            watchdog = Thread(target=monitor, daemon=True)
            watchdog.start()
            try:
                ordered = connection.execute(
                    f"SELECT {', '.join(SINGLE_FILE_SCHEMA.names)} FROM read_parquet(?) ORDER BY {', '.join(order)}",
                    [str(path)],
                )
                with ordered.to_arrow_reader(batch_size=batch_rows or self.batch_rows) as reader:
                    yield reader
            except duckdb.InterruptException:
                if failure:
                    raise failure[0] from None
                raise
            finally:
                stopped.set()
                watchdog.join()
            if failure:
                raise failure[0]
            if monotonic() >= deadline:
                raise TimeoutError("The single-file sort reached its configured time budget.")
        self.check()


def _published_inputs(engine, base):
    counts = base["counts"]
    if counts.keys() != base["wide_snapshots"].keys() or counts.keys() != base["columns"].keys():
        raise SingleFileError("The current publication has inconsistent dataset metadata.")
    for table_id in sorted(counts):
        dataset = engine.registry.get_dataset(table_id)
        checkpoint = engine._checkpoint(table_id)
        marker = "lsn" if dataset["mode"] == "cdc" else "key"
        if not checkpoint or checkpoint.get("source") != {"kind": "sql"} or marker not in checkpoint:
            raise SingleFileError(f"Dataset {table_id} has no published SQL Server checkpoint.")
        if not dataset["schema_fingerprint"] or dataset["status"] != "ready":
            raise SingleFileError(f"Dataset {table_id} is missing a ready source schema.")
        yield dataset, checkpoint.get("key"), counts[table_id]


def _read_source(engine, source, dataset, cutoff, expected, bounds, guard):
    table_id = dataset["id"]
    run = {"schema": dataset["schema_fingerprint"]}
    engine._validate_source(source, run)
    read = getattr(source, "read_lookup_base", None)
    if read is None:
        read, layout = source.read_base, source.layout
    else:
        layout = source.lookup_layout
    if dataset["mode"] == "cdc":
        guard()
        cutoff = source.cutoff()
    cursor = None
    rows = 0
    while True:
        guard()
        limit = bounds.check()
        changes, next_cursor = read(cursor, cutoff, engine.settings.fetch_batch_rows, limit)
        engine._validate_source(source, run)
        if not changes:
            break
        previous = cursor
        keys, latitudes, longitudes = [], [], []
        for operation, values in changes:
            key = int(values[layout.key])
            if operation != 2 or (previous is not None and key <= previous):
                raise SingleFileError(f"Dataset {table_id} returned duplicate or unordered source keys.")
            previous = key
            lat, lon, reject = position(values[layout.lat], values[layout.lon])
            if reject is None:
                keys.append(key)
                latitudes.append(lat)
                longitudes.append(lon)
        if previous != next_cursor or cutoff is None or next_cursor > cutoff:
            raise SingleFileError(f"Dataset {table_id} returned a key outside its reload interval.")
        cursor = next_cursor
        bounds.check()
        previous_rows = rows
        rows += len(keys)
        if rows // PROGRESS_ROWS > previous_rows // PROGRESS_ROWS:
            log.info("Reloaded %s of %s searchable rows for dataset %s", rows, expected, table_id)
        if rows > expected:
            break
        if keys:
            lat = pa.array(latitudes, type=pa.float64())
            lon = pa.array(longitudes, type=pa.float64())
            cells = pa.array(coordinates_to_cells(lat, lon, 15)).cast(pa.int64())
            yield pa.Table.from_arrays(
                [pa.repeat(pa.scalar(table_id), len(keys)), pa.array(keys, type=pa.int64()), lat, lon, cells],
                schema=SINGLE_FILE_SCHEMA,
            )
    if rows != expected:
        raise SingleFileError(f"Dataset {table_id} source rows differ from its published searchable count. "
                              "Bring ordinary ingestion up to date and retry the comparison.")


def _stage_fresh(engine, datasets, path, bounds, guard):
    with pq.ParquetWriter(path, SINGLE_FILE_SCHEMA, compression="zstd") as writer:
        for dataset, cutoff, expected in datasets:
            log.info("Reloading source lookup rows for dataset %s", dataset["id"])
            with engine._source(dataset, {"kind": "sql"}) as source:
                for narrow in _read_source(engine, source, dataset, cutoff, expected, bounds, guard):
                    writer.write_table(narrow, row_group_size=bounds.batch_rows)
                    bounds.check()
    bounds.check()


def _read_frozen_file(stream, batch_rows, footer_limit):
    stream.seek(-8, 2)
    tail = stream.read(8)
    if tail[4:] != b"PAR1" or int.from_bytes(tail[:4], "little") > footer_limit:
        raise SingleFileError("A frozen search Parquet footer is invalid or exceeds its configured byte limit.")
    with pq.ParquetFile(stream) as source:
        yield from source.iter_batches(batch_size=batch_rows, columns=SINGLE_FILE_SCHEMA.names, use_threads=False)


def _frozen_files(lake, snapshot_id, small_file_limit):
    if isinstance(lake, LocalLake):
        return lake.files(search_name, snapshot_id), lambda path: path.open("rb")
    table = lake._load(search_name)
    snapshot = table.snapshot_by_id(int(snapshot_id)) if table else None
    if snapshot is None:
        raise SingleFileError("The published search snapshot is unavailable for exact comparison.")
    client = lake._s3_client() if lake.warehouse.startswith("s3://") else None

    def open_file(file):
        size = file.file_size_in_bytes
        if client is not None and 0 < size <= small_file_limit and file.file_path.startswith("s3://"):
            from .iceberg import _bucket_key

            # A bounded single GET avoids separate metadata and range requests for tiny files.
            bucket, key = _bucket_key(file.file_path)
            response = client.get_object(Bucket=bucket, Key=key)
            with closing(response["Body"]) as body:
                if response["ContentLength"] != size:
                    raise SingleFileError("A frozen search object differs from its recorded size.")
                data = body.read(size + 1)
            if len(data) != size:
                raise SingleFileError("A frozen search object differs from its recorded size.")
            return pa.BufferReader(data)
        return table.io.new_input(file.file_path).open()

    return lake._data_files(table, snapshot), open_file


def _base_batches(lake, snapshot_id, bounds, guard):
    settings = bounds.settings
    workers = min(16, settings.transform_workers)
    size_limit = settings.prepared_carry_mb * MIB // (4 * workers)
    batch_rows = min(bounds.batch_rows, max(1, size_limit // 512))
    footer_limit = settings.bulk_max_footer_mb * MIB
    files, open_file = _frozen_files(lake, snapshot_id, min(size_limit, 256 * 1024))
    files = enumerate(files, start=1)
    file_lock = Lock()
    data = Queue(maxsize=workers)
    stopped = Event()

    def send(value):
        while not stopped.is_set():
            try:
                data.put(value, timeout=0.25)
                return True
            except Full:
                continue
        return False

    def read_files():
        while not stopped.is_set():
            with file_lock:
                item = next(files, None)
            if item is None:
                return
            index, file = item
            if index > settings.bulk_max_files:
                raise SingleFileError("The frozen search snapshot exceeds its configured file limit.")
            with open_file(file) as stream:
                for batch in _read_frozen_file(stream, batch_rows, footer_limit):
                    if batch.nbytes > size_limit:
                        raise SingleFileError("A frozen search batch exceeds its configured decoded byte limit.")
                    if not send(batch):
                        return
            if not send(None):
                return

    log.info("Reading the frozen search snapshot with %d concurrent file readers", workers)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        work = [pool.submit(read_files) for _ in range(workers)]
        checked_at = -float("inf")
        try:
            while work or not data.empty():
                now = monotonic()
                if now - checked_at >= 1:
                    guard()
                    bounds.check()
                    checked_at = now
                for future in work[:]:
                    if future.done():
                        future.result()
                        work.remove(future)
                if not work and data.empty():
                    break
                try:
                    yield data.get(timeout=0.25)
                except Empty:
                    continue
        finally:
            stopped.set()


def _stage_frozen(engine, snapshot_id, path, bounds, guard):
    files, rows, size = 0, 0, 0
    staged = []
    stage_limit = bounds.settings.prepared_carry_mb * MIB // 4
    with (closing(_base_batches(engine.lake, snapshot_id, bounds, guard)) as batches,
          pq.ParquetWriter(path, SINGLE_FILE_SCHEMA, compression="zstd") as writer):
        for batch in batches:
            if batch is None:
                files += 1
                if files % PROGRESS_FILES == 0:
                    log.info("Read %s frozen search files and %s narrow rows", files, rows)
                continue
            if staged and size + batch.nbytes > stage_limit:
                writer.write_table(pa.Table.from_batches(staged), row_group_size=bounds.batch_rows)
                staged.clear()
                size = 0
            staged.append(batch.cast(SINGLE_FILE_SCHEMA))
            size += batch.nbytes
            rows += len(batch)
        if staged:
            writer.write_table(pa.Table.from_batches(staged), row_group_size=bounds.batch_rows)
    guard()
    bounds.check()
    log.info("Staged %s frozen narrow rows from %s search files", rows, files)
    return rows


def _verify(engine, base, fresh, bounds, guard):
    # Stage the immutable base to give both the sorter and the comparator one bounded input stream.
    log.info("Reading frozen partitioned search snapshot %s for exact comparison", base["search_snapshot_id"])
    path = bounds.root / "published.parquet"
    rows = _stage_frozen(engine, base["search_snapshot_id"], path, bounds, guard)
    log.info("Comparing %s frozen rows with the reloaded source", rows)
    _compare_files(path, fresh, bounds, guard)
    path.unlink()
    guard()


def _compare_files(path, fresh, bounds, guard):
    """Compare sealed projected inputs with a bounded external key sort."""
    with bounds.sorted_batches(path, KEY_ORDER) as expected, pq.ParquetFile(fresh) as source:
        fresh_batches = source.iter_batches(batch_size=bounds.batch_rows, use_threads=False)
        left, right = next(expected, None), next(fresh_batches, None)
        while left is not None and right is not None:
            bounds.check()
            length = min(len(left), len(right))
            expected_part = left.slice(0, length).cast(SINGLE_FILE_SCHEMA)
            fresh_part = right.slice(0, length)
            if not expected_part.equals(fresh_part):
                raise SingleFileError("The reloaded source differs from the published narrow search rows. "
                                      "Bring ordinary ingestion up to date and retry the comparison.")
            left = left.slice(length) if length < len(left) else next(expected, None)
            right = right.slice(length) if length < len(right) else next(fresh_batches, None)
        if left is not None or right is not None:
            raise SingleFileError("The reloaded source differs from the published narrow search row count.")
    guard()


def _iceberg_table(lake, guard):
    from pyiceberg.io.pyarrow import _pyarrow_to_schema_without_ids
    from pyiceberg.schema import assign_fresh_schema_ids
    from pyiceberg.table.sorting import SortField, SortOrder
    from pyiceberg.transforms import IdentityTransform

    schema = assign_fresh_schema_ids(_pyarrow_to_schema_without_ids(SINGLE_FILE_SCHEMA))
    sort = SortOrder(*(SortField(schema.find_field(name).field_id, IdentityTransform()) for name in SORT_ORDER))
    split_size = str(lake.settings.single_file_read_split_mb * MIB)
    split_key = "read.split.target-size"
    table = lake._load(TABLE_NAME)
    if table is None:
        guard()
        lake.catalog.create_namespace_if_not_exists(lake.namespace)
        table = lake.catalog.create_table_if_not_exists(
            lake._id(TABLE_NAME), schema, location=lake._location(TABLE_NAME), sort_order=sort,
            properties={
                **lake.properties,
                "commit.num-retries": "0",
                "write.metadata.metrics.column.h3_r15": "full",
                split_key: split_size,
            },
        )
    if (not table.spec().is_unpartitioned() or len(table.specs()) != 1 or table.schema().fields != schema.fields
            or table.sort_order().fields != sort.fields
            or table.properties.get("commit.num-retries") != "0"
            or table.properties.get("write.metadata.delete-after-commit.enabled", "false").lower() != "false"
            or (lake.warehouse and table.location().rstrip("/") != lake._location(TABLE_NAME))):
        raise SingleFileError("The owned single-file Iceberg table has incompatible metadata.")
    if table.properties.get(split_key) != split_size:
        guard()
        with table.transaction() as transaction:
            transaction.set_properties({split_key: split_size})
            guard()
    return table


def _write_sorted(fresh, output, schema, bounds):
    columns = pq.SortingColumn.from_ordering(schema, SORT_ORDER)
    group_rows = min(bounds.settings.single_file_row_group_rows, bounds.settings.batch_max_mb * MIB // 512)
    rows = 0
    with pq.ParquetWriter(output, schema, compression="zstd", sorting_columns=columns) as writer:
        with bounds.sorted_batches(fresh, SORT_ORDER, batch_rows=group_rows) as batches:
            for batch in batches:
                bounds.check()
                writer.write_batch(batch.cast(schema), row_group_size=group_rows)
                if (rows + len(batch)) // PROGRESS_ROWS > rows // PROGRESS_ROWS:
                    log.info("Wrote %s rows into the globally sorted Parquet file", rows + len(batch))
                rows += len(batch)
    bounds.check(force_inventory=True)
    with output.open("rb") as stream:
        stream.seek(-8, 2)
        tail = stream.read(8)
    if tail[4:] != b"PAR1" or int.from_bytes(tail[:4], "little") > bounds.settings.bulk_max_footer_mb * MIB:
        raise SingleFileError("The single-file Parquet footer exceeded its configured byte limit.")
    return pq.read_metadata(output)


def _copy(path, target, bounds, guard):
    with path.open("rb") as source:
        for part, block in enumerate(iter(lambda: source.read(MIB), b"")):
            if part % 64 == 0:
                bounds.check()
                guard()
            target.write(block)
    guard()


def _commit_local(lake, path, operation_id, rows, bounds, guard):
    directory = lake._directory(TABLE_NAME) / "data"
    directory.mkdir(parents=True, exist_ok=True)
    if disk_usage(directory).free < path.stat().st_size + bounds.settings.bulk_disk_reserve_mb * MIB:
        raise SingleFileError("The local lake lacks free disk space for the single-file snapshot.")
    target = directory / f"{operation_id}.parquet"
    with target.open("xb") as stream:
        _copy(path, stream, bounds, guard)
    return lake._commit(TABLE_NAME, [{"file": target.name, "table_id": None, "cell": None, "count": rows}], operation_id)


def _commit_iceberg(lake, table, path, metadata, operation_id, bounds, guard):
    from pyiceberg.io.pyarrow import (
        compute_statistics_plan, data_file_statistics_from_parquet_metadata, parquet_path_to_id_mapping,
    )
    from pyiceberg.manifest import DataFile, DataFileContent, FileFormat
    from pyiceberg.typedef import Record

    from .offsets import without_offsets

    size = path.stat().st_size
    uri = f"{table.location().rstrip('/')}/data/{operation_id}.parquet"
    # Table IO streams the completed Arrow file to a unique object independent of the catalog transaction.
    if urlsplit(uri).scheme in ("", "file") and disk_usage(path.parent).free < size + bounds.settings.bulk_disk_reserve_mb * MIB:
        raise SingleFileError("The local Iceberg lake lacks free disk space for the single-file snapshot.")
    with table.io.new_output(uri).create(overwrite=False) as stream:
        _copy(path, stream, bounds, guard)
    if len(table.io.new_input(uri)) != size:
        raise SingleFileError("The uploaded single-file object differs from its staged size.")
    statistics = data_file_statistics_from_parquet_metadata(
        metadata, compute_statistics_plan(table.schema(), table.properties), parquet_path_to_id_mapping(table.schema()),
    ).to_serialized_dict()
    file = DataFile.from_args(
        content=DataFileContent.DATA, file_path=uri, file_format=FileFormat.PARQUET, partition=Record(),
        file_size_in_bytes=size, sort_order_id=table.sort_order().order_id,
        equality_ids=None, key_metadata=None, **statistics,
    )
    file.spec_id = table.spec().spec_id
    # Let the scan planner size splits independently of the Parquet row groups.
    file = without_offsets(file)
    previous = table.current_snapshot()
    guard()
    with table.transaction() as transaction:
        with transaction.update_snapshot(snapshot_properties={"h3search.single-file-id": operation_id}).overwrite() as update:
            if previous is not None:
                existing = iter(lake._data_files(table, previous))
                old_file = next(existing, None)
                if old_file is None or next(existing, None) is not None:
                    raise SingleFileError("The current single-file Iceberg snapshot does not own exactly one data file.")
                update.delete_data_file(old_file)
            update.append_data_file(file)
            guard()
        guard()
    table.refresh()
    committed = table.current_snapshot()
    if committed is None or committed.summary.get("h3search.single-file-id") != operation_id:
        raise SingleFileError("The single-file Iceberg commit could not be verified.")
    active = iter(lake._data_files(table, committed))
    actual = next(active, None)
    if (actual is None or actual.file_path != uri or actual.record_count != metadata.num_rows
            or next(active, None) is not None):
        raise SingleFileError("The committed single-file Iceberg snapshot differs from its verified file.")
    return committed.snapshot_id


def build_single_file(engine):
    """Reload and exclusively publish a verified one-file alternative to the current search snapshot."""
    registry = engine.registry
    with registry.writer_lease() as guard:
        guard = guard or (lambda: None)
        guard()
        if engine._pending() or registry.bulk_activation() or registry.bulk_preparations():
            raise ConflictError("Resolve pending ETL and bulk work before building the single-file search index.")
        base = registry.current_publication()
        if base and base.get("layout_version") == 2:
            raise ConflictError("Use load --lookup single-file or both to refresh isolated lookup generations.")
        if not base or not base.get("counts"):
            raise SingleFileError("Publish a SQL Server dataset before building the single-file search index.")
        datasets = tuple(_published_inputs(engine, base))
        operation_id = new_id()
        engine.stage.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(prefix="single-file-", dir=engine.stage) as directory:
            root = Path(directory)
            bounds = ResourceBounds(engine, root)
            fresh = root / "fresh.parquet"
            output = root / "ordered.parquet"
            _stage_fresh(engine, datasets, fresh, bounds, guard)
            _verify(engine, base, fresh, bounds, guard)
            log.info("Sorting the verified narrow rows globally by H3 resolution 15 and record key")
            lake = engine.lake
            if isinstance(lake, LocalLake):
                table, schema = None, SINGLE_FILE_SCHEMA
            else:
                from pyiceberg.io.pyarrow import schema_to_pyarrow

                table = _iceberg_table(lake, guard)
                schema = schema_to_pyarrow(table.schema())
            metadata = _write_sorted(fresh, output, schema, bounds)
            if metadata.num_rows != sum(base["counts"].values()):
                raise SingleFileError("The globally sorted file differs from the published row count.")
            log.info("Committing %s bytes of verified single-file data", output.stat().st_size)
            if table is None:
                snapshot_id = _commit_local(lake, output, operation_id, metadata.num_rows, bounds, guard)
            else:
                snapshot_id = _commit_iceberg(lake, table, output, metadata, operation_id, bounds, guard)
            publication = {
                **base, "id": operation_id, "created_at": utc_now(), "base_publication_id": base["id"],
                "search_snapshot_id": snapshot_id, "search_table_name": TABLE_NAME,
            }
            guard()
            if not registry.set_single_file_publication(publication, base["id"]):
                raise ConflictError("The base publication changed before the single-file index could be published.")
            log.info("Published one-file search snapshot %s with %s rows", snapshot_id, metadata.num_rows)
            return publication


def discard_single_file(engine, guard):
    """Invalidate readers and reclaim all comparison snapshots during dataset removal."""
    lake, registry = engine.lake, engine.registry
    with registry.write_lease():
        guard()
        with registry.connect() as conn:
            registry.clear_single_file_publication(conn)
        guard()
        if isinstance(lake, LocalLake):
            directory = lake._directory(TABLE_NAME)
            if directory.exists():
                if directory.resolve() != lake.root.resolve() / TABLE_NAME:
                    raise SingleFileError("The comparison directory is outside its owned local lake path.")
                rmtree(directory)
            return
        from pyiceberg.exceptions import NoSuchTableError

        if not lake.warehouse:
            table = lake._load(TABLE_NAME)
            if table is not None:
                lake.catalog.purge_table(lake._id(TABLE_NAME))
            return
        location = lake.location(TABLE_NAME)
        try:
            lake.catalog.drop_table(lake._id(TABLE_NAME))
        except NoSuchTableError:
            pass
        lake._purge_prefix(location)
