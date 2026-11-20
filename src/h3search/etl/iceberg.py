"""REST-catalog writer with explicit S3 ownership and snapshot maintenance."""

from base64 import b64encode
from bisect import bisect_left, bisect_right
from collections import Counter, OrderedDict
from datetime import UTC, datetime, timedelta
from hashlib import md5
from time import monotonic
from urllib.parse import urlsplit

import pyarrow as pa
import pyarrow.parquet as pq
import psutil

from pyiceberg.catalog import load_catalog
from pyiceberg.conversions import from_bytes
from pyiceberg.exceptions import NoSuchTableError
from pyiceberg.expressions import And, EqualTo, GreaterThanOrEqual, In, LessThanOrEqual
from pyiceberg.io.pyarrow import _dataframe_to_data_files, _pyarrow_to_schema_without_ids, schema_to_pyarrow
from pyiceberg.manifest import DataFileContent
from pyiceberg.partitioning import PartitionField, PartitionSpec
from pyiceberg.schema import assign_fresh_schema_ids
from pyiceberg.table.sorting import SortField, SortOrder
from pyiceberg.transforms import BucketTransform, IdentityTransform

from h3search.control import ConflictError
from .lake import read_compaction_batches
from .layout import SEARCH_SCHEMA, search_name, wide_name
from .manifests import is_regroup, regroup
from .offsets import normalize_wide_offsets, without_offsets


def _bucket_key(uri):
    parsed = urlsplit(uri)
    if parsed.scheme != "s3" or not parsed.netloc or not parsed.path.strip("/"):
        raise ValueError("The Iceberg warehouse must use a non-root s3:// bucket prefix.")
    return parsed.netloc, parsed.path.strip("/")


def _sign_delete_checksum(request, **_):
    if "Content-MD5" not in request.headers:
        request.headers["Content-MD5"] = b64encode(md5(request.body, usedforsecurity=False).digest()).decode("ascii")


