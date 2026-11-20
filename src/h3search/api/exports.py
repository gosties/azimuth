"""Owner-bound, disk-backed full-width exports with independent worker budgets."""

from __future__ import annotations

import asyncio
import copy
import csv
import io
import json
import logging
import os
import re
import shutil
import sqlite3
import struct
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing, contextmanager, suppress
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Event, Lock, Thread
from typing import Literal
from uuid import UUID, uuid4
from xml.sax.saxutils import escape, quoteattr

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse
from pydantic import Field

from .csv_safety import spreadsheet_cell
from .export_store import ExportStore, WORKER
from .execution import Job
from .models import Input
from .search import Search
from .storage import Storage, quote

LOG = logging.getLogger(__name__)
FORMAT_INFO = {
    "csv": (".zip", "application/zip"),
    "kml": (".kml", "application/vnd.google-earth.kml+xml"),
    "json": (".geojson", "application/geo+json"),
    "gpkg": (".gpkg", "application/geopackage+sqlite3"),
}
CORE = ("table_id", "object_id", "source_schema", "source_table", "h3", "latitude", "longitude", "distance_m")
ACTIVE = ("queued", "running")


def _provenance(session, table, row):
    return {**row, **session["query"]["dataset_sources"][table]}


class ExportInput(Input):
    format: Literal["csv", "kml", "json", "gpkg"]
    dataset_ids: list[UUID] | None = Field(default=None, min_length=1, max_length=1000)


def _json(value):
    return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":"))


def _cell(value):
    if value is None:
        return ""
    return value if isinstance(value, str) else _json(value)


def _csv_cell(value):
    return spreadsheet_cell(value) if isinstance(value, str) else _cell(value)


def _xml_text(value):
    """Keep readable Unicode while representing XML 1.0 forbidden characters."""
    return "".join(character if (character in "\t\n\r" or 0x20 <= ord(character) <= 0xD7FF
                                  or 0xE000 <= ord(character) <= 0xFFFD or 0x10000 <= ord(character) <= 0x10FFFF)
                   else "\\u" + format(ord(character), "04x") for character in value)


def _table_name(raw, identifier):
    return (re.sub(r"[^A-Za-z0-9_-]+", "_", raw).strip("_")[:80] or "dataset") + "_" + identifier.replace("-", "")


def _layers(session):
    for table in session["query"]["dataset_ids"]:
        if session["query"]["counts"].get(table, 0):
            yield table, session["query"].get("dataset_names", {}).get(table, table), session["publication"]["columns"][table]


def write_csv(path, session, rows, compresslevel=1):
    """Write one complete table per ZIP member, with unambiguous column names."""
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=compresslevel, allowZip64=True) as archive:
        for table, name, columns in _layers(session):
            used = {column["name"].casefold() for column in columns}
            core_names = []
            for key in CORE:
                candidate = "azimuth_" + key
                while candidate.casefold() in used:
                    candidate += "_"
                used.add(candidate.casefold())
                core_names.append(candidate)
            with archive.open(_table_name(name, table) + ".csv", "w", force_zip64=True) as member:
                with io.TextIOWrapper(member, encoding="utf-8", newline="") as stream:
                    writer = csv.writer(stream)
                    writer.writerow([*(spreadsheet_cell(column["name"]) for column in columns), *core_names])
                    for row in rows(table):
                        row = _provenance(session, table, row)
                        writer.writerow([*(_csv_cell(row["attributes"][column["name"]]) for column in columns), *(spreadsheet_cell(row[key]) for key in CORE)])


def write_json(path, session, rows):
    """Write a streaming GeoJSON collection with nested, collision-free attributes."""
    with path.open("w", encoding="utf-8", newline="") as stream:
        stream.write('{"type":"FeatureCollection","features":[')
        first = True
        for table, name, _columns in _layers(session):
            for row in rows(table):
                row = _provenance(session, table, row)
                feature = {"type": "Feature", "id": table + ":" + row["object_id"],
                           "geometry": {"type": "Point", "coordinates": [row["longitude"], row["latitude"]]},
                           "properties": {**{key: row[key] for key in CORE}, "dataset": name, "attributes": row["attributes"]}}
                if not first:
                    stream.write(",")
                stream.write(_json(feature))
                first = False
        stream.write("]}")


def write_kml(path, session, rows):
    """Encode every source value as a JSON literal inside escaped ExtendedData."""
    with path.open("w", encoding="utf-8", newline="") as stream:
        stream.write('<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>')
        for table, name, _columns in _layers(session):
            stream.write("<Folder><name>" + escape(_xml_text(name)) + "</name>")
            for row in rows(table):
                row = _provenance(session, table, row)
                stream.write("<Placemark><name>" + escape(row["object_id"]) + "</name><ExtendedData>")
                fields = [("core:" + key, row[key]) for key in CORE]
                fields.extend(("source:" + key, value) for key, value in row["attributes"].items())
                for key, value in fields:
                    stream.write("<Data name=" + quoteattr(_xml_text(key), {"\n": "&#10;", "\r": "&#13;", "\t": "&#9;"}) + "><value>" + escape(_xml_text(json.dumps(value, ensure_ascii=False, allow_nan=False))) + "</value></Data>")
                stream.write("</ExtendedData><Point><coordinates>" + str(row["longitude"]) + "," + str(row["latitude"]) + ",0</coordinates></Point></Placemark>")
            stream.write("</Folder>")
        stream.write("</Document></kml>")


