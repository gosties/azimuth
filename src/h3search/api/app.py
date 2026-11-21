"""HTTP interface for dataset metadata and frozen search sessions."""

import asyncio
import copy
import csv
import io
import json
import logging
import secrets
import time
from concurrent.futures import TimeoutError as FutureTimeout
from contextlib import asynccontextmanager, closing, contextmanager, suppress
from datetime import datetime, timedelta, timezone
from importlib.resources import files
from logging.handlers import RotatingFileHandler
from typing import Annotated
from uuid import UUID, uuid4

import anyio
from fastapi import APIRouter, FastAPI, HTTPException, Path, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from starlette.middleware.cors import CORSMiddleware

from h3search.config import Settings
from h3search.control import ConflictError, Registry
from h3search.coordinates import CoordinateError, coordinate_info, parse_coordinate_info

from .csv_safety import spreadsheet_cell
from .auth import AuthAPI, require_role
from .execution import Unavailable, Workers
from .exports import Exports, register_exports
from .models import (
    CORE_COLUMN_KEYS, PUBLIC_DATASET_FIELDS, ColumnPreferences, DatasetInput, DatasetMetadataInput, Input, PointsInput, PointsStreamInput, SearchInput,
    CSVInput, CSVLocationsInput, TimeFilterInput, CategoryInput, MapsInput, ExportSettingsInput, AggregatesInput,
    object_key, validate_search_limits,
)
from .maps import configured_maps, public_maps
from .saved_searches import register_saved_searches
from .search import Search
from .storage import Storage
from .wfs_data import WFSData
from .wfs_protocol import register_wfs
from .csv_locations import locations as csv_locations, read_csv
from .temporal import temporal_kind

LOG = logging.getLogger(__name__)


class WfsClientOrigins:
    """Give configured web GIS clients CORS access on the WFS endpoint only."""

    def __init__(self, app, origins):
        self.app = app
        self.wfs = CORSMiddleware(app, allow_origins=origins, allow_credentials=True,
                                  allow_methods=["GET", "POST"], allow_headers=["Authorization", "Content-Type"])

    async def __call__(self, scope, receive, send):
        handler = self.wfs if scope["type"] == "http" and scope["path"] == "/api/wfs" else self.app
        await handler(scope, receive, send)


Limit = Annotated[int, Query(ge=1, le=100)]
Cursor = Annotated[str | None, Query(max_length=768)]
Latitude = Annotated[float, Query(ge=-90, le=90, allow_inf_nan=False)]
Longitude = Annotated[float, Query(ge=-180, le=180, allow_inf_nan=False)]
EXPORT_FIELDS = ("table_id", "object_id", "h3", "latitude", "longitude", "distance_m")
EMPTY_PUBLICATION = {
    "id": str(UUID(int=0)), "search_snapshot_id": None, "wide_snapshots": {}, "counts": {}, "columns": {},
}
INVENTORY_FIELDS = ("id", "name", "description", "status", "searchable_count", "datetime_column", "category_ids")


class SessionStreamResponse(StreamingResponse):
    """Close the stream and its producer on disconnect, including during ASGI sends."""

    def __init__(self, content, on_close, **options):
        super().__init__(content, **options)
        self.on_close = on_close

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            with anyio.CancelScope(shield=True):
                try:
                    await self.body_iterator.aclose()
                finally:
                    await self.on_close()


def _public_dataset(dataset, admin=True):
    return {field: dataset.get(field, 4326 if field == "source_srid" else [] if field == "category_ids" else None)
            for field in (PUBLIC_DATASET_FIELDS if admin else INVENTORY_FIELDS)}


def _public_maps(settings):
    return configured_maps(settings.maps, settings.default_map_id)


def _owned_session(registry, session_id, user_id):
    session = registry.get_session(session_id)
    if session is None or session.get("kind") == "wfs" or session.get("owner_user_id") != user_id:
        raise HTTPException(404, "Search session not found")
    return session


def _session(registry, session_id, user_id):
    session = _owned_session(registry, session_id, user_id)
    if session.get("invalidated"):
        raise HTTPException(410, session.get("invalidated_reason", "A dataset used by this search was removed"))
    if datetime.fromisoformat(session["expires_at"]) <= datetime.now(timezone.utc):
        raise HTTPException(410, "Search session expired")
    return session


