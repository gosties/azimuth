"""Group Iceberg search manifests without changing the data files."""

from collections import Counter, defaultdict
from uuid import UUID, uuid4
import re

from h3.api import basic_int as h3
from pyiceberg.avro.file import AvroFile
from pyiceberg.manifest import (
    DEFAULT_READ_VERSION, MANIFEST_ENTRY_SCHEMAS, DataFile, DataFileContent, FileFormat, ManifestContent,
    ManifestEntry, ManifestEntryStatus, _inherit_from_manifest, read_manifest_list, write_manifest, write_manifest_list,
)
from pyiceberg.table import TableProperties
from pyiceberg.table.refs import SnapshotRefType
from pyiceberg.table.snapshots import (
    TOTAL_DATA_FILES, TOTAL_DELETE_FILES, TOTAL_EQUALITY_DELETES, TOTAL_FILE_SIZE, TOTAL_POSITION_DELETES,
    TOTAL_RECORDS, Operation, Snapshot, Summary,
)
from pyiceberg.table.update import AddSnapshotUpdate, AssertCurrentSchemaId, AssertDefaultSpecId, AssertRefSnapshotId, SetSnapshotRefUpdate
from pyiceberg.transforms import IdentityTransform
from pyiceberg.typedef import Record


MARKER = "h3search.manifest-regroup"
VERSION = "1"
MERGE = TableProperties.MANIFEST_MERGE_ENABLED


def is_regroup(snapshot, parent):
    """Identify a regroup committed directly on the expected publication."""
    return (
        snapshot is not None and snapshot.parent_snapshot_id == parent and snapshot.summary is not None
        and snapshot.summary.operation == Operation.REPLACE and snapshot.summary.get(MARKER) == VERSION
        and snapshot.summary.get(f"{MARKER}.parent") == str(parent)
    )


def _entry_identity(entry):
    return (entry.snapshot_id, entry.sequence_number, entry.file_sequence_number)


def _group(entry, resolution, generation=False):
    if generation:
        (cell,) = entry.data_file.partition
        table_id = ""
    else:
        table_id, cell = entry.data_file.partition
    if (not isinstance(table_id, str) or not h3.is_valid_cell(cell)
            or h3.get_resolution(cell) != resolution):
        raise RuntimeError("The search manifest contains an invalid partition.")
    return table_id, h3.get_base_cell_number(cell)


def _manifest_entries(table, manifest, spec, max_files, check):
    if manifest.content != ManifestContent.DATA or manifest.partition_spec_id != spec.spec_id:
        raise RuntimeError("Search manifest regroup requires data manifests with the current partition spec.")
    counts = (manifest.added_files_count, manifest.existing_files_count, manifest.deleted_files_count)
    if any(count is None or count < 0 for count in counts):
        raise RuntimeError("Search manifest regroup requires valid v2 manifest entry counts.")
    expected = sum(counts)
    if expected > max_files:
        raise TimeoutError("Search manifest inventory exceeds its configured file limit.")
    check()
    # Stream the same pinned PyIceberg reader used by fetch_manifest_entry so
    # a single large manifest cannot allocate its whole decoded entry list.
    with AvroFile[ManifestEntry](
        table.io.new_input(manifest.manifest_path), MANIFEST_ENTRY_SCHEMAS[DEFAULT_READ_VERSION],
        read_types={-1: ManifestEntry, 2: DataFile},
        read_enums={0: ManifestEntryStatus, 101: FileFormat, 134: DataFileContent},
    ) as reader:
        seen = 0
        for seen, entry in enumerate(reader, 1):
            if seen > expected:
                raise RuntimeError("The search manifest exceeds its declared entry count.")
            if seen % 128 == 0:
                check()
            yield _inherit_from_manifest(entry, manifest)
        if seen != expected:
            raise RuntimeError("The search manifest differs from its declared entry count.")


def _owned_output(table, name):
    location = table.location_provider().new_metadata_location(name)
    if not location.startswith(table.location().rstrip("/") + "/metadata/"):
        raise RuntimeError("Search manifest output is outside the owned metadata path.")
    return table.io.new_output(location)


