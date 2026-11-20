"""Quiesced, idempotent handoff of export metadata between SQLite and PostgreSQL."""
from __future__ import annotations

import argparse
import json
import sqlite3
import time
from collections import Counter
from contextlib import closing
from pathlib import Path
from uuid import UUID

from h3search.config import Settings
from .export_store import ExportStore, JOB_COLUMNS, NOTIFICATION_COLUMNS, WORKER, legacy_snapshot, snapshot_fingerprint

TABLES = {'jobs': JOB_COLUMNS, 'notifications': NOTIFICATION_COLUMNS, 'spool_identity': {'id': 'TEXT'}}
SUFFIXES = {'csv': '.zip', 'json': '.geojson', 'kml': '.kml', 'gpkg': '.gpkg'}


def snapshot(connection):
    found = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    return {table: [dict(row) for row in connection.execute(f'SELECT * FROM {table} ORDER BY id')] if table in found else [] for table in TABLES}


def preflight(store, data):
    if len(data['spool_identity']) != 1:
        raise ValueError('Expected exactly one legacy spool identity')
    identity = str(UUID(data['spool_identity'][0]['id']))
    artifacts = []
    for row in data['jobs']:
        identifier = str(UUID(row['id']))
        if row['format'] not in SUFFIXES or row.get('source', 'iceberg') not in {'iceberg', 'sqlserver'}:
            raise ValueError('Unsupported export format or source')
        json.loads(row['session'])
        for partial in (False, True):
            path = store.root / (identifier + SUFFIXES[row['format']] + ('.part' if partial else ''))
            if path.exists():
                artifacts.append({'file': path.name, 'bytes': path.stat().st_size})
        if row['status'] == 'completed' and row['expires'] > time.time() and not (store.root / (identifier + SUFFIXES[row['format']])).is_file():
            raise ValueError('A completed export artifact is missing; reconcile before handoff')
    return {'spool_id': identity, 'jobs': len(data['jobs']), 'notifications': len(data['notifications']),
            'statuses': dict(Counter(row['status'] for row in data['jobs'])), 'artifacts': artifacts,
            'fingerprint': snapshot_fingerprint(data)}


def fence(connection, enabled):
    for table in TABLES:
        for event in ('INSERT', 'UPDATE', 'DELETE'):
            name = f'pg_handoff_{table}_{event.lower()}'
            connection.execute(f'DROP TRIGGER IF EXISTS {name}')
            if enabled:
                connection.execute(f"CREATE TRIGGER {name} BEFORE {event} ON {table} BEGIN SELECT RAISE(ABORT,'Export metadata moved to PostgreSQL'); END")


def pg_snapshot(connection):
    return {table: [dict(row) for row in connection.execute(f'SELECT * FROM {table} ORDER BY id')] for table in TABLES}


def insert_rows(connection, table, columns, rows):
    for row in rows:
        selected = [name for name in columns if name in row]
        names = ','.join(selected)
        marks = ','.join('?' for _ in selected)
        connection.execute(f'INSERT INTO {table} ({names}) VALUES ({marks})', tuple(row[name] for name in selected))


def handoff(settings, *, action='preflight', quiesced=False):
    """No artifacts or registry sessions are rewritten by this operation."""
    with closing(ExportStore(settings)) as store:
        return _handoff(store, action=action, quiesced=quiesced)


