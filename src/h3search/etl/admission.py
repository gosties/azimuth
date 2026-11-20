"""Upload immutable prepared files and append them through native Iceberg metadata."""

from base64 import b64decode, b64encode
from concurrent.futures import ThreadPoolExecutor
from hashlib import md5, sha256
import json
from pathlib import Path
from threading import Lock
from time import monotonic
from urllib.parse import unquote, urlsplit
from uuid import UUID

import psutil
import pyarrow.parquet as pq
from h3.api import basic_int as h3
from pyiceberg.io.pyarrow import (
    compute_statistics_plan, data_file_statistics_from_parquet_metadata,
    parquet_path_to_id_mapping, pyarrow_to_schema,
)
from pyiceberg.manifest import DataFile, DataFileContent, FileFormat, ManifestEntryStatus, read_manifest_list
from pyiceberg.partitioning import PartitionField, PartitionSpec
from pyiceberg.table import TableProperties
from pyiceberg.table.name_mapping import MappedField, NameMapping
from pyiceberg.transforms import BucketTransform, IdentityTransform
from pyiceberg.typedef import Record
from pyiceberg.types import LongType

from h3search.control import ConflictError
from .layout import SEARCH_SCHEMA, search_name, wide_name
from .manifests import _manifest_entries


MiB = 1024 * 1024
OPERATION = "h3search.bulk.operation"
IDENTITY = "h3search.bulk.manifest"
DATASET = "h3search.bulk.dataset"
KIND = "h3search.bulk.kind"
CAPSULE = "h3search.bulk.capsule"


def _check(lake, guard):
    guard()
    if psutil.Process().memory_info().rss >= lake.settings.memory_budget_mb * MiB:
        raise MemoryError("Bulk admission reached its configured RSS budget.")


def _positive(value, label, *, zero=False):
    if type(value) is not int or value < (0 if zero else 1):
        raise ValueError(f"The prepared {label} must be a {'nonnegative' if zero else 'positive'} integer.")
    return value


def _name(table_id, kind):
    UUID(table_id)
    if kind not in ("wide", "narrow"):
        raise ValueError("Bulk admission requires a wide or narrow file set.")
    return wide_name(table_id) if kind == "wide" else search_name


def _json_bytes(value):
    return sum(len(piece.encode("utf-8")) for piece in json.JSONEncoder(sort_keys=True).iterencode(value))


def _partition(lake, table_id, kind, entry):
    partition = entry["partition"]
    if kind == "wide":
        if set(partition) != {"object_bucket"}:
            raise ValueError("The prepared wide partition must identify its object bucket.")
        bucket = _positive(partition["object_bucket"], "bucket", zero=True)
        if bucket >= lake.buckets:
            raise ValueError("The prepared wide bucket exceeds the configured bucket count.")
        return (bucket,), f"object_bucket={bucket}"
    cell_name = f"h3_r{lake.resolution}"
    if set(partition) != {"table_id", cell_name} or partition["table_id"] != table_id:
        raise ValueError("The prepared search partition differs from its registered dataset.")
    cell = partition[cell_name]
    if type(cell) is not int or not h3.is_valid_cell(cell) or h3.get_resolution(cell) != lake.resolution:
        raise ValueError("The prepared search partition contains an invalid cell.")
    return (table_id, cell), f"table_id={table_id}/{cell_name}={cell}"


