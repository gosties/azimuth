"""Durable preparation and atomic publication of an initial insert-only load."""
from __future__ import annotations

from base64 import b64decode, b64encode
from hashlib import sha256
from dataclasses import replace
from copy import copy
import json
import os
from pathlib import Path
import shutil
import socket
from time import monotonic, sleep
from uuid import UUID, uuid4

import psutil
import pyarrow as pa
import pyarrow.parquet as pq

from h3search.control import ConflictError
from h3search.models import utc_now
from .layout import SEARCH_SCHEMA, transform, wide_name
from .source import ReloadRequired
from . import spool

MiB = 1024 * 1024


class BulkStopped(Exception):
    """Preparation reached an explicitly requested durable stop boundary."""


def _json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def _atomic(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("wb") as handle:
        handle.write(_json(value)); handle.flush(); os.fsync(handle.fileno())
    for attempt in range(20):
        try:
            temporary.replace(path)
            return
        except OSError as error:
            if os.name != "nt" or getattr(error, "winerror", None) not in (5, 32, 33) or attempt == 19:
                raise
            sleep(0.05)


def _path(root, relative):
    if not isinstance(relative, str) or Path(relative).is_absolute() or ".." in Path(relative).parts:
        raise RuntimeError("A prepared path is outside its reservation directory.")
    path = root / relative
    if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
        raise RuntimeError("A prepared path is outside its reservation directory.")
    return path


def _seal(root, path, rows, check=lambda: None):
    return {"path": path.relative_to(root).as_posix(), "sha256": spool.checksum(path, check),
            "rows": rows, "bytes": path.stat().st_size}


def _verify(root, entry, check=lambda: None, schema=None):
    path = _path(root, entry["path"])
    if not path.is_file() or path.stat().st_size != entry["bytes"] or spool.checksum(path, check) != entry["sha256"]:
        raise RuntimeError("A sealed bulk artifact is missing or changed. Restore the reservation directory before retrying.")
    if schema is not None:
        with pq.ParquetFile(path) as parquet:
            if parquet.metadata.num_rows != entry["rows"] or parquet.schema_arrow != schema:
                raise RuntimeError("A sealed bulk chunk has a different row count or schema.")
    return path


class Journal:
    """Fsynced hash chain; only an incomplete final physical line is discarded."""
    def __init__(self, path, limit, check=lambda: None):
        self.path, self.limit, self.records, self.previous = path, limit, [], ""
        if not path.exists():
            return
        if path.stat().st_size > limit:
            raise MemoryError("The bulk journal reached its configured metadata limit.")
        offset = 0
        with path.open("rb") as handle:
            for line in handle:
                check()
                if not line.endswith(b"\n"):
                    break
                try:
                    envelope = json.loads(line)
                    payload = envelope["payload"]
                    digest = sha256(_json([len(self.records), self.previous, payload])).hexdigest()
                    if envelope["seq"] != len(self.records) or envelope["previous"] != self.previous or envelope["sha256"] != digest:
                        raise ValueError()
                except (ValueError, KeyError, TypeError) as error:
                    raise RuntimeError("The bulk journal contains a corrupt committed record.") from error
                self.records.append(payload); self.previous = digest; offset += len(line)
        if offset != path.stat().st_size:
            with path.open("r+b") as handle:
                handle.truncate(offset); handle.flush(); os.fsync(handle.fileno())

    def append(self, payload):
        digest = sha256(_json([len(self.records), self.previous, payload])).hexdigest()
        envelope = dict(seq=len(self.records), previous=self.previous, payload=payload, sha256=digest)
        encoded = _json(envelope) + b"\n"
        if (self.path.stat().st_size if self.path.exists() else 0) + len(encoded) > self.limit:
            raise MemoryError("The bulk journal reached its configured metadata limit.")
        with self.path.open("ab") as handle:
            handle.write(encoded); handle.flush(); os.fsync(handle.fileno())
        self.records.append(payload); self.previous = digest


class Bulk:
    """Prepare outside the global writer lease; activate under a durable fence."""
    def __init__(self, engine):
        self.engine, self.registry, self.settings = engine, engine.registry, engine.settings
        self.run = None
        self._last_disk = self._last_progress = self._last_guard = -float("inf")
        self._disk_bytes = 0
        self._bulk_lake = None

    @property
    def lake(self):
        if self._bulk_lake is None:
            original = self.engine.lake
            if hasattr(original, "catalog"):
                self._bulk_lake = copy(original)
                self._bulk_lake.settings = replace(original.settings, memory_budget_mb=self.settings.bulk_memory_mb)
            else:
                self._bulk_lake = original
        return self._bulk_lake

    def _owner(self):
        return self.settings.bulk_owner_id or socket.gethostname()

    def _root(self, run):
        stage = self.engine.stage.resolve()
        if run["owner"] != self._owner() or run["stage_root"] != str(stage):
            raise ConflictError("Bulk recovery requires its original owner and staging directory. "
                                "Run on the recorded bulk_owner_id with the original stage_path restored.")
        operation = str(UUID(run["id"]))
        root = stage / operation
        if root.is_symlink() or getattr(root, "is_junction", lambda: False)() or not root.is_dir():
            raise ConflictError("The bulk reservation directory is missing. Restore its original staging directory before recovery.")
        owner = json.loads((root / "owner.json").read_text())
        if owner != {key: run[key] for key in ("id", "table_id", "owner", "stage_root")}:
            raise ConflictError("The local bulk reservation identity differs from control storage.")
        return root

    def _check(self, guard, stop_file=None):
        if monotonic() - self._last_guard >= 1:
            guard(); self._last_guard = monotonic()
        if stop_file is not None and stop_file.exists():
            raise BulkStopped()
        memory = self.settings.bulk_memory_mb * MiB
        if psutil.Process().memory_info().rss > memory:
            raise MemoryError("Bulk preparation reached its configured process memory budget.")
        if psutil.virtual_memory().available < self.settings.bulk_host_reserve_mb * MiB:
            raise MemoryError("Bulk preparation reached its configured host memory reserve.")
        # Hash and row-group callbacks have an inexpensive fast path.
        if self._disk_bytes > self.settings.bulk_stage_quota_mb * MiB:
            raise OSError("Bulk preparation reached its total staging disk quota.")
        if monotonic() - self._last_disk >= self.settings.prepared_inventory_interval_sec:
            stage = self.engine.stage
            self._disk_bytes = sum(path.stat().st_size for path in stage.rglob("*") if path.is_file())
            self._last_disk = monotonic()
            if self._disk_bytes > self.settings.bulk_stage_quota_mb * MiB:
                raise OSError("Bulk preparation reached its total staging disk quota.")
            if shutil.disk_usage(stage).free < self.settings.bulk_disk_reserve_mb * MiB:
                raise OSError("Bulk preparation reached its staging disk free-space reserve.")

    def _activation_guard(self, guard):
        guard()
        if psutil.Process().memory_info().rss > self.settings.bulk_memory_mb * MiB:
            raise MemoryError("Bulk activation reached its configured process memory budget.")
        if psutil.virtual_memory().available < self.settings.bulk_host_reserve_mb * MiB:
            raise MemoryError("Bulk activation reached its configured host memory reserve.")

    def _save(self, guard, *, rejects=(), **changes):
        guard()
        old = self.run
        updated = {**old, **changes, "revision": old["revision"] + 1, "updated_at": utc_now()}
        with self.registry.connect() as conn:
            result = conn.execute("UPDATE etl_bulk_preparations SET revision=?,payload=? WHERE table_id=? AND id=? AND revision=?",
                (updated["revision"], json.dumps(updated), old["table_id"], old["id"], old["revision"]))
            if result.rowcount != 1:
                raise ConflictError("The bulk preparation reservation changed. Retry with its original owner.")
            if rejects:
                conn.executemany("INSERT INTO etl_rejects (table_id,object_id,reason) VALUES (?,?,?) "
                    "ON CONFLICT(table_id,object_id) DO UPDATE SET reason=excluded.reason",
                    ((old["table_id"], key, reason) for key, reason in rejects)).close()
        self.run = updated
        _atomic(self._root(updated) / "progress.json", updated)
        return updated

    def _layout(self):
        return {"partition_resolution": self.settings.partition_resolution, "wide_bucket_count": self.settings.wide_bucket_count,
                "target_file_mb": self.settings.target_file_mb, "parquet_row_group_rows": self.settings.parquet_row_group_rows}

    def _reserve(self, dataset, source, guard):
        existing = self.registry.bulk_preparation(dataset["id"])
        if existing:
            if existing["phase"] in ("discarding", "discard_local"):
                raise ConflictError("Bulk discard is pending. Resume bulk-discard before preparing this dataset again.")
            self._root(existing)
            return existing
        with self.registry.writer_lease() as writer:
            self.recover(writer or (lambda: None))
            dataset = self.registry.get_dataset(dataset["id"])
            pending = self.engine._pending()
            publication = self.registry.current_publication() or {}
            if publication.get("layout_version") == 2 or (pending and pending["operation"] in ("load", "discard-load")):
                raise ConflictError("Ordinary bulk preparation cannot reserve a target during an isolated layout load.")
            if (dataset["mode"] != "insert" or dataset["status"] != "registered" or dataset["schema_fingerprint"]
                    or self.engine._checkpoint(dataset["id"]) or dataset["id"] in publication.get("counts", {})
                    or (pending and pending["table_id"] == dataset["id"])):
                raise ConflictError("Bulk preparation requires a fresh, unpublished insert-only dataset.")
            target = wide_name(dataset["id"])
            loader = getattr(self.engine.lake, "_load", None)
            exists = loader(target) is not None if loader is not None else self.engine.lake.location(target) is not None
            if exists:
                self.engine.lake.location(target)  # Verify ownership of any existing native target.
                raise ConflictError("Bulk preparation requires an empty, unpublished wide target. Resolve the existing load first.")
            operation = str(uuid4()); stage = self.engine.stage.resolve(); stage.mkdir(parents=True, exist_ok=True)
            root = stage / operation; root.mkdir()
            run = dict(id=operation, table_id=dataset["id"], revision=0, owner=self._owner(), stage_root=str(stage),
                phase="fetch", schema=source.layout.fingerprint, layout=self._layout(), source={"kind": "sql"},
                cutoff=source.cutoff(), cursor=None, chunks=0, rows=0, rejected=0, source_rows=0, created_at=utc_now(), updated_at=utc_now())
            _atomic(root / "owner.json", {key: run[key] for key in ("id", "table_id", "owner", "stage_root")})
            guard(); writer and writer()
            with self.registry.connect() as conn:
                conn.execute("INSERT INTO etl_bulk_preparations (table_id,id,revision,payload) VALUES (?,?,0,?)", (dataset["id"], operation, json.dumps(run)))
                conn.execute("UPDATE datasets SET schema_fingerprint=?,status='preparing',updated_at=? WHERE id=?", (run["schema"], utc_now(), dataset["id"]))
            _atomic(root / "progress.json", run)
            return run

    def _manifest(self, root, name, value, check):
        path = root / name
        previous = path.stat().st_size if path.exists() else 0
        _atomic(path, value)
        self._disk_bytes += path.stat().st_size - previous
        if path.stat().st_size > self.settings.bulk_max_manifest_mb * MiB:
            raise MemoryError("The prepared file manifest reached its configured metadata limit.")
        return _seal(root, path, value.get("rows", 0), check)

    def _read_manifest(self, root, entry, check):
        return json.loads(_verify(root, entry, check).read_text())

    def _adopt_chunks(self, root, source, journal, guard, check):
        cursor = None; rows = rejected = source_rows = 0
        for index, entry in enumerate(journal.records):
            check()
            if entry["index"] != index or entry["after"] != cursor or (cursor is not None and entry["cursor"] <= cursor):
                raise RuntimeError("Bulk source chunks do not form a strictly ordered durable cursor.")
            _verify(root, entry["wide"], check, source.layout.schema)
            _verify(root, entry["narrow"], check, SEARCH_SCHEMA)
            rejects = json.loads(_verify(root, entry["rejects"], check).read_text())
            if entry["source_rows"] != entry["rows"] + len(rejects) or entry["rows"] != entry["wide"]["rows"] or entry["rows"] != entry["narrow"]["rows"]:
                raise RuntimeError("Bulk source, searchable and rejected row counts differ.")
            cursor = entry["cursor"]; rows += entry["rows"]; rejected += len(rejects); source_rows += entry["source_rows"]
            if index >= self.run["chunks"]:
                self._save(guard, rejects=rejects, chunks=index + 1, cursor=cursor, rows=rows, rejected=rejected, source_rows=source_rows)
        if len(journal.records) != self.run["chunks"] or (cursor, rows, rejected, source_rows) != (self.run["cursor"], self.run["rows"], self.run["rejected"], self.run["source_rows"]):
            raise RuntimeError("The durable bulk cursor differs from its sealed source journal.")

    def prepare(self, table_id, *, max_batches=None, stop_file=None):
        from . import prepared, admission
        table_id = str(UUID(table_id)); stop_file = Path(stop_file) if stop_file is not None else None
        if max_batches is not None and (type(max_batches) is not int or max_batches < 1):
            raise ValueError("Batch limit must be a positive integer.")
        if self.settings.mode != "live" and self.engine.source_factory is None:
            raise ConflictError("Bulk preparation requires Iceberg storage and an explicit SQL source.")
        with self.registry.bulk_lease(table_id) as lease:
            lease = lease or (lambda: None)
            dataset = self.registry.get_dataset(table_id)
            if dataset["mode"] != "insert":
                raise ConflictError("Bulk preparation supports only an initial insert-only dataset.")
            reserved = self.registry.bulk_preparation(table_id)
            if reserved and reserved["phase"] in ("discarding", "discard_local"):
                raise ConflictError("Bulk discard is pending. Resume bulk-discard before preparing this dataset again.")
            with self.engine._source(dataset, {"kind": "sql"}) as source:
                self.run = self._reserve(dataset, source, lease)
                root = self._root(self.run)
                if self.run["layout"] != self._layout():
                    raise ConflictError("Resume bulk preparation with its original partition, bucket, file-size and row-group settings.")
                if self.run["phase"] == "activating":
                    raise ConflictError("Bulk activation is pending. Resume bulk-activate with its original owner.")
                self.engine._validate_source(source, self.run)
                check = lambda: self._check(lease, stop_file)
                batches = 0
                try:
                    chunks = Journal(root / "source-chunks.jsonl", self.settings.bulk_max_manifest_mb * MiB, check)
                    self._adopt_chunks(root, source, chunks, lease, check)
                    referenced = {entry[kind]["path"] for entry in chunks.records for kind in ("wide", "narrow", "rejects")}
                    for abandoned in root.glob(f"{self.run['id']}-source-*"):
                        if abandoned.is_symlink() or not abandoned.is_file():
                            raise RuntimeError("A bulk source artifact is not an owned regular file.")
                        if abandoned.name not in referenced:
                            abandoned.unlink()
                    while self.run["phase"] == "fetch":
                        check()
                        if max_batches is not None and batches >= max_batches:
                            return self._status("paused", "max_batches", batches)
                        headroom = self.settings.bulk_memory_mb * MiB - psutil.Process().memory_info().rss
                        if headroom < 5 * MiB:
                            raise MemoryError("Bulk preparation has insufficient process headroom for another source batch.")
                        memory = min(self.settings.batch_max_mb * MiB, headroom // 5)
                        changes, cursor = source.read_base(self.run["cursor"], self.run["cutoff"], self.settings.fetch_batch_rows, memory)
                        self.engine._validate_source(source, self.run)
                        if not changes:
                            self._save(lease, phase="wide_prepare"); break
                        keys = [int(values[source.layout.key]) for operation, values in changes]
                        if (any(operation != 2 for operation, _ in changes) or keys != sorted(set(keys))
                                or cursor != keys[-1] or (self.run["cursor"] is not None and keys[0] <= self.run["cursor"])
                                or keys[-1] > self.run["cutoff"]):
                            raise ReloadRequired("The source key order or fixed cutoff changed during bulk preparation.")
                        wide, _, rejects = transform(table_id, source.layout, changes, self.settings.transform_workers)
                        check(); index = len(chunks.records); prefix = f"{self.run['id']}-source-{index}-{uuid4()}"
                        wide_path = root / (prefix + "-wide.parquet"); narrow_path = root / (prefix + "-narrow.parquet"); rejects_path = root / (prefix + "-rejects.json")
                        spool.write_parquet(wide_path, wide, self.settings.parquet_row_group_rows)
                        spool.write_parquet(narrow_path, wide.select(SEARCH_SCHEMA.names), self.settings.parquet_row_group_rows)
                        _atomic(rejects_path, rejects)
                        entry = dict(index=index, after=self.run["cursor"], cursor=cursor, rows=len(wide), source_rows=len(changes),
                            wide=_seal(root, wide_path, len(wide), check), narrow=_seal(root, narrow_path, len(wide), check), rejects=_seal(root, rejects_path, len(rejects), check))
                        self._disk_bytes += sum(entry[kind]["bytes"] for kind in ("wide", "narrow", "rejects"))
                        check()
                        chunks.append(entry)
                        self._save(lease, rejects=rejects, chunks=index + 1, cursor=cursor, rows=self.run["rows"] + len(wide), rejected=self.run["rejected"] + len(rejects), source_rows=self.run["source_rows"] + len(changes))
                        batches += 1; del changes, wide
                    def progress(kind):
                        def persist(event):
                            if event.get("entry"):
                                self._disk_bytes += event["entry"]["bytes"]
                            # Builder seal journals are authoritative; compact CAS is throttled.
                            if event["kind"] == "complete" or monotonic() - self._last_progress >= 1:
                                self._save(lease, **{kind + "_progress": event["progress"]})
                                self._last_progress = monotonic()
                        return persist
                    if self.run["phase"] == "wide_prepare":
                        wide = prepared.build_wide(root, self.run["id"], source.layout.schema, [entry["wide"] for entry in chunks.records], self.settings, check, progress("wide"), self.run.get("wide_progress"))
                        self._save(lease, wide_manifest=self._manifest(root, "wide-manifest.json", wide, check), phase="narrow_sort")
                    if self.run["phase"] == "narrow_sort":
                        run = dict(id=self.run["id"], spatial_files=[{"file": entry["narrow"]["path"], "rows": entry["rows"], "sha256": entry["narrow"]["sha256"]} for entry in chunks.records], added=self.run["rows"], spatial_resolution=self.settings.partition_resolution)
                        remaining = self.settings.bulk_stage_quota_mb * MiB - self._disk_bytes
                        if remaining < 2 * MiB:
                            raise OSError("Bulk preparation has no staging quota left for sorting.")
                        sort_settings = replace(self.settings, initial_search_sort_temp_mb=min(self.settings.initial_search_sort_temp_mb, max(1, remaining // (2 * MiB))))
                        baseline_disk = self._disk_bytes
                        last_sort_check = [-float("inf")]
                        def sort_check():
                            check()
                            if monotonic() - last_sort_check[0] >= 1:
                                temporary_bytes = 0
                                # Only the current sort's bounded temporary paths;
                                # never stat the completed partition inventory here.
                                for candidate in root.glob(f"{self.run['id']}-spatial-*"):
                                    if candidate.is_file(): temporary_bytes += candidate.stat().st_size
                                    elif candidate.is_dir(): temporary_bytes += sum(item.stat().st_size for item in candidate.rglob("*") if item.is_file())
                                last_sort_check[0] = monotonic()
                                if baseline_disk + temporary_bytes > self.settings.bulk_stage_quota_mb * MiB:
                                    raise OSError("Bulk sorting reached its total staging disk quota.")
                        sorted_input = spool.sort_narrow(root, run, sort_settings, sort_check, lease, stop_file)
                        if sorted_input:
                            path = root / sorted_input["file"]; sorted_input = _seal(root, path, sorted_input["rows"], check)
                            self._disk_bytes += sorted_input["bytes"]; check()
                        self._save(lease, sorted_input=sorted_input, phase="narrow_prepare")
                    if self.run["phase"] == "narrow_prepare":
                        narrow = prepared.build_narrow(root, self.run["id"], self.run["sorted_input"], table_id, self.settings.partition_resolution, self.settings, check, progress("narrow"), self.run.get("narrow_progress"))
                        self._save(lease, narrow_manifest=self._manifest(root, "narrow-manifest.json", narrow, check), phase="upload")
                    if self.run["phase"] == "upload":
                        for kind, schema in (("wide", source.layout.schema), ("narrow", SEARCH_SCHEMA)):
                            receipt_log = Journal(root / f"{kind}-uploads.jsonl", self.settings.bulk_max_manifest_mb * MiB, check)
                            manifest = self._read_manifest(root, self.run[kind + "_manifest"], check)
                            receipts = {event["path"]: event["upload"] for event in receipt_log.records}
                            for entry in manifest["files"]:
                                if entry["path"] in receipts: entry["upload"] = receipts[entry["path"]]
                            def uploaded(event):
                                if receipts.get(event["path"]) != event["upload"]:
                                    receipt_log.append(event); receipts[event["path"]] = event["upload"]
                            enriched = admission.prepare_uploads(self.lake, table_id, self.run["id"], root, kind, manifest, schema,
                                guard=check, persist=uploaded, max_files=self.settings.bulk_max_files,
                                max_manifest_bytes=self.settings.bulk_max_manifest_mb * MiB, max_footer_bytes=self.settings.bulk_max_footer_mb * MiB,
                                upload_workers=self.settings.bulk_upload_workers)
                            self._save(lease, **{kind + "_uploaded": self._manifest(root, kind + "-uploaded.json", enriched, check)})
                        capsule = {key: self.run[key] for key in ("id", "table_id", "schema", "source", "cutoff", "cursor", "rows", "rejected", "source_rows", "layout", "wide_uploaded", "narrow_uploaded")}
                        capsule.update(wide_schema=b64encode(source.layout.schema.serialize().to_pybytes()).decode(), columns=source.layout.fields)
                        self._save(lease, capsule=self._manifest(root, "admission.json", capsule, check), phase="ready")
                    return self._status("ready", None, batches)
                except (BulkStopped, spool.SortStopped):
                    return self._status("paused", "stop_file", batches)

    def _status(self, status, reason=None, batches=0):
        return dict(status=status, reason=reason, table_id=self.run["table_id"], operation_id=self.run["id"],
            owner_id=self.run["owner"], stage_root=self.run["stage_root"], phase=self.run["phase"],
            rows=self.run["rows"], rejected=self.run["rejected"], source_rows=self.run["source_rows"], cursor=self.run["cursor"],
            batches=batches, total_batches=self.run["chunks"])

    def status(self, table_id):
        self.run = self.registry.bulk_preparation(str(UUID(table_id)))
        return self._status(self.run["phase"]) if self.run else {"status": "not_reserved", "table_id": table_id}

    def discard(self, table_id):
        """Reclaim only this unadmitted operation, retaining protection until done."""
        from . import admission
        table_id = str(UUID(table_id))
        with self.registry.bulk_lease(table_id) as lease:
            lease = lease or (lambda: None)
            self.run = self.registry.bulk_preparation(table_id)
            if not self.run:
                return {"status": "not_reserved", "table_id": table_id}
            if self.run["phase"] == "discard_local":
                if self.run["owner"] != self._owner() or self.run["stage_root"] != str(self.engine.stage.resolve()):
                    raise ConflictError("Finish bulk discard on its original bulk_owner_id and stage_path.")
                root = self.engine.stage.resolve() / str(UUID(self.run["id"]))
                if root.is_symlink() or getattr(root, "is_junction", lambda: False)() or root.resolve().parent != self.engine.stage.resolve():
                    raise ConflictError("The discarded staging directory is outside its reservation.")
            else:
                root = self._root(self.run)
                with self.registry.writer_lease() as guard:
                    guard = guard or (lambda: None)
                    intent = self.registry.bulk_activation()
                    publication = self.registry.current_publication() or {}
                    pending = self.engine._pending()
                    if (self.run["phase"] == "activating" or (intent and intent["table_id"] == table_id)
                            or self.engine._checkpoint(table_id) or table_id in publication.get("counts", {})
                            or (pending and pending.get("table_id") == table_id)):
                        raise ConflictError("Bulk admission or publication has started. Recover bulk-activate, then use normal remove.")
                    self._save(lease, phase="discarding")
                # Cleanup uses trusted manifest identities, never corrupt source
                # or prepared Parquet bytes. Missing receipts are rediscovered.
                for kind in ("wide", "narrow"):
                    if self.run.get(kind + "_discarded"):
                        continue
                    manifest = self._read_manifest(root, self.run[kind + "_manifest"], lease) if kind + "_manifest" in self.run else dict(files=[], rows=0, bytes=0, layout_fingerprint="discard-empty")
                    log = Journal(root / f"{kind}-uploads.jsonl", self.settings.bulk_max_manifest_mb * MiB, lease)
                    receipts = {event["path"]: event["upload"] for event in log.records}
                    for entry in manifest["files"]:
                        if entry["path"] in receipts: entry["upload"] = receipts[entry["path"]]
                    admission.cleanup_uploads(self.lake, table_id, self.run["id"], root, kind, manifest,
                        guard=lease, max_files=self.settings.bulk_max_files, max_snapshots=self.settings.bulk_max_snapshots,
                        max_manifest_bytes=self.settings.bulk_max_manifest_mb * MiB)
                    self._save(lease, **{kind + "_discarded": True})
                self._save(lease, phase="discard_local")
            # All remote candidates have been verified absent. This UUID path is
            # the only local deletion target; phase survives partial local cleanup.
            lease()
            if root.exists(): shutil.rmtree(root)
            with self.registry.writer_lease() as guard:
                guard and guard()
                if self.registry.bulk_activation() and self.registry.bulk_activation()["table_id"] == table_id:
                    raise ConflictError("Bulk activation began before discard completion. Recover it before removing data.")
                with self.registry.connect() as conn:
                    conn.execute("DELETE FROM etl_rejects WHERE table_id=?", (table_id,))
                    result = conn.execute("DELETE FROM etl_bulk_preparations WHERE table_id=? AND id=? AND revision=?", (table_id, self.run["id"], self.run["revision"]))
                    if result.rowcount != 1: raise ConflictError("The bulk reservation changed during discard.")
                    conn.execute("UPDATE datasets SET status='registered',schema_fingerprint=NULL,updated_at=? WHERE id=?", (utc_now(), table_id))
            return {"status": "discarded", "table_id": table_id, "operation_id": self.run["id"]}

    def _resolve_pending(self, guard):
        pending = self.engine._pending()
        if pending:
            if pending["operation"] == "bulk_activation":
                raise ConflictError("The bulk activation fence has no matching recoverable intent.")
            if pending["operation"] == "remove": self.engine._remove(pending["table_id"], guard, pending)
            else: self.engine._ingest(pending["table_id"], pending["source"], guard, pending)

    def activate(self, table_id):
        from . import admission
        table_id = str(UUID(table_id))
        with self.registry.bulk_lease(table_id) as lease:
            lease = lease or (lambda: None)
            if self.registry.bulk_activation():
                with self.registry.writer_lease() as guard:
                    intent = self.registry.bulk_activation()
                    if intent and intent["table_id"] != table_id:
                        raise ConflictError("Recover the pending bulk activation before activating another dataset.")
                    return self.recover(guard or (lambda: None))
            self.run = self.registry.bulk_preparation(table_id)
            if not self.run:
                checkpoint = self.engine._checkpoint(table_id)
                if checkpoint and checkpoint.get("bulk_id"):
                    return self.registry.current_publication()
                raise ConflictError("Prepare this dataset before bulk activation.")
            root = self._root(self.run)
            if self.run["phase"] != "ready":
                raise ConflictError("Finish bulk preparation before activating the dataset.")
            if self.run["layout"] != self._layout():
                raise ConflictError("Activate bulk preparation with its original physical layout settings.")
            # Source availability and expensive immutable-file/remote verification
            # are required only before installing the activation fence.
            with self.engine._source(self.registry.get_dataset(table_id), self.run["source"]) as source:
                self.engine._validate_source(source, self.run)
                cutoff = source.cutoff()
                if self.run["cutoff"] is not None and (cutoff is None or cutoff < self.run["cutoff"]):
                    raise ReloadRequired("The source key range moved backward. Restore the prepared source before activation.")
            check = lambda: self._check(lease)
            capsule = self._read_manifest(root, self.run["capsule"], check)
            schema = pa.ipc.read_schema(pa.BufferReader(b64decode(capsule["wide_schema"])))
            for kind, physical in (("wide", schema), ("narrow", SEARCH_SCHEMA)):
                manifest = self._read_manifest(root, self.run[kind + "_manifest"], check)
                log = Journal(root / f"{kind}-uploads.jsonl", self.settings.bulk_max_manifest_mb * MiB, check)
                receipts = {event["path"]: event["upload"] for event in log.records}
                for entry in manifest["files"]:
                    if entry["path"] in receipts: entry["upload"] = receipts[entry["path"]]
                def uploaded(event):
                    if receipts.get(event["path"]) != event["upload"]:
                        log.append(event); receipts[event["path"]] = event["upload"]
                enriched = admission.prepare_uploads(self.lake, table_id, self.run["id"], root, kind, manifest, physical,
                    guard=check, persist=uploaded, max_files=self.settings.bulk_max_files,
                    max_manifest_bytes=self.settings.bulk_max_manifest_mb * MiB, max_footer_bytes=self.settings.bulk_max_footer_mb * MiB,
                    upload_workers=self.settings.bulk_upload_workers)
                capsule[kind + "_uploaded"] = self._manifest(root, f"{kind}-verified-{uuid4()}.json", enriched, check)
            self._save(lease, capsule=self._manifest(root, f"admission-{uuid4()}.json", capsule, check))
            generation = self.run["revision"]
            with self.registry.writer_lease() as guard:
                guard = guard or (lambda: None)
                intent = self.registry.bulk_activation()
                if intent:
                    Bulk(self.engine).recover(guard)
                fresh = self.registry.bulk_preparation(table_id)
                if not fresh or fresh["id"] != self.run["id"] or fresh["revision"] != generation:
                    raise ConflictError("The bulk preparation generation changed before activation.")
                self._resolve_pending(guard)
                capsule = self._read_manifest(root, self.run["capsule"], guard)
                intent = {key: self.run[key] for key in ("id", "table_id", "owner", "stage_root", "capsule")}
                fence = dict(id=self.run["id"], table_id="bulk:" + self.run["id"], bulk_table_id=table_id,
                    operation="bulk_activation", phase="bulk_activation", source={"kind": "bulk_activation"})
                guard(); lease()
                with self.registry.connect() as conn:
                    conn.execute("INSERT INTO etl_bulk_activation (singleton,id,table_id,payload) VALUES (1,?,?,?)", (intent["id"], table_id, json.dumps(intent)))
                    conn.execute("INSERT INTO etl_pending (singleton,id,table_id,revision,payload) VALUES (1,?,?,0,?)", (intent["id"], fence["table_id"], json.dumps(fence)))
                    updated = {**self.run, "phase": "activating", "revision": self.run["revision"] + 1}
                    changed = conn.execute("UPDATE etl_bulk_preparations SET revision=?,payload=? WHERE table_id=? AND id=? AND revision=?", (updated["revision"], json.dumps(updated), table_id, self.run["id"], self.run["revision"]))
                    if changed.rowcount != 1: raise ConflictError("The bulk reservation changed before activation.")
                self.run = updated
                return self._admit(intent, capsule, guard)

    def recover(self, guard):
        intent = self.registry.bulk_activation()
        pending = self.engine._pending()
        if not intent:
            if pending and pending.get("operation") == "bulk_activation":
                raise ConflictError("The bulk activation fence is missing its intent. Restore control storage before continuing.")
            return None
        if not pending or pending.get("id") != intent["id"] or pending.get("operation") != "bulk_activation" or pending.get("table_id") != "bulk:" + intent["id"]:
            raise ConflictError("The bulk activation intent and publication fence differ. Restore control storage before continuing.")
        self.run = self.registry.bulk_preparation(intent["table_id"])
        if not self.run or self.run["id"] != intent["id"] or self.run["phase"] != "activating":
            raise ConflictError("The bulk activation reservation is missing or changed.")
        root = self._root(self.run)
        capsule = self._read_manifest(root, intent["capsule"], guard)
        return self._admit(intent, capsule, guard)

    def _admit(self, intent, capsule, guard):
        from . import admission
        from .engine import _publication
        root = self._root(self.run); table_id = intent["table_id"]
        if any(capsule[key] != self.run[key] for key in ("id", "table_id", "schema", "layout", "cursor", "rows")):
            raise ConflictError("The immutable bulk admission manifest differs from its reservation.")
        schema = pa.ipc.read_schema(pa.BufferReader(b64decode(capsule["wide_schema"])))
        metadata_guard = lambda: self._activation_guard(guard)
        for kind, physical in (("wide", schema), ("narrow", SEARCH_SCHEMA)):
            metadata_guard()
            manifest = self._read_manifest(root, capsule[kind + "_uploaded"], metadata_guard)
            metadata_guard()
            if manifest["rows"] != capsule["rows"]:
                raise RuntimeError("The prepared narrow and wide row counts differ.")
            admission.admit(self.lake, table_id, intent["id"], root, kind, manifest, physical,
                guard=metadata_guard, max_files=self.settings.bulk_max_files,
                max_snapshots=self.settings.bulk_max_snapshots, max_manifest_bytes=self.settings.bulk_max_manifest_mb * MiB)
        guard()
        if hasattr(self.lake, "catalog"):
            search, wide, (search_count, wide_count) = admission.snapshots(
                self.lake, table_id, schema, guard=metadata_guard, max_files=self.settings.bulk_max_files)
        else:
            search, wide, (search_count, wide_count) = self.lake.snapshots(table_id, schema)
        if search_count != capsule["rows"] or wide_count != capsule["rows"]:
            raise RuntimeError("Bulk admission row counts differ. Its publication fence remains pending.")
        publication = _publication(self.registry.current_publication(), search)
        publication["wide_snapshots"][table_id] = wide
        publication["counts"][table_id] = search_count
        publication["columns"][table_id] = capsule["columns"]
        with self.registry.write_lease():
            guard()
            with self.registry.connect() as conn:
                self.registry.publish(publication, conn, bulk_id=intent["id"])
                conn.execute("INSERT INTO etl_checkpoints (table_id,payload) VALUES (?,?) ON CONFLICT(table_id) DO UPDATE SET payload=excluded.payload", (table_id, json.dumps(dict(source=capsule["source"], key=capsule["cursor"], bulk_id=intent["id"]))))
                if conn.execute("DELETE FROM etl_bulk_preparations WHERE table_id=? AND id=? AND revision=?", (table_id, intent["id"], self.run["revision"])).rowcount != 1:
                    raise ConflictError("The bulk reservation changed during publication.")
                conn.execute("DELETE FROM etl_bulk_activation WHERE singleton=1 AND id=?", (intent["id"],))
                conn.execute("DELETE FROM etl_pending WHERE singleton=1 AND id=?", (intent["id"],))
        _atomic(root / "completed.json", dict(publication_id=publication["id"], rows=search_count, completed_at=utc_now()))
        return publication
