"""Offline, resumable removal of one application's derived data and registrations."""
from __future__ import annotations

import argparse
from contextlib import ExitStack, closing
from dataclasses import fields, replace
from hashlib import sha256
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
import tomllib
from uuid import UUID, uuid4

import portalocker

from h3search.config import Settings
from h3search.control import ConflictError, Registry
from h3search.api.export_store import ExportStore, GATE, WORKER, legacy_snapshot
from h3search.api.export_migrate import fence, preflight
from h3search.etl.iceberg import IcebergLake, _bucket_key
from h3search.etl.layout import owned_table_name

FENCE = 'clean_slate_session'
DERIVED = ('sessions', 'current_publication', 'publications', 'retired_tables', 'deletion_audit',
           'etl_pending', 'etl_checkpoints', 'etl_rejects', 'etl_maintenance', 'etl_completed_loads',
           'etl_bulk_activation', 'etl_bulk_preparations', 'export_dataset_purges')
PRESERVED = ('accounts', 'login_sessions', 'saved_search_state', 'saved_searches', 'categories',
             'release_notes', 'export_spools')
ARTIFACT_SUFFIXES = ('.zip', '.geojson', '.kml', '.gpkg', '.zip.part', '.geojson.part', '.kml.part', '.gpkg.part')
CACHE_MARKER = '.azimuth-cache-owner.json'
STAGE_MARKER = '.azimuth-stage-owner.json'


class CleanSlateError(ValueError):
    """A scoped reset prerequisite was not satisfied."""


def digest(value):
    return sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), default=str).encode()).hexdigest()


def file_identity(path):
    fingerprint = sha256()
    with checked_path(path).open('rb') as stream:
        while block := stream.read(1024 * 1024):
            fingerprint.update(block)
    return {'bytes': path.stat().st_size, 'sha256': fingerprint.hexdigest()}


def checked_path(path):
    """Reject links and junctions in every existing path component before deletion."""
    path = Path(os.path.abspath(path))
    for component in (path, *path.parents):
        if component.is_symlink() or component.is_junction():
            raise CleanSlateError('A scoped path contains a symbolic link or junction.')
    if path == Path(path.anchor):
        raise CleanSlateError('A filesystem root cannot be a scoped target.')
    return path


def child(root, name):
    root = checked_path(root)
    if not isinstance(name, str) or Path(name).name != name or name in ('', '.', '..'):
        raise CleanSlateError('A scoped entry must be one direct child name.')
    result = checked_path(root / name)
    if result.parent != root:
        raise CleanSlateError('A scoped entry escapes its parent.')
    return result


def local_inventory(path):
    path = checked_path(path)
    if not path.exists():
        return {'files': 0, 'bytes': 0}
    paths = [path] if path.is_file() else path.rglob('*')
    count = size = 0
    for item in paths:
        checked_path(item)
        if item.is_file():
            count += 1
            size += item.stat().st_size
    return {'files': count, 'bytes': size}


