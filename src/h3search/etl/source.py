"""Bounded source readers for SQL Server and explicitly imported Parquet."""

from contextlib import contextmanager
import os
from pathlib import Path
from sys import getsizeof
from time import monotonic, sleep

import pyarrow as pa
import pyarrow.parquet as pq

from .layout import Column, SourceLayout, make_layout


class ReloadRequired(RuntimeError):
    """The registered dataset must be removed and loaded again."""


class CapturePending(RuntimeError):
    """The CDC capture reader has yet to cross a required time boundary."""


def quote(name):
    """Quote one SQL Server identifier without accepting qualified SQL fragments."""
    if not isinstance(name, str) or not name or len(name) > 128 or "\x00" in name:
        raise ValueError("Invalid SQL Server identifier.")
    return "[" + name.replace("]", "]]") + "]"


def connection_string(config, environ=None):
    """Build a native ODBC connection string from configured options and secret references."""
    environ = os.environ if environ is None else environ
    raw = config.get("odbc_env") or config.get("connection_string_env")
    if raw:
        value = environ.get(raw)
        if not value:
            raise ValueError("Set the configured SQL Server ODBC connection environment variable.")
        return value
    server, database = config.get("server"), config.get("database")
    if not server or not database:
        raise ValueError("Set the configured SQL Server server and database or an ODBC environment reference.")

    def flag(name, default):
        value = config.get(name, default)
        if not isinstance(value, bool):
            raise ValueError(f"The SQL Server {name} setting must be a Boolean.")
        return value

    def encoded(value):
        if not isinstance(value, str) or not value or "\x00" in value:
            raise ValueError("The configured SQL Server connection contains an invalid option.")
        return "{" + value.replace("}", "}}") + "}"

    options = {
        "DRIVER": encoded(config.get("driver", "ODBC Driver 18 for SQL Server")),
        "SERVER": encoded(server), "DATABASE": encoded(database),
        "Encrypt": "yes" if flag("encrypt", True) else "no",
        "TrustServerCertificate": "yes" if flag("trust_server_certificate", False) else "no",
    }
    trusted = flag("trusted_connection", not (config.get("username") or config.get("username_env")))
    if trusted:
        options["Trusted_Connection"] = "yes"
    else:
        username = config.get("username") or environ.get(config.get("username_env", ""))
        password = environ.get(config.get("password_env", ""))
        if not username or not password:
            raise ValueError("Set the configured SQL Server username and password environment reference.")
        options.update(UID=encoded(username), PWD=encoded(password))
    return ";".join(f"{key}={value}" for key, value in options.items())


def _column(row):
    ordinal, name, base, user_type, length, precision, scale, nullable, collation, computed = row
    scalar = {
        "bigint": pa.int64(), "int": pa.int32(), "smallint": pa.int32(), "tinyint": pa.int32(),
        "bit": pa.bool_(), "real": pa.float32(), "float": pa.float64(),
        "binary": pa.binary(), "varbinary": pa.binary(), "image": pa.binary(),
        "timestamp": pa.binary(), "rowversion": pa.binary(), "geometry": pa.binary(), "geography": pa.binary(),
        "date": pa.date32(),
    }
    string_types = {
        "char", "nchar", "varchar", "nvarchar", "text", "ntext", "xml", "uniqueidentifier",
        "datetime", "datetime2", "datetimeoffset", "smalldatetime", "time",
    }
    if base in scalar:
        arrow_type = scalar[base]
    elif base in string_types:
        arrow_type = pa.string()
    elif base in ("decimal", "numeric", "money", "smallmoney"):
        arrow_type = pa.decimal128(precision, scale)
    else:
        raise ValueError(f"Unsupported SQL Server type for column {name!r}: {user_type}.")
    declaration = user_type
    if base in ("decimal", "numeric"):
        declaration += f"({precision},{scale})"
    elif base in ("datetime2", "datetimeoffset", "time"):
        declaration += f"({scale})"
    elif base in ("char", "nchar", "varchar", "nvarchar", "binary", "varbinary"):
        width = length // 2 if base.startswith("n") else length
        declaration += f"({'max' if length == -1 else width})"
    identity = (ordinal, base, user_type, length, precision, scale, collation, bool(computed))
    return Column(name, declaration, arrow_type, bool(nullable), identity)


