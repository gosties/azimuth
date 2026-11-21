"""Durable registry, publications, sessions, and cross-process reader leases."""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from hashlib import sha256
from typing import Any, Callable, Iterator
from uuid import UUID

from .config import Settings
from .models import new_id, utc_now
from .releases import seed_release_notes

SINGLE_FILE_SEARCH_TABLE = "search_index_single_file"


class ConflictError(ValueError):
    """The requested operation conflicts with durable control state."""


class SavedSearchInputError(ValueError):
    """A saved search mutation fails library validation."""


class Connection:
    """Portable SQL adapter with question-mark parameters and dictionary rows."""

    def __init__(self, raw: Any, postgres: bool):
        self.raw, self.postgres = raw, postgres

    def execute(self, sql: str, params: Any = ()) -> Any:
        """Execute parameterized control SQL without interpolating values."""
        return self.raw.execute(sql.replace("?", "%s") if self.postgres else sql, params)

    def executemany(self, sql: str, params: Any) -> Any:
        """Execute a bounded sequence of parameter sets."""
        cursor = self.raw.cursor()
        cursor.executemany(sql.replace("?", "%s") if self.postgres else sql, params)
        return cursor

    def commit(self) -> None:
        self.raw.commit()

    def rollback(self) -> None:
        self.raw.rollback()


SCHEMA = (
    "CREATE TABLE IF NOT EXISTS release_notes (version TEXT PRIMARY KEY, released_on TEXT NOT NULL, title TEXT NOT NULL, changes TEXT NOT NULL, release_order INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS datasets (id TEXT PRIMARY KEY, definition TEXT NOT NULL, status TEXT NOT NULL, searchable_count BIGINT NOT NULL DEFAULT 0, schema_fingerprint TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS publications (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS current_publication (singleton INTEGER PRIMARY KEY, publication_id TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS retired_tables (name TEXT PRIMARY KEY, retired_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at)",
    "CREATE TABLE IF NOT EXISTS wfs_paging (id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, owner TEXT NOT NULL, digest TEXT NOT NULL, UNIQUE(owner,digest))",
    "CREATE INDEX IF NOT EXISTS wfs_paging_owner ON wfs_paging(owner)",
    "CREATE TABLE IF NOT EXISTS deletion_audit (id TEXT PRIMARY KEY, table_id TEXT NOT NULL, deleted_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS export_spools (id TEXT PRIMARY KEY, registered_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS export_dataset_purges (table_id TEXT NOT NULL, spool_id TEXT NOT NULL REFERENCES export_spools(id), acknowledged_at TEXT, PRIMARY KEY(table_id,spool_id))",
    "CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK (role IN ('user','admin','superadmin')), active INTEGER NOT NULL CHECK (active IN (0,1)), password_hash TEXT NOT NULL, created_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS login_sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, csrf_token TEXT NOT NULL, expires_at TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS login_sessions_account ON login_sessions(account_id)",
    "CREATE INDEX IF NOT EXISTS login_sessions_expiry ON login_sessions(expires_at)",
    "CREATE TABLE IF NOT EXISTS gis_credentials (account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, username TEXT NOT NULL UNIQUE, secret_hash TEXT NOT NULL, created_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS account_mutex (singleton INTEGER PRIMARY KEY)",
    "CREATE TABLE IF NOT EXISTS login_attempts (scope TEXT NOT NULL, subject_hash TEXT NOT NULL, window_start BIGINT NOT NULL, attempts INTEGER NOT NULL, PRIMARY KEY(scope,subject_hash))",
    "CREATE INDEX IF NOT EXISTS login_attempts_window ON login_attempts(window_start)",
    "CREATE TABLE IF NOT EXISTS table_preferences (account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, table_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE, hidden_columns TEXT NOT NULL, PRIMARY KEY(account_id,table_id))",
    "CREATE TABLE IF NOT EXISTS saved_search_state (account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE, revision BIGINT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS saved_searches (account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, id TEXT NOT NULL, payload TEXT NOT NULL, position INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(account_id,id))",
    "CREATE INDEX IF NOT EXISTS saved_searches_position ON saved_searches(account_id,position,id)",
    "CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE)",
    "CREATE TABLE IF NOT EXISTS dataset_categories (table_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE, category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE, PRIMARY KEY(table_id,category_id))",
    "CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, payload TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS etl_bulk_preparations (table_id TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, revision BIGINT NOT NULL, payload TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS etl_bulk_activation (singleton INTEGER PRIMARY KEY, id TEXT NOT NULL, table_id TEXT NOT NULL, payload TEXT NOT NULL)",
)


