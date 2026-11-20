"""Exact bounded key validation without a cardinality-sized hash aggregate."""

from time import monotonic

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq


KEYS = ("table_id", "object_id")
FAILURE = "Prepared table identities differ from their canonical staged records or contain duplicate record identities."


def _parquet(path, bounds, guard):
    guard()
    bounds.check()
    with open(path, "rb") as stream:
        stream.seek(-8, 2)
        tail = stream.read(8)
    if tail[4:] != b"PAR1" or int.from_bytes(tail[:4], "little") > bounds.settings.bulk_max_footer_mb * 1048576:
        raise RuntimeError("A prepared identity input exceeds its Parquet footer bound.")
    return pq.ParquetFile(path)


def _dense_ranges(paths, bounds, guard):
    """Use conservative footer spans only when each row group names one source."""
    ranges = {}
    budget = min(bounds.settings.initial_search_sort_memory_mb * 1048576,
                 bounds.settings.prepared_carry_mb * 4 * 1048576, bounds.engine._memory_limit())
    for path in paths:
        with _parquet(path, bounds, guard) as source:
            names = source.schema_arrow.names
            if any(key not in names for key in KEYS):
                raise RuntimeError("A prepared identity input is missing its record keys.")
            for index in range(source.num_row_groups):
                group = source.metadata.row_group(index)
                if not group.num_rows:
                    continue
                table = group.column(names.index("table_id")).statistics
                key = group.column(names.index("object_id")).statistics
                if (table is None or key is None or not table.has_min_max or not key.has_min_max
                        or not isinstance(table.min, str) or table.min != table.max
                        or not isinstance(key.min, int) or not isinstance(key.max, int)):
                    return None
                low, high = ranges.get(table.min, (key.min, key.max))
                ranges[table.min] = min(low, key.min), max(high, key.max)
                # Two bitmaps plus a cardinality workspace, leaving room for decode.
                metadata_bytes = sum(1024 + 3 * len(source) for source in ranges)
                if metadata_bytes + 3 * sum((high - low) // 8 + 1 for low, high in ranges.values()) > budget * 3 // 4:
                    return None
    return ranges


def _batches(paths, bounds, guard):
    # A frozen writer's read window is an encoding contract, not a key-check limit.
    rows = max(1, min(bounds.settings.fetch_batch_rows, 65536,
                      bounds.engine._memory_limit() // 128))
    for path in paths:
        with _parquet(path, bounds, guard) as source:
            for batch in source.iter_batches(batch_size=rows, columns=list(KEYS), use_threads=False):
                guard()
                bounds.check()
                if batch.num_columns != 2 or any(column.null_count for column in batch.columns):
                    raise RuntimeError("Prepared record identities contain missing or null keys.")
                yield pa.Table.from_batches([batch])


def _dense_verify(expected, actual, ranges, bounds, guard):
    expected_bits = {key: np.zeros((high - low) // 8 + 1, np.uint8) for key, (low, high) in ranges.items()}
    actual_bits = {key: np.zeros_like(bits) for key, bits in expected_bits.items()}
    for paths, bitmaps in ((expected, expected_bits), (actual, actual_bits)):
        counts = dict.fromkeys(ranges, 0)
        for table in _batches(paths, bounds, guard):
            for source in pc.unique(table["table_id"]).to_pylist():
                if source not in ranges:
                    raise RuntimeError(FAILURE)
                keys = pc.filter(table["object_id"], pc.equal(table["table_id"], source)).cast(pa.int64()).to_numpy()
                low, high = ranges[source]
                if np.any(keys < low) or np.any(keys > high):
                    raise RuntimeError(FAILURE)
                offsets = keys - low
                # at() preserves repeated bytes; ordinary indexed |= loses updates.
                np.bitwise_or.at(bitmaps[source], offsets >> 3, np.left_shift(np.uint8(1), (offsets & 7).astype(np.uint8)))
                counts[source] += len(keys)
        for source, bitmap in bitmaps.items():
            guard()
            bounds.check()
            if int(np.bitwise_count(bitmap).sum(dtype=np.uint64)) != counts[source]:
                raise RuntimeError(FAILURE)
    if any(not np.array_equal(expected_bits[key], actual_bits[key]) for key in ranges):
        raise RuntimeError(FAILURE)


def _sorted_verify(expected, actual, bounds, guard, query_batches):
    """External sorting spills compact tagged keys; vector pairs prove exact counts."""
    schema = pa.schema([("table_id", pa.string()), ("object_id", pa.int64()), ("side", pa.int8())])
    branches, values = [], []
    for side, paths in enumerate((expected, actual)):
        if paths:
            branches.append(f"SELECT table_id,object_id,CAST({side} AS TINYINT) AS side FROM read_parquet(?)")
            values.append(paths)
    sql = "SELECT * FROM (" + " UNION ALL ".join(branches) + ") ORDER BY table_id,object_id,side"
    pending = None
    with query_batches(sql, values, schema, bounds, guard) as batches:
        for table in batches:
            if any(column.null_count for column in table.columns):
                raise RuntimeError("Prepared record identities contain null keys.")
            if pending is not None:
                table = pa.concat_tables([pending, table])
            even_rows = len(table) - len(table) % 2
            pending = table.slice(even_rows) if even_rows < len(table) else None
            if not even_rows:
                continue
            left = table.take(pa.array(np.arange(0, even_rows, 2, dtype=np.int64)))
            right = table.take(pa.array(np.arange(1, even_rows, 2, dtype=np.int64)))
            if (not left.select(KEYS).equals(right.select(KEYS))
                    or not pc.all(pc.equal(left["side"], 0)).as_py()
                    or not pc.all(pc.equal(right["side"], 1)).as_py()):
                raise RuntimeError(FAILURE)
    if pending is not None:
        raise RuntimeError(FAILURE)


def verify(expected, actual, bounds, guard, query_batches):
    deadline = monotonic() + bounds.settings.initial_search_sort_timeout_sec

    def check():
        guard()
        if monotonic() >= deadline:
            raise TimeoutError("Exact identity verification reached its configured time budget.")

    if not actual:
        for path in expected:
            with _parquet(path, bounds, check) as source:
                if source.metadata.num_rows:
                    raise RuntimeError(FAILURE)
        return
    ranges = _dense_ranges(expected, bounds, check)
    if ranges is not None:
        _dense_verify(expected, actual, ranges, bounds, check)
    else:
        _sorted_verify(expected, actual, bounds, check, query_batches)
