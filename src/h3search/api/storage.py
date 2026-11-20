"""Read frozen search and feature snapshots through Trino or local DuckDB."""

import os
import time
from contextlib import contextmanager, suppress
from dataclasses import dataclass

from fastapi import HTTPException

from .execution import ConnectionPool, log_query


def quote(identifier):
    """Quote a trusted identifier without interpreting embedded quotes."""
    return '"' + identifier.replace('"', '""') + '"'


@dataclass(frozen=True)
class Relation:
    """Frozen table expression and its bound arguments."""

    sql: str
    args: tuple = ()


class Storage:
    """Lease pooled query connections and resolve explicit lake snapshots."""

    def __init__(self, settings, *, source="h3search-api"):
        self.settings = settings
        self.source = source
        self.local = settings.mode == "local"
        self.pool = ConnectionPool(self._connect, settings.pool_size, settings.pool_wait_sec)

    def _connect(self):
        if self.local:
            import duckdb

            memory = max(1, self.settings.memory_budget_mb // self.settings.pool_size)
            return duckdb.connect(config={"threads": 1, "memory_limit": f"{memory}MiB"})

        import trino

        settings = self.settings
        password = settings.trino_password
        if password and settings.trino_scheme != "https":
            raise RuntimeError("Trino password authentication requires HTTPS")
        auth = trino.auth.BasicAuthentication(settings.trino_user, password) if password else None
        return trino.dbapi.connect(
            host=settings.trino_host,
            port=settings.trino_port,
            user=settings.trino_user,
            catalog=settings.trino_catalog,
            schema=settings.trino_schema,
            http_scheme=settings.trino_scheme,
            auth=auth,
            verify=settings.trino_ca_bundle or True,
            request_timeout=settings.query_timeout_sec,
            max_attempts=1,
            legacy_prepared_statements=False,
            session_properties={
                "query_max_run_time": f"{settings.query_timeout_sec}s",
                f"{settings.trino_catalog}.statistics_enabled": str(settings.trino_statistics_enabled).lower(),
                f"{settings.trino_catalog}.parquet_small_file_threshold": f"{settings.trino_parquet_small_file_threshold_bytes}B",
            },
            source=self.source,
        )

    def relation(self, name, snapshot, columns=()):
        """Resolve a published snapshot without falling back to current data."""
        if snapshot is None:
            raise ValueError("Publication has no snapshot for this table")
        if not self.local:
            snapshot_id = int(snapshot)
            if not 0 <= snapshot_id < 1 << 63:
                raise ValueError("Invalid snapshot ID")
            qualified = ".".join(map(quote, (self.settings.trino_catalog, self.settings.trino_schema, name)))
            return Relation(f"{qualified} FOR VERSION AS OF {snapshot_id}")

        from h3search.etl.lake import LocalLake

        paths = [os.fspath(path) for path in LocalLake(self.settings).files(name, snapshot)]
        if paths:
            return Relation("read_parquet(?)", (paths,))
        fields = [
            "CAST(NULL AS VARCHAR) AS table_id", "CAST(NULL AS BIGINT) AS object_id",
            "CAST(NULL AS DOUBLE) AS lat", "CAST(NULL AS DOUBLE) AS lon",
            *(f"CAST(NULL AS BIGINT) AS h3_r{resolution}" for resolution in range(16)),
            *(f"NULL AS {quote(column)}" for column in columns),
        ]
        return Relation(f"(SELECT {', '.join(fields)} WHERE FALSE)")

    @contextmanager
    def cursor(self, job, operation, sql, args):
        """Execute a query while leasing an exclusive connection through its final fetch."""
        job.check()
        # Include bound values and conservative prepared-statement escaping before
        # contacting a query engine. The limit also covers derived time queries.
        if not self.local:
            estimated_bytes = 4096 + 2 * len(sql.encode("utf-8")) + sum(
                len(str(value).replace("'", "''").encode("utf-8")) + 16 for value in args)
            if estimated_bytes > self.settings.max_search_query_bytes:
                raise HTTPException(422, "Search exceeds the configured query size limit; reduce centers or radius")
        started = time.monotonic()
        query_id = None
        stats = {}
        try:
            with self.pool.lease() as connection:
                cursor = connection if self.local else connection.cursor()
                cancel = connection.interrupt if self.local else cursor.cancel
                try:
                    with job.query(cancel):
                        cursor.execute(sql, list(args))
                        job.check()
                        yield cursor
                finally:
                    if not self.local:
                        query_id = cursor.query_id
                        stats = cursor.stats or {}
                        with suppress(Exception):
                            cursor.close()
        finally:
            log_query(job, operation, started, query_id, stats)

    def query(self, job, operation, sql, args, maximum):
        """Fetch only the bounded rows expected from one completed query."""
        with self.cursor(job, operation, sql, args) as cursor:
            rows = cursor.fetchmany(maximum + 1)
            job.check()
            if len(rows) > maximum:
                raise RuntimeError("Storage returned more rows than the query permits")
            return rows

    def close(self):
        self.pool.close()
