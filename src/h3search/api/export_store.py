"""Durable export metadata: PostgreSQL in live mode and SQLite for standalone use."""
from __future__ import annotations

import json
import sqlite3
from contextlib import closing, contextmanager
from queue import Empty, LifoQueue
from threading import Lock
from uuid import uuid4

SCHEMA = 'azimuth_exports'
GATE = 83172517
WORKER = 83172518
INIT = 83172519

JOB_COLUMNS = {
    'id': 'TEXT PRIMARY KEY', 'owner': 'TEXT NOT NULL', 'format': 'TEXT NOT NULL',
    'status': 'TEXT NOT NULL', 'session': 'TEXT NOT NULL', 'total': 'BIGINT NOT NULL',
    'rows_done': 'BIGINT NOT NULL DEFAULT 0', 'created': 'DOUBLE PRECISION NOT NULL',
    'expires': 'DOUBLE PRECISION NOT NULL', 'started': 'DOUBLE PRECISION', 'error': 'TEXT',
    'cleanup_complete': 'INTEGER NOT NULL DEFAULT 0', 'worker_id': 'TEXT',
    'heartbeat': 'DOUBLE PRECISION', 'worker_pid': 'INTEGER',
    'source': "TEXT NOT NULL DEFAULT 'iceberg' CHECK(source IN ('iceberg','sqlserver'))",
}
NOTIFICATION_COLUMNS = {
    'id': 'TEXT PRIMARY KEY', 'owner': 'TEXT NOT NULL', 'export_id': 'TEXT NOT NULL',
    'event': 'TEXT NOT NULL', 'message': 'TEXT NOT NULL', 'created': 'DOUBLE PRECISION NOT NULL',
    'read_at': 'DOUBLE PRECISION',
}

class Row(dict):
    """Support the established name and positional SQLite row access contract."""
    def __getitem__(self, key):
        return tuple(self.values())[key] if isinstance(key, int) else super().__getitem__(key)


def row_factory(cursor):
    names = [column.name for column in (cursor.description or [])]
    return lambda values: Row(zip(names, values))


class Connection:
    def __init__(self, raw, postgres):
        self.raw, self.postgres = raw, postgres

    def execute(self, sql, params=()):
        if self.postgres:
            if sql == 'BEGIN IMMEDIATE':
                sql = f'SELECT pg_advisory_xact_lock({GATE})'
            elif sql == 'BEGIN':
                sql = 'BEGIN ISOLATION LEVEL REPEATABLE READ'
            sql = sql.replace('?', '%s')
        return self.raw.execute(sql, params)

    def commit(self):
        self.raw.commit()

    def rollback(self):
        self.raw.rollback()

    def set_trace_callback(self, callback):
        self.raw.set_trace_callback(callback)