def _row_bytes(row):
    return getsizeof(row) + sum(getsizeof(value) for value in row) + 384


def _bounded(cursor, rows, byte_limit):
    collected = []
    size = 0
    for _ in range(rows):
        row = cursor.fetchone()
        if row is None:
            break
        values = tuple(row)
        size += _row_bytes(values)
        if size > byte_limit:
            if not collected:
                raise ValueError("A source row exceeds the configured transformation batch byte budget.")
            break
        collected.append(values)
    return collected


class SqlServerSource:
    """Read fixed key and CDC intervals through native SQL Server ODBC."""

    def __init__(self, connection, dataset, wait_seconds=60):
        self.connection = connection
        self.dataset = dataset
        self.wait_seconds = wait_seconds
        self.table = f"{quote(dataset['source_schema'])}.{quote(dataset['source_table'])}"
        self.key = quote(dataset["object_id_column"])
        self.capture = dataset.get("capture_instance")
        self._layout = self._read_layout()

    @property
    def layout(self):
        """Return metadata read independently of source row count."""
        return self._layout

    def _execute(self, sql, params=()):
        cursor = self.connection.cursor()
        try:
            return cursor.execute(sql, params)
        except BaseException:
            cursor.close()
            raise

    @contextmanager
    def _query(self, sql, params=()):
        cursor = self._execute(sql, params)
        try:
            yield cursor
        finally:
            cursor.close()

    def _one(self, sql, params=()):
        with self._query(sql, params) as cursor:
            return cursor.fetchone()

    def _read_layout(self):
        source = self._one(
            """
            SELECT t.object_id, CONVERT(varchar(40),t.create_date,126)
            FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id
            WHERE s.name=? AND t.name=?
            """,
            (self.dataset["source_schema"], self.dataset["source_table"]),
        )
        if not source:
            raise ValueError("The source table does not exist or its metadata is inaccessible.")
        object_id, created = source
        with self._query(
            """
            SELECT c.column_id,c.name,COALESCE(b.name,u.name),u.name,c.max_length,c.precision,c.scale,
                   c.is_nullable,c.collation_name,c.is_computed
            FROM sys.columns c
            JOIN sys.types u ON u.user_type_id=c.user_type_id
            LEFT JOIN sys.types b ON b.user_type_id=c.system_type_id AND b.system_type_id=c.system_type_id
            WHERE c.object_id=? ORDER BY c.column_id
            """, (object_id,)
        ) as cursor:
            columns = tuple(_column(row) for row in cursor.fetchall())
        unique = self._one(
            """
            SELECT 1 FROM sys.indexes i
            JOIN sys.index_columns k ON k.object_id=i.object_id AND k.index_id=i.index_id
            JOIN sys.columns c ON c.object_id=k.object_id AND c.column_id=k.column_id
            WHERE i.object_id=? AND c.name=? AND i.is_unique=1 AND i.has_filter=0 AND
                i.is_disabled=0 AND i.is_hypothetical=0 AND c.is_nullable=0 AND k.key_ordinal=1 AND
                NOT EXISTS (SELECT 1 FROM sys.index_columns x WHERE x.object_id=i.object_id
                            AND x.index_id=i.index_id AND x.key_ordinal>1)
            """, (object_id, self.dataset["object_id_column"])
        )
        if not unique:
            raise ValueError("The source OBJECTID requires a nonnullable single-column unique index.")
        identity = (object_id, created)
        if self.dataset["mode"] == "cdc":
            identity += self._check_capture(object_id, columns)
        return make_layout(self.dataset, columns, identity)

    def _check_capture(self, object_id, columns):
        if not self.capture:
            raise ValueError("CDC requires the existing SQL Server capture instance name.")
        self.change_table = f"[cdc].{quote(self.capture + '_CT')}"
        capture = self._one(
            """
            SELECT object_id, CONVERT(varchar(40),create_date,126) FROM cdc.change_tables
            WHERE source_object_id=? AND capture_instance=?
            """, (object_id, self.capture)
        )
        if not capture:
            raise ValueError("The configured CDC capture instance does not track this source table.")
        with self._query(
            "SELECT column_name FROM cdc.captured_columns WHERE object_id=?", (capture[0],)
        ) as cursor:
            captured = {row[0] for row in cursor.fetchall()}
        if captured != {column.name for column in columns}:
            raise ReloadRequired("CDC must capture every source column. Remove and reload after configuring capture.")
        if any(column.identity[-1] or column.identity[1] in ("image", "text", "ntext", "timestamp", "rowversion") for column in columns):
            raise ValueError("CDC cannot faithfully reconstruct computed, legacy LOB, or rowversion columns.")
        if not self._one("SELECT COL_LENGTH(?, '__$command_id')", (self.change_table,))[0]:
            raise ValueError("The CDC change table must expose SQL Server's command-order column.")
        return tuple(capture)

    def validate_layout(self):
        """Read the current schema and CDC capture fingerprint independently of row reads."""
        return self._read_layout().fingerprint

    def _selected(self):
        result = []
        for column in self.layout.columns:
            name = quote(column.name)
            if column.identity[1] in {"datetime", "datetime2", "datetimeoffset", "smalldatetime", "time"}:
                name = f"CONVERT(varchar(48), {name}, 126)"
            elif column.identity[1] in {"xml", "uniqueidentifier", "ntext"}:
                name = f"CONVERT(nvarchar(max), {name})"
            elif column.identity[1] in ("geometry", "geography"):
                name = f"{name}.STAsBinary()"
            result.append(name)
        if self.layout.derived_geometry:
            result.extend(self._coordinate_expressions())
        return ", ".join(result)

    def _coordinate_expressions(self):
        if self.layout.derived_geometry:
            result = []
            source = self.dataset["geometry_column"]
            name = quote(source)
            geometry_column = next(column for column in self.layout.columns if column.name == source)
            geometry = f"geometry::STGeomFromWKB({name}.STAsBinary(),4326)" if geometry_column.identity[1] == "geography" else name
            valid = f"{name} IS NOT NULL AND {name}.STSrid = 4326 AND {name}.STIsValid() = 1"
            for axis in ("STY", "STX"):
                result.append(
                    f"CASE WHEN {valid} AND {name}.STGeometryType() = 'Point' THEN {geometry}.{axis} "
                    f"WHEN {valid} THEN {geometry}.STCentroid().{axis} END"
                )
            return result
        return [quote(self.layout.columns[index].name) for index in (self.layout.lat, self.layout.lon)]

    @property
    def lookup_layout(self):
        """Projection layout for rebuilding lookup values without copying wide payloads."""
        columns = (
            self.layout.columns[self.layout.key],
            Column("latitude", "float", pa.float64()),
            Column("longitude", "float", pa.float64()),
        )
        return SourceLayout(columns, 0, 1, 2)

    def read_lookup_base(self, after, cutoff, rows, bytes_limit):
        """Read only keys and coordinates over a fixed, bounded source interval."""
        if cutoff is None:
            return [], after
        lower = f"{self.key}>? AND " if after is not None else ""
        params = (rows, after, cutoff) if after is not None else (rows, cutoff)
        projection = ", ".join([self.key, *self._coordinate_expressions()])
        with self._query(
            f"SELECT TOP (?) {projection} FROM {self.table} "
            f"WHERE {lower}{self.key}<=? ORDER BY {self.key}", params,
        ) as cursor:
            page = _bounded(cursor, rows, bytes_limit)
        return [(2, row) for row in page], page[-1][0] if page else after

    def cutoff(self):
        """Capture the greatest ID visible when this key interval begins."""
        return self._one(f"SELECT MAX({self.key}) FROM {self.table}")[0]

    def read_base(self, after, cutoff, rows, bytes_limit):
        """Fetch an ordered bounded slice of the fixed base key interval."""
        if cutoff is None:
            return [], after
        lower = f"{self.key}>? AND " if after is not None else ""
        params = (rows, after, cutoff) if after is not None else (rows, cutoff)
        with self._query(
            f"SELECT TOP (?) {self._selected()} FROM {self.table} "
            f"WHERE {lower}{self.key}<=? ORDER BY {self.key}", params
        ) as cursor:
            page = _bounded(cursor, rows, bytes_limit)
        return [(2, row) for row in page], page[-1][self.layout.key] if page else after

    def max_lsn(self):
        """Return the current database CDC high-water mark."""
        result = self._one("SELECT sys.fn_cdc_get_max_lsn()")[0]
        if not result or not any(result):
            raise CapturePending("Wait for SQL Server CDC capture to initialize.")
        return bytes(result).hex()

    def scan_marker(self):
        """Record SQL Server time after the fixed-key scan has completed."""
        return self._one("SELECT CONVERT(varchar(40),GETDATE(),126)")[0]

    def fence(self, marker):
        """Wait for capture to pass the base scan, then freeze its replay cutoff."""
        deadline = monotonic() + self.wait_seconds
        while True:
            lsn = self._one(
                "SELECT sys.fn_cdc_map_time_to_lsn('smallest greater than', CONVERT(datetime,?,126))",
                (marker,),
            )[0]
            if lsn and any(lsn):
                return self.max_lsn()
            if monotonic() >= deadline:
                raise CapturePending("SQL Server CDC has not crossed the initial scan marker. Retry when capture catches up.")
            sleep(min(1.0, max(0.0, deadline - monotonic())))

    def _validate_range(self, baseline, high):
        minimum, start, maximum = self._one(
            "SELECT sys.fn_cdc_get_min_lsn(?),sys.fn_cdc_increment_lsn(?),sys.fn_cdc_get_max_lsn()",
            (self.capture, bytes.fromhex(baseline)),
        )
        if not minimum or not any(minimum) or not start or not maximum or start < minimum or maximum < bytes.fromhex(high):
            raise ReloadRequired("CDC history is no longer available for this checkpoint. Remove and reload the dataset.")

    def read_changes(self, baseline, high, after, rows, bytes_limit):
        """Fetch all ordered CDC operations, preserving before and after images."""
        self._validate_range(baseline, high)
        if baseline == high:
            return [], after
        keys = tuple(f"changes.{name}" for name in (
            "[__$start_lsn]", "[__$command_id]", "[__$seqval]", "[__$operation]", self.key,
        ))
        order = ", ".join(keys)
        params = [rows, bytes.fromhex(baseline), bytes.fromhex(high)]
        lower = ""
        if after is not None:
            values = (bytes.fromhex(after[0]), after[1], bytes.fromhex(after[2]), after[3], after[4])
            alternatives = []
            for index, key in enumerate(keys):
                alternatives.append("(" + " AND ".join(
                    [f"{prior}=?" for prior in keys[:index]] + [f"{key}>?"]
                ) + ")")
                params.extend(values[:index+1])
            lower = " AND (" + " OR ".join(alternatives) + ")"
        with self._query(
            f"SELECT TOP (?) {order}, {self._selected()} FROM {self.change_table} AS changes "
            f"WHERE {keys[0]}>? AND {keys[0]}<=?{lower} ORDER BY {order}", tuple(params),
        ) as cursor:
            page = _bounded(cursor, rows, bytes_limit)
        # Recheck after fetching so cleanup during the query cannot silently skip work.
        self._validate_range(baseline, high)
        if not page:
            return [], after
        lsn, command, sequence, operation, key = page[-1][:5]
        next_key = [bytes(lsn).hex(), command, bytes(sequence).hex(), operation, key]
        if any(row[1] is None or row[3] not in (1, 2, 3, 4) or row[4] is None for row in page):
            raise ReloadRequired("CDC produced an unsupported operation or missing OBJECTID. Remove and reload.")
        return [(row[3], row[5:]) for row in page], next_key

    def close(self):
        """Close the source connection."""
        self.connection.close()