def _entries(lake, table_id, kind, manifest, max_files, max_manifest_bytes, guard):
    _positive(max_files, "file inventory limit")
    _positive(max_manifest_bytes, "manifest byte limit")
    files = manifest["files"]
    if not isinstance(files, list) or len(files) > max_files:
        raise ValueError("The prepared file inventory exceeds its configured limit.")
    if _json_bytes(manifest) > max_manifest_bytes:
        raise ValueError("The prepared file manifest exceeds its configured byte limit.")
    _positive(manifest["rows"], "manifest row count", zero=True)
    _positive(manifest["bytes"], "manifest byte count", zero=True)
    if not isinstance(manifest["layout_fingerprint"], str) or not manifest["layout_fingerprint"]:
        raise ValueError("The prepared layout fingerprint is missing.")
    paths, content, ranges, rows, size = set(), set(), {}, 0, 0
    for index, entry in enumerate(files):
        if index % 64 == 0:
            _check(lake, guard)
        relative = entry["path"]
        if not isinstance(relative, str) or not relative or relative in paths:
            raise ValueError("The prepared file inventory contains an invalid or duplicate path.")
        digest = entry["sha256"]
        if (not isinstance(digest, str) or len(digest) != 64
                or any(character not in "0123456789abcdef" for character in digest) or digest in content):
            raise ValueError("The prepared file inventory contains an invalid or duplicate content identity.")
        paths.add(relative)
        content.add(digest)
        rows += _positive(entry["rows"], "file row count")
        size += _positive(entry["bytes"], "file byte count")
        partition, _ = _partition(lake, table_id, kind, entry)
        low, high = entry["object_id_min"], entry["object_id_max"]
        if type(low) is not int or type(high) is not int or not -(1 << 63) <= low <= high < (1 << 63):
            raise ValueError("The prepared OBJECTID bounds are invalid.")
        if partition in ranges and low <= ranges[partition]:
            raise ValueError("Prepared files overlap or move backward within a partition.")
        ranges[partition] = high
    if rows != manifest["rows"] or size != manifest["bytes"]:
        raise ValueError("The prepared manifest totals differ from its closed files.")
    return files


def _identity(table_id, operation_id, kind, manifest):
    operation = str(UUID(operation_id))
    header = (table_id, operation, kind, manifest["layout_fingerprint"], manifest["rows"], manifest["bytes"])
    digest = sha256(json.dumps(header, separators=(",", ":")).encode())
    for entry in manifest["files"]:
        values = {key: entry[key] for key in (
            "path", "sha256", "rows", "bytes", "partition", "object_id_min", "object_id_max",
        )}
        digest.update(json.dumps(values, sort_keys=True, separators=(",", ":")).encode())
    return operation, digest.hexdigest()


def _path(root, relative):
    root = Path(root)
    if root.is_symlink() or root.is_junction():
        raise ValueError("A prepared run directory cannot be a symbolic link or junction.")
    root = root.resolve(strict=True)
    supplied = Path(relative)
    if supplied.is_absolute() or ".." in supplied.parts:
        raise ValueError("A prepared file must use a relative path inside its run directory.")
    target = root / supplied
    current = root
    for component in supplied.parts:
        current = current / component
        if current.is_symlink() or current.is_junction():
            raise ValueError("Prepared file paths cannot traverse symbolic links.")
    target = target.resolve(strict=True)
    if not target.is_relative_to(root) or not target.is_file():
        raise ValueError("A prepared file is outside its run directory.")
    return target


def _file_hash(lake, path, entry, guard):
    before = path.stat()
    if before.st_size != entry["bytes"] or before.st_size > 5 * 1024**3:
        raise ValueError("A prepared file differs from its declared size or exceeds the upload limit.")
    strong, transport = sha256(), md5(usedforsecurity=False)
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(MiB), b""):
            _check(lake, guard)
            strong.update(block)
            transport.update(block)
    after = path.stat()
    if ((before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns)
            or strong.hexdigest() != entry["sha256"]):
        raise ValueError("An immutable prepared file changed. Restore the original file before retrying.")
    return transport.hexdigest()


def _uri(lake, table_id, operation_id, kind, entry):
    _, partition_path = _partition(lake, table_id, kind, entry)
    prefix = lake._location(_name(table_id, kind))
    parsed = urlsplit(prefix)
    if (parsed.scheme != "s3" or not parsed.netloc or parsed.query or parsed.fragment
            or ".." in Path(unquote(parsed.path)).parts):
        raise ValueError("Bulk admission requires an owned S3 table prefix.")
    return f"{prefix}/data/{partition_path}/bulk-{UUID(operation_id).hex}-{entry['sha256']}.parquet"


def _bucket_key(uri):
    parsed = urlsplit(uri)
    return parsed.netloc, parsed.path.lstrip("/")


def _head(client, bucket, key):
    try:
        return client.head_object(Bucket=bucket, Key=key)
    except Exception as error:
        code = getattr(error, "response", {}).get("Error", {}).get("Code")
        if code in ("404", "NoSuchKey", "NotFound"):
            return None
        raise