class ExportStore:
    """One metadata namespace bound to one persistent artifact spool."""
    def __init__(self, settings):
        self.settings = settings
        self.postgres = settings.mode == 'live'
        self.root = settings.export_path.resolve()
        self.database = self.root / 'jobs.sqlite'
        self.identity_path = self.root / 'spool-id'
        self.root.mkdir(parents=True, exist_ok=True)
        self.idle = LifoQueue()
        self.pool_lock = Lock()
        self.pool_count = 0
        self.closed = False

    def raw_postgres(self):
        import psycopg
        if not self.settings.postgres_dsn:
            raise ValueError('postgres_dsn is required for live export metadata')
        raw = psycopg.connect(self.settings.postgres_dsn, row_factory=row_factory, connect_timeout=10)
        raw.execute(f'SET search_path TO {SCHEMA},public')
        raw.commit()
        return raw

    def checkout(self):
        try:
            return self.idle.get_nowait()
        except Empty:
            pass
        with self.pool_lock:
            if self.closed:
                raise RuntimeError('Export metadata pool is closed')
            create = self.pool_count < self.settings.export_metadata_pool_size
            if create:
                self.pool_count += 1
        if create:
            try:
                return self.raw_postgres()
            except BaseException:
                with self.pool_lock:
                    self.pool_count -= 1
                raise
        try:
            return self.idle.get(timeout=self.settings.pool_wait_sec)
        except Empty as error:
            raise TimeoutError('Export metadata connection pool is busy') from error

    def release(self, raw):
        with self.pool_lock:
            if self.closed or raw.closed:
                raw.close()
                self.pool_count -= 1
            else:
                self.idle.put(raw)

    def close(self):
        with self.pool_lock:
            self.closed = True
            while not self.idle.empty():
                self.idle.get_nowait().close()
                self.pool_count -= 1

    @contextmanager
    def connect(self):
        raw = self.checkout() if self.postgres else sqlite3.connect(self.database, timeout=self.settings.pool_wait_sec)
        if not self.postgres:
            raw.row_factory = sqlite3.Row
        try:
            yield Connection(raw, self.postgres)
            raw.commit()
        except BaseException:
            try:
                raw.rollback()
            except Exception:
                raw.close()
            raise
        finally:
            self.release(raw) if self.postgres else raw.close()

    def initialize(self, *, migration=False):
        import portalocker
        with portalocker.Lock(str(self.root / 'store-init.lock'), timeout=max(10, self.settings.pool_wait_sec)):
            return self._initialize(migration=migration)

    def _initialize(self, *, migration=False):
        if self.postgres and self.database.exists() and not migration:
            with self.connect() as connection:
                found = connection.execute("SELECT to_regclass(?)", (SCHEMA + '.migration',)).fetchone()[0]
                manifest = connection.execute('SELECT * FROM migration WHERE singleton=1').fetchone() if found else None
            if not manifest or manifest['fingerprint'] != legacy_fingerprint(self.database):
                raise RuntimeError('Legacy export metadata requires a quiesced PostgreSQL handoff; run azimuth-export-migrate')
            if json.loads(manifest['manifest']).get('state') != 'migrated':
                raise RuntimeError('Export metadata handoff is not active')
            with closing(sqlite3.connect(f'file:{self.database.as_posix()}?mode=ro', uri=True)) as legacy:
                guarded = legacy.execute("SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name LIKE 'pg_handoff_%'").fetchone()[0]
            if guarded != 9:
                raise RuntimeError('Legacy export write fence is incomplete; rerun the quiesced handoff')
        with self.connect() as connection:
            if self.postgres:
                connection.execute(f'SELECT pg_advisory_xact_lock({INIT})')
                connection.execute(f'CREATE SCHEMA IF NOT EXISTS {SCHEMA}')
            else:
                connection.execute('PRAGMA journal_mode=WAL')
                connection.execute('BEGIN IMMEDIATE')
            for table, columns in [('jobs', JOB_COLUMNS), ('notifications', NOTIFICATION_COLUMNS)]:
                definition = ','.join(name + ' ' + kind for name, kind in columns.items())
                if table == 'notifications':
                    definition += ',UNIQUE(export_id,event)'
                connection.execute(f'CREATE TABLE IF NOT EXISTS {table} ({definition})')
                if self.postgres:
                    for name, kind in columns.items():
                        if 'PRIMARY KEY' not in kind:
                            connection.execute(f'ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {name} {kind}')
                if not self.postgres:
                    existing = {row['name'] for row in connection.execute(f'PRAGMA table_info({table})')}
                    for name in columns.keys() - existing:
                        connection.execute(f'ALTER TABLE {table} ADD COLUMN {name} {columns[name]}')
            connection.execute('CREATE INDEX IF NOT EXISTS notifications_owner_created ON notifications(owner,created DESC,id DESC)')
            connection.execute('CREATE TABLE IF NOT EXISTS spool_identity (id TEXT PRIMARY KEY)')
            connection.execute('CREATE TABLE IF NOT EXISTS migration (singleton INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL, spool_id TEXT NOT NULL, manifest TEXT NOT NULL)')
            identity = connection.execute('SELECT id FROM spool_identity').fetchone()
            disk = self.identity_path.read_text().strip() if self.identity_path.exists() else None
            if identity:
                self.spool_id = identity[0]
                if self.postgres and disk is None and not migration:
                    raise RuntimeError('Persistent export spool identity file is missing')
                if disk is not None and disk != self.spool_id:
                    raise RuntimeError('Export metadata belongs to a different artifact spool')
            else:
                if self.postgres and self.database.exists() and migration:
                    return
                self.spool_id = disk or str(uuid4())
                connection.execute('INSERT INTO spool_identity VALUES (?)', (self.spool_id,))
            if disk is None:
                # Registry/PG initialization serializes competing API/worker starts.
                try:
                    with self.identity_path.open('x') as stream:
                        stream.write(self.spool_id + '\n')
                except FileExistsError:
                    if self.identity_path.read_text().strip() != self.spool_id:
                        raise RuntimeError('Export spool identity changed')


def legacy_snapshot(database):
    with closing(sqlite3.connect(f'file:{database.as_posix()}?mode=ro', uri=True)) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute('BEGIN')
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        result = {}
        for table in ('jobs', 'notifications', 'spool_identity'):
            result[table] = [dict(row) for row in connection.execute(f'SELECT * FROM {table} ORDER BY id')] if table in tables else []
        return result


def snapshot_fingerprint(snapshot):
    from hashlib import sha256
    return sha256(json.dumps(snapshot, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def legacy_fingerprint(database):
    return snapshot_fingerprint(legacy_snapshot(database))
