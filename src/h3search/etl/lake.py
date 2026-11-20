"""Snapshot storage adapters for explicit local fixtures and Iceberg REST."""

from collections import OrderedDict, defaultdict
from time import time
import json
from pathlib import Path
from uuid import uuid4

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from .layout import SEARCH_SCHEMA, search_name, wide_name


def _write_json(path, payload):
    temp = path.with_suffix(".tmp")
    with temp.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"))
        handle.flush()
        import os
        os.fsync(handle.fileno())
    temp.replace(path)


def read_compaction_batches(parquet, byte_limit, can_continue, schema=None):
    """Decode bounded chunks and stop before retaining more than the remaining budget."""
    batches, size = [], 0
    for batch in parquet.iter_batches(batch_size=256, use_threads=False):
        if not can_continue() or batch.nbytes > byte_limit - size:
            return None
        if schema is not None:
            batch = batch.cast(schema)
            if batch.nbytes > byte_limit - size:
                return None
        size += batch.nbytes
        batches.append(batch)
    return batches, size


class LocalLake:
    """Store immutable Parquet files and snapshot manifests for fixture runs."""

    def __init__(self, settings):
        self.root = Path(settings.lake_path)
        self.resolution = settings.partition_resolution
        self.batch_rows = settings.fetch_batch_rows
        self.retention_days = settings.snapshot_retention_days

    def _directory(self, name):
        return self.root / name

    def _manifest(self, name, snapshot):
        path = self._directory(name) / "snapshots" / f"{snapshot}.json"
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError as error:
            raise KeyError(f"Unknown snapshot {snapshot}") from error

    def _head(self, name):
        path = self._directory(name) / "head.json"
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
        return None

    def _commit(self, name, files, batch_id):
        directory = self._directory(name)
        (directory / "snapshots").mkdir(parents=True, exist_ok=True)
        snapshot = uuid4().hex
        _write_json(directory / "snapshots" / f"{snapshot}.json", files)
        _write_json(directory / "head.json", {"snapshot": snapshot, "batch": batch_id})
        return snapshot

    def files(self, name, snapshot_id):
        """Yield immutable data files referenced by an existing local snapshot."""
        for entry in self._manifest(name, snapshot_id):
            yield self._directory(name) / "data" / entry["file"]

    def _update(self, name, table_id, batch_id, data, keys=None, remove=False):
        head = self._head(name)
        if head and head["batch"] == batch_id:
            return
        directory = self._directory(name)
        (directory / "data").mkdir(parents=True, exist_ok=True)
        entries = self._manifest(name, head["snapshot"]) if head else []
        retained = []
        for entry in entries:
            if entry["table_id"] != table_id or (keys is None and not remove):
                retained.append(entry)
                continue
            if remove:
                continue
            previous = directory / "data" / entry["file"]
            with pq.ParquetFile(previous) as source:
                for batch in source.iter_batches(batch_size=self.batch_rows):
                    keep = pc.invert(pc.is_in(batch.column("object_id"), value_set=keys))
                    filtered = pa.Table.from_batches([batch]).filter(keep)
                    if len(filtered):
                        if len(filtered) == entry["count"]:
                            retained.append(entry)
                        else:
                            retained.append(self._write(name, table_id, entry["cell"], filtered))
        if len(data):
            if name == search_name:
                groups = defaultdict(list)
                for index, cell in enumerate(data[f"h3_r{self.resolution}"]):
                    groups[cell.as_py()].append(index)
                for cell, indexes in groups.items():
                    retained.append(self._write(name, table_id, cell, data.take(indexes)))
            else:
                retained.append(self._write(name, table_id, None, data))
        self._commit(name, retained, batch_id)

    def _write(self, name, table_id, cell, data):
        filename = f"{table_id}-{uuid4().hex}.parquet"
        path = self._directory(name) / "data" / filename
        pq.write_table(data, path, compression="zstd", row_group_size=self.batch_rows)
        return {"file": filename, "table_id": table_id, "cell": cell, "count": len(data)}

    def apply(self, table_id, batch_id, wide, keys=None, *, guard=lambda: None):
        """Append or replace one staged batch in both physical tables."""
        guard()
        self._update(wide_name(table_id), table_id, batch_id, wide, keys)
        guard()
        self._update(search_name, table_id, batch_id, wide.select(SEARCH_SCHEMA.names), keys)

    def snapshots(self, table_id, wide_schema):
        """Return current snapshot IDs and validated counts for this dataset."""
        name = wide_name(table_id)
        search = (self._head(search_name) or {"snapshot": self._commit(search_name, [], None)})["snapshot"]
        wide = (self._head(name) or {"snapshot": self._commit(name, [], None)})["snapshot"]
        counts = (
            sum(entry["count"] for entry in self._manifest(search_name, search) if entry["table_id"] == table_id),
            sum(entry["count"] for entry in self._manifest(name, wide)),
        )
        return search, wide, counts

    def remove_rows(self, table_id):
        """Remove all rows owned by a dataset from the current search index."""
        self._update(search_name, table_id, f"remove-{table_id}", SEARCH_SCHEMA.empty_table(), remove=True)
        return self._head(search_name)["snapshot"]

    def location(self, name):
        """Return the location owned by this table, if it exists."""
        directory = self._directory(name)
        return str(directory) if directory.exists() else None

    def drop_wide(self, table_id, location):
        """Reclaim the removed dataset's entire local wide-table directory."""
        from shutil import rmtree

        directory = self._directory(wide_name(table_id))
        if location is not None and Path(location).resolve() != directory.resolve():
            raise RuntimeError("Cannot reclaim a non-owned storage directory.")
        if directory.resolve() != self.root.resolve() / wide_name(table_id):
            raise RuntimeError("Cannot reclaim a directory outside the owned lake.")
        if directory.exists():
            rmtree(directory)

    def drop_owned_table(self, name, location):
        """Reclaim an explicitly inventoried application table without following directory links."""
        from shutil import rmtree
        from .layout import owned_table_name

        if not owned_table_name(name):
            raise RuntimeError("Cannot reclaim an unrecognized application table.")
        directory = self._directory(name)
        if directory.resolve() != self.root.resolve() / name or (location is not None and Path(location).resolve() != directory.resolve()):
            raise RuntimeError("Cannot reclaim a non-owned storage directory.")
        if directory.exists():
            rmtree(directory)

    def compaction_head(self, name):
        """Return a file-only replacement head eligible for publication after recovery."""
        head = self._head(name)
        if head and (head["batch"] or "").startswith("compact-"):
            return head["snapshot"]
        return None

    def compact_unit(self, name, max_files, byte_limit, can_continue, guard):
        """Replace bounded small files from a single local partition."""
        head = self._head(name)
        if not head or max_files < 2:
            return None
        entries = self._manifest(name, head["snapshot"])
        groups = OrderedDict()
        sizes = defaultdict(int)
        directory = self._directory(name) / "data"
        for entry in entries:
            if not can_continue():
                return None
            path = directory / entry["file"]
            if path.stat().st_size > byte_limit // 2:
                continue
            with pq.ParquetFile(path) as parquet:
                size = sum(parquet.metadata.row_group(i).total_byte_size for i in range(parquet.num_row_groups))
            key = entry["table_id"], entry["cell"]
            if size > byte_limit // 2 or sizes[key] + size > byte_limit:
                continue
            if key not in groups and len(groups) >= 128:
                expired, _ = groups.popitem(last=False)
                sizes.pop(expired, None)
            groups.setdefault(key, []).append(entry)
            groups.move_to_end(key)
            sizes[key] += size
            if len(groups[key]) == max_files:
                break
        else:
            key = max(groups, key=lambda item: len(groups[item]), default=None)
        if key is None or len(groups[key]) < 2 or not can_continue():
            return None
        selected = groups[key]
        batches = []
        remaining = byte_limit
        for entry in selected:
            if not can_continue():
                return None
            with pq.ParquetFile(directory / entry["file"]) as parquet:
                decoded = read_compaction_batches(parquet, remaining, can_continue)
            if decoded is None:
                return None
            file_batches, size = decoded
            remaining -= size
            batches.extend(file_batches)
        data = pa.Table.from_batches(batches).sort_by("object_id")
        if len(data) != sum(entry["count"] for entry in selected):
            raise RuntimeError("A local compaction group did not preserve its row count.")
        replaced = {entry["file"] for entry in selected}
        retained = [entry for entry in entries if entry["file"] not in replaced]
        guard()
        retained.append(self._write(name, *key, data))
        if not can_continue():
            raise TimeoutError("Maintenance window closed before committing file replacement.")
        guard()
        return self._commit(name, retained, "compact-" + uuid4().hex)

    def plan_maintenance(self, name, pinned, can_continue, *, removed_id=None):
        """Find one local snapshot or unreferenced file eligible for reclamation."""
        directory = self._directory(name)
        if not directory.exists():
            return None
        head = self._head(name)
        snapshots = directory / "snapshots"
        cutoff = time() - self.retention_days * 86400
        referenced = set()
        for path in snapshots.glob("*.json"):
            if not can_continue():
                return None
            entries = self._manifest(name, path.stem)
            if removed_id:
                relevant = any(entry["table_id"] == removed_id for entry in entries)
                if relevant and (path.stem in pinned or (head and path.stem == head["snapshot"])):
                    raise RuntimeError("A retained search snapshot still references removed data.")
            else:
                relevant = path.stat().st_mtime < cutoff
            if relevant and path.stem not in pinned and (not head or path.stem != head["snapshot"]):
                return "expire", path.stem
            referenced.update(entry["file"] for entry in entries)
        pattern = f"{removed_id}-*.parquet" if removed_id else "*.parquet"
        for file in (directory / "data").glob(pattern):
            if not can_continue():
                return None
            if file.name not in referenced and (removed_id or file.stat().st_mtime < cutoff):
                return "file", file
        return None

    def apply_maintenance(self, name, action, pinned):
        """Reclaim a planned local unit after rechecking any snapshot pin."""
        kind, item = action
        if kind == "expire":
            if item in pinned:
                return False
            item = self._directory(name) / "snapshots" / f"{item}.json"
        item.unlink(missing_ok=True)
        return True

    def maintenance_unit(self, name, pinned, *, removed_id=None):
        """Reclaim a single local removal unit."""
        action = self.plan_maintenance(name, pinned, lambda: True, removed_id=removed_id)
        return self.apply_maintenance(name, action, pinned) if action else False


def open_lake(settings):
    """Open the explicitly configured storage adapter."""
    if settings.mode == "local":
        return LocalLake(settings)
    from .iceberg import IcebergLake

    return IcebergLake(settings)
