"""Owned, durable receipts for completed frozen dataset output preparation."""
from __future__ import annotations

from hashlib import sha256
import json
import os
from pathlib import Path
from uuid import UUID

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq
import numpy as np

from h3search.control import ConflictError
from . import spool
from .layout import SEARCH_SCHEMA


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def _path(root, name):
    if not isinstance(name, str) or Path(name).name != name or name in ('', '.', '..'):
        raise ConflictError('A prepared output receipt contains an unowned filename.')
    target = root / name
    if target.is_symlink() or target.is_junction() or target.resolve().parent != root:
        raise ConflictError('A prepared output receipt crosses its owned staging scope.')
    return target


def _root(root, generation):
    original = Path(root)
    if original.is_symlink() or original.is_junction():
        raise ConflictError('Prepared output receipts require the original owned run directory.')
    root = original.resolve()
    if not root.is_dir() or root.name != 'load-' + str(UUID(generation)):
        raise ConflictError('Prepared output receipts belong to a different run directory.')
    return root


def _binding(root, generation, dataset_id, state, schema, settings):
    from .load import ENCODING_FIELDS
    source = {'dataset_id': str(UUID(dataset_id)), 'schema': schema.serialize().to_pybytes().hex(),
              'chunks': state['chunks'], 'phase': state['phase'], 'key': state.get('key'),
              'cutoff': state.get('cutoff'), 'reuse': state.get('reuse', False)}
    return {'generation': str(UUID(generation)), 'dataset_id': str(UUID(dataset_id)), 'root': str(root),
            'source': sha256(_json(source)).hexdigest(),
            'encoding': {key: getattr(settings, key) for key in ENCODING_FIELDS}, 'pyarrow': pa.__version__}


def receipt_path(root, dataset_id):
    return Path(root) / ('.prepared-' + str(UUID(dataset_id)) + '.json')


def _write(path, value):
    payload = {key: item for key, item in value.items() if key != 'seal'}
    data = _json({**payload, 'seal': sha256(_json(payload)).hexdigest()})
    temporary = _path(path.parent, path.name + '.tmp')
    with temporary.open('wb') as stream:
        stream.write(data); stream.flush(); os.fsync(stream.fileno())
    temporary.replace(path)
    if os.name != 'nt':
        descriptor = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(descriptor)
        finally: os.close(descriptor)


def _read(path):
    value = json.loads(path.read_text())
    payload = {key: item for key, item in value.items() if key != 'seal'}
    if value.get('version') != 1 or value.get('seal') != sha256(_json(payload)).hexdigest():
        raise ConflictError('A prepared output receipt is incomplete or changed.')
    return value


def _schema_hash(schema):
    return sha256(schema.serialize().to_pybytes()).hexdigest()


def _record(root, path, schema, settings, guard, *, rows=None, partition=None):
    path = Path(path)
    if path.is_symlink() or path.is_junction():
        raise ConflictError('A prepared output cannot be a link or junction.')
    path = path.resolve()
    if path.parent != root:
        raise ConflictError('A prepared output lies outside its original run directory.')
    path = _path(root, path.name)
    guard()
    with path.open('rb') as stream:
        stream.seek(-8, 2); trailer = stream.read(8)
    if trailer[4:] != b'PAR1' or int.from_bytes(trailer[:4], 'little') > settings.bulk_max_footer_mb * 1048576:
        raise ConflictError('A prepared output footer exceeds its configured validation budget.')
    with pq.ParquetFile(path) as source:
        if source.schema_arrow != schema or (rows is not None and source.metadata.num_rows != rows):
            raise ConflictError('A prepared output schema or row count differs from its receipt.')
        count = source.metadata.num_rows
    result = {'file': path.name, 'rows': count, 'bytes': path.stat().st_size,
              'sha256': spool.checksum(path, guard), 'schema': _schema_hash(schema)}
    if partition is not None:
        if (not isinstance(partition, list) or len(partition) != 1 or type(partition[0]) is not int
                or not 0 <= partition[0] < settings.wide_bucket_count):
            raise ConflictError('A prepared output has an invalid physical bucket.')
        result['partition'] = partition
    return result


