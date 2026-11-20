"""Restartable reclamation of isolated lookup generations and dataset records."""

import json
import socket
from pathlib import Path
from uuid import UUID

from h3ronpy.vector import coordinates_to_cells
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from h3search.control import ConflictError
from h3search.models import new_id, utc_now
from .lake import LocalLake
from .layout import SEARCH_SCHEMA, owned_table_name, search_name, wide_name
from .load import build_lookups, clean_completed_load_stages
from .single_file import ResourceBounds, discard_single_file


def _lookup_names(publication):
    names = {value["search_table_name"] for value in publication.get("lookup_publications", {}).values()}
    if publication.get("search_table_name"):
        names.add(publication["search_table_name"])
    elif publication.get("search_snapshot_id") is not None:
        names.add(search_name)
    if any(not owned_table_name(name) or not name.startswith("search_") for name in names):
        raise RuntimeError("A publication references an invalid owned lookup table.")
    return names


def _validate_publication(publication):
    _lookup_names(publication)
    for table_id, name in publication.get("wide_table_names", {}).items():
        prefix = wide_name(table_id)
        if not owned_table_name(name) or not (name == prefix or name.startswith(prefix + "_")):
            raise RuntimeError("A publication references another dataset's wide table.")


def _publications(conn):
    after = ""
    while True:
        rows = conn.execute("SELECT id,payload FROM publications WHERE id>? ORDER BY id LIMIT 100", (after,)).fetchall()
        if not rows:
            return
        yield from rows
        after = rows[-1]["id"]


def begin(engine, table_id, guard, pending):
    """Freeze the complete owned reclamation inventory before changing any pointers."""
    registry, lake = engine.registry, engine.lake
    registry.get_dataset(table_id)
    with registry.write_lease():
        guard()
        base = registry.current_publication() or {"id": None, "counts": {}, "wide_snapshots": {}, "columns": {}}
        _validate_publication(base)
        modes = base.get("lookup_publications", {})
        lookup = "both" if len(modes) > 1 or (base.get("layout_version") != 2 and registry.single_file_publication()) else next(iter(modes), "r3")
        tables = {wide_name(table_id): lake.location(wide_name(table_id))}
        if base.get("layout_version") != 2:
            tables[search_name] = lake.location(search_name)
        def remember(name):
            if name not in tables:
                tables[name] = lake.location(name)
        with registry.connect() as conn:
            stage_publications = []
            for row in _publications(conn):
                publication = json.loads(row["payload"])
                if table_id not in publication.get("wide_snapshots", {}) and table_id not in publication.get("counts", {}):
                    continue
                _validate_publication(publication)
                stage_publications.append(row["id"])
                wide = publication.get("wide_table_names", {}).get(table_id, wide_name(table_id))
                if not owned_table_name(wide) or not (wide == wide_name(table_id) or wide.startswith(wide_name(table_id) + "_")):
                    raise RuntimeError("A publication references another dataset's wide table.")
                remember(wide)
                for name in _lookup_names(publication):
                    remember(name)
            pins = engine._pinned()
            for row in conn.execute("SELECT name FROM retired_tables").fetchall():
                name = row["name"]
                target_wide = name == wide_name(table_id) or name.startswith(wide_name(table_id) + "_")
                if target_wide or (name.startswith("search_") and not pins.get(name)):
                    remember(name)
            run = {"id": new_id(), "revision": 0, "table_id": table_id, "operation": "remove", "generation_removal": True,
                   "phase": "index", "base": base, "tables": tables,
                   "lookup": lookup,
                   "stage_owner": engine.settings.bulk_owner_id or socket.gethostname(), "stage_root": str(engine.stage.resolve()),
                   "completed_stages": stage_publications + [row["id"] for row in conn.execute("SELECT c.id FROM etl_completed_loads c LEFT JOIN publications p ON p.id=c.id WHERE p.id IS NULL").fetchall()],
                   "ingest_id": (pending.get("ingest_id") if pending["operation"] == "remove" else pending["id"]) if pending else None}
            conn.execute("UPDATE datasets SET status='removing',updated_at=? WHERE id=?", (utc_now(), table_id))
            registry.invalidate_sessions(table_id, conn)
            if pending:
                result = conn.execute("UPDATE etl_pending SET id=?,revision=0,payload=? WHERE singleton=1 AND id=? AND revision=?",
                                      (run["id"], json.dumps(run), pending["id"], pending["revision"]))
                if result.rowcount != 1:
                    raise ConflictError("The ETL work lease changed. Retry removal.")
            else:
                conn.execute("INSERT INTO etl_pending (singleton,id,table_id,revision,payload) VALUES (1,?,?,0,?)",
                             (run["id"], table_id, json.dumps(run)))
    return run