def _verify_object(lake, uri, entry, transport_hash, guard):
    client = lake._s3_client()
    bucket, key = _bucket_key(uri)
    _check(lake, guard)
    head = _head(client, bucket, key)
    if head is None:
        return None
    if head["ContentLength"] != entry["bytes"] or head.get("Metadata", {}).get("sha256") != entry["sha256"]:
        raise ConflictError("A prepared upload path already contains a different immutable file.")
    etag = head["ETag"].strip('"')
    if etag != transport_hash:
        # Encrypted objects can use non-MD5 ETags. Verify their complete bytes without buffering them.
        body = client.get_object(Bucket=bucket, Key=key)["Body"]
        digest = sha256()
        try:
            for block in iter(lambda: body.read(MiB), b""):
                _check(lake, guard)
                digest.update(block)
        finally:
            body.close()
        if digest.hexdigest() != entry["sha256"]:
            raise ConflictError("A prepared upload no longer matches its immutable content identity.")
    return {"uri": uri, "sha256": entry["sha256"], "bytes": entry["bytes"], "etag": head["ETag"]}


def _context(lake, table_id, kind, schema):
    mapping = NameMapping([MappedField(field_id=index + 1, names=[field.name]) for index, field in enumerate(schema)])
    expected = pyarrow_to_schema(schema, name_mapping=mapping)
    columns = ("object_id",) if kind == "wide" else ("table_id", f"h3_r{lake.resolution}")
    transforms = (BucketTransform(lake.buckets),) if kind == "wide" else (IdentityTransform(), IdentityTransform())
    names = ("object_bucket",) if kind == "wide" else columns
    spec = PartitionSpec(*(PartitionField(source_id=expected.find_field(column).field_id, field_id=1000 + index,
                                         transform=transform, name=name)
                           for index, (column, transform, name) in enumerate(zip(columns, transforms, names))))
    table = lake._load(_name(table_id, kind))
    properties = lake.properties
    if table is not None:
        if (table.location().rstrip("/") != lake._location(_name(table_id, kind))
                or table.schema().fields != expected.fields or not table.spec().compatible_with(spec)
                or len(table.specs()) != 1 or table.metadata.format_version != 2):
            raise ConflictError("The prepared target differs from the registered schema or partition layout.")
        expected, spec = table.schema(), table.spec()
        mapping, properties = table.metadata.name_mapping() or expected.name_mapping, table.properties
    return ({"version": 1, "table": _name(table_id, kind), "schema": expected.model_dump_json(),
             "spec": spec.model_dump_json(), "mapping": mapping.model_dump_json(),
             "table_uuid": str(table.metadata.table_uuid) if table else None}, expected, mapping, properties)


def _encode_statistics(statistics):
    result = {}
    for name, values in statistics.items():
        if isinstance(values, dict):
            result[name] = {str(key): b64encode(value).decode("ascii") if isinstance(value, bytes) else value
                            for key, value in values.items()}
        else:
            result[name] = values
    result["split_offsets"] = None
    return result


def _decode_statistics(statistics):
    names = {"record_count", "column_sizes", "value_counts", "null_value_counts", "nan_value_counts",
             "lower_bounds", "upper_bounds", "split_offsets"}
    if set(statistics) != names or statistics["split_offsets"] is not None:
        raise ValueError("The sealed file statistics are incomplete or contain split offsets.")
    result = {}
    for name, values in statistics.items():
        if isinstance(values, dict):
            result[name] = {int(key): (b64decode(value, validate=True)
                                     if name in ("lower_bounds", "upper_bounds") else value)
                            for key, value in values.items()}
        else:
            result[name] = values
    return result


def _seal(manifest, header):
    digest = sha256()
    for value in ({key: value for key, value in header.items() if key != "seal_sha256"}, manifest["files"]):
        for piece in json.JSONEncoder(sort_keys=True, separators=(",", ":")).iterencode(value):
            digest.update(piece.encode("utf-8"))
    return digest.hexdigest()


