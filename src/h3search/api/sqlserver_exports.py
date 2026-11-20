"""Bounded current SQL Server records for an exact frozen search selection."""

from contextlib import ExitStack, closing, contextmanager
import logging
import math
import time

from fastapi import HTTPException
import pyarrow as pa

from h3search.etl.source import SqlServerSource, _row_bytes, connection_string, quote

from .execution import Job
from .search import source_value

LOG = logging.getLogger(__name__)


class _Source(SqlServerSource):
    def __init__(self, connection, dataset, job):
        self.job = job
        super().__init__(connection, dataset)

    @contextmanager
    def _query(self, sql, params=()):
        with closing(self.connection.cursor()) as cursor:
            with self.job.query(cursor.cancel):
                cursor.execute(sql, params)
                self.job.check()
                yield cursor


def _projection(column):
    name = quote(column.name)
    kind = column.identity[1]
    if kind in {"datetime", "datetime2", "datetimeoffset", "smalldatetime", "time"}:
        return f"CONVERT(varchar(48),{name},126)"
    if kind in {"xml", "uniqueidentifier", "ntext"}:
        return f"CONVERT(nvarchar(max),{name})"
    if kind in {"geometry", "geography"}:
        return name + ".STAsBinary()"
    return name


class SqlServerExport:
    """Fetch current full rows, without changing frozen membership or coordinates."""

    def __init__(self, settings, registry, search, job, session):
        self.settings, self.registry, self.search = settings, registry, search
        self.job, self.session = job, session
        # The frozen lookup cursor remains open while SQL runs. Keep both
        # cancellers registered independently beneath the export watchdog.
        self.lookup_job, self.sql_job = Job(job.request_id), Job(job.request_id)
        for child in (self.lookup_job, self.sql_job):
            child.check = job.check
            child.verify_lease = job.verify_lease
        self.stack = ExitStack()

    def __enter__(self):
        self.stack.enter_context(self.job.query(self.cancel))
        return self

    def __exit__(self, *args):
        return self.stack.__exit__(*args)

    def cancel(self):
        self.lookup_job.stop_query()
        self.sql_job.stop_query()

    def _normalize(self, source, points, rows):
        arrays = [pa.array((row[index] for row in rows), type=column.type).to_pylist()
                  for index, column in enumerate(source.layout.columns)]
        return [{**point, "attributes": {
            column.name: point["object_id"] if index == source.layout.key else source_value(arrays[index][ordinal])
            for index, column in enumerate(source.layout.columns)}}
            for ordinal, point in enumerate(points)]

    def _fetch(self, source, points):
        keys = [int(point["object_id"]) for point in points]
        if (not keys or len(keys) > self.settings.export_sql_batch_rows
                or any(key <= previous for previous, key in zip(keys, keys[1:]))
                or any(not -(1 << 63) <= key < 1 << 63 for key in keys)):
            raise RuntimeError("Frozen lookup contains invalid, unordered, or duplicate keys")
        columns = source.layout.columns
        fields = self.session["publication"]["columns"][source.dataset["id"]]
        selected = ",".join(_projection(column) + " AS " + quote("src_" + str(index))
                            for index, column in enumerate(columns))
        key_type = columns[source.layout.key].identity[1]
        if key_type not in {"tinyint", "smallint", "int", "bigint"}:
            raise RuntimeError("Unsupported SQL export OBJECTID type")
        binds = ",".join(f"CAST(? AS {key_type})" for _ in keys)
        costs = []
        for index, field in enumerate(fields):
            name = quote("src_" + str(index))
            if pa.types.is_binary(columns[index].type) or pa.types.is_fixed_size_binary(columns[index].type):
                costs.append(f"COALESCE(DATALENGTH({name}),0)*CAST(2 AS bigint)")
            elif pa.types.is_string(columns[index].type):
                costs.append(f"COALESCE(DATALENGTH(CONVERT(nvarchar(max),{name})),0)*CAST(3 AS bigint)")
        base = 512 + sum(len(field["name"].encode("utf-8")) * 6 + 128 for field in fields)
        fits = "(" + str(base) + "".join(" + " + cost for cost in costs) + f") <= {self.settings.export_row_budget_bytes}"
        values = ",".join(f"CASE WHEN __fits=1 THEN {quote('src_' + str(index))} ELSE NULL END" for index in range(len(columns)))
        sql = f"WITH selected AS (SELECT {selected} FROM {source.table} WHERE {source.key} IN ({binds})),"
        sql += f" guarded AS (SELECT *, CASE WHEN {fits} THEN 1 ELSE 0 END AS __fits FROM selected)"
        sql += f" SELECT {quote('src_' + str(source.layout.key))},__fits,{values} FROM guarded ORDER BY {quote('src_' + str(source.layout.key))}"
        row_limit = self.settings.export_memory_mb * 1024 * 1024 // 8
        raw_rows, chunk_points, raw_size, seen = [], [], 0, 0
        started = time.monotonic()
        with source._query(sql, keys) as cursor:
            while raw := cursor.fetchone():
                self.job.check()
                key, fits, *values = raw
                if seen >= len(keys) or key != keys[seen]:
                    raise HTTPException(409, "SQL rows no longer match the search: a record is missing, duplicated, or unexpected")
                if not fits:
                    raise HTTPException(413, "A SQL record exceeds export_row_budget_bytes")
                size = _row_bytes(values)
                if size > row_limit:
                    raise HTTPException(413, "A SQL record exceeds the export memory budget")
                if raw_rows and raw_size + size > row_limit:
                    yield self._normalize(source, chunk_points, raw_rows)
                    raw_rows, chunk_points, raw_size = [], [], 0
                raw_rows.append(values)
                chunk_points.append(points[seen])
                raw_size += size
                seen += 1
            if seen != len(keys):
                raise HTTPException(409, "SQL rows no longer match the search: a record is missing")
            if raw_rows:
                yield self._normalize(source, chunk_points, raw_rows)
        LOG.info("request_id=%s operation=sql_export_keys elapsed_ms=%.1f requested_rows=%s returned_rows=%s",
                 self.job.request_id, (time.monotonic() - started) * 1000, len(keys), seen)

    def batches(self, table):
        frozen = self.session["query"].get("export_sql_sources", {}).get(table)
        if not frozen:
            raise HTTPException(409, "SQL export source metadata is unavailable; submit the export again")
        dataset = {**frozen, "id": table}
        profile = self.settings.connections.get(dataset["connection_name"])
        if not profile:
            raise HTTPException(503, "SQL export requires a configured read-only SQL Server connection")
        try:
            import pyodbc

            connection = pyodbc.connect(connection_string(profile),
                                         timeout=max(1, min(30, int(profile.get("login_timeout_sec", 15)))),
                                         autocommit=True, readonly=True)
            with closing(connection):
                connection.timeout = max(1, min(int(self.settings.export_timeout_sec),
                                               math.ceil(self.settings.query_timeout_sec),
                                               int(profile.get("query_timeout_sec", 30))))
                source = _Source(connection, dataset, self.sql_job)
                initial_schema = source.layout.fingerprint
                if ((dataset.get("schema_fingerprint") and initial_schema != dataset["schema_fingerprint"])
                        or source.layout.fields != self.session["publication"]["columns"][table]):
                    raise HTTPException(409, "The SQL source schema or table identity changed; reload the dataset")
                with closing(self.search.export_key_chunks(self.lookup_job, self.session, table)) as batches:
                    for points in batches:
                        yield from self._fetch(source, points)
                if source.validate_layout() != initial_schema:
                    raise HTTPException(409, "The SQL source schema or table identity changed during export")
        except HTTPException:
            raise
        except Exception as error:
            LOG.warning("request_id=%s operation=sql_export_error error_type=%s", self.job.request_id, type(error).__name__)
            raise HTTPException(503, "SQL export failed: check the read-only connection, driver, permissions, and unchanged source schema") from None