class Registry:
    """Maintain small control records independently from lake data files."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.postgres = settings.mode == "live"
        if self.postgres and not settings.postgres_dsn:
            raise ValueError("postgres_dsn is required in live mode")

    @contextmanager
    def connect(self) -> Iterator[Connection]:
        """Open a short transaction, committing on success and rolling back on error."""
        if self.postgres:
            import psycopg
            from psycopg.rows import dict_row
            raw = psycopg.connect(self.settings.postgres_dsn, row_factory=dict_row, connect_timeout=10)
        else:
            self.settings.state_path.parent.mkdir(parents=True, exist_ok=True)
            raw = sqlite3.connect(self.settings.state_path, timeout=max(5, self.settings.pool_wait_sec))
            raw.row_factory = sqlite3.Row
            raw.execute("PRAGMA busy_timeout=10000")
            raw.execute("PRAGMA foreign_keys=ON")
        wrapped = Connection(raw, self.postgres)
        try:
            yield wrapped
            raw.commit()
        except BaseException:
            raw.rollback()
            raise
        finally:
            raw.close()

    def initialize(self) -> None:
        """Create registry tables without changing existing records."""
        if not self.postgres:
            self.settings.state_path.parent.mkdir(parents=True, exist_ok=True)
            with sqlite3.connect(self.settings.state_path) as conn:
                conn.execute("PRAGMA journal_mode=WAL")
        with self.connect() as conn:
            if self.postgres:
                # The API and export worker may both create the catalog on first start.
                conn.execute("SELECT pg_advisory_xact_lock(83172505)")
            for statement in SCHEMA:
                conn.execute(statement)
            self._assert_no_clean_slate(conn)
            conn.execute("INSERT INTO account_mutex (singleton) VALUES (1) ON CONFLICT DO NOTHING")
            seed_release_notes(conn)
            from .community import initialize as initialize_community
            initialize_community(conn)

    @staticmethod
    def _assert_no_clean_slate(conn):
        if conn.execute("SELECT 1 FROM app_settings WHERE key='clean_slate_session'").fetchone():
            raise ConflictError("A clean-slate session is unfinished. Resume that session before starting services or ingestion.")

    def release_notes(self) -> list[dict]:
        """Read application milestones from the control database, newest first."""
        with self.connect() as conn:
            rows = conn.execute("SELECT version,released_on,title,changes FROM release_notes ORDER BY release_order DESC").fetchall()
        return [{**dict(row), "changes": json.loads(row["changes"])} for row in rows]

    @staticmethod
    def _dataset(row: Any) -> dict:
        data = json.loads(row["definition"])
        data.update({key: row[key] for key in ("id", "status", "searchable_count", "schema_fingerprint", "created_at", "updated_at")})
        return data

    def list_datasets(self) -> list[dict]:
        """List registered datasets, including those not yet published."""
        with self.connect() as conn:
            rows = conn.execute("SELECT * FROM datasets ORDER BY created_at,id").fetchall()
            assignments = conn.execute("SELECT table_id,category_id FROM dataset_categories ORDER BY category_id").fetchall()
        categories = {}
        for assignment in assignments:
            categories.setdefault(assignment["table_id"], []).append(assignment["category_id"])
        return [{**self._dataset(row), "category_ids": categories.get(row["id"], [])} for row in rows]

    def get_dataset(self, table_id: str) -> dict:
        """Read one immutable dataset identity or raise KeyError."""
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM datasets WHERE id=?", (table_id,)).fetchone()
            categories = conn.execute("SELECT category_id FROM dataset_categories WHERE table_id=? ORDER BY category_id", (table_id,)).fetchall()
        if row is None:
            raise KeyError(table_id)
        return {**self._dataset(row), "category_ids": [item["category_id"] for item in categories]}

    @staticmethod
    def _dataset_definition(payload: dict) -> dict:
        allowed = {"name", "description", "connection_name", "source_schema", "source_table", "object_id_column", "latitude_column", "longitude_column", "geometry_column", "source_srid", "mode", "capture_instance"}
        unknown = set(payload) - allowed
        if unknown:
            raise ValueError("Unknown dataset fields: " + ", ".join(sorted(unknown)))
        data = {key: value for key, value in payload.items() if value is not None}
        for required in ("name", "connection_name", "source_schema", "source_table", "object_id_column"):
            if not isinstance(data.get(required), str) or not data[required].strip():
                raise ValueError(f"{required} is required")
            data[required] = data[required].strip()
        if not data.get("geometry_column") and not (data.get("latitude_column") and data.get("longitude_column")):
            raise ValueError("Specify coordinate columns or a geometry_column")
        if data.get("mode", "insert") not in {"insert", "cdc"}:
            raise ValueError("mode must be insert or cdc")
        if int(data.get("source_srid", 4326)) != 4326:
            raise ValueError("Source coordinates must use EPSG:4326")
        data.setdefault("mode", "insert")
        data.setdefault("description", "")
        data.setdefault("latitude_column", "")
        data.setdefault("longitude_column", "")
        return data

    def register_dataset(self, payload: dict) -> dict:
        """Register a source table without connecting to SQL Server."""
        return self.register_datasets([payload])[0]

    def register_datasets(self, payloads: list[dict], *, reuse_existing: bool = False) -> list[dict]:
        """Register a group atomically, optionally retaining matching dataset IDs."""
        definitions = [self._dataset_definition(payload) for payload in payloads]
        identity_fields = ("connection_name", "source_schema", "source_table")
        identities = [tuple(data[key] for key in identity_fields) for data in definitions]
        if len(set(identities)) != len(identities):
            raise ValueError("Each configured source table must appear only once")
        physical_fields = ("object_id_column", "latitude_column", "longitude_column",
                           "geometry_column", "mode", "capture_instance", "source_srid")
        now = utc_now()
        results = []
        with self.write_lease(), self.connect() as conn:
            rows = conn.execute("SELECT * FROM datasets").fetchall()
            existing = {}
            for row in rows:
                dataset = self._dataset(row)
                existing[tuple(dataset[key] for key in identity_fields)] = dataset
            for identity, data in zip(identities, definitions, strict=True):
                other = existing.get(identity)
                if other is not None:
                    if not reuse_existing:
                        raise ConflictError("This source table is already registered; remove it before registering again")
                    normalized = {"source_srid": 4326, "mode": "insert", "latitude_column": "", "longitude_column": ""}
                    old, requested = {**normalized, **other}, {**normalized, **data}
                    if any(old.get(key) != requested.get(key) for key in physical_fields):
                        raise ConflictError(f"Configured source mapping differs for {identity[1]}.{identity[2]}")
                    results.append(other["id"])
                    continue
                table_id = new_id()
                conn.execute("INSERT INTO datasets (id,definition,status,searchable_count,schema_fingerprint,created_at,updated_at) VALUES (?,?,?,0,NULL,?,?)", (table_id, json.dumps(data), "registered", now, now))
                results.append(table_id)
        return [self.get_dataset(table_id) for table_id in results]

    def update_description(self, table_id: str, description: str) -> dict:
        """Update display metadata without modifying the source schema."""
        return self.update_metadata(table_id, {"description": description})

    def update_metadata(self, table_id: str, changes: dict) -> dict:
        """Update catalog annotations under the publication writer lease."""
        from .api.temporal import temporal_kind

        if set(changes) - {"description", "datetime_column", "category_ids"}:
            raise ValueError("Only description, datetime_column and category_ids are editable")
        with self.write_lease():
            with self.connect() as conn:
                row = conn.execute("SELECT definition FROM datasets WHERE id=?", (table_id,)).fetchone()
                if row is None:
                    raise KeyError(table_id)
                definition = json.loads(row["definition"])
                if changes.get("datetime_column") is not None:
                    publication = self.current_publication() or {}
                    column = next((column for column in publication.get("columns", {}).get(table_id, [])
                                   if column["name"] == changes["datetime_column"]), None)
                    if column is None or temporal_kind(column) is None:
                        raise ValueError("Select a published SQL date or datetime column")
                if "category_ids" in changes:
                    categories = changes["category_ids"]
                    if not isinstance(categories, list) or len(categories) > 100:
                        raise ValueError("Select at most 100 categories")
                    for category_id in categories:
                        if not isinstance(category_id, str) or conn.execute("SELECT id FROM categories WHERE id=?", (category_id,)).fetchone() is None:
                            raise ValueError("Unknown dataset category")
                    conn.execute("DELETE FROM dataset_categories WHERE table_id=?", (table_id,))
                    conn.executemany("INSERT INTO dataset_categories (table_id,category_id) VALUES (?,?)", [(table_id, category_id) for category_id in sorted(set(categories))])
                definition.update({key: value for key, value in changes.items() if key != "category_ids"})
                conn.execute("UPDATE datasets SET definition=?,updated_at=? WHERE id=?", (json.dumps(definition), utc_now(), table_id))
        return self.get_dataset(table_id)

    def list_categories(self) -> list[dict]:
        """Read shared catalog categories."""
        with self.connect() as conn:
            return [dict(row) for row in conn.execute("SELECT id,name FROM categories ORDER BY name_key,id").fetchall()]

    def save_category(self, name: str, category_id: str | None = None) -> dict:
        """Create or rename a category without changing dataset identity."""
        if not isinstance(name, str) or not name.strip() or len(name.strip()) > 200 or any(ord(c) < 32 for c in name):
            raise ValueError("Category name must contain 1 to 200 printable characters")
        name = name.strip()
        with self.write_lease(), self.connect() as conn:
            if category_id is not None and conn.execute("SELECT id FROM categories WHERE id=?", (category_id,)).fetchone() is None:
                raise KeyError(category_id)
            duplicate = conn.execute("SELECT id FROM categories WHERE name_key=?", (name.casefold(),)).fetchone()
            if duplicate is not None and duplicate["id"] != category_id:
                raise ConflictError("A category with this name already exists")
            category_id = category_id or new_id()
            conn.execute("INSERT INTO categories (id,name,name_key) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,name_key=excluded.name_key", (category_id, name, name.casefold()))
        return {"id": category_id, "name": name}

    def delete_category(self, category_id: str) -> None:
        """Remove a catalog category and its assignments."""
        with self.write_lease(), self.connect() as conn:
            if conn.execute("SELECT id FROM categories WHERE id=?", (category_id,)).fetchone() is None:
                raise KeyError(category_id)
            conn.execute("DELETE FROM categories WHERE id=?", (category_id,))

    def maps_config(self) -> dict | None:
        """Read a durable browser map override, if configured."""
        with self.connect() as conn:
            row = conn.execute("SELECT payload FROM app_settings WHERE key='maps'").fetchone()
        return json.loads(row["payload"]) if row else None

    def save_maps_config(self, payload: dict) -> None:
        """Atomically replace all browser map settings."""
        with self.connect() as conn:
            conn.execute("INSERT INTO app_settings (key,payload) VALUES ('maps',?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload", (json.dumps(payload),))

    def export_settings(self) -> dict:
        """Read the source used when staging new export jobs."""
        with self.connect() as conn:
            row = conn.execute("SELECT payload FROM app_settings WHERE key='exports'").fetchone()
        return json.loads(row["payload"]) if row else {"source": "iceberg"}

    def save_export_settings(self, payload: dict) -> None:
        """Persist the export source independently of existing jobs."""
        if payload.get("source") not in {"iceberg", "sqlserver"}:
            raise ValueError("Export source must be iceberg or sqlserver")
        with self.connect() as conn:
            conn.execute("INSERT INTO app_settings (key,payload) VALUES ('exports',?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload", (json.dumps({"source": payload["source"]}),))

    def current_publication(self) -> dict | None:
        """Return the last completely published lake view."""
        with self.connect() as conn:
            row = conn.execute("SELECT p.payload FROM publications p JOIN current_publication c ON c.publication_id=p.id WHERE c.singleton=1").fetchone()
        return json.loads(row["payload"]) if row else None

    def single_file_publication(self) -> dict | None:
        """Return the single-file lookup only for the currently published data."""
        with self.connect() as conn:
            row = conn.execute(
                "SELECT p.payload,s.payload AS alternate,c.publication_id FROM current_publication c "
                "JOIN publications p ON p.id=c.publication_id "
                "LEFT JOIN app_settings s ON s.key='single_file_publication' WHERE c.singleton=1"
            ).fetchone()
        if row:
            publication = json.loads(row["payload"])
            if "lookup_publications" in publication:
                lookup = publication["lookup_publications"].get("single-file")
                return {**publication, **lookup} if lookup else None
            if row["alternate"]:
                alternate = json.loads(row["alternate"])
                if alternate["base_publication_id"] == row["publication_id"]:
                    return alternate
        return None

    def set_single_file_publication(self, publication: dict, base_publication_id: str) -> bool:
        """Publish a single-file snapshot if its base is current. Caller holds writer_lease."""
        with self.write_lease(), self.connect() as conn:
            row = conn.execute(
                "SELECT p.payload FROM publications p JOIN current_publication c ON c.publication_id=p.id "
                "WHERE c.singleton=1 AND c.publication_id=?", (base_publication_id,)
            ).fetchone()
            if row is None:
                return False
            base = json.loads(row["payload"])
            payload = {key: base[key] for key in ("wide_snapshots", "counts", "columns")}
            payload.update(
                id=publication["id"],
                base_publication_id=base_publication_id,
                search_table_name=SINGLE_FILE_SEARCH_TABLE,
                search_snapshot_id=publication["search_snapshot_id"],
                created_at=publication.get("created_at") or utc_now(),
            )
            conn.execute(
                "INSERT INTO app_settings (key,payload) VALUES ('single_file_publication',?) "
                "ON CONFLICT(key) DO UPDATE SET payload=excluded.payload", (json.dumps(payload),)
            )
        return True

    def clear_single_file_publication(self, conn: Connection | None = None) -> int:
        """Remove the alternate pointer and invalidate sessions. Callers supplying conn hold write_lease."""
        if conn is None:
            with self.write_lease(), self.connect() as own:
                return self.clear_single_file_publication(own)
        conn.execute("DELETE FROM app_settings WHERE key='single_file_publication'")
        return self._invalidate_sessions(
            conn, lambda publication: publication.get("search_table_name") == SINGLE_FILE_SEARCH_TABLE,
            "The single-file lookup used by this search was removed",
        )

    def publish(self, publication: dict, conn: Connection | None = None, *, bulk_id: str | None = None) -> None:
        """Publish with an optional caller transaction containing source checkpoints.

        Callers must hold write_lease during final validation and publication.
        Lake writes finish before this atomic metadata update.
        """
        if conn is None:
            with self.write_lease(), self.connect() as own:
                self.publish(publication, own, bulk_id=bulk_id)
            return
        intent = conn.execute("SELECT id FROM etl_bulk_activation WHERE singleton=1").fetchone()
        if intent and intent["id"] != bulk_id:
            raise ConflictError("Recover the pending bulk activation before publishing another dataset.")
        payload = dict(publication)
        payload.setdefault("id", new_id())
        payload.setdefault("created_at", utc_now())
        if payload.get("layout_version") == 2:
            from .etl.layout import publication_tables
            previous = conn.execute(
                "SELECT p.payload FROM current_publication c JOIN publications p ON c.publication_id=p.id WHERE c.singleton=1"
            ).fetchone()
            if previous:
                retired = publication_tables(json.loads(previous["payload"])) - publication_tables(payload)
                alternate = conn.execute("SELECT payload FROM app_settings WHERE key='single_file_publication'").fetchone()
                if alternate:
                    retired.update(publication_tables(json.loads(alternate["payload"])) - publication_tables(payload))
                    conn.execute("DELETE FROM app_settings WHERE key='single_file_publication'")
                conn.executemany(
                    "INSERT INTO retired_tables (name,retired_at) VALUES (?,?) ON CONFLICT(name) DO NOTHING",
                    [(name, utc_now()) for name in retired],
                ).close()
        conn.execute("INSERT INTO publications (id,payload,created_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", (payload["id"], json.dumps(payload), payload["created_at"]))
        conn.execute("INSERT INTO current_publication (singleton,publication_id) VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET publication_id=excluded.publication_id", (payload["id"],))
        for table_id, count in payload.get("counts", {}).items():
            conn.execute("UPDATE datasets SET searchable_count=?,status='ready',updated_at=? WHERE id=? AND status<>'removing'", (int(count), utc_now(), table_id))

    def save_session(self, session: dict) -> None:
        """Save a frozen search; caller holds read_lease across query and save."""
        UUID(str(session["id"]))
        with self.connect() as conn:
            conn.execute("INSERT INTO sessions (id,payload,expires_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at", (session["id"], json.dumps(session), session["expires_at"]))

    def get_session(self, session_id: str) -> dict | None:
        """Read a session, retaining its expiry for the caller's 410 response."""
        with self.connect() as conn:
            row = conn.execute("SELECT payload FROM sessions WHERE id=?", (session_id,)).fetchone()
        return json.loads(row["payload"]) if row else None

    def find_wfs_session(self, owner: str, digest: str) -> dict | None:
        """Resolve tokenless WFS pages to the same principal's frozen query."""
        with self.connect() as conn:
            row = conn.execute("SELECT s.payload FROM wfs_paging w JOIN sessions s ON s.id=w.id WHERE w.owner=? AND w.digest=? AND s.expires_at>?",
                               (owner, digest, utc_now())).fetchone()
        return json.loads(row["payload"]) if row else None

    def save_wfs_session(self, session: dict, *, maximum: int, per_owner: int) -> dict:
        """Admit bounded WFS paging state atomically with its snapshot holder."""
        from fastapi import HTTPException

        with self.connect() as conn:
            if self.postgres:
                conn.execute("SELECT pg_advisory_xact_lock(83172507)")
            else:
                conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM sessions WHERE id IN (SELECT w.id FROM wfs_paging w JOIN sessions s ON s.id=w.id WHERE s.expires_at<=?)", (utc_now(),))
            existing = conn.execute("SELECT s.payload FROM wfs_paging w JOIN sessions s ON s.id=w.id WHERE w.owner=? AND w.digest=?",
                                    (session["owner_user_id"], session["digest"])).fetchone()
            if existing:
                return json.loads(existing["payload"])
            count = conn.execute("SELECT count(*) AS n FROM wfs_paging").fetchone()["n"]
            owned = conn.execute("SELECT count(*) AS n FROM wfs_paging WHERE owner=?", (session["owner_user_id"],)).fetchone()["n"]
            if count >= maximum or owned >= per_owner:
                raise HTTPException(429, "WFS paging capacity exhausted; finish existing queries or wait for expiry")
            conn.execute("INSERT INTO sessions (id,payload,expires_at) VALUES (?,?,?)",
                         (session["id"], json.dumps(session), session["expires_at"]))
            conn.execute("INSERT INTO wfs_paging (id,owner,digest) VALUES (?,?,?)", (session["id"], session["owner_user_id"], session["digest"]))
        return session

    def delete_session(self, session_id: str) -> None:
        """Invalidate one session; running requests retain their read lease."""
        with self.connect() as conn:
            conn.execute("DELETE FROM sessions WHERE id=?", (session_id,))

    def cleanup_expired_sessions(self, limit: int | None = None) -> int:
        """Delete one bounded batch of expired search metadata, preserving export pins."""
        limit = self.settings.session_cleanup_batch_size if limit is None else limit
        if type(limit) is not int or not 1 <= limit <= 100_000:
            raise ValueError("Session cleanup limit must be between 1 and 100000")
        now = datetime.now(timezone.utc)
        with self.connect() as conn:
            result = conn.execute(
                "DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE expires_at<=? "
                "ORDER BY expires_at,id LIMIT ?)", (now.isoformat(), limit),
            )
            oldest = conn.execute(
                "SELECT expires_at FROM sessions WHERE expires_at<=? ORDER BY expires_at LIMIT 1", (now.isoformat(),)
            ).fetchone()
            removed = result.rowcount
        if removed or oldest:
            lag = (now - datetime.fromisoformat(oldest["expires_at"])).total_seconds() if oldest else 0
            logging.getLogger("h3search.api.sessions").info(
                "session_cleanup removed=%d backlog=%s oldest_expired_sec=%.0f", removed, bool(oldest), lag,
            )
        return removed

    def register_export_spool(self, spool_id: str) -> None:
        """Register a persistent spool identity before it can accept export jobs."""
        UUID(spool_id)
        with self.read_lease(), self.connect() as conn:
            conn.execute("INSERT INTO export_spools (id,registered_at) VALUES (?,?) ON CONFLICT DO NOTHING", (spool_id, utc_now()))
            # A spool coming online during removal must also acknowledge reclamation.
            for row in conn.execute("SELECT id FROM datasets WHERE status='removing'").fetchall():
                conn.execute("INSERT INTO export_dataset_purges (table_id,spool_id) VALUES (?,?) ON CONFLICT DO NOTHING", (row["id"], spool_id))

    def request_dataset_export_purge(self, table_id: str) -> bool:
        """Queue durable reclamation on every known spool; never infer a remote file is absent."""
        UUID(table_id)
        with self.connect() as conn:
            conn.execute("INSERT INTO export_dataset_purges (table_id,spool_id) SELECT ?,id FROM export_spools WHERE 1=1 ON CONFLICT DO NOTHING", (table_id,))
            return conn.execute("SELECT spool_id FROM export_dataset_purges WHERE table_id=? AND acknowledged_at IS NULL LIMIT 1", (table_id,)).fetchone() is None

    def pending_export_purges(self, spool_id: str, limit: int = 100) -> list[str]:
        """Return a bounded batch of dataset requests for one locally verified spool."""
        UUID(spool_id)
        if type(limit) is not int or not 1 <= limit <= 1000:
            raise ValueError("Export purge batch must be between 1 and 1000")
        with self.connect() as conn:
            rows = conn.execute("SELECT table_id FROM export_dataset_purges WHERE spool_id=? AND acknowledged_at IS NULL ORDER BY table_id LIMIT ?", (spool_id, limit)).fetchall()
            return [row["table_id"] for row in rows]

    def acknowledge_export_purge(self, table_id: str, spool_id: str) -> None:
        """Record success only after the owning spool verifies files and jobs were reclaimed."""
        with self.connect() as conn:
            result = conn.execute("UPDATE export_dataset_purges SET acknowledged_at=? WHERE table_id=? AND spool_id=?", (utc_now(), table_id, spool_id))
            if result.rowcount != 1:
                raise ConflictError("Export purge was not requested for this spool")

    def remove_saved_dataset_references(self, table_id: str, conn: Connection) -> None:
        """Remove a deleted dataset from explicit saved selections and advance account revisions."""
        changed = set()
        for row in conn.execute("SELECT account_id,id,payload FROM saved_searches").fetchall():
            payload = json.loads(row["payload"])
            query = payload.get("query", {})
            selected = query.get("dataset_ids")
            if selected is None or table_id not in selected:
                continue
            selected = [value for value in selected if value != table_id]
            if selected:
                query["dataset_ids"] = selected
                conn.execute("UPDATE saved_searches SET payload=?,updated_at=? WHERE account_id=? AND id=?",
                             (json.dumps(payload), utc_now(), row["account_id"], row["id"]))
            else:
                conn.execute("DELETE FROM saved_searches WHERE account_id=? AND id=?", (row["account_id"], row["id"]))
            changed.add(row["account_id"])
        for account in sorted(changed):
            rows = conn.execute("SELECT id FROM saved_searches WHERE account_id=? ORDER BY position,id", (account,)).fetchall()
            for position, row in enumerate(rows):
                conn.execute("UPDATE saved_searches SET position=? WHERE account_id=? AND id=?", (position, account, row["id"]))
            conn.execute("INSERT INTO saved_search_state (account_id,revision) VALUES (?,1) "
                         "ON CONFLICT(account_id) DO UPDATE SET revision=saved_search_state.revision+1", (account,))

    @staticmethod
    def _saved_search_list(conn: Connection, account_id: str) -> dict:
        rows = conn.execute(
            "SELECT COALESCE(state.revision,0) AS revision,s.id,s.payload,s.position,s.created_at,s.updated_at "
            "FROM accounts a LEFT JOIN saved_search_state state ON state.account_id=a.id "
            "LEFT JOIN saved_searches s ON s.account_id=a.id WHERE a.id=? AND a.active=1 ORDER BY s.position,s.id",
            (account_id,),
        ).fetchall()
        if not rows:
            raise KeyError(account_id)
        items = [{**json.loads(row["payload"]), **{key: row[key] for key in ("id", "position", "created_at", "updated_at")}}
                 for row in rows if row["id"] is not None]
        return {"items": items, "revision": rows[0]["revision"]}

    def list_saved_searches(self, account_id: str) -> dict:
        """Read one account's definitions and revision from the same database snapshot."""
        with self.connect() as conn:
            return self._saved_search_list(conn, account_id)

    @contextmanager
    def _saved_search_write(self, account_id: str) -> Iterator[Connection]:
        with self.connect() as conn:
            # Lock the account on PostgreSQL and take the writer lock before reads on SQLite.
            locked = conn.execute("UPDATE accounts SET id=id WHERE id=? AND active=1", (account_id,))
            if locked.rowcount != 1:
                raise KeyError(account_id)
            yield conn

    @staticmethod
    def _check_saved_search_revision(conn: Connection, account_id: str, expected_revision: int) -> None:
        row = conn.execute("SELECT revision FROM saved_search_state WHERE account_id=?", (account_id,)).fetchone()
        if expected_revision != (row["revision"] if row else 0):
            raise ConflictError("Saved searches changed. Reload the list and try again.")

    def _saved_search_result(self, conn: Connection, account_id: str, revision: int) -> dict:
        conn.execute(
            "INSERT INTO saved_search_state (account_id,revision) VALUES (?,?) "
            "ON CONFLICT(account_id) DO UPDATE SET revision=excluded.revision",
            (account_id, revision + 1),
        )
        return self._saved_search_list(conn, account_id)

    def save_saved_search(self, account_id: str, expected_revision: int, definition: dict,
                          search_id: str | None = None) -> dict:
        """Create or replace a search definition without storing its search session."""
        payload = json.dumps(definition, separators=(",", ":"))
        with self._saved_search_write(account_id) as conn:
            name_sql = "CAST(payload AS JSON)->>'name'" if conn.postgres else "json_extract(payload, '$.name')"
            rows = conn.execute(
                f"SELECT id,LENGTH(payload) AS size,{name_sql} AS name FROM saved_searches WHERE account_id=?",
                (account_id,),
            ).fetchall()
            searches = {row["id"]: row for row in rows}
            if search_id is not None and search_id not in searches:
                raise KeyError(search_id)
            self._check_saved_search_revision(conn, account_id, expected_revision)
            name_key = definition["name"].strip().casefold()
            # An unchanged name remains valid when editing search settings.
            previous = searches.get(search_id)
            if previous is None or previous["name"].strip().casefold() != name_key:
                if any(row["name"].strip().casefold() == name_key for row in rows):
                    raise SavedSearchInputError("A saved search with this name already exists. Choose a different name.")
            if search_id is None and len(rows) >= self.settings.max_saved_searches:
                raise SavedSearchInputError("The saved search limit for this account has been reached")
            total = sum(row["size"] for row in rows) - (previous["size"] if previous else 0) + len(payload)
            if total > self.settings.max_saved_search_bytes_per_account:
                raise SavedSearchInputError("The saved search storage limit for this account has been reached")
            now = utc_now()
            if search_id is None:
                conn.execute(
                    "INSERT INTO saved_searches (account_id,id,payload,position,created_at,updated_at) VALUES (?,?,?,?,?,?)",
                    (account_id, new_id(), payload, len(rows), now, now),
                )
            else:
                conn.execute("UPDATE saved_searches SET payload=?,updated_at=? WHERE account_id=? AND id=?",
                             (payload, now, account_id, search_id))
            return self._saved_search_result(conn, account_id, expected_revision)

    def delete_saved_search(self, account_id: str, expected_revision: int, search_id: str) -> dict:
        """Remove one owned definition and close the gap in its list."""
        with self._saved_search_write(account_id) as conn:
            row = conn.execute("SELECT position FROM saved_searches WHERE account_id=? AND id=?",
                               (account_id, search_id)).fetchone()
            if row is None:
                raise KeyError(search_id)
            self._check_saved_search_revision(conn, account_id, expected_revision)
            conn.execute("DELETE FROM saved_searches WHERE account_id=? AND id=?", (account_id, search_id))
            conn.execute("UPDATE saved_searches SET position=position-1 WHERE account_id=? AND position>?",
                         (account_id, row["position"]))
            return self._saved_search_result(conn, account_id, expected_revision)

    def reorder_saved_searches(self, account_id: str, expected_revision: int, search_ids: list[str]) -> dict:
        """Replace the order with a complete permutation of the account's definitions."""
        with self._saved_search_write(account_id) as conn:
            self._check_saved_search_revision(conn, account_id, expected_revision)
            rows = conn.execute("SELECT id FROM saved_searches WHERE account_id=?", (account_id,)).fetchall()
            owned = {row["id"] for row in rows}
            requested = set(search_ids)
            if requested - owned:
                raise KeyError("Saved search not found")
            if len(search_ids) != len(requested) or requested != owned:
                raise SavedSearchInputError("Provide each saved search ID exactly once")
            conn.executemany("UPDATE saved_searches SET position=? WHERE account_id=? AND id=?",
                             [(position, account_id, search_id) for position, search_id in enumerate(search_ids)])
            return self._saved_search_result(conn, account_id, expected_revision)

    def hidden_columns(self, account_id: str, table_id: str) -> list[str]:
        """Read a user's saved column visibility for one dataset."""
        with self.connect() as conn:
            row = conn.execute("SELECT hidden_columns FROM table_preferences WHERE account_id=? AND table_id=?",
                               (account_id, table_id)).fetchone()
            return json.loads(row["hidden_columns"]) if row else []

    def list_table_preferences(self, account_id: str) -> list[dict]:
        """List only the authenticated account's saved column preferences."""
        with self.connect() as conn:
            rows = conn.execute("SELECT table_id,hidden_columns FROM table_preferences WHERE account_id=? ORDER BY table_id", (account_id,)).fetchall()
        return [{"table_id": row["table_id"], "hidden_columns": json.loads(row["hidden_columns"])} for row in rows]

    def reset_table_preferences(self, account_id: str, table_id: str | None = None) -> None:
        """Delete saved columns for one account, optionally for one dataset."""
        with self.connect() as conn:
            if table_id is None:
                conn.execute("DELETE FROM table_preferences WHERE account_id=?", (account_id,))
            else:
                conn.execute("DELETE FROM table_preferences WHERE account_id=? AND table_id=?", (account_id, table_id))

    def save_hidden_columns(self, account_id: str, table_id: str, hidden_columns: list[str]) -> None:
        """Replace one user's saved column visibility."""
        with self.connect() as conn:
            if hidden_columns:
                conn.execute(
                    "INSERT INTO table_preferences (account_id,table_id,hidden_columns) VALUES (?,?,?) "
                    "ON CONFLICT(account_id,table_id) DO UPDATE SET hidden_columns=excluded.hidden_columns",
                    (account_id, table_id, json.dumps(hidden_columns)),
                )
            else:
                conn.execute("DELETE FROM table_preferences WHERE account_id=? AND table_id=?", (account_id, table_id))

    def active_sessions(self) -> list[dict]:
        """Return unexpired snapshot holders for retention decisions."""
        with self.connect() as conn:
            rows = conn.execute("SELECT payload FROM sessions WHERE expires_at>?", (utc_now(),)).fetchall()
        return [payload for row in rows if not (payload := json.loads(row["payload"])).get("invalidated")]

    def invalidate_sessions(self, table_id: str, conn: Connection | None = None) -> int:
        """Invalidate all sessions whose frozen publication can retain a dataset."""
        if conn is None:
            with self.connect() as own:
                return self.invalidate_sessions(table_id, own)
        return self._invalidate_sessions(
            conn, lambda publication: table_id in publication.get("wide_snapshots", {}) or table_id in publication.get("counts", {}),
            "A dataset used by this search was removed",
        )

    def _invalidate_sessions(self, conn: Connection, matches: Callable[[dict], bool], reason: str) -> int:
        removed = 0
        for row in conn.execute("SELECT id,payload FROM sessions").fetchall():
            payload = json.loads(row["payload"])
            publication = payload.get("publication", {})
            if matches(publication):
                payload = {"id": row["id"], "owner_user_id": payload.get("owner_user_id"),
                           "expires_at": payload.get("expires_at", utc_now()), "invalidated": True,
                           "invalidated_reason": reason}
                conn.execute("UPDATE sessions SET payload=? WHERE id=?", (json.dumps(payload), row["id"]))
                removed += 1
        return removed

    @contextmanager
    def _lease(self, key: int, shared: bool, timeout: float | None, *, clean_slate=False) -> Iterator[None]:
        duration = self.settings.query_timeout_sec if timeout is None else timeout
        if self.postgres:
            import psycopg
            from psycopg.rows import dict_row

            function = "pg_try_advisory_lock_shared" if shared else "pg_try_advisory_lock"
            unlock = "pg_advisory_unlock_shared" if shared else "pg_advisory_unlock"
            # Session-scoped advisory locks do not need a transaction. Keep this connection
            # private to the lease; every guard sees the latest committed fence in one round-trip.
            raw = psycopg.connect(self.settings.postgres_dsn, row_factory=dict_row,
                                   connect_timeout=10, autocommit=True)
            try:
                conn = Connection(raw, True)
                deadline = time.monotonic() + duration
                while not conn.execute(f"SELECT {function}(?) AS acquired", (key,)).fetchone()["acquired"]:
                    if time.monotonic() >= deadline:
                        raise TimeoutError("Timed out waiting for a data publication lease")
                    time.sleep(0.05)
                def guard() -> None:
                    if clean_slate:
                        conn.execute("SELECT 1 AS lease_alive").fetchone()
                    else:
                        self._assert_no_clean_slate(conn)
                failed = False
                try:
                    guard()
                    yield guard
                except BaseException:
                    failed = True
                    raise
                finally:
                    if not raw.closed:
                        try:
                            conn.execute(f"SELECT {unlock}(?)", (key,)).fetchone()
                        except Exception:
                            if not failed:
                                raise
            finally:
                raw.close()
        else:
            import portalocker
            lock_path = self.settings.state_path.with_suffix(f".{key}.lock")
            lock_path.parent.mkdir(parents=True, exist_ok=True)
            flags = (portalocker.LOCK_SH if shared else portalocker.LOCK_EX) | portalocker.LOCK_NB
            with portalocker.Lock(str(lock_path), mode="a", timeout=duration, flags=flags):
                def guard():
                    if not clean_slate:
                        with self.connect() as conn:
                            self._assert_no_clean_slate(conn)
                guard()
                yield guard

    def read_lease(self, timeout: float | None = None):
        """Protect active reads and session registration against removal."""
        return self._lease(83172501, True, timeout)

    def write_lease(self, timeout: float | None = None):
        """Coordinate short publication/removal state changes with readers."""
        return self._lease(83172501, False, timeout)

    def writer_lease(self, timeout: float | None = None):
        """Serialize lake writers while allowing reads of published snapshots."""
        return self._lease(83172502, False, timeout)

    def bulk_preparation(self, table_id: str) -> dict | None:
        """Return one durable unpublished dataset reservation."""
        with self.connect() as conn:
            row = conn.execute("SELECT payload FROM etl_bulk_preparations WHERE table_id=?", (table_id,)).fetchone()
        return json.loads(row["payload"]) if row else None

    def bulk_preparations(self) -> list[dict]:
        """List reservations, including paused work whose uploads remain protected."""
        with self.connect() as conn:
            rows = conn.execute("SELECT payload FROM etl_bulk_preparations ORDER BY table_id").fetchall()
        return [json.loads(row["payload"]) for row in rows]

    def bulk_activation(self) -> dict | None:
        """Return the publication barrier for an unfinished bulk admission."""
        with self.connect() as conn:
            row = conn.execute("SELECT payload FROM etl_bulk_activation WHERE singleton=1").fetchone()
        return json.loads(row["payload"]) if row else None

    def bulk_lease(self, table_id: str, timeout: float | None = 0):
        """Serialize one preparation without blocking unrelated lake writers."""
        canonical = str(UUID(table_id))
        key = (int.from_bytes(sha256(canonical.encode()).digest()[:8], "big") & ((1 << 62) - 1)) | (1 << 62)
        return self._lease(key, False, timeout)

    def install_bulk_pending_guard(self) -> None:
        """Reject older writers targeting a reserved dataset before lake writes."""
        if not self.postgres:
            with self.connect() as conn:
                for operation in ("INSERT", "UPDATE"):
                    name = f"h3search_bulk_pending_{operation.lower()}_v1"
                    sql = (f"CREATE TRIGGER {name} BEFORE {operation} ON etl_pending "
                           "WHEN EXISTS (SELECT 1 FROM etl_bulk_preparations WHERE table_id=NEW.table_id) "
                           "BEGIN SELECT RAISE(ABORT, 'Dataset is reserved for bulk preparation'); END")
                    found = conn.execute("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?", (name,)).fetchone()
                    if found:
                        if "".join(found["sql"].split()).lower() != "".join(sql.split()).lower():
                            raise ConflictError("The bulk reservation guard differs from its required control protocol.")
                    else:
                        conn.execute(sql)
            return
        with self.connect() as conn:
            # Serialize first installation only; compatible triggers are retained.
            conn.execute("SELECT pg_advisory_xact_lock(83172504)")
            target = conn.execute("SELECT c.oid AS table_oid,n.nspname AS schema_name FROM pg_class c "
                "JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid='etl_pending'::regclass").fetchone()
            schema = target["schema_name"]
            quoted = '"' + schema.replace('"', '""') + '"'
            function = "h3search_bulk_pending_guard_v1"
            body = """-- h3search bulk pending guard v1
DECLARE reserved boolean;
BEGIN
    EXECUTE pg_catalog.format('SELECT EXISTS (SELECT 1 FROM %I.etl_bulk_preparations WHERE table_id=$1)', TG_TABLE_SCHEMA)
      INTO reserved USING NEW.table_id;
    IF reserved THEN
        RAISE EXCEPTION 'Dataset is reserved for bulk preparation' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
END;
"""
            found = conn.execute("SELECT p.oid,p.prosrc,p.prosecdef,p.proconfig,pg_get_function_result(p.oid) AS result "
                "FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace "
                "WHERE n.nspname=? AND p.proname=? AND p.pronargs=0", (schema, function)).fetchone()
            if found:
                if (found["prosrc"] != body or found["prosecdef"] or found["result"] != "trigger"
                        or found["proconfig"] != ["search_path=pg_catalog"]):
                    raise ConflictError("The bulk reservation guard differs from its required control protocol.")
            else:
                conn.execute(f"CREATE FUNCTION {quoted}.{function}() RETURNS trigger LANGUAGE plpgsql "
                    "SECURITY INVOKER SET search_path=pg_catalog AS $bulk_guard$" + body + "$bulk_guard$", None)
                found = conn.execute("SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace "
                    "WHERE n.nspname=? AND p.proname=? AND p.pronargs=0", (schema, function)).fetchone()
            name = "h3search_bulk_pending_v1"
            trigger = conn.execute("SELECT tgfoid,tgtype,tgenabled FROM pg_trigger WHERE tgrelid=? AND tgname=? AND NOT tgisinternal",
                                   (target["table_oid"], name)).fetchone()
            if trigger:
                if trigger["tgfoid"] != found["oid"] or trigger["tgtype"] != 23 or trigger["tgenabled"] != "O":
                    raise ConflictError("The bulk reservation trigger differs from its required control protocol.")
            else:
                conn.execute(f"CREATE TRIGGER {name} BEFORE INSERT OR UPDATE ON {quoted}.etl_pending "
                             f"FOR EACH ROW EXECUTE FUNCTION {quoted}.{function}()")