def _commit(table, parent, snapshot, check, guard):
    # PyIceberg 0.12 has typed transaction updates but no public manifest-rewrite
    # producer. Staging directly avoids the automatic producer rebase on CAS failure.
    with table.transaction() as tx:
        tx.set_properties({MERGE: "false"})
        tx._stage(
            (AddSnapshotUpdate(snapshot=snapshot), SetSnapshotRefUpdate(
                ref_name="main", type=SnapshotRefType.BRANCH, snapshot_id=snapshot.snapshot_id,
                parent_snapshot_id=parent.snapshot_id,
            )),
            (AssertRefSnapshotId(ref="main", snapshot_id=parent.snapshot_id),
             AssertCurrentSchemaId(current_schema_id=table.metadata.current_schema_id),
             AssertDefaultSpecId(default_spec_id=table.metadata.default_spec_id)),
        )
        check()
        guard()


def validate_generation(table, parent, name):
    if (not isinstance(name, str) or not re.fullmatch(r"search_r3_[0-9a-f]{32}", name)
            or table.name()[-1] != name):
        raise RuntimeError("Manifest regroup requires an owned R3 generation table.")
    try:
        owned = UUID(parent.summary.get("h3search.load-id", "")).hex == name.removeprefix("search_r3_")
    except (ValueError, TypeError, AttributeError):
        owned = False
    if not owned or not re.fullmatch(r"[0-9a-f]{64}", parent.summary.get("h3search.load-content", "")):
        raise RuntimeError("The R3 generation lacks matching sealed load ownership.")
    spec = table.spec()
    fields = tuple((table.schema().find_field(field.source_id).name, field.name, type(field.transform)) for field in spec.fields)
    if (table.metadata.format_version != 2 or len(table.specs()) != 1
            or fields != (("h3_r3", "h3_r3", IdentityTransform),)):
        raise RuntimeError("R3 manifest regroup requires one identity h3_r3 partition.")


