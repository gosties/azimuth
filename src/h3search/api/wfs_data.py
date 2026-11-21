"""Bounded, frozen point retrieval for the read-only WFS service."""

import hashlib
import json
import math
import re
from contextlib import nullcontext
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from uuid import UUID, uuid4

from fastapi import HTTPException

from h3search.control import SINGLE_FILE_SEARCH_TABLE
from h3search.geo import EARTH_RADIUS_M
from h3search.gis import GisAccess

from .pruning import partition_cover
from .search import _wide_name, source_value
from .storage import quote
from .temporal import canonical_instant, instant_expression, temporal_kind
from .wide import value_kind


def layer_name(table_id):
    """Use the immutable dataset identity as a collision-free XML name."""
    return "az_" + UUID(table_id).hex


def feature_id(table_id, object_id):
    return f"{layer_name(table_id)}.{object_id}"


def _key(value, table_id):
    value = str(value)
    if "." in value:
        prefix, value = value.rsplit(".", 1)
        if prefix != layer_name(table_id):
            raise HTTPException(400, "Feature ID belongs to another layer")
    if not re.fullmatch(r"-?(?:0|[1-9][0-9]{0,18})", value) or not -(2**63) <= int(value) < 2**63:
        raise HTTPException(400, "Invalid feature ID")
    return int(value)


def _columns(publication, table_id):
    columns = [{"name": "object_id", "type": "bigint", "source_name": "object_id", "physical_name": None}]
    used = {"object_id", "geometry"}
    for index, column in enumerate(publication.get("columns", {}).get(table_id, []), 1):
        name = re.sub(r"[^A-Za-z0-9_.-]+", "_", column["name"]).strip("_") or f"field_{index}"
        if not re.match(r"[A-Za-z_]", name) or name.lower().startswith("xml"):
            name = "field_" + name
        base = name
        suffix = 1
        while name.casefold() in used:
            name = f"{base}_{suffix}"
            suffix += 1
        used.add(name.casefold())
        columns.append({**column, "source_name": column["name"], "name": name})
    return columns


def _bbox(value, maximum):
    if value is None:
        return None
    if len(value) != 4 or not all(isinstance(part, (int, float)) and math.isfinite(part) for part in value):
        raise HTTPException(400, "Invalid bounding box")
    west, south, east, north = value
    if not (-180 <= west <= east <= 180 and -90 <= south <= north <= 90):
        raise HTTPException(400, "Invalid bounding box")
    # Also measure the wider horizontal edge: opposite corners alone understate
    # a rectangle spanning a pole or a hemisphere.
    def distance(lat1, lon1, lat2, lon2):
        hav = (math.sin(math.radians(lat2 - lat1) / 2)**2
               + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
               * math.sin(math.radians(lon2 - lon1) / 2)**2)
        return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(min(1, max(0, hav))))
    nearest_equator = max(south, min(0, north))
    diagonal = max(distance(south, west, north, east), distance(nearest_equator, west, nearest_equator, east))
    if east - west > 180 or diagonal > maximum:
        raise HTTPException(400, "Bounding box exceeds the configured diagonal limit; zoom in")
    return tuple(float(part) for part in value)