def save_prepared(root, generation, dataset_id, state, schema, bounds, guard, prepared):
    """Called only after the trusted writer or an exact full-payload adoption proof succeeds."""
    root = _root(root, generation)
    narrow, rejected, files, count = prepared
    slim = pa.schema([field for field in schema if field.name in ('table_id', 'object_id') or field.name.startswith('src_')])
    reject = pa.schema([pa.field('object_id', pa.int64()), pa.field('__reason', pa.string())])
    records = [_record(root, entry['path'], slim, bounds.settings, guard, rows=entry['rows'], partition=entry['partition'])
               for entry in files]
    value = {'version': 1, 'binding': _binding(root, generation, dataset_id, state, schema, bounds.settings),
             'narrow': _record(root, narrow, SEARCH_SCHEMA, bounds.settings, guard, rows=count),
             'rejected': _record(root, rejected, reject, bounds.settings, guard), 'wide': records, 'count': count}
    if sum(entry['rows'] for entry in records) != count or len({entry['file'] for entry in records}) != len(records):
        raise ConflictError('Prepared output inventory does not reconcile with its canonical count.')
    if len(_json(value)) > bounds.settings.bulk_max_manifest_mb * 1048576:
        raise ConflictError('The prepared output receipt exceeds its manifest budget.')
    _write(receipt_path(root, dataset_id), value)
    return value


def load_prepared(root, generation, dataset_id, state, schema, bounds, guard, check_source):
    root = _root(root, generation)
    path = receipt_path(root, dataset_id)
    if not path.exists():
        return None
    if path.stat().st_size > bounds.settings.bulk_max_manifest_mb * 1048576:
        raise ConflictError('The prepared output receipt exceeds its manifest budget.')
    value = _read(_path(root, path.name))
    if value['binding'] != _binding(root, generation, dataset_id, state, schema, bounds.settings):
        raise ConflictError('A prepared output receipt belongs to different source, encoding or generation evidence.')
    for chunk in state['chunks']:
        for kind in ('data', 'events'):
            check_source(chunk[kind], guard)
    slim = pa.schema([field for field in schema if field.name in ('table_id', 'object_id') or field.name.startswith('src_')])
    reject = pa.schema([pa.field('object_id', pa.int64()), pa.field('__reason', pa.string())])
    for entry, expected in [(value['narrow'], SEARCH_SCHEMA), (value['rejected'], reject),
                            *((entry, slim) for entry in value['wide'])]:
        actual = _record(root, _path(root, entry['file']), expected, bounds.settings, guard,
                         rows=entry['rows'], partition=entry.get('partition'))
        if actual != entry:
            raise ConflictError('A prepared output artifact differs from its durable receipt.')
    if sum(entry['rows'] for entry in value['wide']) != value['count'] or value['narrow']['rows'] != value['count']:
        raise ConflictError('A prepared output receipt has inconsistent row accounting.')
    files = [{**entry, 'path': str(_path(root, entry['file']))} for entry in value['wide']]
    return _path(root, value['narrow']['file']), _path(root, value['rejected']['file']), files, value['count']


def record_commit(root, dataset_id, table, snapshot, content):
    path = receipt_path(Path(root).resolve(), dataset_id)
    value = _read(path)
    expected = 'wide_' + UUID(dataset_id).hex + '_' + UUID(value['binding']['generation']).hex
    if table != expected:
        raise ConflictError('A prepared output commit belongs to a different physical table.')
    completed = {'table': table, 'snapshot': str(snapshot), 'content': content}
    if value.get('completed') not in (None, completed):
        raise ConflictError('A prepared output receipt records a different completed snapshot.')
    _write(path, {**value, 'completed': completed})


def _same(left, right):
    if left.schema != right.schema or len(left) != len(right):
        return False
    # Float payloads, including signed zero and NaN payload bits, must remain exact.
    for index, field in enumerate(left.schema):
        if pa.types.is_floating(field.type):
            integer = pa.int32() if field.type.bit_width == 32 else pa.int64()
            left = left.set_column(index, field.name, left.column(index).combine_chunks().view(integer))
            right = right.set_column(index, field.name, right.column(index).combine_chunks().view(integer))
    return left.equals(right)