def _survivor_narrow(engine, run, root, guard):
    """Stream frozen lookup rows into bounded canonical batches without reading a source."""
    base = run["base"]
    if base.get("search_snapshot_id") is None:
        target = root / "survivors.parquet"
        pq.write_table(SEARCH_SCHEMA.empty_table(), target)
        return target
    lookups = base.get("lookup_publications", {})
    lookup = lookups.get("r3") or lookups.get("single-file") or base
    name, snapshot = lookup.get("search_table_name", search_name), lookup["search_snapshot_id"]
    lake = engine.lake
    if isinstance(lake, LocalLake):
        files = lake.files(name, snapshot)
        open_file = lambda path: path.open("rb")
    else:
        table = lake._load(name)
        if table is None or table.snapshot_by_id(int(snapshot)) is None:
            raise RuntimeError("The frozen lookup snapshot needed for removal is unavailable.")
        lake.location(name)
        files = lake._data_files(table, table.snapshot_by_id(int(snapshot)))
        open_file = lambda file: table.io.new_input(file.file_path).open()
    target = root / "survivors.parquet"
    bounds = ResourceBounds(engine, root)
    counts = {key: 0 for key in base["counts"] if key != run["table_id"]}
    with pq.ParquetWriter(target, SEARCH_SCHEMA, compression="zstd") as writer:
        for index, file in enumerate(files):
            guard()
            bounds.check()
            if index >= engine.settings.bulk_max_files:
                raise RuntimeError("The frozen lookup exceeds its configured file inventory limit.")
            with open_file(file) as stream:
                stream.seek(-8, 2)
                footer = stream.read(8)
                if footer[4:] != b"PAR1" or int.from_bytes(footer[:4], "little") > engine.settings.bulk_max_footer_mb * 1048576:
                    raise RuntimeError("The frozen lookup footer exceeds its configured limit.")
                stream.seek(0)
                with pq.ParquetFile(stream) as source:
                    columns = [name for name in SEARCH_SCHEMA.names if name in source.schema_arrow.names]
                    for batch in source.iter_batches(batch_size=min(4096, engine.settings.fetch_batch_rows), columns=columns, use_threads=False):
                        guard()
                        bounds.check()
                        rows = pa.Table.from_batches([batch])
                        rows = rows.filter(pc.not_equal(rows["table_id"], run["table_id"]))
                        if not len(rows):
                            continue
                        arrays = []
                        for field in SEARCH_SCHEMA:
                            if field.name in rows.column_names:
                                arrays.append(rows[field.name])
                            else:
                                resolution = int(field.name.removeprefix("h3_r"))
                                arrays.append(pa.array(coordinates_to_cells(rows["lat"], rows["lon"], resolution)).cast(pa.int64()))
                        canonical = pa.Table.from_arrays(arrays, schema=SEARCH_SCHEMA)
                        if canonical.nbytes > engine._memory_limit():
                            raise MemoryError("A removal batch exceeds the configured memory limit.")
                        frequencies = pc.value_counts(canonical["table_id"])
                        for table_id, count in zip(frequencies.field("values").to_pylist(), frequencies.field("counts").to_pylist()):
                            if table_id not in counts:
                                raise RuntimeError("The frozen lookup contains an unpublished dataset.")
                            counts[table_id] += count
                        writer.write_table(canonical, row_group_size=engine.settings.parquet_row_group_rows)
    if counts != {key: value for key, value in base["counts"].items() if key != run["table_id"]}:
        raise RuntimeError("Survivor lookup counts differ from the frozen publication.")
    return target