class _CheckedStream:
    def __init__(self, stream, lake, guard, size):
        self.stream, self.lake, self.guard, self.size = stream, lake, guard, size

    def read(self, size=-1):
        _check(self.lake, self.guard)
        if size < 0 and self.size > MiB:
            raise ValueError("The object client must stream prepared files in bounded chunks.")
        return self.stream.read(size)

    def __getattr__(self, name):
        return getattr(self.stream, name)


def prepare_uploads(lake, table_id, operation_id, root, kind, manifest, schema, *, guard, persist,
                    max_files=100000, max_manifest_bytes=64 * MiB, max_footer_bytes=8 * MiB, upload_workers=4):
    """Verify and upload closed files; persist append-only ``{path, upload}`` receipt events.

    Object names are deterministic. A failed receipt save can be recovered by verifying the
    existing object on the next attempt. This phase does not create or modify catalog tables.
    The caller reserves these target prefixes against orphan reclamation before calling it.
    """
    _name(table_id, kind)
    if type(upload_workers) is not int or not 1 <= upload_workers <= 4:
        raise ValueError("Bulk upload workers must be between one and four.")
    if kind == "narrow" and not schema.equals(SEARCH_SCHEMA, check_metadata=False):
        raise ValueError("Prepared search admission requires the canonical search schema.")
    _identity(table_id, operation_id, kind, manifest)
    files = _entries(lake, table_id, kind, manifest, max_files, max_manifest_bytes, guard)
    if not files:
        return manifest
    updated = {**manifest, "files": []}
    header, iceberg_schema, mapping, properties = _context(lake, table_id, kind, schema)
    header["source_manifest"] = _identity(table_id, operation_id, kind, manifest)[1]
    size = _json_bytes(manifest)
    client = lake._s3_client()
    lock = Lock()

    def checked_guard():
        with lock:
            guard()

    def upload(entry):
        path = _path(root, entry["path"])
        transport = _file_hash(lake, path, entry, checked_guard)
        metadata = _footer(path, entry, schema, table_id, kind, lake, max_footer_bytes)
        if pyarrow_to_schema(metadata.schema.to_arrow_schema(), name_mapping=mapping).fields != iceberg_schema.fields:
            raise ValueError("Prepared Parquet field IDs differ from the registered Iceberg fields.")
        statistics = data_file_statistics_from_parquet_metadata(
            metadata, compute_statistics_plan(iceberg_schema, properties), parquet_path_to_id_mapping(iceberg_schema),
        ).to_serialized_dict()
        uri = _uri(lake, table_id, operation_id, kind, entry)
        if "upload" in entry and any(entry["upload"].get(key) != value for key, value in {
            "uri": uri, "sha256": entry["sha256"], "bytes": entry["bytes"],
        }.items()):
            raise ConflictError("A durable upload receipt differs from its prepared file identity.")
        receipt = _verify_object(lake, uri, entry, transport, checked_guard)
        if receipt is None:
            bucket, key = _bucket_key(uri)
            _check(lake, checked_guard)
            with path.open("rb") as stream:
                try:
                    client.put_object(
                        Bucket=bucket, Key=key, Body=_CheckedStream(stream, lake, checked_guard, entry["bytes"]),
                        ContentLength=entry["bytes"], ContentMD5=b64encode(bytes.fromhex(transport)).decode("ascii"),
                        Metadata={"sha256": entry["sha256"]}, IfNoneMatch="*",
                    )
                except Exception as error:
                    code = getattr(error, "response", {}).get("Error", {}).get("Code")
                    if code not in ("PreconditionFailed", "412", "ConditionalRequestConflict", "409"):
                        raise
            receipt = _verify_object(lake, uri, entry, transport, checked_guard)
            if receipt is None:
                raise RuntimeError("The prepared upload is unavailable after upload completion.")
        _check(lake, checked_guard)
        receipt["statistics"] = _encode_statistics(statistics)
        return receipt

    with ThreadPoolExecutor(max_workers=upload_workers) as workers:
        for start in range(0, len(files), upload_workers):
            batch = files[start:start + upload_workers]
            futures = [workers.submit(upload, entry) for entry in batch]
            # Wait for this bounded batch before any serial journal callbacks.
            receipts = [future.result() for future in futures]
            for entry, receipt in zip(batch, receipts, strict=True):
                _check(lake, guard)
                size += _json_bytes(receipt) - _json_bytes(entry.get("upload", {}))
                if size > max_manifest_bytes:
                    raise ValueError("The sealed admission metadata exceeds its configured byte limit.")
                persist({"path": entry["path"], "upload": receipt})
                updated["files"].append({**entry, "upload": receipt})
    header["seal_sha256"] = _seal(updated, header)
    updated["admission"] = header
    if _json_bytes(updated) > max_manifest_bytes:
        raise ValueError("The sealed admission manifest exceeds its configured byte limit.")
    return updated


