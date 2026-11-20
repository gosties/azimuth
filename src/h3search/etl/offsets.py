"""Replace optional Iceberg split locations without rewriting wide data files."""

from collections import defaultdict
from pathlib import PurePosixPath
from urllib.parse import unquote, urlsplit
from uuid import uuid4

from pyiceberg.manifest import (
    DATA_FILE_TYPE, DataFile, DataFileContent, FileFormat, ManifestEntry, ManifestEntryStatus,
    read_manifest_list, write_manifest, write_manifest_list,
)
from pyiceberg.table.refs import SnapshotRefType
from pyiceberg.table.snapshots import (
    TOTAL_DATA_FILES, TOTAL_DELETE_FILES, TOTAL_EQUALITY_DELETES, TOTAL_FILE_SIZE,
    TOTAL_POSITION_DELETES, TOTAL_RECORDS, Operation, Snapshot, Summary,
)
from pyiceberg.table.update import (
    AddSnapshotUpdate, AssertCurrentSchemaId, AssertDefaultSpecId, AssertRefSnapshotId, SetSnapshotRefUpdate,
)
from pyiceberg.typedef import Record

from .manifests import _entry_identity, _manifest_entries, _owned_output


MARKER = "h3search.offset-normalize"
MAX_ENTRIES = 2048


def without_offsets(file):
    """Copy one v2 data file while omitting its optional recommended split locations."""
    fields = {field.name: getattr(file, field.name) for field in DATA_FILE_TYPE[2].fields}
    fields["split_offsets"] = None
    normalized = DataFile.from_args(_table_format_version=2, **fields)
    normalized.spec_id = file.spec_id
    return normalized


def _owned(path, prefix):
    return path.startswith(prefix) and ".." not in PurePosixPath(unquote(urlsplit(path).path)).parts