_WGS84 = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]'


def _gpkg_type(column):
    base = column["type"].lower().split("(", 1)[0].split("[", 1)[0]
    if base in {"bigint", "int", "smallint", "tinyint", "bit", "bool", "int8", "int16", "int32", "int64", "uint8", "uint16", "uint32"}:
        return "INTEGER"
    if base in {"real", "float", "double", "halffloat"}:
        return "REAL"
    return "TEXT"


def _gpkg_cell(value, kind):
    if value is None:
        return None
    if kind == "INTEGER":
        return int(value)
    if kind == "REAL" and isinstance(value, (int, float)):
        return float(value)
    return _cell(value)


def write_gpkg(path, session, rows, maximum_bytes):
    """Write portable point layers and preserve source names/types in a mapping table."""
    with closing(sqlite3.connect(path)) as connection:
        connection.executescript("""
            PRAGMA application_id = 1196444487;
            PRAGMA user_version = 10300;
            PRAGMA journal_mode = OFF;
            PRAGMA synchronous = OFF;
            PRAGMA temp_store = FILE;
            PRAGMA cache_size = -8192;
            CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT NOT NULL,srs_id INTEGER PRIMARY KEY,
                organization TEXT NOT NULL,organization_coordsys_id INTEGER NOT NULL,definition TEXT NOT NULL,description TEXT);
            CREATE TABLE gpkg_contents (table_name TEXT PRIMARY KEY,data_type TEXT NOT NULL,identifier TEXT UNIQUE,
                description TEXT DEFAULT '',last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                min_x DOUBLE,min_y DOUBLE,max_x DOUBLE,max_y DOUBLE,srs_id INTEGER);
            CREATE TABLE gpkg_geometry_columns (table_name TEXT PRIMARY KEY,column_name TEXT NOT NULL,
                geometry_type_name TEXT NOT NULL,srs_id INTEGER NOT NULL,z TINYINT NOT NULL,m TINYINT NOT NULL);
            CREATE TABLE azimuth_columns (table_name TEXT NOT NULL,column_name TEXT NOT NULL,source_name TEXT NOT NULL,
                source_type TEXT NOT NULL,PRIMARY KEY(table_name,column_name));
        """)
        connection.execute(f"PRAGMA max_page_count = {max(1, maximum_bytes // 4096)}")
        connection.executemany("INSERT INTO gpkg_spatial_ref_sys VALUES (?,?,?,?,?,?)", [
            ("WGS 84", 4326, "EPSG", 4326, _WGS84, "longitude, latitude"),
            ("Undefined geographic SRS", -1, "NONE", -1, "undefined", None),
            ("Undefined Cartesian SRS", 0, "NONE", 0, "undefined", None),
        ])
        for table, name, columns in _layers(session):
            if len(columns) + len(CORE) + 2 > 2000:
                raise HTTPException(413, "This schema exceeds the GeoPackage column limit; use CSV or JSON")
            layer = "dataset_" + table.replace("-", "")
            used = {"fid", "geom", *("azimuth_" + key for key in CORE)}
            mapped = []
            for index, column in enumerate(columns):
                # SQLite compares names without case. Keep colliding names in the mapping.
                candidate = column["name"]
                if candidate.casefold() in used or "\0" in candidate or not candidate:
                    candidate = "source_" + str(index + 1)
                while candidate.casefold() in used:
                    candidate += "_"
                used.add(candidate.casefold())
                mapped.append(candidate)
                connection.execute("INSERT INTO azimuth_columns VALUES (?,?,?,?)", (layer, candidate, column["name"], column["type"]))
            fields = [*(quote("azimuth_" + key) + (" REAL" if key in {"latitude", "longitude", "distance_m"} else " TEXT") for key in CORE),
                      *(quote(key) + " " + _gpkg_type(column) for key, column in zip(mapped, columns, strict=True))]
            connection.execute(f"CREATE TABLE {quote(layer)} (fid INTEGER PRIMARY KEY, geom BLOB NOT NULL, " + ",".join(fields) + ")")
            insert = f"INSERT INTO {quote(layer)} VALUES (" + ",".join("?" for _ in range(len(fields) + 2)) + ")"
            bounds = [None, None, None, None]
            for index, row in enumerate(rows(table), 1):
                row = _provenance(session, table, row)
                lon, lat = row["longitude"], row["latitude"]
                geometry = b"GP\0\x01" + struct.pack("<iBI2d", 4326, 1, 1, lon, lat)
                connection.execute(insert, [index, geometry, *(row[key] for key in CORE),
                                             *(_gpkg_cell(row["attributes"][column["name"]], _gpkg_type(column)) for column in columns)])
                bounds = [lon if bounds[0] is None else min(bounds[0], lon), lat if bounds[1] is None else min(bounds[1], lat),
                          lon if bounds[2] is None else max(bounds[2], lon), lat if bounds[3] is None else max(bounds[3], lat)]
                if index % 1000 == 0:
                    connection.commit()
            connection.execute("INSERT INTO gpkg_contents (table_name,data_type,identifier,description,min_x,min_y,max_x,max_y,srs_id) VALUES (?,'features',?,?,?,?,?,?,4326)",
                               (layer, name + " " + table, name, *bounds))
            connection.execute("INSERT INTO gpkg_geometry_columns VALUES (?,'geom','POINT',4326,0,0)", (layer,))
            connection.commit()