def _predicate(tree, columns, table_id, *, depth=0, nodes=None):
    """Compile only allowlisted fields/operators; every client value is bound."""
    nodes = [0] if nodes is None else nodes
    nodes[0] += 1
    if depth > 8 or nodes[0] > 64 or not isinstance(tree, dict):
        raise HTTPException(400, "Filter exceeds the supported complexity")
    op = tree.get("op")
    if op in {"and", "or"}:
        parts = tree.get("args")
        if not isinstance(parts, list) or not 1 <= len(parts) <= 32:
            raise HTTPException(400, "Invalid filter expression")
        expressions = [_predicate(part, columns, table_id, depth=depth + 1, nodes=nodes) for part in parts]
        return "(" + f" {op.upper()} ".join(sql for sql, _ in expressions) + ")", [value for _, args in expressions for value in args]
    if op == "ids":
        values = tree.get("values")
        if not isinstance(values, list) or not 1 <= len(values) <= 1000:
            raise HTTPException(400, "Feature ID list exceeds the supported limit")
        keys = sorted({_key(value, table_id) for value in values})
        return "s.object_id IN (" + ", ".join("?" for _ in keys) + ")", keys
    operators = {"eq": "=", "ne": "<>", "lt": "<", "le": "<=", "gt": ">", "ge": ">="}
    column = next((column for column in columns if column["name"] == tree.get("property")), None)
    value = tree.get("value")
    if op not in operators or column is None or not isinstance(value, (str, int, float, bool)) or len(str(value)) > 4096:
        raise HTTPException(400, "Unsupported filter property or operator")
    expression = "s.object_id" if column["physical_name"] is None else "w." + quote(column["physical_name"])
    kind = temporal_kind(column)
    declaration = column["type"].lower().split("(", 1)[0]
    try:
        if kind and kind != "date":
            expression = instant_expression(column, False)
            value = canonical_instant(str(value))
        elif kind == "date":
            value = date.fromisoformat(str(value))
        elif column["physical_name"] is None or declaration in {"bigint", "int", "smallint", "tinyint", "int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64"}:
            value = _key(value, table_id)
        elif declaration in {"bit", "bool", "boolean"}:
            if str(value).lower() not in {"0", "1", "true", "false"}:
                raise ValueError()
            value = str(value).lower() in {"1", "true"}
        elif value_kind(column) == "scalar":
            value = Decimal(str(value))
            if not value.is_finite():
                raise ValueError()
        elif value_kind(column) == "text":
            value = str(value)
        else:
            raise ValueError()
    except (ValueError, InvalidOperation):
        raise HTTPException(400, "Invalid filter value for this property") from None
    return f"{expression} {operators[op]} ?", [value]


