"""Durable narrow Parquet staging for the initial spatial load."""

from bisect import bisect_right
from hashlib import sha256
import os
from pathlib import Path
import shutil
from threading import Event, Thread
from time import monotonic
from uuid import UUID, uuid4

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from .layout import SEARCH_SCHEMA


MiB = 1024 * 1024
ROW_BUDGET = 256


class SortStopped(Exception):
    """The spatial sort yielded to a stop request."""


def owned_file(root, run_id, name):
    if Path(name).name != name or not name.startswith(f"{run_id}-") or not name.endswith(".parquet"):
        raise RuntimeError("A spatial staging path is outside the pending run.")
    path = root / name
    if path.is_symlink():
        raise RuntimeError("A spatial staging file is a symbolic link.")
    return path


def checksum(path, check=lambda: None):
    digest = sha256()
    with path.open("rb") as handle:
        while block := handle.read(MiB):
            check()
            digest.update(block)
    return digest.hexdigest()


def seal(path, rows, check=lambda: None):
    return {"file": path.name, "rows": rows, "sha256": checksum(path, check)}


def verify(root, run_id, entry, check=lambda: None, *, sorted_file=False):
    path = owned_file(root, run_id, entry["file"])
    if not path.is_file() or checksum(path, check) != entry["sha256"]:
        raise RuntimeError("A durable spatial staging file is missing or changed. Restore it before retrying.")
    with pq.ParquetFile(path) as parquet:
        schema = parquet.schema_arrow
        expected = SEARCH_SCHEMA
        if sorted_file:
            expected = pa.schema([field.with_nullable(True) for field in expected])
        if parquet.metadata.num_rows != entry["rows"] or schema != expected:
            raise RuntimeError("A spatial staging file has an unexpected schema or row count.")
    return path


def write_parquet(path, data, row_group_rows):
    temp = path.with_suffix(".tmp")
    with temp.open("xb") as handle:
        pq.write_table(data, handle, compression="zstd", row_group_size=row_group_rows)
        handle.flush()
        os.fsync(handle.fileno())
    temp.replace(path)


def sort_narrow(root, run, settings, memory_check, guard, stop_file):
    """Sort exactly the journaled inputs with bounded DuckDB memory and disk."""
    import duckdb

    deadline = monotonic() + settings.initial_search_sort_timeout_sec
    done = Event()
    failure = []

    def check():
        if stop_file is not None and stop_file.exists():
            raise SortStopped()
        if monotonic() >= deadline:
            raise TimeoutError("Initial search sort reached its time budget.")
        memory_check()

    guard()
    check()
    _clean_abandoned_sort(root, run, check)
    files = [verify(root, run["id"], item, check) for item in run["spatial_files"]]
    size = sum(path.stat().st_size for path in files)
    rows = sum(item["rows"] for item in run["spatial_files"])
    if rows != run["added"]:
        raise RuntimeError("Initial search spool rows differ from the pending base count.")
    if not rows:
        return None
    temp_budget = settings.initial_search_sort_temp_mb * MiB
    reserve = max(64 * MiB, size * 2)
    if shutil.disk_usage(root).free < temp_budget + reserve:
        raise OSError("Insufficient staging disk space for the initial search sort.")
    guard()
    check()
    output = root / f"{run['id']}-spatial-sorted-{uuid4()}.parquet"
    incomplete = output.with_suffix(".tmp")
    spill = root / f"{run['id']}-spatial-temp-{uuid4()}"
    spill.mkdir()
    completed = False
    try:
        with duckdb.connect(config={
            "memory_limit": f"{settings.initial_search_sort_memory_mb}MiB",
            "threads": settings.initial_search_sort_threads,
            "temp_directory": str(spill),
            "max_temp_directory_size": f"{settings.initial_search_sort_temp_mb}MiB",
        }) as connection:
            def monitor():
                while not done.wait(0.25):
                    try:
                        check()
                        if shutil.disk_usage(root).free < 64 * MiB:
                            raise OSError("The initial search sort reached its staging disk reserve.")
                    except Exception as error:
                        failure.append(error)
                        connection.interrupt()
                        return

            watchdog = Thread(target=monitor, daemon=True)
            watchdog.start()
            try:
                columns = ", ".join(SEARCH_SCHEMA.names)
                partition = f"h3_r{run['spatial_resolution']}"
                # DuckDB binds COPY's output path before the subquery parameters.
                connection.execute(
                    f"COPY (SELECT {columns} FROM read_parquet(?) ORDER BY {partition}, object_id) "
                    f"TO ? (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE {settings.initial_search_sort_row_group_rows})",
                    [str(incomplete), [str(path) for path in files]],
                )
            except duckdb.InterruptException:
                if failure:
                    raise failure[0]
                raise
            finally:
                done.set()
                watchdog.join()
        if failure:
            raise failure[0]
        check()
        with incomplete.open("r+b") as handle:
            os.fsync(handle.fileno())
        incomplete.replace(output)
        with pq.ParquetFile(output) as parquet:
            if (parquet.metadata.num_rows != rows or parquet.schema_arrow.names != SEARCH_SCHEMA.names
                    or parquet.schema_arrow.types != SEARCH_SCHEMA.types):
                raise RuntimeError("The sorted spatial spool differs from its input schema or count.")
        result = seal(output, rows, check)
        completed = True
        return result
    finally:
        clean_run_spill(root, run["id"], spill)
        if not completed:
            _clean_sort_file(root, incomplete)
            _clean_sort_file(root, output)