class ExportJob(Job):
    def __init__(self, manager, record):
        super().__init__(record["id"])
        self.manager, self.record = manager, record
        self.deadline = time.monotonic() + manager.settings.export_timeout_sec
        self.next_check = 0
        self.reason = None

    def check(self):
        super().check()
        now = time.monotonic()
        if now >= self.deadline:
            raise HTTPException(503, "Export exceeded the configured time limit")
        if now >= self.next_check:
            self.next_check = now + 0.25
            record = self.manager._get(self.record["id"])
            if not record or record["status"] != "running":
                self.cancelled.set()
                super().check()
            self.manager._validate_session(record)
            self.manager._check_disk(self.record)


class Exports:
    """Durable API queue; only an explicitly selected worker owns query resources."""

    def __init__(self, settings, registry, *, worker=False):
        self.is_worker = worker
        self.worker_id = str(uuid4()) if worker else None
        self.worker_lock = None
        self.settings, self.registry = settings, registry
        self.root = settings.export_path.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.store = ExportStore(settings)
        self.store.initialize()
        self.database = self.store.database
        self.spool_id = self.store.spool_id
        self.pg_worker_lock = None
        self.pg_worker_guard = Lock()
        self.next_pg_worker_guard = 0.0
        self.stop = Event()
        self.active, self.active_lock = {}, Lock()
        self.registry.register_export_spool(self.spool_id)
        self.pool = None
        self.futures = []
        if worker:
            self._lock_worker()
            try:
                # The process lock proves previous owners have exited. Never infer
                # writer death from a delayed heartbeat while it still owns files.
                with self._connect() as connection:
                    abandoned = [dict(row) for row in connection.execute("SELECT * FROM jobs WHERE status='running'")]
                    connection.execute("UPDATE jobs SET status='failed',error='Export worker stopped; submit the export again' WHERE status='running'")
                    connection.execute("UPDATE jobs SET worker_id=NULL WHERE worker_id IS NOT NULL")
                    for record in abandoned:
                        self._notify(connection, record, "failed", "Export failed: worker stopped; submit the export again")
                export_settings = replace(settings, pool_size=1,
                                          memory_budget_mb=settings.export_memory_mb,
                                          query_timeout_sec=float(settings.export_timeout_sec))
                self.storage = Storage(export_settings, source="h3search-maintenance")
                self.search = Search(self.storage)
                self.pool = ThreadPoolExecutor(2, thread_name_prefix="export")
                self.futures = [self.pool.submit(self._maintenance), self.pool.submit(self._worker)]
            except BaseException:
                if self.pg_worker_lock is not None:
                    self.pg_worker_lock.close()
                self.worker_lock.close()
                raise

    def _lock_worker(self):
        """Hold an OS lock for the entire writer process lifetime (local spool)."""
        stream = (self.root / "worker.lock").open("a+b")
        try:
            stream.seek(0)
            if os.name == "nt":
                import msvcrt
                if not stream.read(1):
                    stream.write(b"0")
                    stream.flush()
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            stream.close()
            raise RuntimeError("An export worker already owns this spool") from error
        self.worker_lock = stream
        if self.store.postgres:
            try:
                self.pg_worker_lock = self.store.raw_postgres()
                acquired = self.pg_worker_lock.execute("SELECT pg_try_advisory_lock(%s)", (WORKER,)).fetchone()[0]
                self.pg_worker_lock.commit()
                if not acquired:
                    raise RuntimeError("An export worker already owns the PostgreSQL queue")
            except BaseException:
                if self.pg_worker_lock is not None:
                    self.pg_worker_lock.close()
                stream.close()
                raise

    @contextmanager
    def _connect(self):
        if self.pg_worker_lock is not None:
            with self.pg_worker_guard:
                if time.monotonic() >= self.next_pg_worker_guard:
                    self.pg_worker_lock.execute("SELECT 1")
                    self.pg_worker_lock.commit()
                    self.next_pg_worker_guard = time.monotonic() + 0.25
        with self.store.connect() as connection:
            yield connection

    def _get(self, identifier):
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM jobs WHERE id=?", (identifier,)).fetchone()
            return dict(row) if row else None

    def path(self, record, partial=False):
        # Only generated UUIDs and known suffixes form filesystem paths.
        identifier = str(UUID(record["id"]))
        return self.root / (identifier + FORMAT_INFO[record["format"]][0] + (".part" if partial else ""))

    def _unlink(self, record):
        for partial in (True, False):
            self.path(record, partial).unlink(missing_ok=True)

    @staticmethod
    def _notify(connection, record, event, message):
        connection.execute("INSERT INTO notifications (id,owner,export_id,event,message,created) VALUES (?,?,?,?,?,?) ON CONFLICT(export_id,event) DO NOTHING",
                           (str(uuid4()), record["owner"], record["id"], event, message, time.time()))

    def notifications(self, owner):
        with self._connect() as connection:
            connection.execute("BEGIN")
            rows = connection.execute("""SELECT n.*,j.expires AS expires_at,CASE WHEN n.event='ready' AND j.status='completed' AND j.expires>? THEN
                '/api/exports/' || j.id || '/download' END AS download_url
                FROM notifications n LEFT JOIN jobs j ON j.id=n.export_id AND j.owner=n.owner
                WHERE n.owner=? ORDER BY n.created DESC,n.id DESC LIMIT 200""", (time.time(), owner)).fetchall()
            unread = connection.execute("SELECT count(*) FROM notifications WHERE owner=? AND read_at IS NULL", (owner,)).fetchone()[0]
        return {"items": [{**dict(row), "unread": row["read_at"] is None} for row in rows], "unread_count": unread}

    def read_notification(self, identifier, owner):
        with self._connect() as connection:
            result = connection.execute("UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=? AND owner=?", (time.time(), identifier, owner))
            if not result.rowcount:
                raise HTTPException(404, "Notification not found")

    def read_notifications(self, owner):
        with self._connect() as connection:
            connection.execute("UPDATE notifications SET read_at=? WHERE owner=? AND read_at IS NULL", (time.time(), owner))

    def clear_notifications(self, owner, identifier=None):
        # Notification history is independent of artifact ownership and lifetime.
        with self._connect() as connection:
            if identifier is None:
                connection.execute("DELETE FROM notifications WHERE owner=?", (owner,))
            else:
                connection.execute("DELETE FROM notifications WHERE owner=? AND id=?", (owner, identifier))

    def _check_disk(self, record=None):
        maximum = self.settings.export_disk_quota_mb * 1024 * 1024
        used = 0
        for path in self.root.iterdir():
            with suppress(FileNotFoundError):
                if path.is_file():
                    used += path.stat().st_size
        if used >= maximum or shutil.disk_usage(self.root).free < self.settings.export_disk_reserve_mb * 1024 * 1024:
            raise HTTPException(507, "Export spool disk quota or free-space reserve reached")
        if record:
            path = self.path(record, True)
            if path.exists() and path.stat().st_size > self.settings.export_file_max_mb * 1024 * 1024:
                raise HTTPException(413, "Export exceeds export_file_max_mb; increase the configured file budget")

    def enqueue(self, session, owner, fmt, dataset_ids=None):
        # Narrow an independent frozen search copy; never change the user's search.
        if dataset_ids is not None:
            requested = {str(identifier) for identifier in dataset_ids}
            eligible = set(session["query"]["dataset_ids"])
            if not requested or not requested <= eligible:
                raise HTTPException(422, "Select datasets from the current search results")
            session = copy.deepcopy(session)
            selected = [table for table in session["query"]["dataset_ids"] if table in requested]
            session["query"]["dataset_ids"] = selected
            session["query"]["counts"] = {table: session["query"]["counts"].get(table, 0) for table in selected}
            session["total"] = sum(session["query"]["counts"].values())
        maximum = getattr(self.settings, "max_" + fmt + "_export_rows")
        if session["total"] > maximum:
            raise HTTPException(413, f"{fmt.upper()} export is limited to {maximum:,} records; narrow the search or choose another format")
        self._check_disk()
        identifier, now = str(uuid4()), time.time()
        holder = copy.deepcopy(session)
        selected = set(holder["query"]["dataset_ids"])
        for key in ("counts", "dataset_names", "dataset_sources", "datetime_columns", "object_columns", "export_sql_sources"):
            if key in holder["query"]:
                holder["query"][key] = {table: value for table, value in holder["query"][key].items() if table in selected}
        if "spatial_dataset_ids" in holder["query"]:
            holder["query"]["spatial_dataset_ids"] = [table for table in holder["query"]["spatial_dataset_ids"] if table in selected]
        for key in ("counts", "columns", "dataset_sources", "wide_table_names", "wide_snapshots"):
            if key in holder["publication"]:
                holder["publication"][key] = {table: value for table, value in holder["publication"][key].items() if table in selected}
        holder["export_source_session_id"] = session["id"]
        holder["id"] = str(uuid4())
        holder["expires_at"] = (datetime.now(timezone.utc) + timedelta(seconds=self.settings.export_timeout_sec + self.settings.export_ttl_sec)).isoformat()
        with self.registry.read_lease(self.settings.pool_wait_sec):
            current = self.registry.get_session(session["id"])
            if not current or current.get("owner_user_id") != owner or current.get("invalidated") or datetime.fromisoformat(current["expires_at"]) <= datetime.now(timezone.utc):
                raise HTTPException(410, "Search expired or was cancelled before the export was queued")
            source = self.registry.export_settings()["source"]
            if source == "sqlserver":
                fields = ("connection_name", "source_schema", "source_table", "object_id_column",
                          "latitude_column", "longitude_column", "geometry_column", "source_srid",
                          "mode", "capture_instance", "schema_fingerprint")
                holder["query"]["export_sql_sources"] = {}
                for table in holder["query"]["dataset_ids"]:
                    dataset = self.registry.get_dataset(table)
                    if not dataset or dataset["status"] == "removing":
                        raise HTTPException(410, "A dataset used by this export was removed")
                    holder["query"]["export_sql_sources"][table] = {key: dataset.get(key) for key in fields}
            self.registry.save_session(holder)
            try:
                with self._connect() as connection:
                    connection.execute("BEGIN IMMEDIATE")
                    count = connection.execute("SELECT count(*) FROM jobs WHERE status!='cancelled'").fetchone()[0]
                    if count >= self.settings.export_max_jobs:
                        raise HTTPException(503, "Export job capacity reached; remove a previous export or try again later")
                    connection.execute("INSERT INTO jobs (id,owner,format,status,session,total,created,expires,source) VALUES (?,?,?,'queued',?,?,?,?,?)",
                                       (identifier, owner, fmt, _json(holder), session["total"], now,
                                        now + self.settings.export_timeout_sec + self.settings.export_ttl_sec,
                                        source))
                    position = connection.execute("SELECT count(*) FROM jobs WHERE status='queued' AND (created<? OR (created=? AND id<=?))",
                                                  (now, now, identifier)).fetchone()[0]
                    self._notify(connection, {"id": identifier, "owner": owner}, "staged", fmt.upper() + " export staged · queue position " + str(position))
                    staged = dict(connection.execute("SELECT * FROM notifications WHERE export_id=? AND event='staged'", (identifier,)).fetchone())
            except BaseException:
                self.registry.delete_session(holder["id"])
                raise
        result = self.describe(identifier, owner)
        # Return the committed event even when the worker completes immediately.
        result["notification"] = {**staged, "unread": True, "download_url": None,
                                  "expires_at": now + self.settings.export_timeout_sec + self.settings.export_ttl_sec}
        return result

    def owned(self, identifier, owner, *, available=None):
        record = self._get(identifier)
        if not record or record["owner"] != owner:
            raise HTTPException(404, "Export not found")
        if record["status"] == "purging":
            raise HTTPException(410, "A dataset used by this export was removed")
        if record["expires"] <= time.time():
            raise HTTPException(410, "Export expired")
        self._validate_session(record, available=available)
        return self._get(identifier) or record

    def _validate_session(self, record, *, available=None):
        frozen = json.loads(record["session"])
        if record["status"] in ACTIVE:
            session = self.registry.get_session(frozen["id"])
            if (not session or session.get("owner_user_id") != record["owner"] or session.get("invalidated")
                    or datetime.fromisoformat(session["expires_at"]) <= datetime.now(timezone.utc)):
                # Publication can finish and release its holder between the job
                # status read and this lookup. Revalidate the final state.
                latest = self._get(record["id"])
                if latest and latest["status"] not in ACTIVE:
                    self._validate_session(latest)
                    return
                raise HTTPException(410, "The export snapshot expired or was invalidated; run a new search")
        if record["status"] in (*ACTIVE, "completed"):
            if available is None:
                available = {dataset["id"] for dataset in self.registry.list_datasets() if dataset["status"] != "removing"}
            if any(table not in available for table in frozen["query"]["dataset_ids"]):
                raise HTTPException(410, "A dataset used by this export was removed")

    def _release_holder(self, record):
        self.registry.delete_session(json.loads(record["session"])["id"])

    def describe(self, identifier, owner, *, available=None):
        record = self.owned(identifier, owner, available=available)
        with self._connect() as connection:
            position = connection.execute("SELECT count(*) FROM jobs WHERE status='queued' AND (created<? OR (created=? AND id<=?))", (record["created"], record["created"], identifier)).fetchone()[0] if record["status"] == "queued" else None
        return {"id": record["id"], "format": record["format"], "status": record["status"],
                "source": record["source"],
                "queue_position": position,
                "rows_done": record["rows_done"], "total": record["total"],
                "expires_at": datetime.fromtimestamp(record["expires"], timezone.utc).isoformat(),
                "download_url": "/api/exports/" + record["id"] + "/download" if record["status"] == "completed" else None,
                "error": record["error"]}

    def list_jobs(self, owner):
        with self._connect() as connection:
            identifiers = [row[0] for row in connection.execute("SELECT id FROM jobs WHERE owner=? AND expires>? ORDER BY created DESC LIMIT ?",
                                                               (owner, time.time(), self.settings.export_max_jobs))]
        items = []
        available = {dataset["id"] for dataset in self.registry.list_datasets() if dataset["status"] != "removing"}
        for identifier in identifiers:
            try:
                items.append(self.describe(identifier, owner, available=available))
            except HTTPException as error:
                if error.status_code not in (404, 410):
                    raise
        return {"items": items}

    def cancel(self, identifier, owner):
        record = self.owned(identifier, owner)
        with self._connect() as connection:
            connection.execute("UPDATE jobs SET status='cancelled',error=NULL WHERE id=? AND status!='purging'", (identifier,))
        # The writer observes durable cancellation. Only the worker reclaims
        # artifacts and holders, including cancellation submitted by another API.
        with self._connect() as connection:
            connection.execute("UPDATE jobs SET expires=? WHERE id=?", (min(record["expires"], time.time() + 30), identifier))

    def _cleanup(self):
        if not self.is_worker:
            raise RuntimeError("Artifact cleanup requires the export worker")
        now = time.time()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            expired = [dict(row) for row in connection.execute("SELECT * FROM jobs WHERE expires<=? AND status!='purging'", (now,))]
            connection.execute("UPDATE jobs SET status='expired' WHERE expires<=? AND status IN ('queued','running','completed')", (now,))
            terminal = [dict(row) for row in connection.execute("SELECT * FROM jobs WHERE status IN ('cancelled','failed') AND cleanup_complete=0 AND expires>?", (now,))]
        for record in [*expired, *terminal]:
            if record.get("worker_id") is None:
                try:
                    if not record["cleanup_complete"]:
                        self._unlink(record)
                        self._release_holder(record)
                except OSError:
                    LOG.warning("export_cleanup_pending=%s", record["id"])
                    continue
                with self._connect() as connection:
                    if record["status"] == "cancelled":
                        self._notify(connection, record, "removed", "Export removed at your request")
                    if record["expires"] <= now:
                        connection.execute("DELETE FROM jobs WHERE id=?", (record["id"],))
                        if record["status"] not in ("cancelled", "failed"):
                            self._notify(connection, record, "expired", "Expired export deleted")
                    else:
                        connection.execute("UPDATE jobs SET cleanup_complete=1 WHERE id=?", (record["id"],))

    def _claim(self):
        if not self.is_worker:
            raise RuntimeError("Job claims require the export worker")
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            identity = connection.execute("SELECT id FROM spool_identity").fetchone()
            if not identity or identity[0] != self.spool_id:
                raise RuntimeError("Export spool identity changed")
            running = connection.execute("SELECT count(*) FROM jobs WHERE status='running'").fetchone()[0]
            if running >= 1:
                return None
            claim_sql = "SELECT * FROM jobs WHERE status='queued' AND expires>? ORDER BY created,id LIMIT 1"
            if self.store.postgres:
                claim_sql += " FOR UPDATE SKIP LOCKED"
            row = connection.execute(claim_sql, (time.time(),)).fetchone()
            if not row:
                return None
            record = dict(row)
            connection.execute("UPDATE jobs SET status='running',started=?,heartbeat=?,worker_id=?,worker_pid=? WHERE id=? AND status='queued'", (time.time(), time.time(), self.worker_id, os.getpid(), record["id"]))
            record["status"] = "running"
            record["worker_id"] = self.worker_id
            return record

    def _maintenance(self):
        next_purge_check = 0
        while not self.stop.is_set():
            try:
                with self._connect() as connection:
                    identity = connection.execute("SELECT id FROM spool_identity").fetchone()
                if not identity or identity[0] != self.spool_id:
                    raise RuntimeError("Export spool identity changed")
                if time.monotonic() >= next_purge_check:
                    next_purge_check = time.monotonic() + 5
                    for dataset_id in self.registry.pending_export_purges(self.spool_id):
                        if purge_dataset_exports(self.settings, self.registry, dataset_id, expected_spool_id=self.spool_id, store=self.store):
                            self.registry.acknowledge_export_purge(dataset_id, self.spool_id)
                self._cleanup()
            except Exception as error:
                LOG.warning("export_maintenance_error=%s", type(error).__name__)
            self.stop.wait(self.settings.export_cleanup_interval_sec)

    def _worker(self):
        while not self.stop.is_set():
            try:
                record = self._claim()
                if record:
                    self._run(record)
                    continue
            except Exception as error:
                LOG.warning("export_worker_error=%s", type(error).__name__)
            self.stop.wait(0.25)

    def _run(self, record):
        job = ExportJob(self, record)
        with self.active_lock:
            self.active[record["id"]] = job
        partial = self.path(record, True)
        finished = Event()
        sql_export = None

        def watch():
            while not finished.wait(0.25):
                try:
                    with self._connect() as connection:
                        connection.execute("UPDATE jobs SET heartbeat=? WHERE id=? AND worker_id=?",
                                           (time.time(), record["id"], self.worker_id))
                    job.check()
                except Exception as error:
                    job.reason = error
                    job.cancel()
                    job.stop_query()
                    return

        watchdog = Thread(target=watch, name="export-watchdog", daemon=True)
        watchdog.start()
        try:
            session = json.loads(record["session"])
            job.check()
            # Queues and search sessions created before provenance was frozen
            # can still resolve the original registration by its immutable UUID.
            sources = session["query"].setdefault("dataset_sources", {})
            for table_id in session["query"]["dataset_ids"]:
                if table_id not in sources:
                    dataset = self.registry.get_dataset(table_id)
                    sources[table_id] = {key: dataset[key] for key in ("source_schema", "source_table")}
            done = 0
            next_progress = 0.0
            if record.get("source", "iceberg") == "sqlserver":
                from .sqlserver_exports import SqlServerExport

                sql_export = SqlServerExport(self.settings, self.registry, self.search, job, session)
                sql_export.__enter__()

            def rows(table):
                nonlocal done, next_progress
                stream = sql_export.batches(table) if sql_export else self.search.export_wide_chunks(job, session, table)
                with closing(stream) as batches:
                    for batch in batches:
                        for row in batch:
                            job.check()
                            yield row
                            done += 1
                        now = time.monotonic()
                        if now >= next_progress:
                            # Small fetch batches bound memory, not disk write cadence.
                            # Final publication always records the exact completed count.
                            with self._connect() as connection:
                                connection.execute("UPDATE jobs SET rows_done=? WHERE id=? AND status='running'", (done, record["id"]))
                            next_progress = now + 0.25

            if record["format"] == "gpkg":
                write_gpkg(partial, session, rows, self.settings.export_file_max_mb * 1024 * 1024)
            elif record["format"] == "csv":
                write_csv(partial, session, rows, self.settings.export_csv_compresslevel)
            else:
                {"json": write_json, "kml": write_kml}[record["format"]](partial, session, rows)
            job.check()
            self._check_disk(record)
            if done != record["total"]:
                raise RuntimeError("Frozen export count does not match the search")
            # The holder protects maintenance retention; only final admission needs
            # the global lease. Long exports do not block ETL publications.
            with self.registry.read_lease(self.settings.pool_wait_sec):
                self._validate_session(record)
                # Cancellation and publishing share the SQLite write transaction.
                with self._connect() as connection:
                    connection.execute("BEGIN IMMEDIATE")
                    status = connection.execute("SELECT status FROM jobs WHERE id=?", (record["id"],)).fetchone()
                    if not status or status[0] != "running":
                        raise HTTPException(410, "Export was cancelled")
                    partial.replace(self.path(record))
                    connection.execute("UPDATE jobs SET status='completed',rows_done=?,expires=? WHERE id=?",
                                       (done, time.time() + self.settings.export_ttl_sec, record["id"]))
                    self._notify(connection, record, "ready", "Export ready to download")
        except Exception as error:
            try:
                self._unlink(record)
            except OSError:
                LOG.warning("export_cleanup_pending=%s", record["id"])
            error = job.reason or error
            message = str(error.detail) if isinstance(error, HTTPException) else "Export could not be completed within its storage limits. Try again or narrow the search."
            LOG.warning("export_id=%s export_error=%s", record["id"], type(error).__name__)
            with self._connect() as connection:
                changed = connection.execute("UPDATE jobs SET status='failed',error=? WHERE id=? AND status='running'", (message, record["id"]))
                if changed.rowcount:
                    self._notify(connection, record, "failed", "Export failed: " + message)
        finally:
            finished.set()
            watchdog.join()
            if sql_export is not None:
                sql_export.__exit__(None, None, None)
            self._release_holder(record)
            with self._connect() as connection:
                connection.execute("UPDATE jobs SET worker_id=NULL WHERE id=? AND worker_id=?", (record["id"], self.worker_id))
            with self.active_lock:
                self.active.pop(record["id"], None)

    def close(self):
        self.stop.set()
        with self.active_lock:
            active = tuple(self.active.values())
        for job in active:
            job.cancel()
        for job in active:
            job.stop_query()
        if self.pool is not None:
            self.pool.shutdown(wait=True, cancel_futures=True)
            self.storage.close()
        if self.worker_lock is not None:
            if self.pg_worker_lock is not None:
                self.pg_worker_lock.close()
                self.pg_worker_lock = None
            self.worker_lock.close()
            self.worker_lock = None
        self.store.close()