class _Rows:
    def __init__(self, paths, schema, batch_rows, budget, guard, bounds):
        self.schema, self.budget, self.guard, self.bounds = schema, budget, guard, bounds
        self.current, self.offset, self.charge, self.previous = None, 0, 0, None
        def batches():
            for path in paths:
                with pq.ParquetFile(path) as source:
                    if source.schema_arrow != schema:
                        raise ConflictError('Prepared payload proof found an incompatible output schema.')
                    for batch in source.iter_batches(batch_size=batch_rows, use_threads=False):
                        if len(batch):
                            yield pa.Table.from_batches([batch])
        self.reader = batches()

    def head(self):
        if self.current is not None and self.offset < len(self.current):
            return self.current.slice(self.offset)
        self.budget['used'] -= self.charge
        self.current, self.charge = None, 0
        table = next(self.reader, None)
        if table is None:
            return None
        self.guard(); self.bounds.check()
        self.charge = table.nbytes
        self.budget['used'] += self.charge
        if self.budget['used'] > self.budget['limit']:
            raise MemoryError('Prepared payload proof exceeded its aggregate decoded carry budget.')
        from .load import _ordered_ids
        self.previous = _ordered_ids(table['object_id'], self.previous)
        self.current, self.offset = table, 0
        return table

    def consume(self, expected):
        offset = 0
        while offset < len(expected):
            actual = self.head()
            if actual is None:
                raise ConflictError('Prepared payload proof found missing output rows.')
            count = min(len(actual), len(expected) - offset)
            if not _same(actual.slice(0, count), expected.slice(offset, count)):
                raise ConflictError('Prepared payload proof found changed row attributes or identities.')
            self.offset += count; offset += count

    def finish(self):
        if self.head() is not None:
            raise ConflictError('Prepared payload proof found extra output rows.')

    def close(self):
        self.reader.close()