def normalize_wide_offsets(table, max_files, check, guard):
    """Commit a strict replacement of the current v2 head with split offsets omitted."""
    if type(max_files) is not int or max_files < 1:
        raise ValueError("The wide offset file limit must be positive.")
    if table.metadata.format_version != 2 or len(table.specs()) != 1:
        raise RuntimeError("Wide offset normalization requires one v2 partition spec.")
    parent = table.current_snapshot()
    if parent is None:
        return None
    spec = table.spec()
    location = table.location().rstrip("/")
    if not urlsplit(location).path.strip("/") or not _owned(location + "/", location + "/"):
        raise RuntimeError("Wide offset normalization requires an owned table location.")
    if (not _owned(table.metadata_location, location + "/metadata/")
            or not _owned(parent.manifest_list, location + "/metadata/")):
        raise RuntimeError("Wide offset metadata is outside the owned table location.")
    summary = parent.summary.additional_properties if parent.summary else {}
    if int(summary.get(TOTAL_DATA_FILES, "0")) > max_files:
        raise TimeoutError("Wide offset inventory exceeds its configured file limit.")

    groups = defaultdict(list)
    inventory = {}
    examined = 0
    changed = False
    check()
    for manifest in read_manifest_list(table.io.new_input(parent.manifest_list)):
        check()
        if not _owned(manifest.manifest_path, location + "/metadata/"):
            raise RuntimeError("Wide offset manifest is outside the owned table location.")
        for entry in _manifest_entries(table, manifest, spec, max_files - examined, check):
            examined += 1
            if entry.status == ManifestEntryStatus.DELETED:
                continue
            file = entry.data_file
            if (file.content != DataFileContent.DATA or file.file_format != FileFormat.PARQUET
                    or not _owned(file.file_path, location + "/data/")
                    or file.file_path in inventory or None in _entry_identity(entry)):
                raise RuntimeError("Wide offset inventory contains an unsupported or non-owned data file.")
            partition = tuple(file.partition[index] for index in range(len(spec.fields)))
            groups[partition].append(entry)
            inventory[file.file_path] = entry
            changed |= file.split_offsets is not None
    if not changed:
        return None

    totals = {
        TOTAL_DATA_FILES: str(len(inventory)),
        TOTAL_RECORDS: str(sum(entry.data_file.record_count for entry in inventory.values())),
        TOTAL_FILE_SIZE: str(sum(entry.data_file.file_size_in_bytes for entry in inventory.values())),
        TOTAL_DELETE_FILES: "0", TOTAL_POSITION_DELETES: "0", TOTAL_EQUALITY_DELETES: "0",
    }
    if any(key in summary and int(summary[key]) != int(value) for key, value in totals.items()):
        raise RuntimeError("Wide offset inventory differs from its snapshot totals.")
    snapshot_id = table.metadata.new_snapshot_id()
    sequence = table.metadata.next_sequence_number()
    commit_id = uuid4().hex
    outputs = []
    for partition in sorted(groups, key=repr):
        entries = sorted(groups[partition], key=lambda entry: entry.data_file.file_path)
        for start in range(0, len(entries), MAX_ENTRIES):
            check()
            output = _owned_output(table, f"offsets-{commit_id}-{len(outputs)}.avro")
            if not _owned(output.location, location + "/metadata/"):
                raise RuntimeError("Wide offset output is outside the owned metadata location.")
            with write_manifest(2, spec, table.schema(), output, snapshot_id, avro_compression="gzip") as writer:
                for index, entry in enumerate(entries[start:start + MAX_ENTRIES]):
                    if index % 128 == 0:
                        check()
                    writer.existing(ManifestEntry.from_args(
                        status=ManifestEntryStatus.EXISTING, snapshot_id=entry.snapshot_id,
                        sequence_number=entry.sequence_number, file_sequence_number=entry.file_sequence_number,
                        data_file=without_offsets(entry.data_file),
                    ))
            outputs.append(writer.to_manifest_file())

    check()
    manifest_list = _owned_output(table, f"snap-{snapshot_id}-{commit_id}-offsets.avro")
    if not _owned(manifest_list.location, location + "/metadata/"):
        raise RuntimeError("Wide offset manifest list is outside the owned metadata location.")
    with write_manifest_list(2, manifest_list, snapshot_id, parent.snapshot_id, sequence,
                             avro_compression="gzip") as writer:
        writer.add_manifests(outputs)
    remaining = dict(inventory)
    seen = set()
    for manifest in read_manifest_list(table.io.new_input(manifest_list.location)):
        check()
        if not _owned(manifest.manifest_path, location + "/metadata/") or manifest.manifest_path in seen:
            raise RuntimeError("Wide offset replacement contains an unexpected manifest.")
        seen.add(manifest.manifest_path)
        partitions = set()
        for entry in _manifest_entries(table, manifest, spec, MAX_ENTRIES, check):
            original = remaining.pop(entry.data_file.file_path, None)
            if (original is None or entry.status != ManifestEntryStatus.EXISTING
                    or _entry_identity(entry) != _entry_identity(original)
                    or entry.data_file.spec_id != original.data_file.spec_id
                    or not Record.__eq__(entry.data_file, without_offsets(original.data_file))):
                raise RuntimeError("Wide offset replacement changed a data file or its sequence.")
            partitions.add(tuple(entry.data_file.partition[index] for index in range(len(spec.fields))))
        if len(partitions) != 1:
            raise RuntimeError("Wide offset replacement mixed partition identities.")
    if remaining or seen != {manifest.manifest_path for manifest in outputs}:
        raise RuntimeError("Wide offset replacement omitted data files or manifests.")

    markers = {"h3search.compaction": "true", MARKER: "v1", f"{MARKER}.parent": str(parent.snapshot_id)}
    if "h3search.batch-id" in summary:
        markers["h3search.batch-id"] = summary["h3search.batch-id"]
    snapshot = Snapshot(
        snapshot_id=snapshot_id, parent_snapshot_id=parent.snapshot_id,
        manifest_list=manifest_list.location, sequence_number=sequence,
        summary=Summary(operation=Operation.REPLACE, **totals, **markers),
        schema_id=table.metadata.current_schema_id,
    )
    # Typed staging preserves the expected parent instead of automatically rebasing a producer.
    with table.transaction() as transaction:
        transaction._stage(
            (AddSnapshotUpdate(snapshot=snapshot), SetSnapshotRefUpdate(
                ref_name="main", type=SnapshotRefType.BRANCH, snapshot_id=snapshot_id,
                parent_snapshot_id=parent.snapshot_id,
            )),
            (AssertRefSnapshotId(ref="main", snapshot_id=parent.snapshot_id),
             AssertCurrentSchemaId(current_schema_id=table.metadata.current_schema_id),
             AssertDefaultSpecId(default_spec_id=table.metadata.default_spec_id)),
        )
        check()
        guard()
    return snapshot_id