def write_journal(path, data):
    path = checked_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.tmp')
    checked_path(temp)
    with temp.open('w', encoding='utf-8') as stream:
        os.chmod(temp, 0o600)
        json.dump(data, stream, indent=2, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    temp.replace(path)


def load_settings(config):
    """Keep the same working-directory path semantics as the running application."""
    config = checked_path(config)
    settings = Settings.load(config)
    paths = {field.name: checked_path(getattr(settings, field.name))
             for field in fields(settings) if isinstance(getattr(settings, field.name), Path)}
    return replace(settings, **paths)


class CleanSlate:
    """The journal contains names, counts and hashes, never row payload backups."""

    def __init__(self, settings, scope, *, registry=None, lake=None, service_only=False, service_receipt=None):
        self.settings = settings
        self.registry = registry or Registry(settings)
        self.lake = lake or IcebergLake(settings)
        self.service_only = service_only
        self.service_receipt = service_receipt
        allowed = {'stage_entries', 'orphan_tables', 'legacy_export_copies', 'cache_roots'}
        if set(scope) - allowed:
            raise CleanSlateError('Unknown clean-slate scope field.')
        self.scope = {key: scope.get(key, []) for key in allowed}
        if any(not isinstance(value, list) for value in self.scope.values()):
            raise CleanSlateError('Scope fields must be lists.')
        self.stage = checked_path(settings.stage_path)
        self.exports = checked_path(settings.export_path)
        if service_receipt and (service_receipt.get('phase') != 'service_complete'
                                or service_receipt['plan'].get('kind') != 'service'):
            raise CleanSlateError('A completed service-phase receipt is required.')
        self.binding = digest({'database': settings.postgres_dsn or str(settings.state_path),
                               'catalog': settings.catalog_uri, 'warehouse': settings.warehouse,
                               'namespace': settings.namespace, 'stage': str(self.stage),
                               'exports': str(self.exports), 'scope': self.scope})
        self._validate_roots()

    def _target(self):
        if self.registry.postgres:
            with self.registry.connect() as conn:
                identity = conn.execute('SELECT id FROM azimuth_exports.spool_identity').fetchone()['id']
        else:
            identity = (self.exports / 'spool-id').read_text().strip()
        return digest({'spool': identity, 'warehouse': self.lake.warehouse, 'namespace': self.lake.namespace})

    def _validate_roots(self):
        roots = [self.stage, self.exports]
        roots.extend(checked_path(path) for path in self.scope['cache_roots'])
        for index, root in enumerate(roots):
            for other in roots[index + 1:]:
                if root == other or root in other.parents or other in root.parents:
                    raise CleanSlateError('Stage, export and dedicated cache roots must not overlap.')
        protected = (checked_path(self.settings.state_path), checked_path(self.settings.log_path))
        if any(target == item or target in item.parents for target in roots for item in protected):
            raise CleanSlateError('A cleanup root contains control metadata or application logs.')

    def _tables(self, conn):
        if self.registry.postgres:
            return {row['table_name'] for row in conn.execute(
                "SELECT table_name FROM information_schema.tables WHERE table_schema='public'").fetchall()}
        return {row['name'] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}

    def _database(self):
        with self.registry.connect() as conn:
            tables = self._tables(conn)
            if not {'datasets', 'app_settings', 'sessions'} <= tables:
                raise CleanSlateError('Initialize the application schema before planning a clean slate.')
            data = {}
            for name in (*DERIVED, 'datasets', 'table_preferences', 'dataset_categories'):
                if name in tables:
                    data[name] = self._row_inventory(conn, name)
            keep = {}
            for name in PRESERVED:
                if name in tables:
                    keep[name] = self._row_inventory(conn, name)['hash']
            settings = [dict(row) for row in conn.execute(
                "SELECT * FROM app_settings WHERE key NOT IN ('single_file_publication',?) ORDER BY key", (FENCE,)).fetchall()]
            keep['app_settings'] = digest(settings)
            ids = sorted(row['id'] for row in conn.execute('SELECT id FROM datasets').fetchall())
            marker = conn.execute('SELECT payload FROM app_settings WHERE key=?', (FENCE,)).fetchone()
            return data, keep, ids, json.loads(marker['payload']) if marker else None

    @staticmethod
    def _row_inventory(conn, name):
        """Stream hashes in primary-column order without retaining reject/session payloads."""
        columns = len(conn.execute('SELECT * FROM ' + name + ' WHERE 1=0').description)
        sql = 'SELECT * FROM ' + name + ' ORDER BY ' + ','.join(str(i + 1) for i in range(columns))
        if conn.postgres:
            cursor = conn.raw.cursor(name='clean_slate_' + name)
            cursor.execute(sql)
        else:
            cursor = conn.execute(sql)
        fingerprint, count = sha256(), 0
        try:
            while rows := cursor.fetchmany(128):
                for row in rows:
                    fingerprint.update(json.dumps(dict(row), sort_keys=True, separators=(',', ':'), default=str).encode())
                    fingerprint.update(b'\n')
                    count += 1
        finally:
            cursor.close()
        return {'rows': count, 'hash': fingerprint.hexdigest()}

    def _export_counts(self):
        if self.registry.postgres:
            with self.registry.connect() as conn:
                return tuple(conn.execute('SELECT count(*) AS n FROM azimuth_exports.' + table).fetchone()['n']
                             for table in ('jobs', 'notifications'))
        snapshot = legacy_snapshot(self.exports / 'jobs.sqlite')
        return len(snapshot['jobs']), len(snapshot['notifications'])

    def _catalog(self):
        names = {entry[-1] for entry in self.lake.catalog.list_tables(self.lake.namespace)}
        requested = set(self.scope['orphan_tables'])
        if not all(owned_table_name(name) for name in names | requested):
            raise CleanSlateError('The namespace includes an unowned table; no namespace-wide reset is permitted.')
        return {name: self.lake.location(name) for name in sorted(names | requested)}

    def _physical(self, names):
        """Bounded listings include old versions even when bucket versioning is disabled."""
        bucket, prefix = _bucket_key(f'{self.lake.warehouse}/{self.lake.namespace}')
        prefix += '/'
        client = self.lake._s3_client()
        counts = {'objects': 0, 'bytes': 0, 'versions': 0, 'delete_markers': 0, 'multipart': 0}
        def check(key):
            if not key.startswith(prefix) or key[len(prefix):].split('/')[0] not in names:
                raise CleanSlateError('Uninventoried objects remain in the namespace; identify exact owned orphan tables in scope.')
        for page in client.get_paginator('list_objects_v2').paginate(Bucket=bucket, Prefix=prefix):
            for item in page.get('Contents', []):
                check(item['Key']); counts['objects'] += 1; counts['bytes'] += item['Size']
        for page in client.get_paginator('list_object_versions').paginate(Bucket=bucket, Prefix=prefix):
            for field, counter in (('Versions', 'versions'), ('DeleteMarkers', 'delete_markers')):
                for item in page.get(field, []):
                    check(item['Key']); counts[counter] += 1
        # Some compatible servers ignore the Prefix parameter for multipart listings.
        for page in client.get_paginator('list_multipart_uploads').paginate(Bucket=bucket):
            for item in page.get('Uploads', []):
                if item['Key'].startswith(prefix):
                    check(item['Key']); counts['multipart'] += 1
        return counts

    def _stage_inventory(self):
        self._verify_stage_owner()
        selected = set(self.scope['stage_entries'])
        if STAGE_MARKER in selected:
            raise CleanSlateError('The persistent stage ownership marker is not a cleanup target.')
        actual = {path.name for path in self.stage.iterdir()} - {STAGE_MARKER}
        if actual - selected:
            raise CleanSlateError('Stage contains entries outside the explicit scope. Add only corroborated application-owned entries.')
        return {name: local_inventory(child(self.stage, name)) for name in sorted(selected)}

    def _verify_stage_owner(self):
        if not self.stage.is_dir():
            raise CleanSlateError('The configured ETL staging directory is unreachable or not mounted.')
        expected = {'application': 'Azimuth', 'namespace': self.lake.namespace, 'warehouse': self.lake.warehouse,
                    'stage_root': str(self.stage), 'bulk_owner_id': self.settings.bulk_owner_id}
        marker = child(self.stage, STAGE_MARKER)
        if not marker.is_file() or json.loads(marker.read_text()) != expected:
            raise CleanSlateError('The actual ETL staging directory requires a matching ownership marker.')
        with self.registry.connect() as conn:
            tables = self._tables(conn)
            roots = []
            if 'etl_completed_loads' in tables:
                roots.extend(row['stage_root'] for row in conn.execute('SELECT stage_root FROM etl_completed_loads').fetchall())
            for name in ('etl_pending', 'etl_bulk_preparations'):
                if name in tables:
                    for row in conn.execute('SELECT payload FROM ' + name).fetchall():
                        value = json.loads(row['payload']).get('stage_root')
                        if value:
                            roots.append(value)
            if any(checked_path(value) != self.stage for value in roots):
                raise CleanSlateError('Durable ETL ownership identifies a different staging directory.')

    def _cache_inventory(self):
        result = {}
        for value in self.scope['cache_roots']:
            root = checked_path(value)
            marker = child(root, CACHE_MARKER)
            expected = {'application': 'Azimuth', 'namespace': self.lake.namespace, 'warehouse': self.lake.warehouse}
            if not marker.is_file() or json.loads(marker.read_text()) != expected:
                raise CleanSlateError('A cache root lacks its matching dedicated Azimuth cache ownership marker.')
            result[str(root)] = local_inventory(root)
        return result

    def _export_inventory(self):
        if self.service_receipt:
            receipt = self.service_receipt
            if (receipt['plan']['target'] != self._target()
                    or digest(receipt['plan']) != receipt.get('confirmation')):
                raise CleanSlateError('The service receipt is not bound to this spool, warehouse and namespace.')
            jobs, notifications = self._export_counts()
            if jobs or notifications:
                raise CleanSlateError('Export metadata changed after the remote service gate.')
            return {'jobs': 0, 'notifications': 0, 'artifacts': {}, 'legacy_copies': {},
                    'remote_receipt': receipt['confirmation']}
        allowed = {'jobs.sqlite', 'jobs.sqlite-wal', 'jobs.sqlite-shm', 'spool-id', 'worker.lock', 'store-init.lock'}
        artifacts = {}
        if not (self.exports / 'spool-id').is_file():
            raise CleanSlateError('The persistent export spool identity is missing.')
        for path in self.exports.iterdir():
            checked_path(path)
            if path.name in allowed:
                continue
            try:
                UUID(path.name.split('.')[0])
            except ValueError:
                raise CleanSlateError('Export spool contains an unrecognized file; reconcile it before reset.') from None
            if not path.is_file() or not path.name.endswith(ARTIFACT_SUFFIXES):
                raise CleanSlateError('Export spool contains an unrecognized artifact.')
            artifacts[path.name] = path.stat().st_size
        backups = {}
        for name in self.scope['legacy_export_copies']:
            path = child(self.exports.parent, name)
            if path.exists():
                with closing(sqlite3.connect(f'file:{path.as_posix()}?mode=ro', uri=True)) as local:
                    tables = {row[0] for row in local.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                    if 'jobs' not in tables or tables - {'jobs', 'notifications', 'spool_identity', 'migration', 'sqlite_sequence'}:
                        raise CleanSlateError('An identified legacy copy is not export-only SQLite metadata.')
                backups[name] = {**file_identity(path), 'sidecars': {
                    suffix: file_identity(checked_path(str(path) + suffix)) for suffix in ('-wal', '-shm', '-journal')
                    if checked_path(str(path) + suffix).exists()}}
            elif any(checked_path(str(path) + suffix).exists() for suffix in ('-wal', '-shm', '-journal')):
                raise CleanSlateError('An orphan legacy backup sidecar requires reconciliation against its verified session inventory.')
        jobs = notifications = 0
        if self.registry.postgres:
            with self.registry.connect() as conn:
                jobs = conn.execute('SELECT count(*) AS n FROM azimuth_exports.jobs').fetchone()['n']
                notifications = conn.execute('SELECT count(*) AS n FROM azimuth_exports.notifications').fetchone()['n']
                identity = conn.execute('SELECT id FROM azimuth_exports.spool_identity').fetchone()['id']
                if identity != (self.exports / 'spool-id').read_text().strip():
                    raise CleanSlateError('The PostgreSQL and artifact spool identities differ.')
        elif (self.exports / 'jobs.sqlite').exists():
            snap = legacy_snapshot(self.exports / 'jobs.sqlite')
            jobs, notifications = len(snap['jobs']), len(snap['notifications'])
        return {'jobs': jobs, 'notifications': notifications, 'artifacts': artifacts, 'legacy_copies': backups}

    def preview(self):
        database, preserved, ids, marker = self._database()
        receipt_marker = ({'session_id': self.service_receipt['plan']['session_id'], 'target': self._target(),
                           'service_receipt': self.service_receipt['confirmation']}
                          if self.service_receipt else None)
        if self.service_receipt and marker != receipt_marker:
            raise CleanSlateError('The service receipt is stale, consumed, or does not own the active service-complete fence.')
        if marker and not self.service_receipt:
            raise CleanSlateError('An unfinished session exists. Resume its existing journal.')
        names = {} if self.service_only else self._catalog()
        plan = {'binding': self.binding, 'dataset_ids': ids, 'tables': names, 'database': database,
                'preserved': preserved, 'physical': {} if self.service_only else self._physical(names),
                'stage': {} if self.service_only else self._stage_inventory(),
                'exports': self._export_inventory(), 'cache': self._cache_inventory()}
        plan.update(kind='service' if self.service_only else 'lake', target=self._target(),
                    session_id=self.service_receipt['plan']['session_id'] if self.service_receipt else str(uuid4()))
        return {'format': 1, 'plan': plan, 'confirmation': digest(plan), 'phase': 'preview'}

    def _set_fence(self, journal):
        _, _, ids, marker = self._database()
        identity = {'session_id': journal['plan']['session_id'], 'target': self._target()}
        if self.service_receipt:
            identity['service_receipt'] = self.service_receipt['confirmation']
        if self.service_only and marker == {**identity, 'service_receipt': journal['confirmation']}:
            identity['service_receipt'] = journal['confirmation']
        if marker and marker != identity:
            raise CleanSlateError('Another clean-slate session owns the durable fence.')
        if journal['phase'] not in ('preview', 'fencing') and marker != identity:
            raise CleanSlateError('The durable session fence was consumed or replaced; no cleanup will be repeated.')
        if self.service_receipt and marker != identity:
            raise CleanSlateError('The service receipt no longer owns an active durable fence.')
        if not set(ids) <= set(journal['plan']['dataset_ids']):
            raise CleanSlateError('New registrations appeared outside the approved session.')
        with self.registry.connect() as conn:
            conn.execute('INSERT INTO app_settings(key,payload) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload',
                         (FENCE, json.dumps(identity)))

    def _clear_controls(self):
        with self.registry.connect() as conn:
            tables = self._tables(conn)
            for name in DERIVED:
                if name in tables:
                    conn.execute('DELETE FROM ' + name)
            conn.execute("DELETE FROM app_settings WHERE key='single_file_publication'")

    def _clear_exports(self, journal):
        if self.service_receipt:
            self._export_inventory()
            return
        store = ExportStore(self.settings)
        try:
            database = self.exports / 'jobs.sqlite'
            report = None
            if database.exists():
                with closing(sqlite3.connect(database)) as local:
                    local.execute('PRAGMA secure_delete=ON'); local.execute('BEGIN EXCLUSIVE')
                    if self.registry.postgres:
                        fence(local, False)
                    for table in ('jobs', 'notifications'):
                        local.execute('DELETE FROM ' + table)
                    if self.registry.postgres:
                        fence(local, True)
                    local.commit()
                    local.execute('PRAGMA wal_checkpoint(TRUNCATE)'); local.execute('VACUUM')
                    local.execute('PRAGMA wal_checkpoint(TRUNCATE)')
                report = preflight(store, legacy_snapshot(database))
            if self.registry.postgres:
                with self.registry.connect() as conn:
                    conn.execute('DELETE FROM azimuth_exports.notifications')
                    conn.execute('DELETE FROM azimuth_exports.jobs')
                    if report:
                        result = conn.execute('UPDATE azimuth_exports.migration SET fingerprint=?,manifest=? WHERE singleton=1 AND spool_id=?',
                                              (report['fingerprint'], json.dumps({**report, 'state': 'migrated'}), report['spool_id']))
                        if result.rowcount != 1:
                            raise CleanSlateError('A sealed legacy copy requires its matching migration manifest.')
            # Remove only backup DBs and sidecars verified in the approved preview. Sidecars go first so an
            # interruption cannot leave an unidentifiable data copy after its main DB has disappeared.
            for name, entry in journal['plan']['exports']['legacy_copies'].items():
                path = child(self.exports.parent, name)
                for suffix, identity in entry['sidecars'].items():
                    copy = checked_path(str(path) + suffix)
                    if copy.exists():
                        if file_identity(copy) != identity:
                            raise CleanSlateError('An inventoried backup sidecar changed after preview.')
                        copy.unlink()
                if path.exists():
                    if file_identity(path) != {key: entry[key] for key in ('bytes', 'sha256')}:
                        raise CleanSlateError('An inventoried backup changed after preview.')
                    path.unlink()
            inventory = self._export_inventory()
            for name in inventory['artifacts']:
                child(self.exports, name).unlink()
            if inventory['legacy_copies']:
                raise CleanSlateError('New legacy export copies appeared outside the approved preview.')
            store._initialize()
        finally:
            store.close()

    def _verify(self, journal):
        if self.lake.catalog.list_tables(self.lake.namespace):
            raise CleanSlateError('Catalog tables remain.')
        if any(self._physical(journal['plan']['tables']).values()):
            raise CleanSlateError('Stored objects, historical versions, delete markers or multipart uploads remain.')
        self._verify_stage_owner()
        if {item.name for item in self.stage.iterdir()} != {STAGE_MARKER}:
            raise CleanSlateError('Staging entries remain.')
        exports = self._export_inventory()
        if any((exports['jobs'], exports['notifications'], exports['artifacts'], exports['legacy_copies'])):
            raise CleanSlateError('Export metadata or files remain.')
        for value in self.scope['cache_roots']:
            if {item.name for item in checked_path(value).iterdir()} != {CACHE_MARKER}:
                raise CleanSlateError('Dedicated cache entries remain.')
        controls, keep, ids, _ = self._database()
        if any(controls[name]['rows'] for name in DERIVED if name in controls):
            raise CleanSlateError('Derived control rows remain.')
        if keep != journal['plan']['preserved']:
            raise CleanSlateError('Unrelated account/configuration or user-authored content changed during reset.')
        return {'datasets': len(ids), 'physical': self._physical(journal['plan']['tables']), 'exports': exports}

    def _clear_cache(self):
        self._cache_inventory()
        for value in self.scope['cache_roots']:
            for path in checked_path(value).iterdir():
                if path.name != CACHE_MARKER:
                    local_inventory(path)
                    shutil.rmtree(path) if path.is_dir() else path.unlink()

    def _verify_service(self):
        exports = self._export_inventory()
        if any((exports['jobs'], exports['notifications'], exports['artifacts'], exports['legacy_copies'])):
            raise CleanSlateError('Service artifacts or metadata remain.')
        with self.registry.connect() as conn:
            if conn.execute('SELECT count(*) AS n FROM sessions').fetchone()['n']:
                raise CleanSlateError('Search sessions remain.')
        for value in self.scope['cache_roots']:
            if {item.name for item in checked_path(value).iterdir()} != {CACHE_MARKER}:
                raise CleanSlateError('Dedicated cache entries remain.')
        return {'exports': exports, 'cache': self._cache_inventory()}

    def _purge_remaining_versions(self, location):
        """Historical versions must be removed regardless of the current versioning status."""
        bucket, prefix = _bucket_key(location)
        prefix += '/'
        client = self.lake._s3_client()
        previous = None
        while True:
            page = client.list_object_versions(Bucket=bucket, Prefix=prefix, MaxKeys=1000)
            entries = [{'Key': item['Key'], 'VersionId': item['VersionId']}
                       for field in ('Versions', 'DeleteMarkers') for item in page.get(field, [])]
            if not entries and not page.get('IsTruncated'):
                return
            if not entries or entries == previous or any(not item['Key'].startswith(prefix) for item in entries):
                raise CleanSlateError('Historical-version reclamation made no progress or returned an out-of-scope key.')
            if client.delete_objects(Bucket=bucket, Delete={'Objects': entries, 'Quiet': True}).get('Errors'):
                raise CleanSlateError('Historical versions could not be reclaimed.')
            previous = entries

    def apply(self, journal_path, confirmation, *, quiesced=False):
        if not quiesced:
            raise CleanSlateError('Stop API admission, export workers, Trino, ETL/watchers and bulk preparation; then pass --quiesced.')
        journal_path = checked_path(journal_path)
        journal = json.loads(journal_path.read_text())
        if (journal.get('format') != 1 or journal.get('confirmation') != confirmation
                or digest(journal.get('plan')) != confirmation or journal['plan']['binding'] != self.binding):
            raise CleanSlateError('The exact preview confirmation, configuration and scope must match the journal.')
        if any(root == journal_path or root in journal_path.parents for root in [self.stage, self.exports,
                *(checked_path(value) for value in self.scope['cache_roots'])]):
            raise CleanSlateError('Keep the session journal outside every cleanup root.')
        with ExitStack() as stack:
            stack.enter_context(portalocker.Lock(str(journal_path) + '.lock', timeout=0))
            for key in (83172503, 83172502, 83172501):
                stack.enter_context(self.registry._lease(key, False, 0, clean_slate=True))
            for table_id in journal['plan']['dataset_ids']:
                # Bulk preparation uses a separate lifetime lease.
                canonical = str(UUID(table_id))
                key = (int.from_bytes(sha256(canonical.encode()).digest()[:8], 'big') & ((1 << 62) - 1)) | (1 << 62)
                stack.enter_context(self.registry._lease(key, False, 0, clean_slate=True))
            if not self.service_receipt:
                for name in ('worker.lock', 'store-init.lock'):
                    stack.enter_context(portalocker.Lock(str(self.exports / name), timeout=0))
            if self.registry.postgres:
                conn = stack.enter_context(self.registry.connect())
                for key in (GATE, WORKER):
                    if not conn.execute('SELECT pg_try_advisory_lock(?) AS acquired', (key,)).fetchone()['acquired']:
                        raise CleanSlateError('An export process still owns its PostgreSQL lock.')
                # The connection closes with the session locks on exit.
            if journal['phase'] == 'complete':
                result = self._verify(journal)
                if result['datasets']:
                    raise CleanSlateError('A completed session cannot reset subsequent registrations. Create a new preview.')
                return result
            if journal['phase'] == 'verified':
                result = self._verify(journal)
                if result['datasets']:
                    raise CleanSlateError('The verified session no longer describes an empty registry.')
                _, _, _, marker = self._database()
                expected = {'session_id': journal['plan']['session_id'], 'target': self._target()}
                if self.service_receipt:
                    expected['service_receipt'] = self.service_receipt['confirmation']
                if marker not in (None, expected):
                    raise CleanSlateError('A different session owns the final fence.')
                with self.registry.connect() as conn:
                    conn.execute('DELETE FROM app_settings WHERE key=?', (FENCE,))
                journal['phase'] = 'complete'; write_journal(journal_path, journal)
                return result
            if journal['phase'] == 'service_complete':
                if not self.service_only:
                    raise CleanSlateError('Resume the lake phase with a separate journal and --service-receipt.')
                _, _, _, marker = self._database()
                expected = {'session_id': journal['plan']['session_id'], 'target': self._target(),
                            'service_receipt': journal['confirmation']}
                if marker != expected:
                    raise CleanSlateError('The service receipt has been consumed or its durable fence changed.')
                self._verify_service()
                return journal
            if journal['phase'] == 'preview':
                current = self.preview()['plan']
                current['session_id'] = journal['plan']['session_id']
                if digest(current) != confirmation:
                    raise CleanSlateError('The preview is stale. Quiesce first, then create a fresh preview.')
                journal['phase'] = 'fencing'; write_journal(journal_path, journal)
            self._set_fence(journal)
            journal['phase'] = 'applying'; write_journal(journal_path, journal)
            # Every phase is idempotent. Recheck every target on each retry rather than trusting a completion flag.
            self._clear_exports(journal)
            if self.service_only:
                with self.registry.connect() as conn:
                    conn.execute('DELETE FROM sessions')
                self._clear_cache()
                journal['phase'] = 'service_complete'; journal['result'] = self._verify_service()
                with self.registry.connect() as conn:
                    marker = {'session_id': journal['plan']['session_id'], 'target': self._target(),
                              'service_receipt': journal['confirmation']}
                    conn.execute('UPDATE app_settings SET payload=? WHERE key=?', (json.dumps(marker), FENCE))
                write_journal(journal_path, journal)
                return journal
            self._clear_controls()
            if set(self._catalog()) - set(journal['plan']['tables']):
                raise CleanSlateError('New lake tables appeared outside the approved session.')
            for name, location in journal['plan']['tables'].items():
                if self.lake.location(name) != location:
                    raise CleanSlateError('An inventoried table location changed.')
                self.lake.drop_owned_table(name, location)
                self._purge_remaining_versions(location)
            for name in self.scope['stage_entries']:
                path = child(self.stage, name)
                local_inventory(path)
                if path.exists():
                    shutil.rmtree(path) if path.is_dir() else path.unlink()
            self._clear_cache()
            self._verify(journal)
            with self.registry.connect() as conn:
                # Saved search definitions intentionally retain unavailable UUIDs, preserving the user's filter intent.
                for name in ('table_preferences', 'dataset_categories', 'datasets'):
                    conn.execute('DELETE FROM ' + name)
            result = self._verify(journal)
            if result['datasets']:
                raise CleanSlateError('Dataset registrations remain.')
            journal['phase'] = 'verified'; journal['result'] = result; write_journal(journal_path, journal)
            with self.registry.connect() as conn:
                conn.execute('DELETE FROM app_settings WHERE key=?', (FENCE,))
            journal['phase'] = 'complete'; write_journal(journal_path, journal)
            return result


def main(argv=None):
    parser = argparse.ArgumentParser(description='Preview or resume an offline clean slate. SQL Server is never accessed.')
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--scope', required=True, type=Path, help='Explicit stage, cache, orphan-table and legacy-copy scope TOML.')
    parser.add_argument('--journal', required=True, type=Path, help='Protected session file outside all cleanup roots.')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--confirm', help='Exact confirmation hash printed by preview.')
    parser.add_argument('--quiesced', action='store_true', help='Acknowledge all related services, queries and ingestion stopped.')
    split = parser.add_mutually_exclusive_group()
    split.add_argument('--service-only', action='store_true', help='Clear exports/sessions/dedicated cache and leave a fenced receipt for the lake host.')
    split.add_argument('--service-receipt', type=Path, help='Completed service-phase journal copied from the export/cache host.')
    args = parser.parse_args(argv)
    try:
        settings = load_settings(args.config)
        if settings.mode != 'live':
            raise CleanSlateError('This operator command requires live PostgreSQL and Iceberg configuration.')
        scope_path = checked_path(args.scope)
        with scope_path.open('rb') as stream:
            scope = tomllib.load(stream)
        scope['cache_roots'] = [str(checked_path(args.config.absolute().parent / value)) for value in scope.get('cache_roots', [])]
        receipt = json.loads(args.service_receipt.read_text()) if args.service_receipt else None
        session = CleanSlate(settings, scope, service_only=args.service_only, service_receipt=receipt)
        if args.apply:
            result = session.apply(args.journal, args.confirm, quiesced=args.quiesced)
        else:
            if args.journal.exists():
                raise CleanSlateError('The journal already exists; use a new path or resume its apply.')
            result = session.preview()
            write_journal(args.journal, result)
        print(json.dumps(result, indent=2))
        return 0
    except (CleanSlateError, ConflictError) as error:
        print(str(error), file=sys.stderr)
    except Exception as error:
        # Dependency diagnostics can embed DSNs or storage credentials.
        print(f'Clean slate stopped ({type(error).__name__}). Keep services quiesced and inspect the protected session.', file=sys.stderr)
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