def purge_dataset_exports(settings, registry, dataset_id, *, expected_spool_id=None, store=None):
    owned = store is None
    store = store or ExportStore(settings)
    try:
        return _purge_dataset_exports(settings, registry, dataset_id, expected_spool_id=expected_spool_id, store=store, initialize=owned)
    finally:
        if owned:
            store.close()


def _purge_dataset_exports(settings, registry, dataset_id, *, expected_spool_id, store, initialize):
    """Invalidate and reclaim affected exports; retain metadata on cleanup failure."""
    root = settings.export_path.resolve()
    if not store.postgres and not store.database.exists():
        if expected_spool_id is not None:
            raise FileNotFoundError("Registered export spool is unavailable")
        return True
    if initialize:
        store.initialize()
    if expected_spool_id is not None and store.spool_id != expected_spool_id:
        raise RuntimeError("Export spool identity changed")
    with store.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        records = []
        for row in connection.execute("SELECT * FROM jobs").fetchall():
            frozen = json.loads(row["session"])
            selected = dataset_id in frozen["query"]["dataset_ids"]
            published = frozen["publication"]
            if selected or (row["status"] in (*ACTIVE, "purging") and dataset_id in published.get("wide_snapshots", {})):
                records.append(dict(row))
                connection.execute("UPDATE jobs SET status='purging' WHERE id=?", (row["id"],))
            elif dataset_id in published.get("wide_snapshots", {}):
                for key in ("counts", "columns", "dataset_sources", "wide_table_names", "wide_snapshots"):
                    published.get(key, {}).pop(dataset_id, None)
                query = frozen["query"]
                for key in ("counts", "dataset_names", "dataset_sources", "datetime_columns", "object_columns"):
                    query.get(key, {}).pop(dataset_id, None)
                if "spatial_dataset_ids" in query:
                    query["spatial_dataset_ids"] = [table for table in query["spatial_dataset_ids"] if table != dataset_id]
                connection.execute("UPDATE jobs SET session=? WHERE id=?", (_json(frozen), row["id"]))
    pending = False
    for record in records:
        frozen = json.loads(record["session"])
        # Only the writer can release its ownership, even when heartbeat is delayed.
        if record.get("worker_id") is not None:
            pending = True
            continue
        for partial in (True, False):
            path = root / (str(UUID(record["id"])) + FORMAT_INFO[record["format"]][0] + (".part" if partial else ""))
            path.unlink(missing_ok=True)
        registry.delete_session(frozen["id"])
        with store.connect() as connection:
            connection.execute("DELETE FROM jobs WHERE id=?", (record["id"],))
            Exports._notify(connection, record, "dataset_removed", "Export removed after dataset deletion")
    return not pending