def _parquet_column(field):
    source = field.type
    if pa.types.is_integer(source):
        destination = pa.int64() if source.bit_width == 64 or source == pa.uint32() else pa.int32()
    elif pa.types.is_date(source):
        destination = pa.date32()
    elif pa.types.is_timestamp(source) and source.unit != "ns":
        destination = pa.timestamp("us", "UTC" if source.tz else None)
    elif pa.types.is_time(source) and source.unit != "ns":
        destination = pa.time64("us")
    elif pa.types.is_float16(source):
        destination = pa.float32()
    elif (
        pa.types.is_boolean(source) or pa.types.is_floating(source)
        or pa.types.is_string(source) or pa.types.is_large_string(source)
        or pa.types.is_binary(source) or pa.types.is_large_binary(source) or pa.types.is_fixed_size_binary(source)
        or (pa.types.is_decimal128(source) and 0 <= source.scale <= source.precision)
    ):
        destination = source
    else:
        raise ValueError(f"Unsupported Parquet type for column {field.name!r}: {source}.")
    return Column(field.name, str(source), destination, field.nullable)


class ParquetSource:
    """Read an explicitly supplied, immutable Parquet fixture ordered by OBJECTID."""

    def __init__(self, path, dataset):
        self.path = Path(path).resolve(strict=True)
        self.file = pq.ParquetFile(self.path)
        columns = tuple(_parquet_column(field) for field in self.file.schema_arrow)
        info = self.path.stat()
        self.layout = make_layout(dataset, columns, (str(self.path), info.st_size, info.st_mtime_ns))
        self._iterator = None
        self._next = None

    def validate_layout(self):
        """Detect edits or replacement of the immutable Parquet input."""
        info = self.path.stat()
        if (str(self.path), info.st_size, info.st_mtime_ns) != self.layout.identity:
            raise ReloadRequired("The Parquet input changed. Remove and reload the dataset.")
        return self.layout.fingerprint

    def cutoff(self):
        """Freeze the number of source rows exposed by the fixture."""
        return self.file.metadata.num_rows

    def read_base(self, after, cutoff, rows, bytes_limit):
        """Stream the next bounded rows with a durable ordinal resume point."""
        offset, previous = after or (0, None)
        if offset >= cutoff:
            return [], after
        if self._iterator is None:
            self._iterator = self._rows(rows, offset)
        changes = []
        size = 0
        for _ in range(min(rows, cutoff - offset)):
            if self._next is None:
                self._next = next(self._iterator)
            values = self._next
            size += _row_bytes(values)
            if size > bytes_limit:
                if not changes:
                    raise ValueError("A Parquet row exceeds the configured transformation batch byte budget.")
                break
            key = values[self.layout.key]
            if key is None or (previous is not None and key <= previous):
                raise ValueError("Parquet rows must be sorted by strictly increasing nonnull OBJECTID.")
            previous = key
            self._next = None
            changes.append((2, values))
        return changes, [offset + len(changes), previous]

    def _rows(self, rows, offset):
        start = 0
        for index in range(self.file.num_row_groups):
            count = self.file.metadata.row_group(index).num_rows
            if start + count <= offset:
                start += count
                continue
            for batch in self.file.iter_batches(batch_size=min(rows, 1024), row_groups=[index]):
                skip = min(len(batch), max(0, offset - start))
                start += len(batch)
                for row in batch.slice(skip).to_pylist():
                    yield tuple(row.values())

    def close(self):
        """Release the Parquet input."""
        self.file.close()