def _footer(path, entry, schema, table_id, kind, lake, max_footer_bytes):
    _positive(max_footer_bytes, "footer byte limit")
    with path.open("rb") as stream:
        stream.seek(-8, 2)
        tail = stream.read(8)
    if tail[4:] != b"PAR1" or int.from_bytes(tail[:4], "little") > max_footer_bytes:
        raise ValueError("The prepared Parquet footer is invalid or exceeds its configured byte limit.")
    metadata = pq.read_metadata(path)
    arrow_schema = metadata.schema.to_arrow_schema()
    ids = [field.metadata is not None and b"PARQUET:field_id" in field.metadata for field in arrow_schema]
    if any(ids) and not all(ids):
        raise ValueError("Prepared Parquet files cannot contain partial Iceberg field IDs.")
    if metadata.num_rows != entry["rows"] or not arrow_schema.equals(schema, check_metadata=False):
        raise ValueError("A prepared Parquet file differs from its declared schema or row count.")
    expected = {"table_id": table_id}
    if kind == "narrow":
        expected.update(entry["partition"])
    column_ids = {field.name: index for index, field in enumerate(schema)}
    low, high = None, None
    for group in range(metadata.num_row_groups):
        row_group = metadata.row_group(group)
        for name, value in expected.items():
            stats = row_group.column(column_ids[name]).statistics
            if (stats is None or stats.null_count != 0 or not stats.has_min_max
                    or stats.min != value or stats.max != value):
                raise ValueError("The prepared file does not prove its declared dataset or search partition.")
        stats = row_group.column(column_ids["object_id"]).statistics
        if stats is None or stats.null_count != 0 or not stats.has_min_max:
            raise ValueError("The prepared OBJECTID bounds cannot be verified from the footer.")
        low = stats.min if low is None else min(low, stats.min)
        high = stats.max if high is None else max(high, stats.max)
    if (low, high) != (entry["object_id_min"], entry["object_id_max"]):
        raise ValueError("The prepared file differs from its declared OBJECTID bounds.")
    if kind == "wide":
        bucket = entry["partition"]["object_bucket"]
        transform = BucketTransform(lake.buckets).transform(LongType())
        if transform(low) != bucket or transform(high) != bucket:
            raise ValueError("The prepared wide bucket disagrees with its verified key bounds.")
    return metadata


def _find(table, table_id, operation_id, kind, manifest, lake, guard, max_snapshots):
    _positive(max_snapshots, "snapshot inventory limit")
    operation, identity = _identity(table_id, operation_id, kind, manifest)
    snapshots = table.snapshots()
    if len(snapshots) > max_snapshots:
        raise ValueError("The admission marker history exceeds its configured snapshot limit.")
    found = None
    for index, snapshot in enumerate(snapshots):
        if index % 64 == 0:
            _check(lake, guard)
        summary = snapshot.summary
        if summary and summary.get(OPERATION) == operation:
            if (summary.get(IDENTITY), summary.get(DATASET), summary.get(KIND)) != (identity, table_id, kind):
                raise ConflictError("The bulk operation marker already identifies different prepared files.")
            if manifest.get("admission") and summary.get(CAPSULE) != manifest["admission"].get("seal_sha256"):
                raise ConflictError("The committed bulk operation uses a different sealed admission manifest.")
            if found is not None:
                raise ConflictError("The bulk operation has more than one committed admission snapshot.")
            found = snapshot.snapshot_id
    return found