class IcebergLake:
    """Manage the shared search and dataset-specific wide Iceberg tables."""

    def __init__(self, settings, catalog=None):
        self.settings = settings
        self.namespace = settings.namespace
        self.resolution = settings.partition_resolution
        self.buckets = settings.wide_bucket_count
        self.warehouse = settings.warehouse.rstrip("/")
        self.properties = {
            "format-version": "2",
            "write.parquet.compression-codec": "zstd",
            "write.parquet.row-group-limit": str(settings.parquet_row_group_rows),
            "write.target-file-size-bytes": str(settings.target_file_mb * 1024 * 1024),
            "write.object-storage.enabled": "false",
            "write.metadata.metrics.default": "truncate(16)",
            "write.metadata.metrics.column.object_id": "full",
            "write.metadata.metrics.column.lat": "full",
            "write.metadata.metrics.column.lon": "full",
            # Scheduled reclamation is the sole metadata deletion owner.
            "write.metadata.delete-after-commit.enabled": "false",
            "write.metadata.previous-versions-max": "2",
            "commit.manifest-merge.enabled": "true",
        }
        self.catalog = catalog or self._catalog()
        self._s3 = None
        self._compaction_inventory = None

    def _catalog(self):
        s = self.settings
        if not s.catalog_uri or not self.warehouse:
            raise ValueError("Live ingestion requires an Iceberg REST catalog URI and S3 warehouse.")
        _bucket_key(f"{self.warehouse}/{self.namespace}")
        properties = {
            "type": "rest", "uri": s.catalog_uri, "warehouse": self.warehouse,
            "s3.endpoint": s.s3_endpoint, "s3.access-key-id": s.s3_access_key,
            "s3.secret-access-key": s.s3_secret_key, "s3.region": s.s3_region,
            "s3.force-virtual-addressing": str(not s.s3_path_style).lower(),
            "token": s.catalog_token, "ssl.cabundle": s.catalog_ca_bundle,
            "s3.ca-bundle": s.s3_ca_bundle,
        }
        return load_catalog(s.catalog_name, **{key: value for key, value in properties.items() if value})

    def _id(self, name):
        return self.namespace, name

    def _location(self, name):
        return f"{self.warehouse}/{self.namespace}/{name}" if self.warehouse else None

    def _load(self, name):
        try:
            return self.catalog.load_table(self._id(name))
        except NoSuchTableError:
            return None

    def _ensure(self, name, schema):
        table = self._load(name)
        iceberg_schema = assign_fresh_schema_ids(_pyarrow_to_schema_without_ids(schema))
        search = name == search_name
        if search:
            columns = ("table_id", f"h3_r{self.resolution}")
            transforms = (IdentityTransform(), IdentityTransform())
            partitions = columns
        else:
            columns = ("object_id",)
            transforms = (BucketTransform(self.buckets),)
            partitions = ("object_bucket",)
        spec = PartitionSpec(*(
            PartitionField(source_id=iceberg_schema.find_field(source).field_id,
                           field_id=1000 + index, transform=transform, name=partition)
            for index, (source, transform, partition) in enumerate(zip(columns, transforms, partitions))
        ))
        if table is None:
            self.catalog.create_namespace_if_not_exists(self.namespace)
            table = self.catalog.create_table_if_not_exists(
                self._id(name), iceberg_schema, location=self._location(name), partition_spec=spec,
                sort_order=SortOrder(SortField(iceberg_schema.find_field("object_id").field_id, IdentityTransform())),
                properties=self.properties,
            )
        if not table.spec().compatible_with(spec) or len(table.specs()) != 1:
            raise RuntimeError("Iceberg partition layout differs from configuration. Use the original partition settings.")
        if table.schema().fields != iceberg_schema.fields:
            raise RuntimeError("Iceberg physical fields differ from the registered schema. Remove and reload.")
        if self.warehouse and table.location().rstrip("/") != self._location(name):
            raise RuntimeError("Iceberg table location differs from its configured owned path.")
        self._scheduled_metadata_cleanup(table)
        return table

    @staticmethod
    def _scheduled_metadata_cleanup(table):
        key = "write.metadata.delete-after-commit.enabled"
        if table.properties.get(key, "false").lower() == "true":
            with table.transaction() as transaction:
                transaction.set_properties({key: "false"})

    def _write(self, table, data, batch_id, predicate=None, *, wide=False, guard=lambda: None):
        snapshot = table.current_snapshot()
        applied = snapshot is not None and snapshot.summary and snapshot.summary.get("h3search.batch-id") == batch_id
        if not applied:
            marker = {"h3search.batch-id": batch_id}
            data = data.sort_by("object_id")
            if predicate is None:
                table.append(data, snapshot_properties=marker)
            else:
                table.overwrite(data, overwrite_filter=predicate, snapshot_properties=marker)
        if wide:
            self._normalize_wide_table(table, lambda: True, guard)

    def _replacement_keys(self, table, keys, *, table_id=None, guard):
        """Retain keys that file bounds cannot prove absent from the current head."""
        snapshot = table.current_snapshot()
        if snapshot is None or not keys:
            return []
        field = table.schema().find_field("object_id")
        ordered = sorted(set(keys))
        candidates = set()
        for index, file in enumerate(self._candidate_files(table, ordered[0], ordered[-1], table_id)):
            if index % 128 == 0:
                guard()
            if table_id is not None and file.partition[0] != table_id:
                continue
            lower = (file.lower_bounds or {}).get(field.field_id)
            upper = (file.upper_bounds or {}).get(field.field_id)
            if lower is None or upper is None:
                return ordered
            low, high = from_bytes(field.field_type, lower), from_bytes(field.field_type, upper)
            if low > high:
                raise RuntimeError("Iceberg OBJECTID bounds are invalid.")
            candidates.update(ordered[bisect_left(ordered, low):bisect_right(ordered, high)])
            if len(candidates) == len(ordered):
                break
        return sorted(candidates)

    @staticmethod
    def _candidate_files(table, low, high, table_id):
        """Prune manifests and files using a bounded ID interval and dataset identity."""
        predicate = And(GreaterThanOrEqual("object_id", low), LessThanOrEqual("object_id", high))
        if table_id is not None:
            predicate = And(EqualTo("table_id", table_id), predicate)
        for task in table.scan(row_filter=predicate).plan_files():
            if task.delete_files:
                raise RuntimeError("Unsupported external Iceberg delete files found in an owned table.")
            yield task.file

    def apply(self, table_id, batch_id, wide, keys=None, *, guard=lambda: None):
        """Apply a staged mutation with replay markers in both Iceberg heads."""
        search_table = self._ensure(search_name, SEARCH_SCHEMA)
        wide_table = self._ensure(wide_name(table_id), wide.schema)
        values = [] if keys is None else keys.to_pylist()
        wide_keys = self._replacement_keys(wide_table, values, guard=guard)
        predicate = In("object_id", wide_keys) if wide_keys else None
        guard()
        self._write(wide_table, wide, batch_id, predicate, wide=True, guard=guard)
        search_keys = self._replacement_keys(search_table, values, table_id=table_id, guard=guard)
        search_predicate = And(EqualTo("table_id", table_id), In("object_id", search_keys)) if search_keys else None
        guard()
        self._write(search_table, wide.select(SEARCH_SCHEMA.names), batch_id, search_predicate)

    def apply_initial_wide(self, table_id, batch_id, wide, *, guard):
        """Append the wide half of an initial batch using its normal replay marker."""
        table = self._ensure(wide_name(table_id), wide.schema)
        guard()
        self._write(table, wide, batch_id, wide=True, guard=guard)

    def apply_initial_search(self, batch_id, narrow, *, guard):
        """Append a grouped narrow batch without replaying its wide records."""
        table = self._ensure(search_name, SEARCH_SCHEMA)
        guard()
        self._write(table, narrow, batch_id)

    @staticmethod
    def _data_files(table, snapshot):
        for manifest in snapshot.manifests(table.io):
            for entry in manifest.fetch_manifest_entry(table.io):
                if entry.data_file.content != DataFileContent.DATA:
                    raise RuntimeError("Unsupported external Iceberg delete files found in an owned table.")
                yield entry.data_file

    def snapshots(self, table_id, wide_schema):
        """Validate the exact row totals from owned Iceberg data file metadata."""
        search = self._ensure(search_name, SEARCH_SCHEMA)
        wide = self._ensure(wide_name(table_id), wide_schema)
        for table, schema in ((search, SEARCH_SCHEMA), (wide, wide_schema)):
            if table.current_snapshot() is None:
                table.append(schema.empty_table())
        index_head, wide_head = search.current_snapshot(), wide.current_snapshot()
        search_count = sum(file.record_count for file in self._data_files(search, index_head) if file.partition[0] == table_id)
        wide_count = sum(file.record_count for file in self._data_files(wide, wide_head))
        return index_head.snapshot_id, wide_head.snapshot_id, (search_count, wide_count)

    def remove_rows(self, table_id):
        """Delete the dataset identity partitions from the current search head."""
        table = self._ensure(search_name, SEARCH_SCHEMA)
        self._write(table, SEARCH_SCHEMA.empty_table(), f"remove-{table_id}", EqualTo("table_id", table_id))
        return table.current_snapshot().snapshot_id

    def location(self, name):
        """Return the verified storage prefix for a dataset's owned table."""
        table = self._load(name)
        expected = self._location(name)
        if not expected and self.settings.mode == "local":
            expected = f"{self.catalog.properties['warehouse'].rstrip('/')}/{self.namespace}/{name}"
        if table and table.location().rstrip("/") != expected:
            raise RuntimeError("The table does not match its configured owned storage prefix.")
        return expected

    def _s3_client(self):
        if self._s3 is None:
            import boto3
            from botocore.config import Config

            s = self.settings
            self._s3 = boto3.client(
                "s3", endpoint_url=s.s3_endpoint or None, region_name=s.s3_region,
                aws_access_key_id=s.s3_access_key or None, aws_secret_access_key=s.s3_secret_key or None,
                verify=s.s3_ca_bundle or None,
                config=Config(s3={"addressing_style": "path" if s.s3_path_style else "virtual"}),
            )
            self._s3.meta.events.register("before-sign.s3.DeleteObjects", _sign_delete_checksum)
        return self._s3

    def _objects(self, location):
        bucket, prefix = _bucket_key(location)
        client = self._s3_client()
        for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix + "/"):
            for obj in page.get("Contents", ()):
                yield bucket, obj

    def _purge_prefix(self, location):
        bucket, prefix = _bucket_key(location)
        prefix += "/"
        client = self._s3_client()
        previous_uploads = None
        while True:
            markers, seen = {}, set()
            identities = []
            while True:
                # Some S3-compatible servers omit uploads when Prefix is supplied.
                # Scan bounded pages and apply the exact owned prefix locally.
                uploads = client.list_multipart_uploads(Bucket=bucket, MaxUploads=1000, **markers)
                items = uploads.get("Uploads", [])
                if len(items) > 1000 or any(not isinstance(item.get("Key"), str) or not item.get("UploadId") for item in items):
                    raise RuntimeError("S3 returned an invalid multipart listing.")
                identities = [(item["Key"], item["UploadId"]) for item in items if item["Key"].startswith(prefix)]
                if identities or not uploads.get("IsTruncated"):
                    break
                marker = (uploads.get("NextKeyMarker"), uploads.get("NextUploadIdMarker"))
                if not marker[0] or marker in seen:
                    raise RuntimeError("S3 multipart listing made no progress.")
                seen.add(marker)
                markers = {"KeyMarker": marker[0]}
                if marker[1]:
                    markers["UploadIdMarker"] = marker[1]
            if not identities:
                break
            if identities == previous_uploads:
                raise RuntimeError("S3 still lists incomplete uploads below the removed storage prefix.")
            for key, upload_id in identities:
                client.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id)
            previous_uploads = identities
        versioned = client.get_bucket_versioning(Bucket=bucket).get("Status") in ("Enabled", "Suspended")
        list_page = client.list_object_versions if versioned else client.list_objects_v2
        previous = None
        while True:
            # Re-list the first page so the deletion cannot invalidate a continuation marker.
            page = list_page(Bucket=bucket, Prefix=prefix, MaxKeys=1000)
            if versioned:
                keys = [
                    {"Key": item["Key"], "VersionId": item["VersionId"]}
                    for field in ("Versions", "DeleteMarkers") for item in page.get(field, ())
                ]
            else:
                keys = [{"Key": item["Key"]} for item in page.get("Contents", ())]
            if not keys and not page.get("IsTruncated"):
                break
            if not keys or len(keys) > 1000 or any(not item["Key"].startswith(prefix) for item in keys):
                raise RuntimeError("S3 returned an invalid listing for the owned storage prefix.")
            if keys == previous:
                raise RuntimeError("S3 still lists objects below the removed storage prefix.")
            result = client.delete_objects(Bucket=bucket, Delete={"Objects": keys, "Quiet": True})
            if result.get("Errors"):
                raise RuntimeError("S3 could not reclaim one or more objects below the owned storage prefix.")
            previous = keys
        if versioned and next(self._objects(location), None) is not None:
            raise RuntimeError("S3 still lists objects below the removed storage prefix.")

    def drop_wide(self, table_id, location):
        """Drop catalog metadata and verify reclamation of the owned wide prefix."""
        name = wide_name(table_id)
        if location != self._location(name):
            raise RuntimeError("Cannot reclaim a non-owned storage prefix.")
        self.location(name)
        try:
            self.catalog.drop_table(self._id(name))
        except NoSuchTableError:
            pass
        self._purge_prefix(location)

    def drop_owned_table(self, name, location):
        """Drop only an inventoried application table and its verified configured prefix."""
        from .layout import owned_table_name

        if not owned_table_name(name):
            raise RuntimeError("Cannot reclaim a non-owned storage prefix.")
        if not self.warehouse and self.settings.mode == "local":
            from pathlib import Path
            from shutil import rmtree
            expected = Path(self.catalog.properties["warehouse"]) / self.namespace / name
            warehouse = Path(self.catalog.properties["warehouse"]).resolve()
            if expected.resolve() != warehouse / self.namespace / name or Path(location).resolve() != expected.resolve():
                raise RuntimeError("Cannot reclaim a non-owned local Iceberg directory.")
            self.location(name)
            try:
                self.catalog.drop_table(self._id(name))
            except NoSuchTableError:
                pass
            if expected.exists():
                rmtree(expected)
            return
        if not self.warehouse or location != self._location(name):
            raise RuntimeError("Cannot reclaim a non-owned storage prefix.")
        # Validate before dropping catalog identity so a bad pointer remains diagnosable.
        self.location(name)
        try:
            self.catalog.drop_table(self._id(name))
        except NoSuchTableError:
            pass
        self._purge_prefix(location)

    def _search_regroup_head(self, published, name=search_name):
        if name != search_name:
            import re
            if not re.fullmatch(r"search_r3_[0-9a-f]{32}", name):
                raise ConflictError("Manifest regroup requires an owned search table.")
        table = self._load(name)
        if (table is None or (self.warehouse and table.location().rstrip("/") != self._location(name))
                or table.snapshot_by_id(published) is None):
            raise ConflictError("The published search snapshot is unavailable in the owned Iceberg table.")
        if name != search_name:
            from .manifests import validate_generation
            validate_generation(table, table.snapshot_by_id(published), name)
        head = table.current_snapshot()
        if head is None or (head.snapshot_id != published and not is_regroup(head, published)):
            raise ConflictError("The Iceberg search head differs from the publication. Resolve existing work before optimizing search.")
        if name != search_name and head.snapshot_id != published:
            parent = table.snapshot_by_id(published)
            if any(head.summary.get(key) != parent.summary.get(key) for key in ("h3search.load-id", "h3search.load-content")):
                raise ConflictError("The R3 regroup differs from its sealed generation identity.")
        return table, head

    def regroup_search(self, published, can_continue, memory_check, guard, *, name=search_name):
        """Regroup one published search head or recover its committed direct child."""
        deadline = monotonic() + self.settings.manifest_regroup_budget_sec

        def check():
            if not can_continue() or monotonic() >= deadline:
                raise TimeoutError("Search manifest regroup reached its time budget.")
            memory_check()

        check()
        table, head = self._search_regroup_head(published, name)
        if head.snapshot_id != published:
            from .manifests import verify_inventory
            verify_inventory(table, table.snapshot_by_id(published), head, self.settings.manifest_regroup_max_files, check)
            return head.snapshot_id
        return regroup(table, head, 3 if name != search_name else self.resolution, self.settings.manifest_regroup_max_files,
                       self.settings.manifest_regroup_max_entries, check, guard,
                       name=name if name != search_name else None)

    def verify_search_regroup(self, published, candidate, *, name=search_name, check=lambda: None, verify_inventory=True):
        """Recheck the candidate immediately before replacing the publication."""
        table, head = self._search_regroup_head(published, name)
        if head.snapshot_id != candidate or not is_regroup(head, published):
            raise ConflictError("The search regroup snapshot changed before publication. Retry the operation.")
        identity = (str(table.metadata.table_uuid), table.location(), table.schema().model_dump_json(),
                    table.spec().model_dump_json(), table.sort_order().model_dump_json(),
                    tuple(sorted(table.properties.items())), head.snapshot_id, head.parent_snapshot_id,
                    head.manifest_list, head.sequence_number, head.schema_id,
                    head.summary.model_dump_json())
        if not verify_inventory:
            return identity
        from .manifests import verify_inventory as prove_inventory
        deadline = monotonic() + self.settings.manifest_regroup_budget_sec
        def bounded():
            check()
            if monotonic() >= deadline:
                raise TimeoutError("Search manifest regroup verification reached its time budget.")
        prove_inventory(table, table.snapshot_by_id(published), head, self.settings.manifest_regroup_max_files, bounded)
        return identity

    def compaction_head(self, name):
        """Return a file-only replacement head eligible for publication after recovery."""
        table = self._load(name)
        snapshot = table.current_snapshot() if table else None
        if snapshot and snapshot.summary and snapshot.summary.get("h3search.compaction") == "true":
            return snapshot.snapshot_id
        return None

    def _compaction_signature(self, table, snapshot, target, max_files):
        return (
            table.metadata.table_uuid, table.location(), snapshot.snapshot_id,
            table.schema().model_dump_json(),
            tuple(spec.model_dump_json() for _, spec in sorted(table.specs().items())),
            target, max_files, self.settings.manifest_regroup_max_files, self.settings.memory_budget_mb,
        )

    def _compaction_check(self, can_continue):
        if not can_continue():
            return False
        if psutil.Process().memory_info().rss >= self.settings.memory_budget_mb * 1024 * 1024:
            raise MemoryError("Compaction reached its configured process memory budget.")
        return True

    def _normalize_wide_table(self, table, can_continue, guard):
        def check():
            if not self._compaction_check(can_continue):
                raise TimeoutError("Wide-file metadata normalization reached its maintenance boundary.")

        return normalize_wide_offsets(table, self.settings.manifest_regroup_max_files, check, guard)

    def normalize_wide(self, name, can_continue, guard):
        """Remove optional wide-file split hints without rewriting record data."""
        if wide_name(name.removeprefix("wide_")) != name:
            raise ValueError("Wide-file metadata normalization requires a wide table.")
        table = self._load(name)
        if table and self.warehouse and table.location().rstrip("/") != self._location(name):
            raise RuntimeError("The table does not match its configured owned storage prefix.")
        return self._normalize_wide_table(table, can_continue, guard) if table else None

    @staticmethod
    def _compaction_order(file, column):
        lower = (file.lower_bounds or {}).get(column)
        upper = (file.upper_bounds or {}).get(column)
        if lower is None or upper is None:
            return (1, 0, 0, file.file_path)
        return (0, int.from_bytes(lower, "little", signed=True),
                int.from_bytes(upper, "little", signed=True), file.file_path)

    def _compaction_candidates(self, table, snapshot, target, max_files, can_continue):
        signature = self._compaction_signature(table, snapshot, target, max_files)
        cached = self._compaction_inventory
        if cached is not None and cached["signature"] == signature:
            return cached
        self._compaction_inventory = None
        groups = OrderedDict()
        for count, file in enumerate(self._data_files(table, snapshot), 1):
            if count % 128 == 1 and not self._compaction_check(can_continue):
                return None
            if count > self.settings.manifest_regroup_max_files:
                raise MemoryError("Compaction inventory exceeds its configured file limit.")
            if file.file_size_in_bytes <= target // 2:
                partition = tuple(file.partition[index] for index in range(len(table.spec().fields)))
                groups.setdefault(partition, []).append(file)
        if not self._compaction_check(can_continue):
            return None
        column = table.schema().find_field("object_id").field_id
        groups = OrderedDict((key, sorted(files, key=lambda file: self._compaction_order(file, column)))
                             for key, files in groups.items() if len(files) > 1)
        cached = {"signature": signature, "groups": groups, "sizes": {}, "column": column}
        self._compaction_inventory = cached
        return cached

    def _compaction_groups(self, table, inventory, target, max_files, can_continue, *, remaining=None, excluded=(), group_limit=128):
        groups = {}
        remaining = target if remaining is None else remaining
        for partition in list(inventory["groups"]):
            if len(groups) == group_limit or remaining <= 0:
                break
            if partition in excluded:
                continue
            selected, total = [], 0
            eligible = 0
            for file in inventory["groups"][partition]:
                if not self._compaction_check(can_continue):
                    return None
                size = inventory["sizes"].get(file.file_path)
                if size is None:
                    with table.io.new_input(file.file_path).open() as stream, pq.ParquetFile(stream) as parquet:
                        size = sum(parquet.metadata.row_group(i).total_byte_size for i in range(parquet.num_row_groups))
                    inventory["sizes"][file.file_path] = size
                if size > target // 2:
                    continue
                eligible += 1
                if total + size > remaining:
                    if len(selected) >= 2:
                        break
                    selected, total = [], 0
                    if size > remaining:
                        continue
                selected.append(file)
                total += size
                if len(selected) == max_files:
                    break
            if len(selected) >= 2:
                groups[partition] = selected
                remaining -= total
            # Immutable file sizes cannot form a group under this cached target.
            elif eligible < 2:
                exhausted = inventory["groups"].pop(partition)
                for file in exhausted:
                    inventory["sizes"].pop(file.file_path, None)
        return groups

    def _read_compaction_group(self, table, files, schema, remaining, can_continue):
        batches, size = [], 0
        for file in files:
            if not self._compaction_check(can_continue):
                return None
            with table.io.new_input(file.file_path).open() as stream, pq.ParquetFile(stream) as parquet:
                decoded = read_compaction_batches(parquet, remaining - size, can_continue, schema)
            if decoded is None:
                return None
            file_batches, file_size = decoded
            batches.extend(file_batches)
            size += file_size
        return batches, size

    def compact_unit(self, name, max_files, byte_limit, can_continue, guard):
        """Replace bounded groups of adjacent small files in up to 128 partitions."""
        table = self._load(name)
        snapshot = table.current_snapshot() if table else None
        if not snapshot or max_files < 2:
            self._compaction_inventory = None
            return None
        target = min(byte_limit, self.settings.target_file_mb * 1024 * 1024)
        if not self._compaction_check(can_continue):
            return None
        inventory = self._compaction_candidates(table, snapshot, target, max_files, can_continue)
        if inventory is None:
            return None
        schema = schema_to_pyarrow(table.schema(), include_field_ids=False)
        batches = []
        remaining = target
        decoded_sizes = Counter()
        groups, attempted = {}, set()
        while len(groups) < 128:
            candidates = self._compaction_groups(
                table, inventory, target, max_files, can_continue, remaining=remaining,
                excluded=attempted, group_limit=128 - len(groups),
            )
            if not candidates:
                break
            for partition, group in candidates.items():
                attempted.add(partition)
                decoded = self._read_compaction_group(table, group, schema, remaining, can_continue)
                if decoded is None:
                    if not self._compaction_check(can_continue):
                        return None
                    continue
                file_batches, size = decoded
                remaining -= size
                decoded_sizes[partition] += size
                batches.extend(file_batches)
                groups[partition] = group
        if not groups or not self._compaction_check(can_continue):
            return None
        files = [file for group in groups.values() for file in group]
        data = pa.Table.from_batches(batches, schema=schema).sort_by("object_id")
        if len(data) != sum(file.record_count for file in files):
            raise RuntimeError("A compaction group did not preserve its row count.")
        if not self._compaction_check(can_continue):
            return None
        guard()
        with table.transaction() as tx:
            tx.set_properties({"write.metadata.delete-after-commit.enabled": "false"})
            with tx.update_snapshot(snapshot_properties={"h3search.compaction": "true"}).overwrite() as rewrite:
                output = list(_dataframe_to_data_files(
                    table_metadata=table.metadata, write_uuid=rewrite.commit_uuid, df=data, io=table.io,
                ))
                for file in output:
                    file.spec_id = table.spec().spec_id
                if name != search_name:
                    output = [without_offsets(file) for file in output]
                if len(output) >= len(files) or sum(file.record_count for file in output) != len(data):
                    raise RuntimeError("File replacement did not reduce file count or preserve row count.")
                partition_count = len(table.spec().fields)
                outputs = {}
                for file in output:
                    partition = tuple(file.partition[index] for index in range(partition_count))
                    outputs.setdefault(partition, []).append(file)
                if outputs.keys() != groups.keys() or any(
                    len(outputs[key]) >= len(group)
                    or sum(file.record_count for file in outputs[key]) != sum(file.record_count for file in group)
                    for key, group in groups.items()
                ):
                    raise RuntimeError("File replacement changed partition rows or did not reduce each group's files.")
                if not can_continue():
                    # Raise to abort the metadata transaction. Orphan retention reclaims its output.
                    raise TimeoutError("Maintenance window closed before committing file replacement.")
                guard()
                for file in output:
                    rewrite.append_data_file(file)
                for file in files:
                    rewrite.delete_data_file(file)
        head = table.current_snapshot()
        if head.snapshot_id == rewrite.snapshot_id and head.parent_snapshot_id == snapshot.snapshot_id:
            for partition, group in groups.items():
                replaced = {file.file_path for file in group}
                retained = [file for file in inventory["groups"][partition] if file.file_path not in replaced]
                retained.extend(file for file in outputs[partition] if file.file_size_in_bytes <= target // 2)
                if len(retained) > 1:
                    retained.sort(key=lambda file: self._compaction_order(file, inventory["column"]))
                    inventory["groups"][partition] = retained
                else:
                    del inventory["groups"][partition]
                for path in replaced:
                    inventory["sizes"].pop(path, None)
                if len(outputs[partition]) == 1 and len(retained) > 1:
                    inventory["sizes"][outputs[partition][0].file_path] = decoded_sizes[partition]
            inventory["signature"] = self._compaction_signature(table, head, target, max_files)
        else:
            self._compaction_inventory = None
        return head.snapshot_id

    def _retained_paths(self, table):
        # Current metadata is authoritative for all explicitly retained snapshots.
        yield table.metadata_location
        for entry in table.metadata.metadata_log:
            yield entry.metadata_file
        seen_manifests = set()
        for snapshot in table.metadata.snapshots:
            yield snapshot.manifest_list
            for manifest in snapshot.manifests(table.io):
                yield manifest.manifest_path
                if manifest.manifest_path in seen_manifests:
                    continue
                seen_manifests.add(manifest.manifest_path)
                for entry in manifest.fetch_manifest_entry(table.io):
                    yield entry.data_file.file_path
        for stat in (*table.metadata.statistics, *table.metadata.partition_statistics):
            yield stat.statistics_path

    def plan_maintenance(self, name, pinned, can_continue, *, removed_id=None):
        """Find one Iceberg snapshot or old unreferenced object to reclaim."""
        table = self._load(name)
        if table is None:
            return None
        cutoff = datetime.now(UTC) - timedelta(days=self.settings.snapshot_retention_days)
        pinned = {int(item) for item in pinned}
        refs = {ref.snapshot_id for ref in table.metadata.refs.values()}
        if table.current_snapshot():
            refs.add(table.current_snapshot().snapshot_id)
        for snapshot in table.metadata.snapshots:
            if not can_continue():
                return None
            if removed_id:
                relevant = any(file.partition[0] == removed_id for file in self._data_files(table, snapshot))
                if relevant and snapshot.snapshot_id in (pinned | refs):
                    raise RuntimeError("An Iceberg reference still retains the removed dataset.")
            else:
                relevant = snapshot.timestamp_ms < cutoff.timestamp() * 1000
            if relevant and snapshot.snapshot_id not in (pinned | refs):
                return "expire", snapshot.snapshot_id
        if removed_id:
            return "prefix", f"{self._location(name)}/data/table_id={removed_id}"
        # Reference sets hold file paths only, never row data.
        referenced = set()
        for path in self._retained_paths(table):
            if not can_continue():
                return None
            referenced.add(_bucket_key(path))
        for bucket, obj in self._objects(self._location(name)):
            if not can_continue():
                return None
            if obj["LastModified"] < cutoff and (bucket, obj["Key"]) not in referenced:
                return "file", (bucket, obj["Key"])
        return None

    def apply_maintenance(self, name, action, pinned):
        """Reclaim one planned Iceberg unit after rechecking any snapshot pin."""
        kind, item = action
        if kind == "expire":
            if str(item) in pinned:
                return False
            table = self._load(name)
            if table and table.snapshot_by_id(item):
                self._scheduled_metadata_cleanup(table)
                table.maintenance.expire_snapshots().by_id(item).commit()
            return True
        if kind == "prefix":
            self._purge_prefix(item)
            return False
        bucket, key = item
        self._s3_client().delete_object(Bucket=bucket, Key=key)
        return True

    def maintenance_unit(self, name, pinned, *, removed_id=None):
        """Reclaim a single Iceberg removal unit."""
        action = self.plan_maintenance(name, pinned, lambda: True, removed_id=removed_id)
        return self.apply_maintenance(name, action, pinned) if action else False