def _new_session(job, registry, search, settings, body, user_id):
    base = registry.current_publication() or EMPTY_PUBLICATION
    layouts = base.get("lookup_publications")
    lookup_mode = body.lookup_mode
    if layouts is not None:
        if "lookup_mode" not in body.model_fields_set and "r3" not in layouts:
            lookup_mode = "single_file"
        key = "single-file" if lookup_mode == "single_file" else "r3"
        if key not in layouts:
            raise HTTPException(409, "The selected lookup is unavailable for the current data.")
        publication = {**base, **layouts[key]}
    elif lookup_mode == "single_file":
        publication = registry.single_file_publication()
        if publication is None:
            raise HTTPException(409, "Single-file lookup is unavailable for the current data.")
    else:
        publication = base
    datasets = {row["id"]: row for row in registry.list_datasets()}
    if any(table not in datasets or datasets[table]["status"] == "removing"
           for table in publication["wide_snapshots"]):
        raise HTTPException(409, "Search is temporarily unavailable while a dataset is being removed")
    available = publication["wide_snapshots"].keys() & datasets.keys()
    if body.dataset_ids is None:
        selection = sorted(available)
    else:
        selection = sorted(str(table) for table in body.dataset_ids)
        if any(table not in datasets for table in selection):
            raise HTTPException(404, "A selected dataset is unknown")
        if any(table not in available for table in selection):
            raise HTTPException(409, "A selected dataset has no searchable publication")

    session = {
        "id": str(uuid4()), "owner_user_id": user_id, "publication": publication,
        "query": {
            "latitude": body.latitude, "longitude": body.longitude, "radius_m": body.radius_m,
            "lookup_mode": lookup_mode,
            "dataset_ids": selection, "cursor_secret": secrets.token_hex(32),
            "object_columns": {table: datasets[table]["object_id_column"] for table in selection},
            "datetime_columns": {table: next((column for column in publication["columns"].get(table, [])
                                                if column["name"] == datasets[table].get("datetime_column")
                                                and temporal_kind(column)), None) for table in selection},
            "dataset_names": {table: datasets[table]["name"] for table in selection},
            "dataset_sources": {
                table: {key: publication.get("dataset_sources", {}).get(table, datasets[table])[key]
                        for key in ("source_schema", "source_table")}
                for table in selection
            },
        },
    }
    if body.centers is not None:
        session["query"]["centers"] = [dict(latitude=latitude, longitude=longitude) for latitude, longitude in
                                         dict.fromkeys((center.latitude, center.longitude) for center in body.centers)]
    if body.time_filter and any(body.time_filter.model_dump().values()):
        query = session["query"]
        query["spatial_dataset_ids"] = list(selection)
        query["dataset_ids"] = [table for table in selection if query["datetime_columns"].get(table)]
        if len(query["dataset_ids"]) > settings.max_temporal_datasets:
            raise HTTPException(422, "Temporal search exceeds the configured dataset limit; narrow the dataset selection")
        query["time_filter"] = body.time_filter.model_dump(mode="json", exclude_none=True)
    return _save_search(job, registry, search, settings, session)


def _save_search(job, registry, search, settings, session):
    counts, page = search.initial(job, session, 100, map_preview=True)
    now = datetime.now(timezone.utc)
    session["created_at"] = now.isoformat()
    session["expires_at"] = (now + timedelta(seconds=settings.session_ttl_sec)).isoformat()
    session["total"] = sum(counts.values())
    session["query"]["counts"] = counts
    job.verify_lease(force=True)
    registry.save_session(session)
    if job.cancelled.is_set():
        registry.delete_session(session["id"])
        job.check()
    return {
        "id": session["id"], "total": session["total"], "expires_at": session["expires_at"],
        "map_preview": page.get("map_preview", []),
        "publication_id": session["publication"]["id"], "rows": page["items"], "next_cursor": page["next_cursor"],
        "lookup_mode": session["query"].get("lookup_mode", "partitioned"),
        "datasets": [{"id": table, "name": session["query"]["dataset_names"][table], "count": counts.get(table, 0)}
                     for table in session["query"]["dataset_ids"]],
        "time_filter": session["query"].get("time_filter"), "parent_session_id": session.get("parent_session_id"),
        "temporal_dataset_ids": [table for table, column in session["query"].get("datetime_columns", {}).items() if column],
    }


async def _disconnected(request):
    while (await request.receive())["type"] != "http.disconnect":
        pass


async def _while_connected(request, operation):
    work = asyncio.create_task(operation)
    disconnect = asyncio.create_task(_disconnected(request))
    try:
        await asyncio.wait((work, disconnect), return_when=asyncio.FIRST_COMPLETED)
        if work.done():
            return work.result()
        raise HTTPException(410, "Request disconnected")
    finally:
        for task in (work, disconnect):
            if not task.done():
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task