def find_admission(lake, table_id, operation_id, kind, manifest, *, guard, max_snapshots=100000):
    """Find this exact admission throughout retained history, including after later appends."""
    _check(lake, guard)
    table = lake._load(_name(table_id, kind))
    if table is None:
        return None
    if not manifest["files"]:
        snapshot = table.current_snapshot()
        return snapshot.snapshot_id if snapshot else None
    return _find(table, table_id, operation_id, kind, manifest, lake, guard, max_snapshots)


def _unreferenced(table, paths, table_id, kind, max_files, lake, guard):
    snapshot = table.current_snapshot()
    if snapshot is None:
        return
    examined = 0
    for number, manifest in enumerate(read_manifest_list(table.io.new_input(snapshot.manifest_list)), 1):
        if number > max(1, max_files):
            raise TimeoutError("Bulk admission manifest inventory exceeds its configured limit.")
        _check(lake, guard)
        entries = _manifest_entries(table, manifest, table.spec(), max_files - examined, lambda: _check(lake, guard))
        for entry in entries:
            examined += 1
            if entry.data_file.file_path in paths:
                raise ConflictError("Prepared files are already referenced without a retained admission marker.")
            if entry.status != ManifestEntryStatus.DELETED:
                file = entry.data_file
                if file.content != DataFileContent.DATA:
                    raise ConflictError("Bulk admission requires a table without external delete files.")
                if file.record_count and (kind == "wide" or file.partition[0] == table_id):
                    raise ConflictError("Bulk initial admission requires an empty registered dataset target.")


def _no_rebase(table, lake, guard):
    key = TableProperties.COMMIT_NUM_RETRIES
    if table.properties.get(key) != "0":
        with table.transaction() as transaction:
            transaction.set_properties({key: "0"})
            _check(lake, guard)
        table.refresh()
        _check(lake, guard)
    if table.properties.get(key) != "0":
        raise ConflictError("The owned table must disable automatic catalog rebasing before bulk admission.")


