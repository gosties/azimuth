"""Durable cancellation and reclamation of an unpublished isolated load."""

from pathlib import Path
import shutil
import socket
from uuid import UUID

from h3search.control import ConflictError
from .lake import LocalLake


def _check_stage(engine, run):
    if (run.get("stage_owner") != (engine.settings.bulk_owner_id or socket.gethostname())
            or run.get("stage_root") != str(engine.stage.resolve())):
        raise ConflictError("Discard requires the load's original owner and staging directory. Restore its bulk_owner_id and stage_path.")
    path = engine.stage / f"load-{UUID(run['id'])}"
    if path.is_symlink() or path.is_junction() or path.resolve() != engine.stage.resolve() / path.name:
        raise ConflictError("The load staging directory is outside its owned path.")
    return path


def _check_base(engine, run):
    current = engine.registry.current_publication()
    if (current["id"] if current else None) != run["base_publication_id"]:
        raise ConflictError("The published data changed. An active publication cannot be discarded.")


def discard(engine):
    registry, lake = engine.registry, engine.lake
    with registry.writer_lease() as guard:
        guard = guard or (lambda: None)
        run = engine._pending()
        if run is None:
            return {"status": "no_pending_load"}
        if run["operation"] not in ("load", "discard-load"):
            raise ConflictError("The pending ETL operation is not an unpublished load.")
        stage = _check_stage(engine, run)
        _check_base(engine, run)
        suffix = UUID(run["id"]).hex
        names = [f"wide_{UUID(dataset['id']).hex}_{suffix}" for dataset in run["datasets"]]
        if run["lookup"] in ("r3", "both"):
            names.append(f"search_r3_{suffix}")
        if run["lookup"] in ("single-file", "both"):
            names.append(f"search_single_{suffix}")
        with registry.write_lease():
            guard()
            pins = engine._pinned()
            for name in names:
                if pins.get(name):
                    raise ConflictError("A published or retained snapshot references a load output. It cannot be discarded.")
                if isinstance(lake, LocalLake):
                    head = lake._head(name)
                    if head and head.get("batch") != run["id"]:
                        raise ConflictError("A load output belongs to another operation.")
                else:
                    table = lake._load(name)
                    if table and table.current_snapshot() and table.current_snapshot().summary.get("h3search.load-id") != run["id"]:
                        raise ConflictError("A load output belongs to another operation.")
            if run["operation"] == "load":
                locations = {name: lake.location(name) for name in names}
                # This persisted intent fences resume before any output is deleted.
                run = engine._update(run, guard, operation="discard-load", discard_locations=locations)
        for name in names:
            guard()
            with registry.write_lease():
                guard()
                _check_base(engine, run)
                if engine._pinned().get(name):
                    raise ConflictError("A retained snapshot references a load output. Retry after resolving its publication.")
                lake.drop_owned_table(name, run["discard_locations"][name])
                with registry.connect() as conn:
                    conn.execute("DELETE FROM retired_tables WHERE name=?", (name,))
        stage = _check_stage(engine, run)
        guard()
        if stage.exists():
            shutil.rmtree(stage)
        if stage.exists():
            raise OSError("The unpublished load staging directory could not be reclaimed.")
        with registry.write_lease():
            guard()
            _check_base(engine, run)
            with registry.connect() as conn:
                result = conn.execute("DELETE FROM etl_pending WHERE singleton=1 AND id=? AND revision=?", (run["id"], run["revision"]))
                if result.rowcount != 1:
                    raise ConflictError("The load work lease changed. Retry discard-load.")
        return {"status": "discarded", "load_id": run["id"]}
