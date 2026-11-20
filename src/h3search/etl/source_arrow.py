"""Optional bounded native rowsets for explicitly frozen initial SQL scans."""

from dataclasses import dataclass
import logging
import math

import pyarrow as pa
import pyarrow.compute as pc
from h3ronpy.vector import coordinates_to_cells

from .source import connection_string


log = logging.getLogger(__name__)


class NativeReadFallback(Exception):
    """The ordinary reader must retry the unchanged key interval."""


@dataclass
class PreparedSourceBatch:
    wide: pa.Table
    keys: list[int]
    rejects: list[tuple[int, str]]
    cursor: int | None
    rows: int


def _schema(layout):
    types = [column.type for column in layout.columns]
    if layout.derived_geometry:
        types.extend((pa.float64(), pa.float64()))
    return pa.schema([pa.field(f"c{i}", kind) for i, kind in enumerate(types)])


def _read(source, settings, dataset, after, cutoff, rows, byte_limit):
    try:
        import arrow_odbc
    except ImportError as error:
        raise NativeReadFallback("optional_dependency") from error
    # arrow-odbc binds parameters as VARCHAR; SQL Server requires an integer TOP.
    sql = f"SELECT TOP (CAST(? AS BIGINT)) {source._selected()} FROM {source.table} WHERE "
    parameters = [str(rows)]
    if after is not None:
        sql += f"{source.key}>? AND "
        parameters.append(str(after))
    sql += f"{source.key}<=? ORDER BY {source.key}"
    parameters.append(str(cutoff))
    schema = _schema(source.layout)
    batches, decoded, count = [], 0, 0
    profile = settings.connections[dataset["connection_name"]]
    reader = arrow_odbc.read_arrow_batches_from_odbc(
        sql, connection_string(profile),
        batch_size=min(rows, settings.prepared_read_batch_rows), parameters=parameters,
        max_bytes_per_batch=min(byte_limit, settings.initial_native_buffer_mb * 1048576),
        max_text_size=settings.initial_native_text_units,
        max_binary_size=settings.initial_native_binary_bytes,
        falliable_allocations=True, fetch_concurrently=False,
        login_timeout_sec=int(profile.get("login_timeout_sec", 15)),
        query_timeout_sec=max(1, math.ceil(profile.get("query_timeout_sec", settings.query_timeout_sec))),
        payload_text_encoding=arrow_odbc.TextEncoding.UTF16,
    )
    # Closing the Arrow reader also releases the native cursor/connection on error.
    with reader.into_pyarrow_record_batch_reader() as stream:
        for batch in stream:
            if batch.num_columns != len(schema):
                raise NativeReadFallback("column_count")
            for actual, expected in zip(batch.schema, schema, strict=True):
                # Decimal/float conversions must never silently round source values.
                if actual.type != expected.type and not (
                    pa.types.is_integer(actual.type) and pa.types.is_integer(expected.type)
                    and actual.type.bit_width <= expected.type.bit_width
                ):
                    raise NativeReadFallback("column_type")
            batch = batch.rename_columns(schema.names).cast(schema, safe=True)
            count += len(batch)
            decoded += batch.nbytes
            if count > rows or decoded > byte_limit:
                raise NativeReadFallback("decoded_budget")
            batches.append(batch)
    return pa.Table.from_batches(batches, schema=schema)


def _prepare(table_id, layout, table, after, cutoff):
    keys = table.column(layout.key).cast(pa.int64(), safe=True).combine_chunks()
    if keys.null_count:
        raise NativeReadFallback("null_key")
    if len(keys):
        if (after is not None and keys[0].as_py() <= after) or keys[-1].as_py() > cutoff:
            raise NativeReadFallback("key_range")
        if len(keys) > 1 and not pc.all(pc.greater(keys.slice(1), keys.slice(0, len(keys) - 1))).as_py():
            raise NativeReadFallback("key_order")
    for index in (layout.lat, layout.lon):
        kind = table.column(index).type
        if not (pa.types.is_floating(kind) or pa.types.is_integer(kind) or pa.types.is_boolean(kind)):
            # Python float(Decimal/text) need not match an Arrow cast bit for bit.
            raise NativeReadFallback("coordinate_conversion")
    lat = table.column(layout.lat).cast(pa.float64(), safe=True).combine_chunks()
    lon = table.column(layout.lon).cast(pa.float64(), safe=True).combine_chunks()
    present = pc.and_(pc.is_valid(lat), pc.is_valid(lon))
    finite = pc.fill_null(pc.and_(pc.is_finite(lat), pc.is_finite(lon)), False)
    ranged = pc.fill_null(pc.and_(pc.and_(pc.greater_equal(lat, -90), pc.less_equal(lat, 90)),
                                 pc.and_(pc.greater_equal(lon, -180), pc.less_equal(lon, 180))), False)
    valid = pc.and_(present, pc.and_(finite, ranged))
    selected = pc.indices_nonzero(valid)
    good_lat, good_lon = pc.take(lat, selected), pc.take(lon, selected)
    arrays = [pa.repeat(pa.scalar(table_id), len(selected)), pc.take(keys, selected), good_lat, good_lon]
    arrays.extend(pa.array(coordinates_to_cells(good_lat, good_lon, resolution)).cast(pa.int64())
                  for resolution in range(16))
    arrays.extend(pc.take(table.column(index), selected) for index in range(len(layout.columns)))
    wide = pa.Table.from_arrays(arrays, schema=layout.schema)
    bad = pc.indices_nonzero(pc.invert(valid)).to_pylist()
    rejects = [(keys[index].as_py(), "missing or nonnumeric coordinates" if not present[index].as_py()
                else "nonfinite coordinates" if not finite[index].as_py() else "out-of-range coordinates")
               for index in bad]
    return PreparedSourceBatch(wide, keys.to_pylist(), rejects, keys[-1].as_py() if len(keys) else after, len(keys))


def frozen_base(source, settings, dataset, after, cutoff, rows, byte_limit):
    """Prepare a native batch, or return None to retry through ordinary ODBC.

    The caller must have persisted the frozen cutoff and pre-scan CDC baseline,
    validate source metadata around this call, and journal only sealed outputs.
    No native failure advances the caller's durable cursor.
    """
    try:
        if cutoff is None:
            return _prepare(dataset["id"], source.layout, _schema(source.layout).empty_table(), after, cutoff)
        table = _read(source, settings, dataset, after, cutoff, rows, byte_limit)
        return _prepare(dataset["id"], source.layout, table, after, cutoff)
    except MemoryError:
        raise
    except Exception as error:
        # Native errors can contain SQL diagnostics. Log only their type.
        log.info("Native initial source reader yielded to ordinary ODBC (%s).", type(error).__name__)
        return None