def regroup(table, parent, resolution, max_files, max_entries, check, guard, *, name=None):
    """Replace data manifests on one fixed v2 head and return the new snapshot ID."""
    spec = table.spec()
    fields = tuple((table.schema().find_field(field.source_id).name, field.name, type(field.transform))
                   for field in spec.fields)
    generation = name is not None
    if generation:
        if resolution != 3:
            raise RuntimeError("R3 manifest regroup requires resolution three.")
        validate_generation(table, parent, name)
    if type(max_entries) is not int or max_entries < 1 or type(max_files) is not int or max_files < 1:
        raise ValueError("Manifest regroup limits must be positive integers.")
    names = ("h3_r3",) if generation else ("table_id", f"h3_r{resolution}")
    expected_fields = tuple((field, field, IdentityTransform) for field in names)
    if table.metadata.format_version != 2 or len(table.specs()) != 1 or fields != expected_fields:
        raise RuntimeError("Search manifest regroup requires the owned v2 search partition layout.")
    summary = parent.summary.additional_properties if parent.summary else {}
    if (is_regroup(parent, parent.parent_snapshot_id) and summary.get(f"{MARKER}.max-entries") == str(max_entries)
            and table.properties.get(MERGE, "false").lower() == "false"):
        return None
    if int(summary.get(TOTAL_DATA_FILES, "0")) > max_files:
        raise TimeoutError("Search manifest inventory exceeds its configured file limit.")

    groups = defaultdict(list)
    inventory = {}
    manifests_per_group = Counter()
    examined = 0
    well_grouped = True
    prefix = table.location().rstrip("/") + "/"
    check()
    for manifest in read_manifest_list(table.io.new_input(parent.manifest_list)):
        check()
        keys = set()
        live_count = 0
        for entry in _manifest_entries(table, manifest, spec, max_files - examined, check):
            examined += 1
            if entry.status == ManifestEntryStatus.DELETED:
                continue
            live_count += 1
            file = entry.data_file
            if (file.content != DataFileContent.DATA or not file.file_path.startswith(prefix)
                    or file.file_path in inventory or None in _entry_identity(entry)):
                raise RuntimeError("The search snapshot contains an unsupported or duplicate data file.")
            if len(inventory) >= max_files:
                raise TimeoutError("Search manifest inventory exceeds its configured file limit.")
            key = _group(entry, resolution, generation)
            groups[key].append(entry)
            inventory[file.file_path] = entry
            keys.add(key)
        manifests_per_group.update(keys)
        well_grouped &= len(keys) == 1 and live_count <= max_entries

    merge_enabled = table.properties.get(MERGE, "false").lower() == "true"
    if not inventory or (not merge_enabled and well_grouped and all(
            manifests_per_group[key] == (len(entries) + max_entries - 1) // max_entries
            for key, entries in groups.items())):
        return None

    file_count = len(inventory)
    totals = {
        TOTAL_DATA_FILES: str(file_count),
        TOTAL_RECORDS: str(sum(entry.data_file.record_count for entry in inventory.values())),
        TOTAL_FILE_SIZE: str(sum(entry.data_file.file_size_in_bytes for entry in inventory.values())),
        TOTAL_DELETE_FILES: "0", TOTAL_POSITION_DELETES: "0", TOTAL_EQUALITY_DELETES: "0",
    }
    if any(key in summary and int(summary[key]) != int(value) for key, value in totals.items()):
        raise RuntimeError("The search manifest inventory differs from its snapshot totals.")
    snapshot_id = table.metadata.new_snapshot_id()
    sequence = table.metadata.next_sequence_number()
    commit_id = uuid4().hex
    outputs = []
    for key in sorted(groups):
        entries = sorted(groups[key], key=lambda entry: (entry.data_file.partition[0 if generation else 1], entry.data_file.file_path))
        for start in range(0, len(entries), max_entries):
            check()
            output = _owned_output(table, f"regroup-{commit_id}-{len(outputs)}.avro")
            with write_manifest(2, spec, table.schema(), output, snapshot_id, avro_compression="gzip") as writer:
                for offset, entry in enumerate(entries[start:start + max_entries]):
                    if offset % 128 == 0:
                        check()
                    writer.existing(entry)
            outputs.append(writer.to_manifest_file())

    check()
    manifest_list = _owned_output(table, f"snap-{snapshot_id}-{commit_id}-regroup.avro")
    with write_manifest_list(2, manifest_list, snapshot_id, parent.snapshot_id, sequence, avro_compression="gzip") as writer:
        writer.add_manifests(outputs)

    seen_manifests = set()
    for manifest in read_manifest_list(table.io.new_input(manifest_list.location)):
        check()
        seen_manifests.add(manifest.manifest_path)
        for entry in _manifest_entries(table, manifest, spec, max_entries, check):
            original = inventory.pop(entry.data_file.file_path, None)
            if (original is None or entry.status != ManifestEntryStatus.EXISTING
                    or _entry_identity(entry) != _entry_identity(original)
                    or not Record.__eq__(entry.data_file, original.data_file)):
                raise RuntimeError("Search manifest regroup changed a live file or sequence.")
    if inventory or seen_manifests != {manifest.manifest_path for manifest in outputs}:
        raise RuntimeError("Search manifest regroup omitted files or manifests.")

    marker = {MARKER: VERSION, f"{MARKER}.parent": str(parent.snapshot_id), f"{MARKER}.files": str(file_count),
              f"{MARKER}.manifests": str(len(outputs)), f"{MARKER}.max-entries": str(max_entries)}
    snapshot = Snapshot(snapshot_id=snapshot_id, parent_snapshot_id=parent.snapshot_id,
                        manifest_list=manifest_list.location, sequence_number=sequence,
                        summary=Summary(operation=Operation.REPLACE, **{key: value for key, value in summary.items()
                            if generation and key in ("h3search.load-id", "h3search.load-content")}, **totals, **marker),
                        schema_id=table.metadata.current_schema_id)
    _commit(table, parent, snapshot, check, guard)
    return snapshot_id


def verify_inventory(table, parent, candidate, max_files, check):
    """Prove exact immutable DataFile and sequence identity on a recovery boundary."""
    inventory = {}
    for snapshot, original in ((parent, True), (candidate, False)):
        examined = 0
        for manifest in read_manifest_list(table.io.new_input(snapshot.manifest_list)):
            check()
            for entry in _manifest_entries(table, manifest, table.spec(), max_files - examined, check):
                examined += 1
                if entry.status == ManifestEntryStatus.DELETED:
                    continue
                path = entry.data_file.file_path
                if original:
                    if path in inventory:
                        raise RuntimeError("Duplicate file in regroup parent inventory.")
                    inventory[path] = entry
                else:
                    previous = inventory.pop(path, None)
                    if (previous is None or _entry_identity(previous) != _entry_identity(entry)
                            or not Record.__eq__(previous.data_file, entry.data_file)):
                        raise RuntimeError("Regroup recovery differs from its exact parent inventory.")
    if inventory:
        raise RuntimeError("Regroup recovery omitted parent files.")