def register_exports(router: APIRouter, read_session):
    """Register APIs against the export manager created during application startup."""
    def community(request):
        from h3search.community import Community
        return Community(request.app.state.exports.registry)

    def all_notifications(request):
        exported = request.app.state.exports.notifications(request.state.user["id"])
        feedback = community(request).notifications(request.state.auth_token)
        return {"items": sorted(exported["items"] + feedback["items"], key=lambda item: (item["created"], item["id"]), reverse=True)[:200],
                "unread_count": exported["unread_count"] + feedback["unread_count"]}

    def read_one(request, identifier):
        if not community(request).notification_action(request.state.auth_token, "read", identifier):
            request.app.state.exports.read_notification(identifier, request.state.user["id"])

    @router.get("/notifications")
    async def notifications(request: Request):
        return await asyncio.to_thread(all_notifications, request)

    @router.post("/notifications/{notification_id}/read", status_code=204)
    async def read_notification(request: Request, notification_id: UUID, body: Input):
        await asyncio.to_thread(read_one, request, str(notification_id))
        return Response(status_code=204)

    @router.post("/notifications/read", status_code=204)
    async def read_notifications(request: Request, body: Input):
        await asyncio.to_thread(community(request).notification_action, request.state.auth_token, "read")
        await asyncio.to_thread(request.app.state.exports.read_notifications, request.state.user["id"])
        return Response(status_code=204)

    @router.delete("/notifications", status_code=204)
    async def clear_notifications(request: Request, body: Input):
        await asyncio.to_thread(community(request).notification_action, request.state.auth_token, "clear")
        await asyncio.to_thread(request.app.state.exports.clear_notifications, request.state.user["id"])
        return Response(status_code=204)

    @router.delete("/notifications/{notification_id}", status_code=204)
    async def clear_notification(request: Request, notification_id: UUID, body: Input):
        await asyncio.to_thread(community(request).notification_action, request.state.auth_token, "clear", str(notification_id))
        await asyncio.to_thread(request.app.state.exports.clear_notifications, request.state.user["id"], str(notification_id))
        return Response(status_code=204)

    @router.get("/exports")
    async def list_exports(request: Request):
        return await asyncio.to_thread(request.app.state.exports.list_jobs, request.state.user["id"])

    @router.post("/searches/{session_id}/exports", status_code=202)
    async def create_export(request: Request, session_id: UUID, body: ExportInput):
        session = await read_session(request, session_id, lambda job, session: copy.deepcopy(session))
        return await asyncio.to_thread(request.app.state.exports.enqueue, session, request.state.user["id"], body.format, body.dataset_ids)

    @router.get("/exports/{export_id}")
    async def export_status(request: Request, export_id: UUID):
        return await asyncio.to_thread(request.app.state.exports.describe, str(export_id), request.state.user["id"])

    @router.delete("/exports/{export_id}", status_code=204)
    async def delete_export(request: Request, export_id: UUID, body: Input):
        await asyncio.to_thread(request.app.state.exports.cancel, str(export_id), request.state.user["id"])
        return Response(status_code=204)

    @router.get("/exports/{export_id}/download")
    async def download_export(request: Request, export_id: UUID):
        manager = request.app.state.exports
        record = await asyncio.to_thread(manager.owned, str(export_id), request.state.user["id"])
        if record["status"] != "completed":
            raise HTTPException(409, "Export is not ready to download")
        path = manager.path(record)
        if not await asyncio.to_thread(path.is_file):
            raise HTTPException(410, "Export artifact is no longer available")
        suffix, media_type = FORMAT_INFO[record["format"]]
        return FileResponse(path, media_type=media_type, filename="azimuth-results-" + record["id"][:8] + suffix)