def admit(lake, table_id, operation_id, root, kind, manifest, schema, *, guard,
          max_files=100000, max_snapshots=100000, max_manifest_bytes=64 * MiB, max_footer_bytes=8 * MiB):
    """Append one complete prepared file set atomically under the caller's writer lease.

    Catalog retries are disabled on the owned table before appending. A conflict must
    reacquire the lease and check retained operation history before another attempt.
    Empty file sets are no-ops; normal snapshot validation supplies empty table snapshots.
    """
    lease_guard = guard
    checked_at = [-float("inf")]

    def guard():
        now = monotonic()
        if now - checked_at[0] >= 1:
            lease_guard()
            checked_at[0] = now

    _check(lake, lease_guard)
    name = _name(table_id, kind)
    files = _entries(lake, table_id, kind, manifest, max_files, max_manifest_bytes, guard)
    if kind == "narrow" and not schema.equals(SEARCH_SCHEMA, check_metadata=False):
        raise ValueError("Prepared search admission requires the canonical search schema.")
    _check(lake, guard)
    if not files:
        table = lake._load(name)
        snapshot = table.current_snapshot() if table else None
        return snapshot.snapshot_id if snapshot else None
    header = manifest.get("admission")
    if (not isinstance(header, dict) or header.get("version") != 1 or header.get("table") != name
            or header.get("source_manifest") != _identity(table_id, operation_id, kind, manifest)[1]
            or header.get("seal_sha256") != _seal(manifest, header)):
        raise ValueError("The prepared admission manifest is not sealed or changed after verification.")
    table = lake._ensure(name, schema)
    if (header["schema"] != table.schema().model_dump_json() or header["spec"] != table.spec().model_dump_json()
            or header["table_uuid"] is not None and header["table_uuid"] != str(table.metadata.table_uuid)):
        raise ConflictError("The target schema, partition spec or table identity changed after preparation.")
    committed = _find(table, table_id, operation_id, kind, manifest, lake, guard, max_snapshots)
    if committed is not None:
        _check(lake, lease_guard)
        return committed
    paths = {_uri(lake, table_id, operation_id, kind, entry) for entry in files}
    _unreferenced(table, paths, table_id, kind, max_files - len(paths), lake, guard)
    _no_rebase(table, lake, lease_guard)
    _check(lake, guard)
    committed = _find(table, table_id, operation_id, kind, manifest, lake, guard, max_snapshots)
    if committed is not None:
        _check(lake, lease_guard)
        return committed
    mapping = table.metadata.name_mapping() or table.schema().name_mapping
    if mapping.model_dump_json() != header["mapping"]:
        raise ConflictError("The target field name mapping changed after preparation.")
    operation, identity = _identity(table_id, operation_id, kind, manifest)
    _unreferenced(table, paths, table_id, kind, max_files - len(paths), lake, guard)
    properties = {OPERATION: operation, IDENTITY: identity, DATASET: table_id,
                  KIND: kind, CAPSULE: header["seal_sha256"]}
    with table.transaction() as transaction:
        if table.metadata.name_mapping() is None:
            transaction.set_properties({TableProperties.DEFAULT_NAME_MAPPING: mapping.model_dump_json()})
        with transaction.update_snapshot(snapshot_properties=properties).fast_append() as append:
            for entry in files:
                uri = _uri(lake, table_id, operation_id, kind, entry)
                receipt = entry.get("upload")
                if (receipt is None or receipt.get("uri") != uri or receipt.get("sha256") != entry["sha256"]
                        or receipt.get("bytes") != entry["bytes"]):
                    raise ValueError("The prepared file has no durable upload receipt.")
                statistics = _decode_statistics(receipt["statistics"])
                if statistics["record_count"] != entry["rows"]:
                    raise ValueError("The sealed file metrics differ from its declared row count.")
                partition, _ = _partition(lake, table_id, kind, entry)
                append.append_data_file(DataFile.from_args(
                    content=DataFileContent.DATA, file_path=uri, file_format=FileFormat.PARQUET,
                    partition=Record(*partition), file_size_in_bytes=entry["bytes"], spec_id=table.spec().spec_id,
                    sort_order_id=None, equality_ids=None, key_metadata=None, **statistics,
                ))
                _check(lake, guard)
            _check(lake, lease_guard)
        _check(lake, lease_guard)
    _check(lake, lease_guard)
    table.refresh()
    committed = _find(table, table_id, operation_id, kind, manifest, lake, guard, max_snapshots)
    if committed is None:
        raise RuntimeError("The bulk admission marker is unavailable. Retry with the same operation identity.")
    _check(lake, lease_guard)
    return committed