def _check_owned_path(root, path):
    if path.is_symlink() or path.is_junction() or path.resolve() != root.resolve() / path.name:
        raise RuntimeError("A spatial staging path is outside the pending run.")


def _clean_sort_file(root, path):
    _check_owned_path(root, path)
    path.unlink(missing_ok=True)


def clean_run_spill(root, run_id, path):
    """Reclaim only a directly owned sort spill directory."""
    prefix = f"{run_id}-spatial-temp-"
    if path.name.startswith(prefix):
        UUID(run_id)
        UUID(path.name.removeprefix(prefix))
        _check_owned_path(root, path)
        shutil.rmtree(path)


def _clean_abandoned_sort(root, run, check):
    run_id = str(UUID(run["id"]))
    protected = (run.get("spatial_sorted") or {}).get("file")
    for kind in ("sorted", "temp"):
        prefix = f"{run_id}-spatial-{kind}-"
        for path in root.glob(prefix + "*"):
            suffix = path.name.removeprefix(prefix)
            identity = Path(suffix).stem if kind == "sorted" else suffix
            try:
                if str(UUID(identity)) != identity:
                    continue
            except ValueError:
                continue
            check()
            if kind == "temp":
                clean_run_spill(root, run_id, path)
            elif path.suffix in {".tmp", ".parquet"} and path.name != protected:
                _clean_sort_file(root, path)


class SpatialReader:
    def __init__(self, root, run, check):
        self.path = verify(root, run["id"], run["spatial_sorted"], check, sorted_file=True)
        self.partition = f"h3_r{run['spatial_resolution']}"
        self.ends = [0]
        with pq.ParquetFile(self.path) as parquet:
            for index in range(parquet.metadata.num_row_groups):
                self.ends.append(self.ends[-1] + parquet.metadata.row_group(index).num_rows)

    def next(self, cursor, byte_limit):
        offset, last_cell, last_id = cursor
        if offset == self.ends[-1]:
            return None, cursor
        if not 0 <= offset < self.ends[-1] or byte_limit < ROW_BUDGET:
            raise RuntimeError("The spatial cursor or its available batch budget is invalid.")
        capacity = byte_limit // ROW_BUDGET
        remaining = min(capacity + 1, self.ends[-1] - offset)
        start_group = bisect_right(self.ends, offset) - 1
        stop_group = bisect_right(self.ends, offset + remaining - 1) - 1
        skip = offset - self.ends[start_group]
        batches = []
        with pq.ParquetFile(self.path) as parquet:
            for batch in parquet.iter_batches(batch_size=min(4096, capacity + 1),
                                              row_groups=range(start_group, stop_group + 1), use_threads=False):
                if skip >= len(batch):
                    skip -= len(batch)
                    continue
                batch = batch.slice(skip, min(len(batch) - skip, remaining))
                skip = 0
                batches.append(batch)
                remaining -= len(batch)
                if not remaining:
                    break
        data = pa.Table.from_batches(batches).cast(SEARCH_SCHEMA)
        cells, ids = data[self.partition], data["object_id"]
        if offset and (cells[0].as_py(), ids[0].as_py()) <= (last_cell, last_id):
            raise RuntimeError("The sorted spatial spool does not advance its cursor.")
        if len(data) > 1 and not pc.all(pc.or_(
            pc.greater(cells.slice(1), cells.slice(0, len(data) - 1)),
            pc.and_(pc.equal(cells.slice(1), cells.slice(0, len(data) - 1)),
                    pc.greater(ids.slice(1), ids.slice(0, len(data) - 1))),
        )).as_py():
            raise RuntimeError("The sorted spatial spool contains unordered or duplicate keys.")
        count = min(capacity, len(data))
        if len(data) > capacity:
            trailing = cells[capacity].as_py()
            if cells[count - 1].as_py() == trailing:
                first = pc.index(cells, trailing).as_py()
                if first > 0:
                    count = first
        return data.slice(0, count), [offset + count, cells[count - 1].as_py(), ids[count - 1].as_py()]