def _csv_chunk(rows):
    buffer = io.StringIO(newline="")
    csv.writer(buffer).writerows([spreadsheet_cell(value) for value in row] for row in rows)
    return buffer.getvalue()


def _ndjson_chunk(record):
    return json.dumps(record, separators=(",", ":"), allow_nan=False) + "\n"


@contextmanager
def _api_logging(settings):
    logger = logging.getLogger("h3search.api")
    previous_level = logger.level
    settings.log_path.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(settings.log_path / "api.log", encoding="utf-8", delay=True,
                                  maxBytes=settings.log_max_mb * 1024 * 1024, backupCount=settings.log_backups)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.setLevel(settings.log_level.upper())
    logger.addHandler(handler)
    try:
        yield
    finally:
        logger.removeHandler(handler)
        handler.close()
        logger.setLevel(previous_level)


def create_app(settings: Settings | None = None) -> FastAPI:
    """Construct the API with explicitly configured storage and worker budgets."""
    settings = settings if settings is not None else Settings.load()
    maps = _public_maps(settings)
    registry = Registry(settings)
    auth = AuthAPI(registry)

    @asynccontextmanager
    async def lifespan(app):
        storage = Storage(settings)
        workers = Workers(settings.pool_size, settings.pool_wait_sec, settings.query_timeout_sec)
        wfs_workers = Workers(settings.pool_size, settings.pool_wait_sec, settings.query_timeout_sec)
        wfs_storage = Storage(settings, source="h3search-wfs")
        app.state.workers = workers
        app.state.wfs_workers = wfs_workers
        app.state.search = Search(storage)
        app.state.wfs_data = WFSData(wfs_storage, registry, settings)
        exports = None
        cleanup_task = None
        async def cleanup_sessions():
            while True:
                try:
                    await asyncio.to_thread(registry.cleanup_expired_sessions)
                except Exception:
                    LOG.exception("Expired search session cleanup failed")
                await asyncio.sleep(settings.session_cleanup_interval_sec)
        with _api_logging(settings):
            try:
                await workers.run(lambda job: registry.initialize(), "startup")
                exports = Exports(settings, registry, worker=False)
                app.state.exports = exports
                cleanup_task = asyncio.create_task(cleanup_sessions())
                yield
            finally:
                if cleanup_task is not None:
                    cleanup_task.cancel()
                    await asyncio.gather(cleanup_task, return_exceptions=True)
                if exports is not None:
                    await asyncio.to_thread(exports.close)
                await asyncio.to_thread(workers.close)
                await asyncio.to_thread(wfs_workers.close)
                await asyncio.to_thread(wfs_storage.close)
                await asyncio.to_thread(storage.close)

    app = FastAPI(title="Azimuth", lifespan=lifespan, openapi_url=None)
    router = APIRouter(prefix="/api")
    router.include_router(auth.router())
    from .community import register_community
    register_community(router, registry, auth)
    auth.register_handlers(app)

    @app.middleware("http")
    async def correlate(request, call_next):
        request.state.request_id = uuid4().hex
        started = time.monotonic()
        try:
            response = await auth.authorize(request)
        except Exception as error:
            LOG.warning("request_id=%s authentication_error=%s", request.state.request_id, type(error).__name__)
            response = JSONResponse({"detail": "Authentication is temporarily unavailable"}, status_code=503)
        if response is None:
            maximum = None
            if request.method in {"POST", "PUT", "PATCH", "DELETE"} and request.url.path.startswith(("/api/feedback", "/api/announcements", "/api/admin/feedback", "/api/admin/announcements")):
                maximum = 3 * 1024 * 1024 if request.url.path.startswith("/api/admin/announcements") else 65536
                body_label = "Community request"
            if request.url.path in {"/api/csv/preview", "/api/csv/locations"}:
                # JSON may escape each input byte as six ASCII characters. Bound the
                # transport before JSON decoding as well as the decoded CSV below.
                maximum = settings.max_csv_bytes * 6 + 65536
                body_label = "CSV request"
            elif request.method in {"POST", "PUT", "DELETE"} and (
                request.url.path == "/api/saved-searches" or request.url.path.startswith("/api/saved-searches/")
            ):
                maximum = settings.max_saved_search_request_bytes
                body_label = "Saved search request"
            if maximum is not None:
                chunks, received = [], 0
                async for chunk in request.stream():
                    received += len(chunk)
                    if received > maximum:
                        response = JSONResponse({"detail": f"{body_label} exceeds the configured byte limit"}, status_code=413)
                        break
                    chunks.append(chunk)
                if response is None:
                    request._body = b"".join(chunks)
            if response is None:
                response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        response.headers["Cache-Control"] = "no-store"
        route = request.scope.get("route")
        LOG.info("request_id=%s method=%s route=%s status=%s elapsed_ms=%.1f",
                 request.state.request_id, request.method, getattr(route, "path", "unmatched"),
                 response.status_code, (time.monotonic() - started) * 1000)
        return response

    @app.exception_handler(RequestValidationError)
    async def invalid_input(request, error):
        if request.url.path.startswith(("/api/auth/", "/api/admin/users")):
            return JSONResponse(status_code=422, content={"detail": "Invalid account request"})
        errors = error.errors()
        field = ".".join(str(part) for part in errors[0]["loc"])
        return JSONResponse(status_code=422, content={"detail": f"Invalid input at {field}: {errors[0]['msg']}"})

    @app.exception_handler(ConflictError)
    async def conflict(request, error):
        return JSONResponse(status_code=409, content={"detail": str(error)})

    @app.exception_handler(Unavailable)
    async def unavailable(request, error):
        return JSONResponse(status_code=503, content={"detail": str(error)})

    @app.exception_handler(CoordinateError)
    async def invalid_coordinate(request, error):
        return JSONResponse(status_code=422, content={"detail": str(error)})

    async def run(request, fn, *, session_id=None, lease=False, monitor=True, worker_pool=None):
        workers = worker_pool or request.app.state.workers

        def operation(job):
            if lease:
                with registry.read_lease(settings.pool_wait_sec) as guard:
                    job.lease_guard = guard
                    job.check()
                    result = fn(job)
                    job.verify_lease(force=True)
                    return result
            return fn(job)

        try:
            work = workers.run(operation, request.state.request_id, session_id)
            if not monitor:
                return await work
            return await _while_connected(request, work)
        except (HTTPException, ConflictError, Unavailable):
            raise
        except Exception as error:
            # SQL clients and their errors can contain credentials or field values.
            LOG.warning("request_id=%s dependency_error=%s", request.state.request_id, type(error).__name__)
            raise Unavailable("Search storage is temporarily unavailable") from None

    async def read_session(request, session_id, fn, *, monitor=True):
        identifier = str(session_id)
        user_id = request.state.user["id"]
        return await run(request, lambda job: fn(job, _session(registry, identifier, user_id)),
                         session_id=identifier, lease=True, monitor=monitor)

    @router.get("/health")
    async def health():
        """Return the API mode and process status."""
        return {"status": "ok", "mode": settings.mode}

    @router.get("/config")
    async def config(request: Request):
        """Expose connection names and approved basemap configurations."""
        connections = settings.connections if request.state.user["role"] != "user" else {}
        return {"mode": settings.mode, "connections": [{"name": name} for name in sorted(connections)],
                **await run(request, lambda job: {**current_maps(), **lookup_availability()}, lease=True),
                "max_radius_m": settings.max_radius_m,
                "max_map_points": settings.max_map_points, "max_search_centers": settings.max_search_centers,
                "max_csv_bytes": settings.max_csv_bytes, "max_csv_rows": settings.max_csv_rows,
                "max_csv_columns": settings.max_csv_columns, "max_csv_cell_chars": settings.max_csv_cell_chars,
                "infrastructure_document_available": infrastructure_document().is_file(),
                "export_limits": {fmt: getattr(settings, "max_" + fmt + "_export_rows") for fmt in ("csv", "kml", "json", "gpkg")}}

    def infrastructure_document():
        return files(__package__).joinpath("documents", "infrastructure.html")

    def current_maps():
        return registry.maps_config() or {"maps": maps, "default_map_id": settings.default_map_id}

    def lookup_availability():
        layouts = (registry.current_publication() or {}).get("lookup_publications")
        if layouts is None:
            return {"partition_resolution": settings.partition_resolution, "partitioned_available": True, "single_file_available": registry.single_file_publication() is not None}
        return {"partition_resolution": 3, "partitioned_available": "r3" in layouts, "single_file_available": "single-file" in layouts}

    @router.get("/admin/infrastructure/document", response_class=HTMLResponse)
    def get_infrastructure_document(request: Request):
        require_role(request, "admin")
        try:
            document = infrastructure_document().read_bytes()
        except (FileNotFoundError, IsADirectoryError):
            raise HTTPException(404, "Document not found") from None
        return HTMLResponse(document, headers={
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
            "X-Frame-Options": "SAMEORIGIN",
        })

    @router.get("/admin/release-notes")
    async def release_notes(request: Request):
        require_role(request, "admin")
        return {"items": await run(request, lambda job: registry.release_notes())}

    @router.get("/admin/maps")
    async def get_maps(request: Request):
        require_role(request, "admin")
        return await run(request, lambda job: current_maps())

    @router.get("/admin/export-settings")
    async def get_export_settings(request: Request):
        require_role(request, "admin")
        return await run(request, lambda job: registry.export_settings())

    @router.put("/admin/export-settings")
    async def put_export_settings(request: Request, body: ExportSettingsInput):
        require_role(request, "admin")
        payload = body.model_dump()
        await run(request, lambda job: registry.save_export_settings(payload))
        return payload

    @router.put("/admin/maps")
    async def put_maps(request: Request, body: MapsInput):
        require_role(request, "admin")
        try:
            payload = {"maps": public_maps(body.maps, body.default_map_id), "default_map_id": body.default_map_id}
        except ValueError as error:
            raise HTTPException(422, str(error)) from None
        await run(request, lambda job: registry.save_maps_config(payload))
        return payload

    @router.get("/categories")
    async def categories(request: Request):
        return {"items": await run(request, lambda job: registry.list_categories())}

    async def write_category(request, body, category_id=None):
        require_role(request, "superadmin")
        def save(job):
            try:
                return registry.save_category(body.name, category_id)
            except KeyError:
                raise HTTPException(404, "Category not found") from None
            except ConflictError:
                raise
            except ValueError as error:
                raise HTTPException(422, str(error)) from None
        return await run(request, save)

    @router.post("/admin/categories", status_code=201)
    async def create_category(request: Request, body: CategoryInput):
        return await write_category(request, body)

    @router.patch("/admin/categories/{category_id}")
    async def update_category(request: Request, category_id: UUID, body: CategoryInput):
        return await write_category(request, body, str(category_id))

    @router.delete("/admin/categories/{category_id}", status_code=204)
    async def delete_category(request: Request, category_id: UUID):
        require_role(request, "superadmin")
        def remove(job):
            try:
                registry.delete_category(str(category_id))
            except KeyError:
                raise HTTPException(404, "Category not found") from None
        await run(request, remove)
        return Response(status_code=204)

    @router.post("/csv/preview")
    async def preview_csv(request: Request, body: CSVInput):
        def preview(job):
            columns, rows = read_csv(body.text, settings)
            return {"columns": columns, "preview_rows": [row for _, row in rows[:10]], "total_rows": len(rows)}
        return await run(request, preview)

    @router.post("/csv/locations")
    async def parse_csv_locations(request: Request, body: CSVLocationsInput):
        return await run(request, lambda job: csv_locations(body, settings))

    @router.get("/coordinates/parse")
    async def coordinates_parse(q: Annotated[str, Query(min_length=1, max_length=256)]):
        return parse_coordinate_info(q)

    @router.get("/coordinates/format")
    async def coordinates_format(latitude: Latitude, longitude: Longitude):
        return coordinate_info(latitude, longitude)

    @router.get("/datasets")
    async def datasets(request: Request):
        """List registry entries and published searchable inventory counts."""
        admin = request.state.user["role"] != "user"

        def inventory(job):
            publication = registry.current_publication() or EMPTY_PUBLICATION
            catalog = {"catalog_id": "primary", "catalog_name": settings.primary_catalog_name,
                       "catalog_kind": "shared", "source_description": settings.primary_catalog_description}
            return {"items": [{**_public_dataset(item, admin), **catalog} for item in registry.list_datasets()],
                    "searchable_total": sum(publication["counts"].values())}

        return await run(request, inventory, lease=True)

    @router.post("/datasets", status_code=201)
    async def register(request: Request, body: DatasetInput):
        """Register immutable source metadata for a future ETL run."""
        require_role(request, "admin")
        if body.connection_name not in settings.connections:
            raise HTTPException(422, "Unknown source connection")
        item = await run(request, lambda job: registry.register_dataset(body.model_dump()))
        return _public_dataset(item)

    @router.patch("/datasets/{table_id}")
    async def describe(request: Request, table_id: UUID, body: DatasetMetadataInput):
        """Update catalog description and temporal designation."""
        require_role(request, "admin")

        def update(job):
            try:
                return registry.update_metadata(str(table_id), body.model_dump(mode="json", exclude_unset=True))
            except KeyError:
                raise HTTPException(404, "Dataset not found") from None
            except ValueError as error:
                raise HTTPException(422, str(error)) from None

        return _public_dataset(await run(request, update))

    @router.get("/datasets/{table_id}/columns")
    async def dataset_columns(request: Request, table_id: UUID):
        require_role(request, "admin")
        def columns(job):
            try:
                dataset = registry.get_dataset(str(table_id))
            except KeyError:
                raise HTTPException(404, "Dataset not found") from None
            publication = registry.current_publication() or EMPTY_PUBLICATION
            return {"columns": [{"name": column["name"], "type": column["type"],
                                  "temporal_eligible": temporal_kind(column) is not None}
                                 for column in publication["columns"].get(str(table_id), [])],
                    "datetime_column": dataset.get("datetime_column")}
        return await run(request, columns, lease=True)

    def table_preferences(user_id, table_id, hidden=None):
        try:
            registry.get_dataset(table_id)
        except KeyError:
            raise HTTPException(404, "Dataset not found") from None
        if hidden is None:
            return {"hidden_columns": registry.hidden_columns(user_id, table_id)}
        publication = registry.current_publication() or EMPTY_PUBLICATION
        allowed = CORE_COLUMN_KEYS | {f"source:{column['name']}" for column in publication["columns"].get(table_id, [])}
        if not allowed.issuperset(hidden):
            raise HTTPException(422, "Unknown dataset column")
        registry.save_hidden_columns(user_id, table_id, hidden)
        return {"hidden_columns": hidden}

    @router.get("/preferences/tables")
    async def list_table_preferences(request: Request):
        user_id = request.state.user["id"]
        return {"items": await run(request, lambda job: registry.list_table_preferences(user_id))}

    @router.delete("/preferences/tables", status_code=204)
    async def reset_table_preferences(request: Request):
        await run(request, lambda job: registry.reset_table_preferences(request.state.user["id"]))
        return Response(status_code=204)

    @router.get("/preferences/tables/{table_id}/columns")
    async def preference_columns(request: Request, table_id: UUID):
        def columns(job):
            try:
                dataset = registry.get_dataset(str(table_id))
            except KeyError:
                raise HTTPException(404, "Dataset not found") from None
            publication = registry.current_publication() or EMPTY_PUBLICATION
            return {"columns": [{"name": column["name"], "type": column["type"],
                                  "temporal_eligible": temporal_kind(column) is not None}
                                 for column in publication["columns"].get(str(table_id), [])],
                    "datetime_column": dataset.get("datetime_column")}
        return await run(request, columns, lease=True)

    @router.delete("/preferences/tables/{table_id}", status_code=204)
    async def reset_table_preference(request: Request, table_id: UUID):
        await run(request, lambda job: registry.reset_table_preferences(request.state.user["id"], str(table_id)))
        return Response(status_code=204)

    @router.get("/preferences/tables/{table_id}")
    async def get_table_preferences(request: Request, table_id: UUID):
        user_id = request.state.user["id"]
        return await run(request, lambda job: table_preferences(user_id, str(table_id)), lease=True)

    @router.put("/preferences/tables/{table_id}")
    async def put_table_preferences(request: Request, table_id: UUID, body: ColumnPreferences):
        user_id = request.state.user["id"]
        hidden = sorted(set(body.hidden_columns))
        return await run(request, lambda job: table_preferences(user_id, str(table_id), hidden), lease=True)

    @router.post("/searches")
    async def create_search(request: Request, body: SearchInput):
        """Freeze one publication and return exact counts and the first page."""
        validate_search_limits(body, settings)
        search = request.app.state.search
        user_id = request.state.user["id"]
        return await run(request, lambda job: _new_session(job, registry, search, settings, body, user_id), lease=True)

    @router.post("/searches/{session_id}/time-filter")
    async def time_filter(request: Request, session_id: UUID, body: TimeFilterInput):
        def derive(job, parent):
            child = copy.deepcopy(parent)
            child.update(id=str(uuid4()), parent_session_id=parent["id"])
            query = child["query"]
            query["cursor_secret"] = secrets.token_hex(32)
            query["dataset_ids"] = query.pop("spatial_dataset_ids", query["dataset_ids"])
            query.pop("counts", None)
            query.pop("time_filter", None)
            if any(body.model_dump().values()):
                query["spatial_dataset_ids"] = list(query["dataset_ids"])
                query["dataset_ids"] = [table for table in query["dataset_ids"] if query.get("datetime_columns", {}).get(table)]
                if len(query["dataset_ids"]) > settings.max_temporal_datasets:
                    raise HTTPException(422, "Date filtering exceeds the configured dataset limit; narrow the spatial dataset selection")
                query["time_filter"] = body.model_dump(mode="json")
            if "dataset_names" not in query:
                query["dataset_names"] = {table: table for table in query["dataset_ids"]}
            return _save_search(job, registry, request.app.state.search, settings, child)
        return await read_session(request, session_id, derive)

    @router.delete("/searches/{session_id}", status_code=204)
    async def cancel_search(request: Request, session_id: UUID, body: Input):
        """Invalidate the session and request cancellation of its running work."""
        workers = request.app.state.workers
        identifier, user_id = str(session_id), request.state.user["id"]
        await auth.account_work(_owned_session, registry, identifier, user_id)
        workers.cancel_session(identifier)
        await auth.account_work(registry.delete_session, identifier)
        workers.cancel_session(identifier)
        return Response(status_code=204)

    @router.get("/searches/{session_id}/rows")
    async def rows(request: Request, session_id: UUID, cursor: Cursor = None, limit: Limit = 100):
        """Page through thin results in stable full-key order."""
        search = request.app.state.search
        return await read_session(request, session_id, lambda job, session: search.page(job, session, limit, cursor))

    @router.get("/searches/{session_id}/tables/{table_id}/rows")
    async def table_rows(request: Request, session_id: UUID, table_id: UUID, cursor: Cursor = None, limit: Limit = 100):
        """Page through wide results for the requested dataset only."""
        search = request.app.state.search
        user_id, identifier = request.state.user["id"], str(table_id)
        return await read_session(request, session_id, lambda job, session: search.table_page(
            job, session, identifier, limit, cursor, registry.hidden_columns(user_id, identifier)))

    @router.get("/searches/{session_id}/records/{table_id}/{object_id}")
    async def record(request: Request, session_id: UUID, table_id: UUID, object_id: str):
        """Fetch the frozen wide record for one matching full key."""
        key = object_key(object_id)
        search = request.app.state.search
        return await read_session(request, session_id, lambda job, session: search.record(job, session, str(table_id), key))

    @router.get("/searches/{session_id}/records/{table_id}/{object_id}/fields/{column_index}")
    async def record_field(request: Request, session_id: UUID, table_id: UUID, object_id: str,
                           column_index: Annotated[int, Path(ge=0)],
                           offset: Annotated[int, Query(ge=0, le=2**31 - 1)] = 0,
                           limit: Annotated[int, Query(ge=1, le=8192)] = 2048):
        """Read a bounded exact text or binary chunk from a matching record."""
        key = object_key(object_id)
        search = request.app.state.search
        return await read_session(request, session_id, lambda job, session: search.field(
            job, session, str(table_id), key, column_index, offset, limit))

    @router.get("/searches/{session_id}/overlaps")
    async def overlaps(request: Request, session_id: UUID, latitude: Latitude, longitude: Longitude,
                       cursor: Cursor = None, limit: Limit = 100):
        """Page through matching records at one exact coordinate."""
        search = request.app.state.search
        return await read_session(request, session_id, lambda job, session: search.page(
            job, session, limit, cursor, overlap=(latitude, longitude)))

    async def viewport_points(request, session_id, west, south, east, north, zoom, limit, dataset_ids):
        if south > north:
            raise HTTPException(422, "South must be at or below north")
        search = request.app.state.search
        selected = None if dataset_ids is None else list(dict.fromkeys(map(str, dataset_ids)))
        return await read_session(request, session_id, lambda job, session: search.points(
            job, session, (west, south, east, north), zoom, min(limit, settings.max_map_points), selected))

    @router.get("/searches/{session_id}/points")
    async def points(request: Request, session_id: UUID, west: Longitude, south: Latitude, east: Longitude,
                     north: Latitude, zoom: Annotated[float, Query(ge=0, le=30, allow_inf_nan=False)],
                     limit: Annotated[int, Query(ge=1)] = 3000,
                     dataset_ids: Annotated[list[UUID] | None, Query(max_length=1000)] = None):
        """Return a bounded selection of actual matching points within the viewport."""
        return await viewport_points(request, session_id, west, south, east, north, zoom, limit, dataset_ids)

    @router.post("/searches/{session_id}/points")
    async def points_query(request: Request, session_id: UUID, body: PointsInput):
        """Query viewport points without encoding the dataset selection in the URL."""
        return await viewport_points(request, session_id, **body.model_dump())

    @router.post("/searches/{session_id}/map/aggregates")
    async def map_aggregates(request: Request, session_id: UUID, body: AggregatesInput):
        """Return full-result cell counts for the visible frozen selection."""
        if body.south > body.north:
            raise HTTPException(422, "South must be at or below north")
        search = request.app.state.search
        selected = None if body.dataset_ids is None else list(dict.fromkeys(map(str, body.dataset_ids)))
        return await read_session(request, session_id, lambda job, session: search.aggregates(
            job, session, (body.west, body.south, body.east, body.north), body.mode, body.columns, selected))

    async def stream_session(request, session_id, produce, *, first_chunk=None, tolerate_interruption=False, **response_options):
        loop = asyncio.get_running_loop()
        chunks = asyncio.Queue(maxsize=1)

        def run_producer(job, session):
            def emit(data):
                pending = asyncio.run_coroutine_threadsafe(chunks.put(data), loop)
                try:
                    while True:
                        job.verify_lease()
                        try:
                            pending.result(timeout=0.2)
                            break
                        except FutureTimeout:
                            pass
                finally:
                    pending.cancel()

            return produce(job, session, emit)

        producer = asyncio.create_task(read_session(request, session_id, run_producer, monitor=False))

        async def pull():
            chunk = asyncio.create_task(chunks.get())
            try:
                await asyncio.wait((producer, chunk), return_when=asyncio.FIRST_COMPLETED)
                if chunk.done():
                    return chunk.result()
                if not chunks.empty():
                    return chunks.get_nowait()
                producer.result()
                return None
            finally:
                if not chunk.done():
                    chunk.cancel()
                    with suppress(asyncio.CancelledError):
                        await chunk

        async def stop_producer():
            producer.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await producer

        try:
            first = await _while_connected(request, pull())
        except BaseException:
            await stop_producer()
            raise

        async def stream():
            if first_chunk is not None:
                yield first_chunk
            try:
                current = first
                while current is not None:
                    yield current
                    current = await pull()
                if (last := producer.result()) is not None:
                    yield last
            except (HTTPException, ConflictError, Unavailable):
                if not tolerate_interruption:
                    raise

        return SessionStreamResponse(stream(), stop_producer, **response_options)

    @router.post("/searches/{session_id}/points/stream")
    async def points_stream(request: Request, session_id: UUID, body: PointsStreamInput):
        """Stream additional viewport points after an optional signed position."""
        if body.south > body.north:
            raise HTTPException(422, "South must be at or below north")
        search = request.app.state.search
        viewport = (body.west, body.south, body.east, body.north)
        selected = None if body.dataset_ids is None else list(map(str, body.dataset_ids))

        def produce(job, session, emit):
            result = search.stream_points(job, session, viewport, body.zoom, body.limit, selected, body.cursor,
                                          lambda record: emit(_ndjson_chunk(record)))
            return _ndjson_chunk(result)

        return await stream_session(request, session_id, produce, tolerate_interruption=True,
                                    media_type="application/x-ndjson", headers={"X-Accel-Buffering": "no"})

    @router.get("/searches/{session_id}/export.csv")
    async def export_csv(request: Request, session_id: UUID):
        """Stream matching identities, coordinates and distances in stable order."""
        search = request.app.state.search

        def produce(job, session, emit):
            with closing(search.export_chunks(job, session)) as batches:
                for rows in batches:
                    emit(_csv_chunk(tuple(row[key] for key in EXPORT_FIELDS) for row in rows))

        return await stream_session(request, session_id, produce, first_chunk=_csv_chunk([EXPORT_FIELDS]),
                                    media_type="text/csv",
                                    headers={"Content-Disposition": 'attachment; filename="search-results.csv"'})

    register_exports(router, read_session)
    register_saved_searches(router, registry, run)
    async def run_wfs(request, operation, *, lease=False):
        return await run(request, operation, lease=lease, worker_pool=request.app.state.wfs_workers)

    register_wfs(router, run_wfs, auth.gis.settings, settings.auth_origins)
    app.include_router(router)
    if settings.wfs_client_origins:
        app.add_middleware(WfsClientOrigins, origins=settings.wfs_client_origins)
    return app
