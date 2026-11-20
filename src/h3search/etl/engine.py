"""Recoverable ingestion, publication, removal, and maintenance orchestration."""

from contextlib import contextmanager
from copy import deepcopy
from datetime import UTC, datetime, time, timedelta
import json
import logging
import os
import socket
from pathlib import Path
from time import monotonic
from uuid import UUID
from zoneinfo import ZoneInfo

import psutil
import pyarrow as pa
import pyarrow.parquet as pq

from h3search.control import ConflictError, Registry
from h3search.models import new_id, utc_now

from .lake import open_lake
from .layout import SEARCH_SCHEMA, search_name, transform, wide_name
from .source import CapturePending, ParquetSource, ReloadRequired, SqlServerSource, connection_string
from . import spool


log = logging.getLogger(__name__)
MiB = 1024 * 1024
SCHEMA = (
    "CREATE TABLE IF NOT EXISTS etl_pending (singleton INTEGER PRIMARY KEY, id TEXT NOT NULL, table_id TEXT NOT NULL, revision BIGINT NOT NULL, payload TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS etl_checkpoints (table_id TEXT PRIMARY KEY, payload TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS etl_rejects (table_id TEXT NOT NULL, object_id BIGINT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY (table_id,object_id))",
    "CREATE TABLE IF NOT EXISTS etl_maintenance (singleton INTEGER PRIMARY KEY, payload TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS etl_completed_loads (id TEXT PRIMARY KEY, stage_owner TEXT NOT NULL, stage_root TEXT NOT NULL)",
)


def _payload(row):
    return json.loads(row["payload"]) if row else None


def _publication(previous, snapshot_id):
    previous = previous or {}
    return {
        "id": new_id(), "created_at": utc_now(), "search_snapshot_id": snapshot_id,
        "wide_snapshots": dict(previous.get("wide_snapshots", {})),
        "counts": dict(previous.get("counts", {})),
        "columns": dict(previous.get("columns", {})),
    }


def maintenance_window(settings, now):
    """Return the current maintenance window key and UTC deadline, or None."""
    local = now.astimezone(ZoneInfo(settings.maintenance_timezone))
    start = time.fromisoformat(settings.maintenance_start)
    end = time.fromisoformat(settings.maintenance_end)
    clock = local.time()
    if start == end:
        return None
    if start < end and start <= clock < end:
        day = finish = local.date()
    elif start > end and clock >= start:
        day, finish = local.date(), local.date() + timedelta(days=1)
    elif start > end and clock < end:
        day, finish = local.date() - timedelta(days=1), local.date()
    else:
        return None
    deadline = datetime.combine(finish, end, local.tzinfo).replace(fold=1).astimezone(UTC)
    if now >= deadline:
        return None
    return day.isoformat(), deadline