def prove_payload(root, generation, dataset_id, state, schema, bounds, guard, check_source,
                  prepared, *, progress=lambda **values: None, proof_read_rows=None):
    """Exactly compare every staged attribute to the original sealed ordered base rows."""
    from .load import _ordered_ids
    from pyiceberg.transforms import BucketTransform
    from pyiceberg.types import LongType
    from pyiceberg.exceptions import NotInstalledError
    root = _root(root, generation)
    if state.get('reuse') or state.get('skip') or state['phase'] != 'complete':
        raise ConflictError('Prepared payload adoption requires completed frozen base-only source state.')
    narrow, rejected, files, declared_count = prepared
    slim = pa.schema([field for field in schema if field.name in ('table_id', 'object_id') or field.name.startswith('src_')])
    reject_schema = pa.schema([pa.field('object_id', pa.int64()), pa.field('__reason', pa.string())])
    budget = {'limit': min(bounds.settings.prepared_carry_mb * 1048576, bounds.engine._memory_limit()), 'used': 0}
    buckets = bounds.settings.wide_bucket_count
    per_reader = max(1, budget['limit'] // (buckets + 4))
    read_rows = max(1, min(bounds.settings.prepared_read_batch_rows, per_reader // max(512, len(slim) * 32)))
    if proof_read_rows is not None:
        if type(proof_read_rows) is not int or proof_read_rows < 1:
            raise ValueError('Payload proof read rows must be a positive integer.')
        read_rows = min(read_rows, proof_read_rows)
    transform = BucketTransform(buckets)
    try: bucket = transform.pyarrow_transform(LongType())
    except (ImportError, NotInstalledError):
        scalar = transform.transform(LongType())
        bucket = lambda ids: pa.array([scalar(value.as_py()) for value in ids], pa.int32())
    grouped = {key: [] for key in range(buckets)}
    for entry in files:
        key = entry['partition'][0]
        if key not in grouped:
            raise ConflictError('Prepared payload proof found a foreign physical bucket.')
        path = Path(entry['path']).resolve()
        if path.parent != root or path.is_symlink():
            raise ConflictError('Prepared payload proof crossed its owned staging directory.')
        grouped[key].append(path)
    readers = {key: _Rows(paths, slim, read_rows, budget, guard, bounds) for key, paths in grouped.items()}
    narrow_reader = _Rows([narrow], SEARCH_SCHEMA, read_rows, budget, guard, bounds)
    reject_reader = _Rows([rejected], reject_schema, read_rows, budget, guard, bounds)
    count, rejected_count, event_previous, data_previous = 0, 0, None, None
    try:
        for number, chunk in enumerate(state['chunks']):
            expected_hash, actual_hash = sha256(), sha256()
            accepted = chunk_rows = 0
            event_path, data_path = (check_source(chunk[kind], guard) for kind in ('events', 'data'))
            with pq.ParquetFile(event_path) as events:
                if events.metadata.num_rows != chunk['events']['rows']:
                    raise ConflictError('Prepared payload proof found changed source event counts.')
                for batch in events.iter_batches(batch_size=read_rows, use_threads=False):
                    if not len(batch): continue
                    guard(); bounds.check()
                    table = pa.Table.from_batches([batch]); valid = table['__valid']
                    event_previous = _ordered_ids(table['object_id'], event_previous)
                    if (valid.null_count or table['__batch'].null_count
                            or not pc.all(pc.equal(table['__batch'], number)).as_py()
                            or not pc.all(pc.equal(pc.is_null(table['__reason']), valid)).as_py()):
                        raise ConflictError('Prepared payload proof found non-base source event accounting.')
                    accepted_ids = pc.filter(table['object_id'], valid)
                    expected_hash.update(accepted_ids.to_numpy().astype('<i8', copy=False).tobytes())
                    accepted += len(accepted_ids)
                    rejects = table.filter(pc.invert(valid)).select(reject_schema.names)
                    reject_reader.consume(rejects); rejected_count += len(rejects)
            with pq.ParquetFile(data_path) as source:
                if source.schema_arrow != schema.append(pa.field('__batch', pa.int64())) or source.metadata.num_rows != chunk['data']['rows']:
                    raise ConflictError('Prepared payload proof found changed source schema or counts.')
                for batch in source.iter_batches(batch_size=read_rows, use_threads=False):
                    if not len(batch): continue
                    guard(); bounds.check()
                    table = pa.Table.from_batches([batch])
                    budget['used'] += table.nbytes
                    if budget['used'] > budget['limit']:
                        raise MemoryError('Prepared payload proof exceeded its decoded source/carry budget.')
                    try:
                        ids = table['object_id']; values = ids.to_numpy()
                        data_previous = _ordered_ids(ids, data_previous)
                        if (table['table_id'].null_count or table['__batch'].null_count
                                or not pc.all(pc.equal(table['table_id'], dataset_id)).as_py()
                                or not pc.all(pc.equal(table['__batch'], number)).as_py()):
                            raise ConflictError('Prepared payload proof found a foreign dataset or source batch.')
                        narrow_reader.consume(table.select(SEARCH_SCHEMA.names))
                        seen = np.zeros(len(table), dtype=np.bool_)
                        for key, reader in readers.items():
                            while (actual := reader.head()) is not None:
                                actual_ids = actual['object_id'].to_numpy()
                                take = int(np.searchsorted(actual_ids, values[-1], side='right'))
                                if not take: break
                                actual = actual.slice(0, take); actual_ids = actual_ids[:take]
                                positions = np.searchsorted(values, actual_ids)
                                if ((positions >= len(values)).any() or not np.array_equal(values[positions], actual_ids)
                                        or seen[positions].any() or not pc.all(pc.equal(bucket(actual['object_id']), key)).as_py()):
                                    raise ConflictError('Prepared payload proof found duplicate, missing or wrongly bucketed identities.')
                                if not _same(actual, table.select(slim.names).take(pa.array(positions))):
                                    raise ConflictError('Prepared payload proof found changed source attributes.')
                                seen[positions] = True; reader.offset += take
                        if not seen.all():
                            raise ConflictError('Prepared payload proof found missing wide rows.')
                        actual_hash.update(values.astype('<i8', copy=False).tobytes())
                        count += len(table); chunk_rows += len(table)
                    finally:
                        budget['used'] -= table.nbytes
            if chunk_rows != accepted or actual_hash.digest() != expected_hash.digest():
                raise ConflictError('Prepared payload proof found inconsistent accepted source identities.')
            progress(rows=count, rejects=rejected_count, chunks=number + 1)
        if event_previous != state.get('key') or (event_previous is not None and (state.get('cutoff') is None or event_previous > state['cutoff'])):
            raise ConflictError('Prepared payload proof differs from its original source cursor or cutoff.')
        for reader in [narrow_reader, reject_reader, *readers.values()]: reader.finish()
        if count != declared_count:
            raise ConflictError('Prepared payload proof differs from its declared accepted count.')
        return {'rows': count, 'rejects': rejected_count, 'wide_files': len(files), 'proof': 'exact_all_columns_and_physical_buckets'}
    finally:
        for reader in [narrow_reader, reject_reader, *readers.values()]: reader.close()


def adopt_prepared(root, generation, dataset_id, state, schema, bounds, guard, check_source, prepared,
                   *, progress=lambda **values: None, proof_read_rows=None):
    proof = prove_payload(root, generation, dataset_id, state, schema, bounds, guard, check_source,
                          prepared, progress=progress, proof_read_rows=proof_read_rows)
    value = save_prepared(root, generation, dataset_id, state, schema, bounds, guard, prepared)
    return {**proof, 'receipt': str(receipt_path(Path(root).resolve(), dataset_id)), 'binding': value['binding']}