def remove(engine, table_id, guard, pending):
    registry, lake = engine.registry, engine.lake
    run = pending if pending and pending.get("generation_removal") else begin(engine, table_id, guard, pending)
    if not registry.request_dataset_export_purge(table_id):
        raise ConflictError("Dataset removal is waiting for export servers to reclaim their files. Keep the API running and retry removal.")
    if run["phase"] == "index":
        root = engine.stage / f"{run['id']}-removal"
        if root.is_symlink() or root.is_junction() or root.resolve() != engine.stage.resolve() / f"{UUID(run['id'])}-removal":
            raise RuntimeError("Removal staging directory is outside its owned path.")
        root.mkdir(parents=True, exist_ok=True)
        source = _survivor_narrow(engine, run, root, guard)
        base = run["base"]
        modes = base.get("lookup_publications", {})
        lookup = run.get("lookup", "both" if len(modes) > 1 else next(iter(modes), "r3"))
        lookups = build_lookups(engine, root, [source], run["id"], lookup, guard)
        publication = {**base, "id": run["id"], "created_at": utc_now(), "lookup_publications": lookups,
                       "layout_version": 2, "lookup_mode": lookup,
                       **lookups["r3" if "r3" in lookups else "single-file"]}
        for key in ("wide_snapshots", "wide_table_names", "counts", "columns", "dataset_sources"):
            publication[key] = {key_id: value for key_id, value in base.get(key, {}).items() if key_id != table_id}
        publication["wide_table_names"] = {key: base.get("wide_table_names", {}).get(key, wide_name(key)) for key in publication["wide_snapshots"]}
        with registry.write_lease():
            guard()
            current = registry.current_publication()
            if (current["id"] if current else None) != base["id"]:
                raise ConflictError("The publication changed during dataset removal.")
            with registry.connect() as conn:
                registry.publish(publication, conn)
                updated = {**run, "phase": "purge", "revision": run["revision"] + 1}
                result = conn.execute("UPDATE etl_pending SET revision=?,payload=? WHERE singleton=1 AND id=? AND revision=?",
                                      (updated["revision"], json.dumps(updated), run["id"], run["revision"]))
                if result.rowcount != 1:
                    raise ConflictError("The ETL work lease changed. Retry removal.")
            run = updated
    discard_single_file(engine, guard)
    for name, location in run["tables"].items():
        guard()
        with registry.write_lease():
            guard()
            if engine._pinned().get(name):
                raise ConflictError("A retained publication still references a table awaiting reclamation.")
            lake.drop_owned_table(name, location)
            with registry.connect() as conn:
                conn.execute("DELETE FROM retired_tables WHERE name=?", (name,))
    if run.get("ingest_id"):
        engine._clean_stage(run["ingest_id"])
    clean_completed_load_stages(engine, guard)
    with registry.connect() as conn:
        remaining = {row["id"] for row in conn.execute("SELECT id FROM etl_completed_loads").fetchall()}
    if remaining.intersection(run.get("completed_stages", [])):
        raise ConflictError("Dataset removal is waiting for completed load staging cleanup. Run maintain on each original load staging owner with its original bulk_owner_id and stage_path, then retry removal.")
    root = engine.stage / f"{run['id']}-removal"
    if root.exists():
        from shutil import rmtree
        if root.resolve() != engine.stage.resolve() / f"{UUID(run['id'])}-removal":
            raise RuntimeError("Removal staging directory is outside its owned path.")
        rmtree(root)
    with registry.write_lease():
        guard()
        if not registry.request_dataset_export_purge(table_id):
            raise ConflictError("Dataset removal is waiting for export servers to reclaim their files. Retry removal.")
        with registry.connect() as conn:
            result = conn.execute("DELETE FROM etl_pending WHERE singleton=1 AND id=? AND revision=?", (run["id"], run["revision"]))
            if result.rowcount != 1:
                raise ConflictError("The ETL work lease changed. Retry removal.")
            for name in ("etl_checkpoints", "etl_rejects"):
                conn.execute(f"DELETE FROM {name} WHERE table_id=?", (table_id,))
            for row in _publications(conn):
                publication = json.loads(row["payload"])
                if table_id in publication.get("wide_snapshots", {}) or table_id in publication.get("counts", {}):
                    conn.execute("DELETE FROM publications WHERE id=?", (row["id"],))
            registry.remove_saved_dataset_references(table_id, conn)
            conn.execute("DELETE FROM datasets WHERE id=?", (table_id,))
            conn.execute("DELETE FROM export_dataset_purges WHERE table_id=?", (table_id,))
            conn.execute("INSERT INTO deletion_audit (id,table_id,deleted_at) VALUES (?,?,?)", (run["id"], table_id, utc_now()))