def _handoff(store, *, action, quiesced):
    import portalocker
    settings = store.settings
    if not store.postgres:
        raise ValueError('Export handoff requires live mode and postgres_dsn')
    if action != 'preflight' and not quiesced:
        raise ValueError('Stop every API and export worker; acknowledge with --quiesced')
    if not store.database.is_file():
        raise ValueError('Legacy jobs.sqlite is missing')
    if action == 'preflight':
        return preflight(store, legacy_snapshot(store.database))
    with portalocker.Lock(str(store.root / 'worker.lock'), timeout=0), portalocker.Lock(str(store.root / 'store-init.lock'), timeout=0):
        # Legacy processes do not understand PG locks. Quiescence is required;
        # SQLite's exclusive transaction additionally excludes concurrent writes.
        with closing(sqlite3.connect(store.database, timeout=settings.pool_wait_sec)) as local:
            local.row_factory = sqlite3.Row
            local.execute('BEGIN EXCLUSIVE')
            try:
                data = snapshot(local)
                report = preflight(store, data)
                # Already holding store-init.lock: call the internal initializer.
                store._initialize(migration=True)
                with store.connect() as connection:
                    connection.execute('BEGIN IMMEDIATE')
                    if not connection.execute('SELECT pg_try_advisory_xact_lock(?)', (WORKER,)).fetchone()[0]:
                        raise RuntimeError('Stop the PostgreSQL export worker before handoff')
                    identity = connection.execute('SELECT id FROM spool_identity').fetchone()
                    if identity and identity[0] != report['spool_id']:
                        raise ValueError('PostgreSQL metadata belongs to another spool')
                    old = connection.execute('SELECT * FROM migration WHERE singleton=1').fetchone()
                    if action == 'apply':
                        already = old and old['fingerprint'] == report['fingerprint'] and json.loads(old['manifest']).get('state') == 'migrated'
                        if not already:
                            if old and json.loads(old['manifest']).get('state') != 'rolled_back':
                                raise ValueError('Legacy state changed after handoff; reconcile before continuing')
                            if not old and any(connection.execute(f'SELECT count(*) FROM {table}').fetchone()[0] for table in ('jobs', 'notifications')):
                                raise ValueError('Target export metadata is not empty')
                            for table in TABLES:
                                connection.execute(f'DELETE FROM {table}')
                                insert_rows(connection, table, TABLES[table], data[table])
                            copied = pg_snapshot(connection)
                            # New columns receive explicit backward-compatible defaults.
                            for source, target in zip(data['jobs'], copied['jobs']):
                                if any(target[key] != value for key, value in source.items()):
                                    raise RuntimeError('Job reconciliation failed')
                            if copied['notifications'] != data['notifications'] or copied['spool_identity'] != data['spool_identity']:
                                raise RuntimeError('Notification or spool reconciliation failed')
                            manifest = {**report, 'state': 'migrated'}
                            connection.execute('INSERT INTO migration VALUES (1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET fingerprint=excluded.fingerprint,spool_id=excluded.spool_id,manifest=excluded.manifest',
                                               (report['fingerprint'], report['spool_id'], json.dumps(manifest)))
                        report['result'] = 'already_migrated' if already else 'migrated'
                    elif action == 'rollback':
                        if not old:
                            raise ValueError('No completed handoff exists')
                        current = pg_snapshot(connection)
                        if any(row['source'] == 'sqlserver' and row['status'] in {'queued', 'running'} for row in current['jobs']):
                            raise ValueError('Finish or cancel SQL Server exports before rollback to an older worker')
                        fence(local, False)
                        for table in TABLES:
                            existing = {row['name'] for row in local.execute(f'PRAGMA table_info({table})')}
                            for name, kind in TABLES[table].items():
                                if name not in existing:
                                    local.execute(f'ALTER TABLE {table} ADD COLUMN {name} {kind}')
                            local.execute(f'DELETE FROM {table}')
                            insert_rows(local, table, TABLES[table], current[table])
                        restored = snapshot(local)
                        if restored != current:
                            raise RuntimeError('Rollback reconciliation failed')
                        report = preflight(store, restored)
                        manifest = {**report, 'state': 'rolled_back'}
                        connection.execute('UPDATE migration SET fingerprint=?,manifest=? WHERE singleton=1', (report['fingerprint'], json.dumps(manifest)))
                        report['result'] = 'rolled_back'
                    else:
                        raise ValueError('Unknown handoff action')
                if action == 'apply':
                    fence(local, True)
                local.commit()
            except BaseException:
                local.rollback()
                raise
    if action == 'apply':
        existing = store.identity_path.read_text().strip() if store.identity_path.exists() else report['spool_id']
        if existing != report['spool_id']:
            raise ValueError('Persistent artifact spool identity mismatch')
        store.identity_path.write_text(report['spool_id'] + '\n')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path)
    parser.add_argument('--action', choices=['preflight', 'apply', 'rollback'], default='preflight')
    parser.add_argument('--quiesced', action='store_true')
    args = parser.parse_args()
    try:
        result = handoff(Settings.load(args.config), action=args.action, quiesced=args.quiesced)
    except (ValueError, RuntimeError) as error:
        parser.exit(1, str(error) + '\n')
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    main()