class Engine:
    """Ingest registered datasets and maintain their published snapshots."""

    def __init__(self, settings, source_factory=None, lake=None):
        self.settings = settings
        if settings.mode == "live":
            os.environ.setdefault("PYICEBERG_MAX_WORKERS", str(settings.transform_workers))
        self.registry = Registry(settings)
        self.registry.initialize()
        self.source_factory = source_factory
        self._lake = lake
        self.stage = Path(settings.stage_path)
        with self.registry.connect() as conn:
            for statement in SCHEMA:
                conn.execute(statement)
        self.registry.install_bulk_pending_guard()

    @property
    def lake(self):
        """Open the configured lake on first use."""
        if self._lake is None:
            self._lake = open_lake(self.settings)
        return self._lake

    def _pending(self):
        with self.registry.connect() as conn:
            return _payload(conn.execute("SELECT payload FROM etl_pending WHERE singleton=1").fetchone())

    def _checkpoint(self, table_id):
        with self.registry.connect() as conn:
            return _payload(conn.execute("SELECT payload FROM etl_checkpoints WHERE table_id=?", (table_id,)).fetchone())

    def _update(self, run, guard, **changes):
        guard()
        revision = run["revision"]
        updated = {**run, **changes, "revision": revision + 1}
        with self.registry.connect() as conn:
            result = conn.execute(
                "UPDATE etl_pending SET revision=?,payload=? WHERE singleton=1 AND id=? AND revision=?",
                (updated["revision"], json.dumps(updated), run["id"], revision),
            )
            if result.rowcount != 1:
                raise ConflictError("The ETL work lease changed. Retry the operation.")
        return updated

    @contextmanager
    def _source(self, dataset, descriptor):
        if descriptor["kind"] == "parquet":
            source = ParquetSource(descriptor["path"], dataset)
        elif self.source_factory is not None:
            source = self.source_factory(dataset)
        else:
            if self.settings.mode != "live":
                raise ValueError("Local mode requires an explicit Parquet import or a supplied source adapter.")
            configured = self.settings.connections.get(dataset["connection_name"], {})
            import pyodbc

            connection = pyodbc.connect(
                connection_string(configured), timeout=int(configured.get("login_timeout_sec", 15)), autocommit=True,
            )
            connection.timeout = int(configured.get("query_timeout_sec", self.settings.query_timeout_sec))
            try:
                source = SqlServerSource(connection, dataset, self.settings.cdc_capture_timeout_sec)
            except BaseException as error:
                connection.close()
                if isinstance(error, ValueError) and dataset["schema_fingerprint"]:
                    raise ReloadRequired("The source schema or identity changed. Remove and reload the dataset.") from error
                raise
        try:
            yield source
        finally:
            source.close()

    def _begin(self, dataset, source, descriptor, checkpoint, guard):
        table_id = dataset["id"]
        mode = dataset["mode"]
        fingerprint = source.layout.fingerprint
        previous = dataset["schema_fingerprint"]
        if previous and previous != fingerprint:
            raise ReloadRequired("The source schema changed. Remove and reload the dataset.")
        first = checkpoint is None
        baseline = source.max_lsn() if mode == "cdc" and first else None
        phase = "base"
        lower = None if first else checkpoint.get("key")
        if mode == "cdc" and not first:
            baseline = checkpoint["lsn"]
            high = source.fence(checkpoint["bootstrap_marker"]) if checkpoint.get("bootstrap_marker") else source.max_lsn()
            phase = "cdc"
            cutoff = None
        else:
            cutoff, high = source.cutoff(), None
            if descriptor["kind"] == "sql" and lower is not None and (cutoff is None or cutoff < lower):
                raise ReloadRequired("The insert-only source key range moved backward. Remove and reload the dataset.")
        run = {
            "id": new_id(), "table_id": table_id, "revision": 0, "phase": phase, "operation": "ingest",
            "source": descriptor, "schema": fingerprint, "first": first, "mode": mode,
            "cutoff": cutoff, "base_cursor": lower, "baseline": baseline, "high": high,
            "cdc_cursor": None, "stage": None, "batch_no": 0, "added": 0,
            "stage_owner": self.settings.bulk_owner_id or socket.gethostname(), "stage_root": str(self.stage.resolve()),
        }
        if self.settings.initial_search_grouping and self.settings.mode == "live" and first and descriptor["kind"] == "sql":
            run.update(spatial_files=[], spatial_resolution=self.settings.partition_resolution)
        guard()
        with self.registry.connect() as conn:
            conn.execute(
                "INSERT INTO etl_pending (singleton,id,table_id,revision,payload) VALUES (1,?,?,?,?)",
                (run["id"], table_id, run["revision"], json.dumps(run)),
            )
            conn.execute(
                "UPDATE datasets SET schema_fingerprint=?,status=?,updated_at=? WHERE id=?",
                (fingerprint, "loading" if first else "ready", utc_now(), table_id),
            )
        return run

    def _memory_limit(self):
        rss = psutil.Process().memory_info().rss
        headroom = self.settings.memory_budget_mb * MiB - rss
        if headroom < MiB:
            raise MemoryError("ETL reached its configured RSS budget. Reduce batch size or increase the memory limit.")
        # The input, worker output, Arrow arrays, and writer buffers can coexist.
        return min(self.settings.batch_max_mb * MiB, headroom // 5)

    def _stage_batch(self, run, source, changes, cursor, guard):
        guard()
        wide, keys, rejects = transform(run["table_id"], source.layout, changes, self.settings.transform_workers)
        self._memory_limit()
        batch_id = f"{run['id']}-{run['batch_no']}"
        self.stage.mkdir(parents=True, exist_ok=True)
        filename = f"{batch_id}-{new_id()}.parquet"
        target = self.stage / filename
        spool.write_parquet(target, wide, self.settings.parquet_row_group_rows)
        stage = {
            "id": batch_id, "file": filename, "cursor": cursor, "rows": len(wide),
            "keys": keys if run["phase"] == "cdc" else None, "rejects": rejects,
        }
        narrow = None
        if "spatial_files" in run and run["phase"] == "base" and len(wide):
            narrow = target.with_name(f"{target.stem}-narrow.parquet")
            spool.write_parquet(narrow, wide.select(SEARCH_SCHEMA.names), self.settings.parquet_row_group_rows)
            stage["narrow"] = spool.seal(narrow, len(wide))
        try:
            return self._update(run, guard, stage=stage)
        except ConflictError:
            # This unique file is unreachable if the journal CAS rejected it.
            target.unlink(missing_ok=True)
            if narrow is not None:
                narrow.unlink(missing_ok=True)
            raise

    def _apply(self, run, guard):
        stage = run["stage"]
        if run["phase"] == "spatial_write":
            target = spool.verify(self.stage, run["id"], stage, self._memory_limit)
            narrow = pq.read_table(target, use_threads=False)
            if narrow.schema != SEARCH_SCHEMA or stage["cursor"][0] - run["spatial_cursor"][0] != len(narrow):
                raise RuntimeError("The staged search batch differs from its durable cursor or schema.")
            self.lake.apply_initial_search(stage["id"], narrow, guard=guard)
            updated = self._update(run, guard, stage=None, spatial_cursor=stage["cursor"],
                                   batch_no=run["batch_no"] + 1)
            target.unlink(missing_ok=True)
            log.debug("Applied spatial batch %s for dataset %s", stage["id"], run["table_id"])
            return updated
        target = self.stage / stage.get("file", f"{stage['id']}.parquet")
        if not target.is_file():
            raise RuntimeError("A durable staged batch is missing. Restore the staging directory before retrying.")
        guard()
        self._memory_limit()
        wide = pq.read_table(target, use_threads=False)
        keys = pa.array(stage["keys"], type=pa.int64()) if stage["keys"] is not None else None
        spatial_base = "spatial_files" in run and run["phase"] == "base"
        if spatial_base:
            if stage["rows"] != len(wide) or bool(len(wide)) != ("narrow" in stage):
                raise RuntimeError("The staged wide batch differs from its durable narrow spool.")
            if len(wide):
                if stage["narrow"]["rows"] != len(wide):
                    raise RuntimeError("The staged wide batch differs from its durable narrow spool.")
                spool.verify(self.stage, run["id"], stage["narrow"], self._memory_limit)
            self.lake.apply_initial_wide(run["table_id"], stage["id"], wide, guard=guard)
        else:
            self.lake.apply(run["table_id"], stage["id"], wide, keys, guard=guard)
        guard()
        cursor = "cdc_cursor" if run["phase"] == "cdc" else "base_cursor"
        updated = {
            **run, cursor: stage["cursor"], "stage": None, "batch_no": run["batch_no"] + 1,
            "added": run["added"] + stage["rows"], "revision": run["revision"] + 1,
        }
        if spatial_base and "narrow" in stage:
            updated["spatial_files"] = [*run["spatial_files"], stage["narrow"]]
        with self.registry.connect() as conn:
            result = conn.execute(
                "UPDATE etl_pending SET revision=?,payload=? WHERE singleton=1 AND id=? AND revision=?",
                (updated["revision"], json.dumps(updated), run["id"], run["revision"]),
            )
            if result.rowcount != 1:
                raise ConflictError("The ETL work lease changed. Retry the operation.")
            if stage["keys"] is not None:
                conn.executemany(
                    "DELETE FROM etl_rejects WHERE table_id=? AND object_id=?",
                    ((run["table_id"], key) for key in stage["keys"]),
                ).close()
            if stage["rejects"]:
                conn.executemany(
                    "INSERT INTO etl_rejects (table_id,object_id,reason) VALUES (?,?,?) "
                    "ON CONFLICT(table_id,object_id) DO UPDATE SET reason=excluded.reason",
                    ((run["table_id"], key, reason) for key, reason in stage["rejects"]),
                ).close()
        target.unlink(missing_ok=True)
        log.debug("Applied batch %s for dataset %s", stage["id"], run["table_id"])
        return updated

    @staticmethod
    def _validate_source(source, run):
        refreshed = getattr(source, "validate_layout", None)
        try:
            fingerprint = refreshed() if refreshed else source.layout.fingerprint
        except ValueError as error:
            raise ReloadRequired("The source schema changed. Remove and reload the dataset.") from error
        if fingerprint != run["schema"]:
            raise ReloadRequired("The source schema changed. Remove and reload the dataset.")

    def _finish(self, run, source, guard):
        table_id = run["table_id"]
        self._validate_source(source, run)
        guard()
        previous = self.registry.current_publication()
        checkpoint = {"source": run["source"]}
        if run["mode"] == "cdc":
            checkpoint["lsn"] = run["high"]
        else:
            checkpoint["key"] = run["base_cursor"]
        publication = None
        if run["first"] or run["batch_no"]:
            search, wide, (search_count, wide_count) = self.lake.snapshots(table_id, source.layout.schema)
            expected = (previous or {}).get("counts", {}).get(table_id, 0) + run["added"]
            if search_count != wide_count or (run["mode"] == "insert" and search_count != expected):
                raise RuntimeError("Lake validation found different searchable row counts. Publication is pending.")
            publication = _publication(previous, search)
            publication["wide_snapshots"][table_id] = wide
            publication["counts"][table_id] = search_count
            publication["columns"][table_id] = source.layout.fields
        with self.registry.write_lease():
            guard()
            with self.registry.connect() as conn:
                result = conn.execute(
                    "DELETE FROM etl_pending WHERE singleton=1 AND id=? AND revision=?",
                    (run["id"], run["revision"]),
                )
                if result.rowcount != 1:
                    raise ConflictError("The ETL work lease changed. Retry the operation.")
                conn.execute(
                    "INSERT INTO etl_checkpoints (table_id,payload) VALUES (?,?) "
                    "ON CONFLICT(table_id) DO UPDATE SET payload=excluded.payload",
                    (table_id, json.dumps(checkpoint)),
                )
                if publication:
                    self.registry.publish(publication, conn)
        self._clean_stage(run["id"])
        if publication:
            log.info("Published dataset %s with %d searchable rows", table_id, search_count)
        return publication or previous

    def _clean_stage(self, run_id):
        UUID(run_id)
        for path in self.stage.glob(f"{run_id}-*"):
            if path.is_dir() and not path.is_symlink():
                spool.clean_run_spill(self.stage, run_id, path)
            else:
                path.unlink(missing_ok=True)

    @staticmethod
    def _paused(table_id, reason, batches, run=None):
        state = run or {}
        phase = state.get("phase", "not_started")
        rows = state.get("added", 0)
        log.info("Paused dataset %s in %s after %d batches this run (%s)", table_id, phase, batches, reason)
        return {
            "status": "paused", "table_id": table_id, "reason": reason, "phase": phase,
            "rows": rows, "batches": batches, "total_batches": state.get("batch_no", 0),
            "cursor": {"base": state.get("base_cursor"), "cdc": state.get("cdc_cursor"),
                       **({"spatial": state.get("spatial_cursor")} if "spatial_files" in state else {})},
        }

    def _ingest(self, table_id, descriptor, guard, pending=None, *, max_batches=None, stop_file=None):
        if self.registry.bulk_preparation(table_id):
            raise ConflictError("This dataset is reserved for bulk preparation. Resume bulk-prepare, bulk-activate or bulk-discard first.")
        dataset = self.registry.get_dataset(table_id)
        if dataset["status"] == "removing":
            raise ConflictError("Removal is pending for this dataset. Retry remove.")
        checkpoint = self._checkpoint(table_id)
        if checkpoint and checkpoint["source"] != descriptor:
            raise ConflictError("The registered source differs from its checkpoint. Remove and reload the dataset.")
        if pending and pending["source"] != descriptor:
            raise ConflictError("Resume using the source of the pending ETL run.")
        with self._source(dataset, descriptor) as source:
            if pending is None and stop_file is not None and stop_file.exists():
                self._validate_source(source, {"schema": dataset["schema_fingerprint"] or source.layout.fingerprint})
                guard()
                return self._paused(table_id, "stop_file", 0)
            run = pending or self._begin(dataset, source, descriptor, checkpoint, guard)
            initial_batch_no = run["batch_no"]
            self._validate_source(source, run)
            if "spatial_files" in run and run["spatial_resolution"] != self.settings.partition_resolution:
                raise ConflictError("Resume initial search grouping with the original partition resolution.")
            spatial_reader = None
            while True:
                guard()
                if run["stage"]:
                    run = self._apply(run, guard)
                    continue
                batches = run["batch_no"] - initial_batch_no
                if stop_file is not None and stop_file.exists():
                    return self._paused(table_id, "stop_file", batches, run)
                if max_batches is not None and batches >= max_batches:
                    return self._paused(table_id, "max_batches", batches, run)
                phase = run["phase"]
                if phase == "publish":
                    return self._finish(run, source, guard)
                if phase == "fence":
                    run = self._update(run, guard, phase="cdc", high=source.fence(run["marker"]))
                    continue
                if phase == "spatial_prepare":
                    try:
                        sorted_spool = spool.sort_narrow(self.stage, run, self.settings, self._memory_limit, guard, stop_file)
                    except spool.SortStopped:
                        return self._paused(table_id, "stop_file", batches, run)
                    self._validate_source(source, run)
                    run = self._update(run, guard, phase="spatial_write", spatial_sorted=sorted_spool,
                                       spatial_cursor=[0, None, None])
                    continue
                if phase == "spatial_write":
                    if run["spatial_sorted"] is not None:
                        if spatial_reader is None:
                            spatial_reader = spool.SpatialReader(self.stage, run, self._memory_limit)
                        limit = min(self._memory_limit(), self.settings.fetch_batch_rows * spool.ROW_BUDGET)
                        narrow, cursor = spatial_reader.next(run["spatial_cursor"], limit)
                        if narrow is not None:
                            batch_id = f"{run['id']}-{run['batch_no']}"
                            path = self.stage / f"{batch_id}-{new_id()}-spatial.parquet"
                            spool.write_parquet(path, narrow, self.settings.parquet_row_group_rows)
                            stage = {"id": batch_id, "cursor": cursor, **spool.seal(path, len(narrow))}
                            run = self._update(run, guard, stage=stage)
                            del narrow
                            continue
                    if run["spatial_cursor"][0] != run["added"]:
                        raise RuntimeError("The initial search load differs from the pending base count.")
                    run = self._update(run, guard, phase="fence" if run["mode"] == "cdc" else "publish")
                    continue
                limit = self._memory_limit()
                rows = self.settings.fetch_batch_rows
                if phase == "base":
                    changes, cursor = source.read_base(run["base_cursor"], run["cutoff"], rows, limit)
                else:
                    changes, cursor = source.read_changes(
                        run["baseline"], run["high"], run["cdc_cursor"], min(rows, self.settings.cdc_batch_rows), limit,
                    )
                if changes:
                    self._validate_source(source, run)
                    run = self._stage_batch(run, source, changes, cursor, guard)
                    del changes
                elif phase == "base" and "spatial_files" in run:
                    marker = source.scan_marker() if run["mode"] == "cdc" else None
                    run = self._update(run, guard, phase="spatial_prepare", marker=marker)
                elif phase == "base" and run["mode"] == "cdc":
                    run = self._update(run, guard, phase="fence", marker=source.scan_marker())
                else:
                    run = self._update(run, guard, phase="publish")

    def _execute(self, table_id, descriptor, *, max_batches=None, stop_file=None):
        UUID(table_id)
        with self.registry.writer_lease() as guard:
            guard = guard or (lambda: None)
            self._recover_bulk_activation(guard)
            current = self.registry.current_publication()
            pending_load = self._pending()
            if pending_load and pending_load.get("operation") not in ("ingest", "remove", "load"):
                raise ConflictError("Finish the pending ETL operation before ordinary ingestion.")
            if (current and current.get("layout_version") == 2) or (pending_load and pending_load.get("operation") == "load"):
                raise ConflictError("Use load to refresh isolated lookup layouts. Ordinary ingestion cannot modify their immutable generations.")
            if self.registry.bulk_preparation(table_id):
                raise ConflictError("This dataset is reserved for bulk preparation. Resume bulk-prepare, bulk-activate or bulk-discard first.")
            pending = self._pending()
            if pending and (max_batches is not None or stop_file is not None):
                if pending["operation"] == "remove":
                    raise ConflictError(f"Finish pending removal of dataset {pending['table_id']} before a bounded run.")
                if pending["table_id"] != table_id:
                    raise ConflictError(f"Resume the pending run for dataset {pending['table_id']} before a bounded run on another dataset.")
            if pending and pending["operation"] == "remove":
                self._remove(pending["table_id"], guard, pending)
                if (self.registry.current_publication() or {}).get("layout_version") == 2:
                    raise ConflictError("Removal completed and published new lookup tables. Retry the requested run.")
                pending = None
            elif pending and pending["table_id"] != table_id:
                self._ingest(pending["table_id"], pending["source"], guard, pending)
                pending = None
            try:
                return self._ingest(table_id, descriptor, guard, pending, max_batches=max_batches, stop_file=stop_file)
            except CapturePending:
                raise
            except (ReloadRequired, ValueError):
                guard()
                with self.registry.connect() as conn:
                    conn.execute(
                        "UPDATE datasets SET status='error',updated_at=? WHERE id=? AND status IN ('registered','loading')",
                        (utc_now(), table_id),
                    )
                raise

    def run(self, table_id, *, max_batches=None, stop_file=None):
        """Load a fixed SQL Server key/LSN interval, optionally pausing between batches."""
        current = self.registry.current_publication()
        pending = self._pending()
        if (current and current.get("layout_version") == 2) or (pending and pending.get("operation") == "load"):
            if pending and pending.get("operation") != "load":
                raise ConflictError("Finish the pending ETL operation before ingesting a dataset.")
            self.registry.get_dataset(table_id)
            from .load import Load
            return Load(self).execute(pending["lookup"] if pending else current["lookup_mode"], max_batches=max_batches, stop_file=stop_file, incremental=True, table_ids={table_id})
        if max_batches is not None and (type(max_batches) is not int or max_batches < 1):
            raise ValueError("Batch limit must be a positive integer.")
        return self._execute(
            table_id, {"kind": "sql"}, max_batches=max_batches,
            stop_file=Path(stop_file) if stop_file is not None else None,
        )

    def load(self, lookup="r3", *, max_batches=None, stop_file=None, initial_only=False, source_frozen=False, output_read_plan=None):
        """Atomically refresh the configured datasets and selected isolated lookup layouts."""
        from .load import Load
        return Load(self).execute(lookup, max_batches=max_batches, stop_file=stop_file,
                                  initial_only=initial_only, source_frozen=source_frozen, output_read_plan=output_read_plan)

    def discard_load(self):
        """Cancel and reclaim a pending unpublished isolated load."""
        from .load_discard import discard
        return discard(self)

    def import_parquet(self, table_id, path):
        """Publish an explicitly supplied, immutable, sorted Parquet fixture."""
        dataset = self.registry.get_dataset(table_id)
        if dataset["mode"] != "insert" or dataset.get("geometry_column"):
            raise ValueError("Parquet import requires insert mode with explicit latitude and longitude columns.")
        return self._execute(table_id, {"kind": "parquet", "path": str(Path(path).resolve(strict=True))})

    def _pinned(self):
        pins = {}
        publications = [self.registry.current_publication()]
        publications.extend(
            session.get("publication") for session in self.registry.active_sessions() if not session.get("invalidated")
        )
        for publication in publications:
            if publication:
                name = publication.get("search_table_name", search_name)
                pins.setdefault(name, set()).add(str(publication["search_snapshot_id"]))
                for lookup in publication.get("lookup_publications", {}).values():
                    pins.setdefault(lookup["search_table_name"], set()).add(str(lookup["search_snapshot_id"]))
                for table_id, snapshot in publication["wide_snapshots"].items():
                    name = publication.get("wide_table_names", {}).get(table_id, wide_name(table_id))
                    pins.setdefault(name, set()).add(str(snapshot))
        return pins

    def _begin_remove(self, table_id, guard, pending):
        self.registry.get_dataset(table_id)
        location = self.lake.location(wide_name(table_id))
        run = {
            "id": new_id(), "revision": 0, "table_id": table_id, "operation": "remove",
            "phase": "index", "wide_location": location, "ingest_id": pending["id"] if pending else None,
            "stage_owner": self.settings.bulk_owner_id or socket.gethostname(), "stage_root": str(self.stage.resolve()),
        }
        with self.registry.write_lease():
            guard()
            with self.registry.connect() as conn:
                conn.execute("UPDATE datasets SET status='removing',updated_at=? WHERE id=?", (utc_now(), table_id))
                self.registry.invalidate_sessions(table_id, conn)
                if pending:
                    result = conn.execute(
                        "UPDATE etl_pending SET id=?,revision=0,payload=? WHERE singleton=1 AND id=? AND revision=?",
                        (run["id"], json.dumps(run), pending["id"], pending["revision"]),
                    )
                    if result.rowcount != 1:
                        raise ConflictError("The ETL work lease changed. Retry removal.")
                else:
                    conn.execute(
                        "INSERT INTO etl_pending (singleton,id,table_id,revision,payload) VALUES (1,?,?,0,?)",
                        (run["id"], table_id, json.dumps(run)),
                    )
        return run

    def _remove(self, table_id, guard, pending):
        current = self.registry.current_publication()
        if self.settings.mode == "live" or (pending and pending.get("generation_removal")) or (current and current.get("layout_version") == 2):
            from .removal import remove
            return remove(self, table_id, guard, pending)
        run = pending if pending and pending["operation"] == "remove" else self._begin_remove(table_id, guard, pending)
        if not self.registry.request_dataset_export_purge(table_id):
            raise ConflictError("Dataset removal is waiting for export servers to reclaim their files. Keep the API running and retry removal.")
        if run["phase"] == "index":
            with self.registry.write_lease():
                guard()
                snapshot = self.lake.remove_rows(table_id)
                publication = _publication(self.registry.current_publication(), snapshot)
                for name in ("wide_snapshots", "counts", "columns"):
                    publication[name].pop(table_id, None)
                guard()
                with self.registry.connect() as conn:
                    self.registry.publish(publication, conn)
                    updated = {**run, "phase": "purge", "revision": run["revision"] + 1}
                    result = conn.execute(
                        "UPDATE etl_pending SET revision=?,payload=? WHERE singleton=1 AND id=? AND revision=?",
                        (updated["revision"], json.dumps(updated), run["id"], run["revision"]),
                    )
                    if result.rowcount != 1:
                        raise ConflictError("The ETL work lease changed. Retry removal.")
            run = updated
        from .single_file import discard_single_file

        discard_single_file(self, guard)
        while True:
            guard()
            pins = self._pinned().get(search_name, set())
            action = self.lake.plan_maintenance(search_name, pins, lambda: True, removed_id=table_id)
            if not action:
                break
            if action[0] == "expire":
                with self.registry.write_lease():
                    guard()
                    self.lake.apply_maintenance(search_name, action, self._pinned().get(search_name, set()))
            else:
                guard()
                if not self.lake.apply_maintenance(search_name, action, pins):
                    break
        guard()
        self.lake.drop_wide(table_id, run["wide_location"])
        if run["ingest_id"]:
            self._clean_stage(run["ingest_id"])
        with self.registry.write_lease():
            guard()
            if not self.registry.request_dataset_export_purge(table_id):
                raise ConflictError("Dataset removal is waiting for export servers to reclaim their files. Retry removal.")
            guard()
            with self.registry.connect() as conn:
                result = conn.execute(
                    "DELETE FROM etl_pending WHERE singleton=1 AND id=? AND revision=?",
                    (run["id"], run["revision"]),
                )
                if result.rowcount != 1:
                    raise ConflictError("The ETL work lease changed. Retry removal.")
                for name in ("etl_checkpoints", "etl_rejects"):
                    conn.execute(f"DELETE FROM {name} WHERE table_id=?", (table_id,))
                for row in conn.execute("SELECT id,payload FROM publications"):
                    if table_id in _payload(row).get("wide_snapshots", {}):
                        conn.execute("DELETE FROM publications WHERE id=?", (row["id"],))
                for row in conn.execute("SELECT id,payload FROM sessions"):
                    session = _payload(row)
                    if table_id in session.get("publication", {}).get("wide_snapshots", {}):
                        retained = {key: session[key] for key in ("id", "expires_at", "invalidated", "invalidated_reason") if key in session}
                        conn.execute("UPDATE sessions SET payload=? WHERE id=?", (json.dumps(retained), row["id"]))
                conn.execute("DELETE FROM datasets WHERE id=?", (table_id,))
                self.registry.remove_saved_dataset_references(table_id, conn)
                conn.execute("DELETE FROM export_dataset_purges WHERE table_id=?", (table_id,))
                conn.execute("INSERT INTO deletion_audit (id,table_id,deleted_at) VALUES (?,?,?)", (run["id"], table_id, utc_now()))
        log.info("Removed and reclaimed dataset %s", table_id)

    def remove(self, table_id):
        """Invalidate readers and completely reclaim a registered dataset."""
        UUID(table_id)
        with self.registry.writer_lease() as guard:
            guard = guard or (lambda: None)
            self._recover_bulk_activation(guard)
            if self.registry.bulk_preparation(table_id):
                raise ConflictError("This dataset is reserved for bulk preparation. Use bulk-discard before removal, or recover bulk-activate if admission has started.")
            pending = self._pending()
            if pending and pending["operation"] in ("load", "discard-load"):
                raise ConflictError("Resume the pending load or finish discard-load before removing a dataset.")
            if pending and pending.get("stage_owner") and (pending["stage_owner"] != (self.settings.bulk_owner_id or socket.gethostname()) or pending.get("stage_root") != str(self.stage.resolve())):
                raise ConflictError("Finish removal on the pending ETL operation's original staging owner and stage_path.")
            if pending and pending["table_id"] != table_id:
                raise ConflictError("Resolve the pending operation on the other dataset before removing this one.")
            self._remove(table_id, guard, pending)

    def _publish_compaction(self, name, snapshot, guard, *, regroup_parent=None, can_continue=lambda: True):
        expected = self.registry.current_publication() if regroup_parent is not None else None
        if regroup_parent is not None:
            def check():
                guard()
                self._memory_limit()
                if not can_continue():
                    raise TimeoutError("Search manifest regroup reached its maintenance window boundary.")
            # Exact metadata proof runs under writer exclusion without blocking readers.
            identity = self.lake.verify_search_regroup(regroup_parent, snapshot, name=name, check=check)
        with self.registry.write_lease(timeout=0.25):
            guard()
            current = self.registry.current_publication()
            if regroup_parent is not None:
                if current != expected or not current or current["search_snapshot_id"] != regroup_parent:
                    raise ConflictError("The search publication changed before manifest regroup publication.")
                if current.get("layout_version") == 2 and current.get("search_table_name") != name:
                    raise ConflictError("The R3 publication table changed before regroup publication.")
                if self.lake.verify_search_regroup(regroup_parent, snapshot, name=name, verify_inventory=False) != identity:
                    raise ConflictError("The search table changed after exact regroup verification.")
                if not can_continue():
                    raise TimeoutError("Search manifest regroup reached its maintenance window boundary.")
                guard()
            publication = (deepcopy(current) if current.get("layout_version") == 2
                           else _publication(current, current["search_snapshot_id"]))
            if current.get("layout_version") == 2 and regroup_parent is not None:
                publication["search_snapshot_id"] = snapshot
                publication["lookup_publications"]["r3"]["search_snapshot_id"] = snapshot
            elif name == search_name:
                publication["search_snapshot_id"] = snapshot
            else:
                table_id = next(key for key in current["wide_snapshots"] if wide_name(key) == name)
                publication["wide_snapshots"][table_id] = snapshot
            with self.registry.connect() as conn:
                self.registry.publish(publication, conn)

    def _optimize_search(self, current, guard, can_continue):
        published = current["search_snapshot_id"] if current else None
        if published is None:
            log.info("Search manifest optimization unchanged: no published search snapshot")
            return {"status": "no_publication"}
        log.info("Starting search manifest optimization for snapshot %s", published)
        generation = current.get("layout_version") == 2
        if generation and "r3" not in current.get("lookup_publications", {}):
            return {"status": "unchanged", "search_snapshot_id": published}
        name = current["lookup_publications"]["r3"]["search_table_name"] if generation else search_name
        if generation and (current.get("search_table_name") != name
                           or current["lookup_publications"]["r3"]["search_snapshot_id"] != published):
            raise ConflictError("The paired R3 publication is inconsistent.")
        candidate = self.lake.regroup_search(published, can_continue, self._memory_limit, guard,
                                            **({"name": name} if generation else {}))
        if candidate is None:
            log.info("Search manifest optimization left snapshot %s unchanged", published)
            return {"status": "unchanged", "search_snapshot_id": published}
        self._publish_compaction(name, candidate, guard, regroup_parent=published, can_continue=can_continue)
        log.info("Search manifest optimization published snapshot %s from %s", candidate, published)
        return {"status": "published", "search_snapshot_id": candidate}

    def optimize_search(self, stop_file=None):
        """Regroup published search manifests without reading source rows or data files."""
        if not hasattr(self.lake, "regroup_search"):
            raise ConflictError("Search manifest optimization is available only for Iceberg storage.")
        stop_file = Path(stop_file) if stop_file is not None else None

        def can_continue():
            if stop_file is not None and stop_file.exists():
                raise TimeoutError("Search manifest optimization stopped. Remove the stop file and retry to publish any committed regroup.")
            return True

        with self.registry.writer_lease(timeout=0) as guard:
            self._recover_bulk_activation(guard or (lambda: None))
            if self._pending():
                raise ConflictError("Resolve pending ETL work before optimizing search.")
            can_continue()
            current = self.registry.current_publication()
            return self._optimize_search(current, guard, can_continue)

    def maintain(self, clock=lambda: datetime.now(UTC), yield_if=lambda: False):
        """Compact and reclaim bounded units within the local window, yielding to ingestion."""
        from .load import clean_completed_load_stages
        with self.registry.writer_lease(timeout=0) as guard:
            clean_completed_load_stages(self, guard or (lambda: None))
        units = 0
        for _ in range(self.settings.maintenance_max_files):
            window = maintenance_window(self.settings, clock())
            if not window or yield_if():
                break
            key, _ = window
            with self.registry.writer_lease(timeout=0) as guard:
                self._recover_bulk_activation(guard or (lambda: None))
                if self._pending() or maintenance_window(self.settings, clock()) != window or yield_if():
                    break
                with self.registry.connect() as conn:
                    state = _payload(conn.execute("SELECT payload FROM etl_maintenance WHERE singleton=1").fetchone())
                state = state or {"key": key, "seconds": 0, "after": "", "done": False}
                if state["key"] != key:
                    state = {**state, "key": key, "seconds": 0, "done": False, "search_metadata_done": False}
                remaining = self.settings.maintenance_budget_sec - state["seconds"]
                if state["done"] or remaining <= 0:
                    break
                started = monotonic()

                def can_continue():
                    return (
                        not yield_if() and monotonic() - started < remaining
                        and maintenance_window(self.settings, clock()) == window
                    )

                current = self.registry.current_publication()
                if current and current.get("layout_version") == 2:
                    if self.registry.bulk_preparations() or self.registry.bulk_activation():
                        break
                    cutoff = (clock() - timedelta(days=self.settings.snapshot_retention_days)).astimezone(UTC).isoformat()
                    with self.registry.connect() as conn:
                        row = conn.execute(
                            "SELECT name FROM retired_tables WHERE retired_at<=? AND name>? ORDER BY name LIMIT 1",
                            (cutoff, state.get("retired_after", "")),
                        ).fetchone()
                    if row:
                        name = row["name"]
                        with self.registry.write_lease(timeout=0.25):
                            pinned = name in self._pinned()
                        if not can_continue():
                            break
                        if not pinned:
                            # New sessions can only acquire current tables. The writer
                            # lease prevents a publisher from changing those pointers.
                            if guard:
                                guard()
                            self.lake.drop_owned_table(name, self.lake.location(name))
                            with self.registry.connect() as conn:
                                conn.execute("DELETE FROM retired_tables WHERE name=?", (name,))
                        state["retired_after"] = name
                    else:
                        state.update(retired_after="", done=True)
                    state["seconds"] += monotonic() - started
                    with self.registry.connect() as conn:
                        conn.execute(
                            "INSERT INTO etl_maintenance (singleton,payload) VALUES (1,?) "
                            "ON CONFLICT(singleton) DO UPDATE SET payload=excluded.payload", (json.dumps(state),),
                        )
                    units += 1
                    continue
                names = {search_name: current["search_snapshot_id"]} if current else {}
                if current:
                    names.update((wide_name(table_id), snapshot) for table_id, snapshot in current["wide_snapshots"].items())
                # Reservations protect all target-wide files, including uploads
                # that have not reached any Iceberg snapshot yet.
                reserved_wide = {wide_name(run["table_id"]) for run in self.registry.bulk_preparations()}
                names = {name: snapshot for name, snapshot in names.items() if name not in reserved_wide}
                name = min((name for name in names if name > state["after"]), default=None)
                if current and not state.get("search_metadata_done") and hasattr(self.lake, "regroup_search"):
                    # Recover any unpublished data compaction using its existing phase.
                    compacted = self.lake.compaction_head(search_name)
                    if compacted is None or compacted == current["search_snapshot_id"]:
                        try:
                            self._optimize_search(current, guard, can_continue)
                        except (TimeoutError, MemoryError) as error:
                            log.info("Search manifest maintenance yielded: %s", error)
                    if can_continue():
                        state["search_metadata_done"] = True
                elif name and state.get("phase") != "reclaim":
                    snapshot = self.lake.compaction_head(name)
                    if snapshot == names[name] or snapshot is None:
                        snapshot = self.lake.compact_unit(
                            name, self.settings.maintenance_max_files, self._memory_limit(), can_continue, guard,
                        )
                        if (snapshot is None and name != search_name
                                and hasattr(self.lake, "normalize_wide") and can_continue()):
                            snapshot = self.lake.normalize_wide(name, can_continue, guard)
                    if snapshot is not None and can_continue():
                        self._publish_compaction(name, snapshot, guard)
                    if snapshot is None and can_continue():
                        state["phase"] = "reclaim"
                elif name:
                    pins = self._pinned().get(name, set())
                    action = self.lake.plan_maintenance(name, pins, can_continue)
                    if (action and action[0] != "expire" and self.registry.bulk_preparations()
                            and (name == search_name or name in reserved_wide)):
                        # Old unreferenced uploads remain recoverable even when
                        # preparation has been paused beyond retention.
                        action = None
                    if action and can_continue():
                        if action[0] == "expire":
                            with self.registry.write_lease(timeout=0.25):
                                if can_continue():
                                    guard()
                                    self.lake.apply_maintenance(name, action, self._pinned().get(name, set()))
                        else:
                            guard()
                            self.lake.apply_maintenance(name, action, pins)
                    elif not action and can_continue():
                        state.update(after=name, phase="compact")
                else:
                    state.update(after="", phase="compact", done=True)
                state["seconds"] += monotonic() - started
                guard()
                with self.registry.connect() as conn:
                    conn.execute(
                        "INSERT INTO etl_maintenance (singleton,payload) VALUES (1,?) "
                        "ON CONFLICT(singleton) DO UPDATE SET payload=excluded.payload", (json.dumps(state),),
                    )
                units += 1
        return units

    def poll(self):
        """Resume unfinished work, then ingest each eligible SQL Server dataset once."""
        pending_load = self._pending()
        current = self.registry.current_publication()
        if pending_load and pending_load.get("operation") == "discard-load":
            return self.discard_load()
        if pending_load and pending_load.get("operation") not in ("ingest", "remove", "load"):
            raise ConflictError("Finish the pending ETL operation before ordinary polling.")
        if pending_load and pending_load.get("operation") == "load":
            from .load import Load
            return Load(self).execute(pending_load["lookup"], incremental=True)
        if current and current.get("layout_version") == 2 and not pending_load:
            from .load import Load
            return Load(self).execute(current["lookup_mode"], incremental=True)
        if self.registry.bulk_activation():
            with self.registry.writer_lease() as guard:
                self._recover_bulk_activation(guard or (lambda: None))
        pending = self._pending()
        completed = None
        if pending:
            completed = pending["table_id"]
            if pending["operation"] == "discard-load":
                self.discard_load()
            elif pending["operation"] == "remove":
                self.remove(completed)
            else:
                self._execute(completed, pending["source"])
        for dataset in self.registry.list_datasets():
            table_id = dataset["id"]
            if table_id == completed or dataset["status"] in ("error", "removing"):
                continue
            if self.registry.bulk_preparation(table_id):
                continue
            checkpoint = self._checkpoint(table_id)
            if checkpoint and checkpoint["source"]["kind"] == "parquet":
                continue
            self.run(table_id)

    def _recover_bulk_activation(self, guard):
        from .bulk import Bulk
        return Bulk(self).recover(guard)

    def bulk_prepare(self, table_id, *, max_batches=None, stop_file=None):
        """Prepare a fresh insert-only dataset without blocking other ingestion."""
        current = self.registry.current_publication()
        pending = self._pending()
        if (current and current.get("layout_version") == 2) or (pending and pending.get("operation") == "load"):
            raise ConflictError("Use load to refresh isolated lookup layouts before preparing ordinary bulk ingestion.")
        from .bulk import Bulk
        return Bulk(self).prepare(table_id, max_batches=max_batches, stop_file=stop_file)

    def bulk_activate(self, table_id):
        """Recover and publish a complete immutable prepared load atomically."""
        current = self.registry.current_publication()
        pending = self._pending()
        if (current and current.get("layout_version") == 2) or (pending and pending.get("operation") == "load"):
            raise ConflictError("Ordinary bulk activation cannot modify isolated lookup generations. Use load.")
        from .bulk import Bulk
        return Bulk(self).activate(table_id)

    def bulk_status(self, table_id):
        """Show the durable progress of a reserved initial load."""
        from .bulk import Bulk
        return Bulk(self).status(table_id)

    def bulk_discard(self, table_id):
        """Discard an unadmitted preparation and release its target reservation."""
        from .bulk import Bulk
        return Bulk(self).discard(table_id)