class WFSData:
    """Keep bounded query membership and snapshot pins in durable session state."""

    def __init__(self, storage, registry, settings=None):
        self.storage, self.registry = storage, registry
        self.settings = settings or storage.settings

    def _publication(self):
        base = self.registry.current_publication() or {}
        layouts = base.get("lookup_publications")
        if layouts is not None:
            # The primary partitioned lookup serves WFS; a single-file-only
            # publication remains usable without introducing another engine.
            layout = layouts.get("r3") or layouts.get("single-file")
            return {**base, **layout} if layout else {}
        return base

    def layers(self, job=None):
        if job:
            job.check()
        publication = self._publication()
        if publication.get("search_snapshot_id") is None:
            return []
        return [{"name": layer_name(row["id"]), "title": row["name"], "table_id": row["id"],
                 "description": row.get("description") or "", "columns": _columns(publication, row["id"])}
                for row in self.registry.list_datasets()
                if row["status"] != "removing" and row["id"] in publication.get("wide_snapshots", {})]

    def features(self, job, principal_id, name, *, bbox=None, object_ids=None, start_index=0, count=1000,
                 properties=None, result_type="results", filters=None, snapshot=None):
        limits = GisAccess(self.registry).settings()
        if self.storage.local:
            raise HTTPException(503, "WFS requires the primary Trino service")
        if type(start_index) is not int or start_index < 0 or type(count) is not int or not 1 <= count <= limits["page_size"]:
            raise HTTPException(400, "Invalid WFS page size or start index")
        bbox = _bbox(bbox, limits["max_diagonal_m"])
        if object_ids is not None and (not isinstance(object_ids, list) or not 1 <= len(object_ids) <= 1000):
            raise HTTPException(400, "Feature ID list exceeds the supported limit")
        if not isinstance(name, str) or not re.fullmatch(r"az_[0-9a-f]{32}", name):
            raise HTTPException(404, "Unknown feature type")
        table_id = str(UUID(hex=name[3:]))
        ids = sorted({_key(value, table_id) for value in object_ids}) if object_ids else None
        identity = {"layer": name, "bbox": bbox, "ids": ids, "filters": filters, "properties": properties}
        digest = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        with self.registry.read_lease() if job.lease_guard is None else nullcontext():
            if snapshot:
                try:
                    UUID(snapshot)
                except (ValueError, TypeError):
                    raise HTTPException(400, "Invalid WFS snapshot") from None
                state = self.registry.get_session(snapshot)
                if not state or state.get("kind") != "wfs" or state.get("owner_user_id") != principal_id:
                    raise HTTPException(404, "WFS snapshot not found")
                if state.get("digest") != digest:
                    raise HTTPException(400, "WFS snapshot belongs to another query")
            else:
                state = self.registry.find_wfs_session(principal_id, digest)
            if state and (state.get("invalidated") or datetime.fromisoformat(state["expires_at"]) <= datetime.now(timezone.utc)):
                raise HTTPException(410, "WFS snapshot expired or was invalidated; restart the query")
            if not state:
                if start_index:
                    raise HTTPException(410, "WFS snapshot expired; restart the query")
                layer = next((layer for layer in self.layers(job) if layer["name"] == name), None)
                if layer is None:
                    raise HTTPException(404, "Unknown feature type")
                if bbox is None and not ids and not self._has_ids(filters):
                    if result_type == "hits" and not filters:
                        return {"items": [], "total": None, "snapshot": None, "columns": layer["columns"], "layer": name, "next_start": None}
                    raise HTTPException(400, "A bounded BBOX or feature ID selection is required")
                publication = self._publication()
                columns = _columns(publication, table_id)
                self._select_columns(columns, properties)
                rows = self._matching(job, publication, table_id, bbox, ids, filters, columns, limits)
                publication = {**publication, **{key: {table_id: publication[key][table_id]} if table_id in publication[key] else {}
                               for key in ("wide_snapshots", "columns", "wide_table_names", "counts", "dataset_sources")
                               if key in publication}}
                publication.pop("lookup_publications", None)
                state = {"id": str(uuid4()), "kind": "wfs", "owner_user_id": principal_id, "digest": digest,
                         "publication": publication, "query": {"dataset_ids": [table_id]}, "points": rows,
                         "expires_at": (datetime.now(timezone.utc) + timedelta(seconds=limits.get("paging_ttl_sec", 300))).isoformat()}
                if len(rows) > count:
                    state = self.registry.save_wfs_session(state, maximum=limits.get("max_paging_sessions", 256),
                                                           per_owner=limits.get("max_paging_sessions_per_user", 8))
                else:
                    # Completed viewport requests retain no paging allocation.
                    state["id"] = None
            columns = _columns(state["publication"], table_id)
            selected = self._select_columns(columns, properties)
            total = len(state["points"])
            if total > limits["max_features"]:
                raise HTTPException(400, "Query exceeds the configured feature limit; narrow the selection")
            page = state["points"][start_index:start_index + count] if result_type != "hits" else []
            items = self._hydrate(job, state["publication"], table_id, page, selected, limits) if page else []
            job.check()
            return {"items": items, "total": total, "snapshot": state["id"], "columns": columns, "layer": name,
                    "next_start": start_index + len(items) if result_type != "hits" and start_index + len(items) < total else None}

    @staticmethod
    def _has_ids(tree):
        # OR with any unbounded branch does not create a bounded ID selection.
        if not isinstance(tree, dict):
            return False
        if tree.get("op") == "ids":
            return True
        args = tree.get("args") or []
        if tree.get("op") == "and":
            return any(WFSData._has_ids(part) for part in args)
        return tree.get("op") == "or" and bool(args) and all(WFSData._has_ids(part) for part in args)

    @staticmethod
    def _select_columns(columns, properties):
        if properties is None:
            return columns
        if not isinstance(properties, list) or any(name not in {column["name"] for column in columns} for name in properties):
            raise HTTPException(400, "Unknown requested property")
        return [column for column in columns if column["name"] in properties]

    def _matching(self, job, publication, table_id, bbox, ids, filters, columns, limits):
        from h3search.etl.layout import search_name
        name = publication.get("search_table_name", search_name)
        use_h3 = name == search_name or bool(re.fullmatch(r"search_r3_[0-9a-f]{32}", name))
        if not use_h3 and name != SINGLE_FILE_SEARCH_TABLE and not re.fullmatch(r"search_single_[0-9a-f]{32}", name):
            raise HTTPException(503, "Published lookup is unavailable")
        source = self.storage.relation(name, publication["search_snapshot_id"])
        conditions, values = ["s.table_id = ?"], [table_id]
        if bbox is not None:
            west, south, east, north = bbox
            conditions += ["s.lat BETWEEN ? AND ?", "s.lon BETWEEN ? AND ?"]
            values += [south, north, west, east]
            resolution = 3 if name.startswith("search_r3_") else self.settings.partition_resolution
            cells, _ = partition_cover([bbox], resolution) if use_h3 else ((), None)
            if cells:
                conditions.append(f"s.h3_r{resolution} IN (" + ", ".join("?" for _ in cells) + ")")
                values += list(cells)
        if ids:
            conditions.append("s.object_id IN (" + ", ".join("?" for _ in ids) + ")")
            values += ids
        join, args = "", list(source.args)
        if filters:
            predicate, predicate_values = _predicate(filters, columns, table_id)
            wide = self.storage.relation(_wide_name(publication, table_id), publication["wide_snapshots"][table_id])
            join = f" JOIN {wide.sql} w ON w.table_id=s.table_id AND w.object_id=s.object_id"
            args += list(wide.args)
            conditions.append(predicate)
            values += predicate_values
        maximum = limits["max_features"]
        sql = f"SELECT s.object_id,s.lon,s.lat FROM {source.sql} s{join} WHERE " + " AND ".join(conditions)
        sql += f" LIMIT {maximum + 1}"
        rows = self.storage.query(job, "wfs_membership", sql, (*args, *values), maximum + 1)
        if len(rows) > maximum:
            raise HTTPException(400, "Query exceeds the configured feature limit; narrow the selection")
        if len({row[0] for row in rows}) != len(rows):
            raise RuntimeError("Published lookup contains duplicate feature IDs")
        return [list(row) for row in sorted(rows, key=lambda row: row[0])]

    def _hydrate(self, job, publication, table_id, points, columns, limits):
        source_columns = [column for column in columns if column["physical_name"] is not None]
        values = {}
        if source_columns:
            source = self.storage.relation(_wide_name(publication, table_id), publication["wide_snapshots"][table_id])
            keys = [row[0] for row in points]
            base = 512 + sum(len(column["name"].encode()) * 6 + 192 for column in columns)
            budget = limits["max_response_bytes"] // max(1, len(points)) - 1024
            costs = []
            for column in source_columns:
                kind = value_kind(column)
                if kind != "scalar":
                    name = quote(column["physical_name"])
                    costs.append(f"coalesce(length({name}), 0) * {2 if kind == 'binary' else 6}")
            fits = f"({base}" + "".join(" + " + cost for cost in costs) + f") <= {budget}"
            projections = [f"CASE WHEN {fits} THEN {quote(column['physical_name'])} ELSE NULL END" for column in source_columns]
            sql = f"SELECT object_id,{fits} AS fits," + ",".join(projections)
            sql += f" FROM {source.sql} WHERE table_id=? AND object_id IN (" + ",".join("?" for _ in keys) + f") LIMIT {len(keys) + 1}"
            rows = self.storage.query(job, "wfs_attributes", sql, (*source.args, table_id, *keys), len(keys))
            for key, fits_value, *row in rows:
                if not fits_value:
                    raise HTTPException(413, "Complete attributes exceed the response budget; request fewer properties or a smaller page")
                if key in values:
                    raise RuntimeError("Published wide table contains duplicate feature IDs")
                values[key] = {column["name"]: source_value(value) for column, value in zip(source_columns, row, strict=True)}
            if set(values) != set(keys):
                raise RuntimeError("Frozen lookup and wide snapshots disagree")
        result = []
        for key, longitude, latitude in points:
            attributes = values.get(key, {})
            if any(column["physical_name"] is None for column in columns):
                attributes = {"object_id": str(key), **attributes}
            result.append({"id": feature_id(table_id, key), "longitude": longitude, "latitude": latitude, "properties": attributes})
        if len(json.dumps(result, ensure_ascii=False).encode()) > limits["max_response_bytes"]:
            raise HTTPException(413, "Complete attributes exceed the response budget; request a smaller page")
        return result