def cleanup_uploads(lake, table_id, operation_id, root, kind, manifest, *, guard,
                    max_files=100000, max_snapshots=100000, max_manifest_bytes=64 * MiB,
                    max_object_versions=1000):
    """Discard only verified unadmitted operation objects, including unacknowledged uploads.

    The caller first excludes an activation intent, stops preparation, and retains the
    dataset reservation until discard finishes. A marker in either physical table
    requires recovery followed by normal dataset removal instead of discard.
    """
    _name(table_id, kind)
    operation = str(UUID(operation_id))
    files = _entries(lake, table_id, kind, manifest, max_files, max_manifest_bytes, guard)
    _positive(max_snapshots, "snapshot inventory limit")
    _positive(max_object_versions, "object version inventory limit")
    for name in (wide_name(table_id), search_name):
        _check(lake, guard)
        table = lake._load(name)
        if table is None:
            continue
        snapshots = table.snapshots()
        if len(snapshots) > max_snapshots:
            raise ValueError("The discard marker history exceeds its configured snapshot limit.")
        for snapshot in snapshots:
            _check(lake, guard)
            if snapshot.summary and snapshot.summary.get(OPERATION) == operation:
                raise ConflictError("Bulk admission has begun. Recover it before removing the dataset.")
    client = lake._s3_client()
    removed, size, versioning = 0, 0, {}
    for entry in files:
        uri = _uri(lake, table_id, operation_id, kind, entry)
        bucket, key = _bucket_key(uri)
        _check(lake, guard)
        if bucket not in versioning:
            versioning[bucket] = client.get_bucket_versioning(Bucket=bucket).get("Status") in ("Enabled", "Suspended")
        versioned = versioning[bucket]
        if versioned:
            page = client.list_object_versions(Bucket=bucket, Prefix=key, MaxKeys=min(1000, max_object_versions + 1))
            versions = [item for field in ("Versions", "DeleteMarkers")
                        for item in page.get(field, ()) if item["Key"] == key]
            if page.get("IsTruncated") or len(versions) > max_object_versions:
                raise ValueError("The discard object history exceeds its configured version limit.")
        else:
            head = _head(client, bucket, key)
            versions = [{"Key": key, "head": head}] if head else []
        verified = []
        for version in versions:
            _check(lake, guard)
            args = {"Bucket": bucket, "Key": key}
            if "VersionId" in version:
                args["VersionId"] = version["VersionId"]
            # Delete markers carry no content. Their exact operation URI is still bounded above.
            if versioned and "Size" not in version:
                verified.append((args, None))
                continue
            head = version.get("head") or client.head_object(**args)
            if head["ContentLength"] != entry["bytes"] or head.get("Metadata", {}).get("sha256") != entry["sha256"]:
                raise ConflictError("An operation upload has a different immutable identity; discard stopped.")
            receipt = entry.get("upload", {})
            if (receipt.get("uri"), receipt.get("sha256"), receipt.get("bytes"), receipt.get("etag")) != (
                uri, entry["sha256"], entry["bytes"], head["ETag"],
            ):
                body = client.get_object(**args)["Body"]
                digest = sha256()
                try:
                    for block in iter(lambda: body.read(MiB), b""):
                        _check(lake, guard)
                        digest.update(block)
                finally:
                    body.close()
                if digest.hexdigest() != entry["sha256"]:
                    raise ConflictError("An operation upload changed; discard stopped without deleting it.")
            verified.append((args, head))
        for args, head in verified:
            _check(lake, guard)
            if head is not None:
                args["IfMatch"] = head["ETag"]
            client.delete_object(**args)
            removed += 1
            size += head["ContentLength"] if head else 0
        _check(lake, guard)
        if _head(client, bucket, key) is not None:
            raise ConflictError("An operation upload remains after discard. Keep its reservation and retry.")
    return {"objects": removed, "bytes": size}


def snapshots(lake, table_id, wide_schema, *, guard, max_files=100000):
    """Return current snapshot IDs and exact live counts using a bounded metadata stream."""
    _positive(max_files, "snapshot file inventory limit")
    _check(lake, guard)
    checked_at = [-float("inf")]

    def periodic():
        now = monotonic()
        if now - checked_at[0] >= 1:
            guard()
            checked_at[0] = now

    tables = (lake._ensure(search_name, SEARCH_SCHEMA), lake._ensure(wide_name(table_id), wide_schema))
    totals, ids, examined, manifests = [], [], 0, 0
    for index, table in enumerate(tables):
        _check(lake, guard)
        if table.current_snapshot() is None:
            # An empty append creates the valid zero-row snapshot used by ordinary final validation.
            _no_rebase(table, lake, guard)
            with table.transaction() as transaction:
                with transaction.update_snapshot().fast_append():
                    _check(lake, guard)
                _check(lake, guard)
            table.refresh()
        snapshot = table.current_snapshot()
        if snapshot is None:
            raise RuntimeError("An empty target snapshot is unavailable. Retry bulk activation.")
        ids.append(snapshot.snapshot_id)
        count, seen = 0, set()
        for manifest in read_manifest_list(table.io.new_input(snapshot.manifest_list)):
            manifests += 1
            if manifests > max_files:
                raise TimeoutError("Bulk validation manifest inventory exceeds its configured limit.")
            _check(lake, periodic)
            entries = _manifest_entries(table, manifest, table.spec(), max_files - examined,
                                        lambda: _check(lake, periodic))
            for entry in entries:
                examined += 1
                if entry.status == ManifestEntryStatus.DELETED:
                    continue
                file = entry.data_file
                if file.content != DataFileContent.DATA or file.record_count < 0 or file.file_path in seen:
                    raise RuntimeError("Bulk validation found delete files, invalid counts or repeated data files.")
                seen.add(file.file_path)
                if index or file.partition[0] == table_id:
                    count += file.record_count
            _check(lake, periodic)
        totals.append(count)
    _check(lake, guard)
    return ids[0], ids[1], tuple(totals)
