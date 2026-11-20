"""Exact snapshot search, bounded paging, and lazy wide record hydration."""

import base64
import hashlib
import json
import logging
import math
import re
from datetime import date, datetime, time
from decimal import Decimal
from uuid import UUID

from fastapi import HTTPException
from h3search.control import SINGLE_FILE_SEARCH_TABLE
from h3search.geo import EARTH_RADIUS_M, circle_bounds

from .models import decode_cursor, decode_point_cursor, encode_cursor, encode_point_cursor
from .pruning import fine_join_cover, partition_cover
from .storage import Relation, quote
from .wide import length_unit, size_plan, slice_projection, value_kind
from .temporal import day_expression, instant_expression, temporal_kind

LOG = logging.getLogger(__name__)
THIN = "table_id, object_id, h3_r15, lat, lon, distance_m"
KEY_ORDER = "table_id, object_id"
INITIAL_CANDIDATE_BUDGET = 32_768
MAP_POINT_CHUNK_ROWS = 1_000
MAP_CELL_HASH = "mod(cell_x * 73856093 + cell_y * 19349663, 2147483647)"


def _wide_name(publication, table_id):
    from h3search.etl.layout import wide_name

    base = wide_name(table_id)
    if "wide_table_names" not in publication:
        return base
    name = publication["wide_table_names"][table_id]
    if name != base and not re.fullmatch(base + r"_[0-9a-f]{32}", name):
        raise ValueError("Invalid published wide table")
    return name


def thin_row(row):
    """Serialize one point with its full key and 64-bit values as strings."""
    table, object_id, h3, latitude, longitude, distance = row
    return {
        "table_id": table, "object_id": str(object_id), "h3": str(h3),
        "latitude": latitude, "longitude": longitude, "distance_m": distance,
    }


def source_value(value):
    """Preserve non-native and large database values in JSON-safe forms."""
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, int) and abs(value) > 2**53 - 1:
        return str(value)
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if isinstance(value, (Decimal, UUID)):
        return str(value)
    if isinstance(value, (date, datetime, time)):
        return value.isoformat()
    if isinstance(value, (bytes, bytearray, memoryview)):
        return base64.b64encode(value).decode("ascii")
    return value


def _interval(column, low, high):
    if low > high:
        return f"({column} >= ? OR {column} <= ?)", (low, high)
    return f"{column} BETWEEN ? AND ?", (low, high)


class Search:
    """Apply exact circle membership and stable ordering to frozen relations."""

    def __init__(self, storage):
        self.storage = storage

    def _matching(self, job, session, table_id=None, key=None, after=None, viewport=None, overlap=None, dataset_ids=None):
        spatial = self._spatial_matching(job, session, table_id, key, after, viewport, overlap, dataset_ids)
        bounds = session["query"].get("time_filter")
        if not bounds:
            return spatial

        selected = session["query"]["dataset_ids"] if dataset_ids is None else dataset_ids
        if table_id is not None:
            selected = [table_id]
        unions, args = [], list(spatial.args)
        for table in selected:
            column = session["query"].get("datetime_columns", {}).get(table)
            if column is None:
                continue
            wide = self.storage.relation(_wide_name(session["publication"], table), session["publication"]["wide_snapshots"][table], [column["physical_name"]])
            day = day_expression(column, self.storage.local)
            conditions = ["w.table_id = ?"]
            values = [table]
            if bounds.get("start_at") or bounds.get("end_at"):
                instant = instant_expression(column, self.storage.local)
                for name, operator in (("start_at", ">="), ("end_at", "<=")):
                    if bounds.get(name):
                        conditions.append(f"{instant} {operator} ?")
                        values.append(bounds[name])
            for name, operator in (("start_date", ">="), ("end_date", "<=")):
                if bounds.get(name):
                    bound = "CAST(? AS DATE)" if temporal_kind(column) == "date" else "?"
                    conditions.append(f"{day} {operator} {bound}")
                    values.append(bounds[name])
            unions.append(f"SELECT w.table_id, w.object_id FROM {wide.sql} w WHERE " + " AND ".join(conditions))
            args.extend((*wide.args, *values))
        # Every result consumer uses this same final membership relation.
        sql = spatial.sql + ", spatial_matches AS (SELECT * FROM matches), temporal_keys AS ("
        sql += " UNION ALL ".join(unions) if unions else "SELECT table_id, object_id FROM spatial_matches WHERE FALSE"
        sql += ")"
        # Rename only the original CTE, leaving the final result relation named matches.
        sql = sql.replace("matches AS (", "unfiltered_matches AS (", 1)
        sql = sql.replace("spatial_matches AS (SELECT * FROM matches)", "spatial_matches AS (SELECT * FROM unfiltered_matches)")
        return Relation(sql + ", matches AS (SELECT m.* FROM temporal_keys t JOIN spatial_matches m "
                        "ON m.table_id = t.table_id AND m.object_id = t.object_id)", tuple(args))

    def _spatial_matching(self, job, session, table_id=None, key=None, after=None, viewport=None, overlap=None, dataset_ids=None):
        query, publication = session["query"], session["publication"]
        datasets = query["dataset_ids"] if dataset_ids is None else dataset_ids
        if table_id:
            datasets = [table_id]
        if not datasets or publication["search_snapshot_id"] is None:
            return Relation("WITH matches AS (SELECT CAST(NULL AS VARCHAR) AS table_id, "
                            "CAST(NULL AS BIGINT) AS object_id, CAST(NULL AS BIGINT) AS h3_r15, "
                            "CAST(NULL AS DOUBLE) AS lat, CAST(NULL AS DOUBLE) AS lon, "
                            "CAST(NULL AS DOUBLE) AS distance_m WHERE FALSE)")

        from h3search.etl.layout import search_name

        table_name = publication.get("search_table_name", search_name)
        use_h3 = table_name == search_name or bool(re.fullmatch(r"search_r3_[0-9a-f]{32}", table_name))
        if not use_h3 and table_name != SINGLE_FILE_SEARCH_TABLE and not re.fullmatch(r"search_single_[0-9a-f]{32}", table_name):
            raise ValueError("Invalid published search table")
        source = self.storage.relation(table_name, publication["search_snapshot_id"])
        resolution = 3 if table_name.startswith("search_r3_") else self.storage.settings.partition_resolution
        if query.get("centers"):
            return self._multi_matching(job, query, source, datasets, key, after, viewport, overlap, resolution=resolution, use_h3=use_h3)
        latitude, longitude, radius = query["latitude"], query["longitude"], query["radius_m"]
        bounds = circle_bounds(latitude, longitude, radius)
        _, south, _, north = bounds[0]
        placeholders = ", ".join("?" for _ in datasets)
        filters = [f"table_id IN ({placeholders})", "lat BETWEEN ? AND ?"]
        args = [*datasets, south, north]
        if len(bounds) != 1 or (bounds[0][0], bounds[0][2]) != (-180.0, 180.0):
            filters.append("(" + " OR ".join("lon BETWEEN ? AND ?" for _ in bounds) + ")")
            args.extend(value for west, _, east, _ in bounds for value in (west, east))
        if use_h3:
            cells, plan = partition_cover(bounds, resolution)
            LOG.debug("request_id=%s partition_resolution=%s cover_plan=%s cover_cells=%s",
                      job.request_id, resolution, plan, len(cells))
            if cells:
                filters.append(f"h3_r{resolution} IN ({', '.join('?' for _ in cells)})")
                args.extend(cells)
        if key is not None:
            filters.append("object_id = ?")
            args.append(key)
        if after is not None:
            filters.append("(table_id > ? OR (table_id = ? AND object_id > ?))")
            args.extend((after[0], after[0], after[1]))
        if viewport is not None:
            west, south, east, north = viewport
            condition, values = _interval("lon", west, east)
            filters.extend(("lat BETWEEN ? AND ?", condition))
            args.extend((south, north, *values))
        if overlap is not None:
            filters.extend(("lat = ?", "lon = ?"))
            args.extend(overlap)

        # Wrapping the shortest longitude difference also makes +180 and -180 coincident.
        # At a pole, the cosine factor is identically zero.
        lon_delta = "radians(CASE WHEN abs(lon - ?) <= 180.0 THEN lon - ? ELSE 360.0 - abs(lon - ?) END)"
        lat_cos = "CASE WHEN abs(lat) = 90 THEN 0.0 ELSE cos(radians(lat)) END"
        center_cos = 0.0 if abs(latitude) == 90 else math.cos(math.radians(latitude))
        hav = f"power(sin((radians(lat) - ?) / 2), 2) + ({lat_cos}) * ? * power(sin({lon_delta} / 2), 2)"
        distance = f"{2 * EARTH_RADIUS_M} * asin(sqrt(least(1.0, greatest(0.0, {hav}))))"
        sql = (
            f"WITH measured AS (SELECT table_id, object_id, h3_r15, lat, lon, {distance} AS distance_m "
            f"FROM {source.sql} WHERE {' AND '.join(filters)}), "
            "matches AS (SELECT * FROM measured WHERE distance_m <= ?)"
        )
        return Relation(sql, (math.radians(latitude), center_cos, longitude, longitude, longitude,
                              *source.args, *args, radius))

    def _multi_matching(self, job, query, source, datasets, key, after, viewport, overlap, *, resolution=None, use_h3=True, use_fine=True):
        if resolution is None:
            resolution = self.storage.settings.partition_resolution
        fine_resolution = self.storage.settings.multi_center_join_resolution
        plans = []
        coarse_cells = set()
        fine_associations = 0
        fine = (use_h3 and use_fine and resolution < fine_resolution <= 9
                and query["radius_m"] <= self.storage.settings.multi_center_fine_max_radius_m)
        for center in query["centers"]:
            bounds = circle_bounds(center["latitude"], center["longitude"], query["radius_m"])
            coarse, _ = partition_cover(bounds, resolution) if use_h3 else ((), None)
            cells = fine_join_cover(bounds, fine_resolution) if fine else ()
            fine_associations += len(cells)
            if fine and (not cells or not coarse or fine_associations > self.storage.settings.max_search_candidate_pairs
                         or any(type(cell) is not int or not 0 < cell < 2**63 for cell in coarse)):
                fine = False
            coarse_cells.update(coarse)
            plans.append((bounds, coarse, cells))
        join_resolution = fine_resolution if fine else resolution
        covered, fallback, associations, all_cells = [], [], [], set()
        budget = self.storage.settings.max_search_candidate_pairs
        for center_index, center in enumerate(query["centers"]):
            latitude, longitude = center["latitude"], center["longitude"]
            bounds, coarse, fine_cells = plans[center_index]
            cells = fine_cells if fine else coarse
            base = (latitude, longitude, math.radians(latitude),
                    0.0 if abs(latitude) == 90 else math.cos(math.radians(latitude)))
            for west, south, east, north in bounds:
                if cells:
                    covered.append((center_index, *base, south, north, west, east))
                else:
                    fallback.append((*base, south, north, west, east))
            if cells:
                associations.extend((center_index, cell) for cell in cells)
                all_cells.update(cells)
            if len(associations) + len(fallback) > budget:
                if fine:
                    return self._multi_matching(job, query, source, datasets, key, after, viewport, overlap, resolution=resolution, use_h3=use_h3, use_fine=False)
                raise HTTPException(422, "Search exceeds the configured candidate relation limit; reduce centers or radius")
        filters = ["s.table_id IN (" + ", ".join("?" for _ in datasets) + ")"]
        filter_args = list(datasets)
        if not use_h3:
            # Static bounds let the file reader prune row groups before the center join.
            south, north, west, east = zip(*(row[4:] for row in fallback), strict=True)
            filters.extend(("s.lat BETWEEN ? AND ?", "s.lon BETWEEN ? AND ?"))
            filter_args.extend((min(south), max(north), min(west), max(east)))
        if key is not None:
            filters.append("s.object_id = ?")
            filter_args.append(key)
        if after is not None:
            filters.append("(s.table_id > ? OR (s.table_id = ? AND s.object_id > ?))")
            filter_args.extend((after[0], after[0], after[1]))
        if viewport is not None:
            west, south, east, north = viewport
            condition, values = _interval("s.lon", west, east)
            filters.extend(("s.lat BETWEEN ? AND ?", condition))
            filter_args.extend((south, north, *values))
        if overlap is not None:
            filters.extend(("s.lat = ?", "s.lon = ?"))
            filter_args.extend(overlap)
        names = "center_lat, center_lon, center_radians, center_cos, south, north, west, east"
        ctes, branches, args = [], [], []
        for label, rows, has_cells in (("covered_centers", covered, True), ("fallback_centers", fallback, False)):
            if not rows:
                continue
            fields = ("center_id, " if has_cells else "") + names
            ctes.append(f"{label} ({fields}) AS (VALUES " + ", ".join("(" + ", ".join("?" for _ in row) + ")" for row in rows) + ")")
            args.extend(value for row in rows for value in row)
        if associations:
            ctes.append("center_cells (center_id, cell) AS (VALUES " + ", ".join("(?, ?)" for _ in associations) + ")")
            args.extend(value for row in associations for value in row)
        for label, rows, has_cells in (("covered_centers", covered, True), ("fallback_centers", fallback, False)):
            if not rows:
                continue
            join = ["s.lat BETWEEN c.south AND c.north", "s.lon BETWEEN c.west AND c.east"]
            branch_filters = list(filters)
            if has_cells:
                join.insert(0, "p.center_id = c.center_id")
                if fine:
                    # Only generated integer H3 IDs enter these literals. Keeping
                    # the independent coarse predicate visible preserves physical
                    # partition pruning while the finer equijoin reduces pairs.
                    branch_filters.append(f"s.h3_r{resolution} IN (" + ", ".join(map(str, sorted(coarse_cells))) + ")")
                else:
                    branch_filters.append(f"s.h3_r{resolution} IN (" + ", ".join("?" for _ in all_cells) + ")")
            source_join = f"JOIN center_cells p ON s.h3_r{join_resolution} = p.cell " if has_cells else ""
            branches.append(f"SELECT s.table_id, s.object_id, s.h3_r15, s.lat, s.lon, "
                            "c.center_lon, c.center_radians, c.center_cos "
                            f"FROM {source.sql} s {source_join}JOIN {label} c ON {' AND '.join(join)} WHERE {' AND '.join(branch_filters)}")
            args.extend((*source.args, *filter_args, *(sorted(all_cells) if has_cells and not fine else ())))
        ctes.append("candidates AS (" + " UNION ALL ".join(branches) + ")")
        delta = "radians(CASE WHEN abs(lon - center_lon) <= 180.0 THEN lon - center_lon ELSE 360.0 - abs(lon - center_lon) END)"
        lat_cos = "CASE WHEN abs(lat) = 90 THEN 0.0 ELSE cos(radians(lat)) END"
        hav = f"power(sin((radians(lat) - center_radians) / 2), 2) + ({lat_cos}) * center_cos * power(sin({delta} / 2), 2)"
        distance = f"{2 * EARTH_RADIUS_M} * asin(sqrt(least(1.0, greatest(0.0, {hav}))))"
        ctes.extend((f"measured AS (SELECT table_id, object_id, h3_r15, lat, lon, {distance} AS distance_m FROM candidates)",
                     "matches AS (SELECT table_id, object_id, h3_r15, lat, lon, min(distance_m) AS distance_m "
                     "FROM measured WHERE distance_m <= ? GROUP BY table_id, object_id, h3_r15, lat, lon)"))
        sql = "WITH " + ", ".join(ctes)
        bound = (*args, query["radius_m"])
        estimated_bytes = 4096 + 2 * len(sql.encode("utf-8")) + sum(len(str(value).replace("'", "''").encode("utf-8")) + 16 for value in bound)
        if getattr(self.storage, "local", False):
            # Local Parquet path inventories are bound source metadata, not
            # uploaded centers or a Trino prepared-statement payload.
            estimated_bytes -= len(branches) * sum(len(str(value).replace("'", "''").encode("utf-8")) + 16 for value in source.args)
        if estimated_bytes > self.storage.settings.max_search_query_bytes:
            if fine:
                return self._multi_matching(job, query, source, datasets, key, after, viewport, overlap, resolution=resolution, use_h3=use_h3, use_fine=False)
            raise HTTPException(422, "Search exceeds the configured query size limit; reduce centers or radius")
        return Relation(sql, bound)

    def counts(self, job, session):
        """Count exact matches by dataset without loading individual matches."""
        matching = self._matching(job, session)
        rows = self.storage.query(job, "search_count", matching.sql + " SELECT table_id, count(*) FROM matches GROUP BY table_id",
                                  matching.args, len(session["query"]["dataset_ids"]))
        return {table: count for table, count in rows}

    def initial(self, job, session, limit):
        """Count all matches and fetch the first page in one bounded scan."""
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError("Initial page size must be an integer from 1 to 100")
        datasets = session["query"]["dataset_ids"]
        empty_page = {"items": [], "next_cursor": None}
        if not datasets:
            return {}, empty_page
        per_dataset = limit + 1
        if len(datasets) * per_dataset > INITIAL_CANDIDATE_BUDGET:
            counts = self.counts(job, session)
            return counts, self.page(job, session, limit) if counts else empty_page

        matching = self._matching(job, session)
        sql = (
            matching.sql + " SELECT table_id, count(*), "
            f"min_by(ROW(object_id, h3_r15, lat, lon, distance_m), object_id, {per_dataset}) "
            "FROM matches GROUP BY table_id ORDER BY table_id"
        )
        rows = self.storage.query(job, "search_initial", sql, matching.args, len(datasets))
        selected = set(datasets)
        counts = {}
        candidates = []
        for row in rows:
            if not isinstance(row, (list, tuple)) or len(row) != 3:
                raise RuntimeError("Storage returned an invalid initial search group")
            table, count, points = row
            if (not isinstance(table, str) or table not in selected or table in counts
                    or type(count) is not int or count <= 0
                    or not isinstance(points, (list, tuple)) or len(points) != min(count, per_dataset)):
                raise RuntimeError("Storage returned invalid initial search counts or candidates")
            counts[table] = count
            object_ids = set()
            for point in points:
                if (not isinstance(point, (list, tuple)) or len(point) != 5
                        or type(point[0]) is not int or type(point[1]) is not int
                        or point[0] in object_ids
                        or any(type(value) is not float or not math.isfinite(value) for value in point[2:])):
                    raise RuntimeError("Storage returned an invalid initial search point")
                object_ids.add(point[0])
                candidates.append((table, *point))

        # A global prefix of N rows can contain at most N rows from each dataset.
        candidates.sort(key=lambda row: row[:2])
        next_cursor = encode_cursor(session, ["rows"], candidates[limit - 1][:2]) if len(candidates) > limit else None
        return counts, {"items": [thin_row(row) for row in candidates[:limit]], "next_cursor": next_cursor}

    def page(self, job, session, limit, cursor=None, table_id=None, overlap=None, projection=None):
        """Retrieve a stable, bounded page and a scope-bound continuation token."""
        scope = ["table", table_id] if table_id else ["overlap", *overlap] if overlap else ["rows"]
        if projection is not None:
            scope.append(projection)
        after = decode_cursor(session, scope, cursor)
        matching = self._matching(job, session, table_id=table_id, after=after, overlap=overlap)
        sql = matching.sql + f" SELECT {THIN} FROM matches ORDER BY {KEY_ORDER} LIMIT {limit + 1}"
        rows = self.storage.query(job, "search_page", sql, matching.args, limit + 1)
        next_cursor = encode_cursor(session, scope, rows[limit - 1][:2]) if len(rows) > limit else None
        return {"items": [thin_row(row) for row in rows[:limit]], "next_cursor": next_cursor}

    def export_chunks(self, job, session):
        """Stream ordered matching points in fixed-size batches from one snapshot query."""
        matching = self._matching(job, session)
        sql = matching.sql + f" SELECT {THIN} FROM matches ORDER BY {KEY_ORDER}"
        with self.storage.cursor(job, "search_export", sql, matching.args) as cursor:
            while rows := cursor.fetchmany(100):
                job.check()
                yield [thin_row(row) for row in rows]

    def export_wide_chunks(self, job, session, table_id):
        """Stream complete frozen feature values without table column preferences.

        A SQL-side size guard rejects an oversized row before its variable-width
        values enter the client. No shortened values are accepted by an export.
        """

        self.check_table(session, table_id)
        layout = session["publication"]["columns"][table_id]
        settings = self.storage.settings
        matching = self._matching(job, session, table_id=table_id)
        wide = self.storage.relation(_wide_name(session["publication"], table_id), session["publication"]["wide_snapshots"][table_id],
                                     [column["physical_name"] for column in layout])
        costs = []
        for column in layout:
            kind = value_kind(column)
            name = "w." + quote(column["physical_name"])
            if kind != "scalar":
                length = f"octet_length({name})" if kind == "binary" and self.storage.local else f"length({name})"
                # Text may need six wire bytes per character; binary becomes base64.
                costs.append(f"coalesce({length}, 0) * {2 if kind == 'binary' else 6}")
        base = 512 + sum(len(column["name"].encode("utf-8")) * 6 + 128 for column in layout)
        fits = f"({base}" + "".join(" + " + cost for cost in costs) + f") <= {settings.export_row_budget_bytes}"
        values = [f"CASE WHEN w.__export_fits THEN w.{quote(column['physical_name'])} ELSE NULL END" for column in layout]
        selection = ", ".join((*("m." + name for name in THIN.split(", ")), "w.object_id", "w.__export_fits", *values))
        sql = matching.sql + f", export_wide AS (SELECT w.*, {fits} AS __export_fits FROM {wide.sql} w)"
        sql += f" SELECT {selection} FROM export_wide w JOIN matches m "
        sql += "ON m.table_id = w.table_id AND m.object_id = w.object_id ORDER BY m.object_id"
        seen, previous = 0, None
        object_column = session["query"]["object_columns"][table_id]
        with self.storage.cursor(job, "wide_export", sql, (*matching.args, *wide.args)) as cursor:
            while rows := cursor.fetchmany(settings.export_batch_rows):
                job.verify_lease()
                batch = []
                for raw in rows:
                    point, wide_key, fits, values = raw[:6], raw[6], raw[7], raw[8:]
                    key = point[1]
                    if wide_key != key or previous is not None and key <= previous:
                        raise RuntimeError("Frozen search and wide snapshots disagree")
                    if not fits:
                        raise HTTPException(413, "A record exceeds export_row_budget_bytes; increase the configured export row budget")
                    previous = key
                    attributes = {column["name"]: str(key) if column["name"] == object_column else source_value(value)
                                  for column, value in zip(layout, values, strict=True)}
                    batch.append({**thin_row(point), "attributes": attributes})
                    seen += 1
                yield batch
        if seen != session["query"]["counts"].get(table_id, 0):
            raise RuntimeError("Frozen export count does not match the search")

    def export_key_chunks(self, job, session, table_id):
        """Stream the exact frozen selection once, without hydrating wide values."""
        self.check_table(session, table_id)
        matching = self._matching(job, session, table_id=table_id)
        sql = matching.sql + f" SELECT {THIN} FROM matches ORDER BY object_id"
        seen, previous = 0, None
        with self.storage.cursor(job, "export_keys", sql, matching.args) as cursor:
            while values := cursor.fetchmany(self.storage.settings.export_sql_batch_rows):
                job.verify_lease()
                batch = []
                for raw in values:
                    key = raw[1]
                    if previous is not None and key <= previous:
                        raise RuntimeError("Frozen lookup contains duplicate or unordered keys")
                    previous = key
                    batch.append(thin_row(raw))
                    seen += 1
                yield batch
        if seen != session["query"]["counts"].get(table_id, 0):
            raise RuntimeError("Frozen export count does not match the search")

    def _known_viewport_count(self, session, viewport, dataset_ids):
        """Reuse frozen circle counts only when every conservative bound is visible."""
        threshold = self.storage.settings.map_known_count_min_rows
        counts = session["query"].get("counts")
        if not threshold or not isinstance(counts, dict) or any(
            type(value) is not int or value < 0 for value in counts.values()
        ):
            return None
        selected = session["query"]["dataset_ids"] if dataset_ids is None else dataset_ids
        total = sum(counts.get(table, 0) for table in set(selected))
        if not threshold <= total < 1 << 63:
            return None
        west, south, east, north = viewport
        intervals = [(west, east)] if west <= east else [(west, 180.0), (-180.0, east)]
        query = session["query"]
        centers = query.get("centers") or [{"latitude": query["latitude"], "longitude": query["longitude"]}]
        bounds = [bound for center in centers for bound in circle_bounds(center["latitude"], center["longitude"], query["radius_m"])]
        if any(not (south <= low and high <= north and any(
            left <= bound_west and bound_east <= right for left, right in intervals
        )) for bound_west, low, bound_east, high in bounds):
            return None
        return total

    @staticmethod
    def _ranked_points(matching, grid_zoom, known_count):
        count_sql = "count(*) OVER ()" if known_count is None else "CAST(? AS BIGINT)"
        # Bin in world coordinates to keep the sample stable during small pans.
        width = 360.0 / 2 ** (grid_zoom + 4)
        sql = matching.sql + (
            ", grid AS (SELECT *, CAST(floor((lon + 180.0) / ?) AS BIGINT) AS cell_x, "
            "CAST(floor((lat + 90.0) / ?) AS BIGINT) AS cell_y FROM matches), "
            f"ranked AS (SELECT *, {count_sql} AS matched_total, "
            f"row_number() OVER (PARTITION BY cell_x, cell_y ORDER BY {KEY_ORDER}) AS cell_rank FROM grid)"
        )
        args = (*matching.args, width, width) + (() if known_count is None else (known_count,))
        return Relation(sql, args)

    def points(self, job, session, viewport, zoom, limit, dataset_ids=None):
        """Select real points by round-robin rank across zoom-dependent grid cells."""
        if dataset_ids is not None:
            for table_id in dataset_ids:
                self.check_table(session, table_id)
        matching = self._matching(job, session, viewport=viewport, dataset_ids=dataset_ids)
        known_count = self._known_viewport_count(session, viewport, dataset_ids)
        ranked = self._ranked_points(matching, math.floor(zoom), known_count)
        sql = ranked.sql + (f" SELECT {THIN}, matched_total FROM ranked "
                            f"ORDER BY cell_rank, {MAP_CELL_HASH}, {KEY_ORDER} LIMIT {limit}")
        rows = self.storage.query(job, "map_points", sql, ranked.args, limit)
        total = rows[0][-1] if rows else 0
        return {"items": [thin_row(row[:-1]) for row in rows], "matched_total": total,
                "returned": len(rows), "truncated": len(rows) < total}

    def stream_points(self, job, session, viewport, zoom, limit, dataset_ids, token, emit):
        """Emit bounded batches from one cursor and return the verified final position."""
        selected = sorted(set(session["query"]["dataset_ids"] if dataset_ids is None else dataset_ids))
        for table_id in selected:
            self.check_table(session, table_id)
        grid_zoom = math.floor(zoom)
        selection_hash = hashlib.sha256(json.dumps(selected, separators=(",", ":")).encode()).hexdigest()
        scope = ["points", list(viewport), grid_zoom, selection_hash]
        if token is None:
            after, total, returned = None, self._known_viewport_count(session, viewport, selected), 0
        else:
            after, total, returned = decode_point_cursor(session, scope, token)
        limit = min(limit, self.storage.settings.max_map_points - returned)
        if total is not None:
            limit = min(limit, total - returned)
        target = returned + limit
        if limit > 0:
            matching = self._matching(job, session, viewport=viewport, dataset_ids=selected)
            ranked = self._ranked_points(matching, grid_zoom, total)
            sql = ranked.sql + (f", point_order AS (SELECT *, {MAP_CELL_HASH} AS cell_hash FROM ranked) "
                                f"SELECT {THIN}, matched_total, cell_rank, cell_hash FROM point_order")
            args = ranked.args
            if after is not None:
                rank, cell_hash, table, key = after
                # Applying the keyset after ranking keeps the positions of the remaining points stable.
                sql += (" WHERE cell_rank > ? OR (cell_rank = ? AND (cell_hash > ? OR "
                        "(cell_hash = ? AND (table_id > ? OR (table_id = ? AND object_id > ?)))))")
                args += (rank, rank, cell_hash, cell_hash, table, table, key)
            sql += f" ORDER BY cell_rank, cell_hash, {KEY_ORDER} LIMIT {limit}"
            with self.storage.cursor(job, "map_points_stream", sql, args) as cursor:
                while returned < target:
                    rows = cursor.fetchmany(min(MAP_POINT_CHUNK_ROWS, target - returned))
                    if not rows:
                        break
                    job.verify_lease()
                    total = rows[0][6]
                    returned += len(rows)
                    table, key = rows[-1][:2]
                    rank, cell_hash = rows[-1][-2:]
                    token = encode_point_cursor(session, scope, (rank, cell_hash, table, key), total, returned)
                    emit({"type": "chunk", "items": [thin_row(row[:6]) for row in rows],
                          "matched_total": total, "returned": returned, "next_cursor": token})
            if total is not None and returned != min(target, total):
                raise RuntimeError("Frozen viewport count does not match the points streamed")
        return {"type": "done", "matched_total": total or 0, "returned": returned, "next_cursor": token}

    @staticmethod
    def check_table(session, table_id):
        """Reject a dataset outside the immutable search selection."""
        if table_id not in session["query"]["dataset_ids"]:
            raise HTTPException(404, "Dataset is outside this search")

    def _wide(self, job, session, table_id, keys, preview, columns):

        publication = session["publication"]
        snapshot = publication["wide_snapshots"][table_id]
        public_columns = [{"name": column["name"], "type": column["type"]} for column in columns]
        if not keys:
            return snapshot, public_columns, {}
        source = self.storage.relation(_wide_name(session["publication"], table_id), snapshot, [column["physical_name"] for column in columns])
        kinds = [value_kind(column) for column in columns]
        expressions = ["object_id"]
        for column, kind in zip(columns, kinds, strict=True):
            if kind == "scalar":
                expressions.append(quote(column["physical_name"]))
            else:
                expressions.extend(slice_projection(column, kind, self.storage.local, 0, preview))
        selection = ", ".join(expressions)
        placeholders = ", ".join("?" for _ in keys)
        sql = f"SELECT {selection} FROM {source.sql} WHERE table_id = ? AND object_id IN ({placeholders}) LIMIT {len(keys) + 1}"
        rows = self.storage.query(job, "wide_records", sql, (*source.args, table_id, *keys), len(keys))
        data = {}
        object_column = session["query"]["object_columns"][table_id]
        for key, *values in rows:
            attributes, truncated = {}, {}
            value_iter = iter(values)
            for column, kind in zip(columns, kinds, strict=True):
                name = column["name"]
                value = next(value_iter)
                attributes[name] = str(key) if name == object_column else source_value(value)
                if kind != "scalar":
                    length = next(value_iter)
                    if length is not None and length > preview:
                        truncated[name] = {"length": length, "unit": length_unit(kind)}
            data[str(key)] = (attributes, truncated)
        if set(data) != {str(key) for key in keys} or len(data) != len(rows):
            raise RuntimeError("Frozen search and wide snapshots disagree")
        return snapshot, public_columns, data

    def table_page(self, job, session, table_id, limit, cursor, hidden_columns=()):
        """Hydrate up to 100 matching keys in one wide query."""
        self.check_table(session, table_id)
        layout = session["publication"]["columns"][table_id]
        hidden_columns = set(hidden_columns)
        selected = [column for column in layout if f"source:{column['name']}" not in hidden_columns]
        limit, preview = size_plan(self.storage.settings, selected, limit, headers=layout)
        projection = None
        if selected != layout:
            names = json.dumps([column["name"] for column in selected]).encode()
            projection = hashlib.sha256(names).hexdigest()
        page = self.page(job, session, limit, cursor, table_id=table_id, projection=projection)
        keys = [int(row["object_id"]) for row in page["items"]]
        _, _, values = self._wide(job, session, table_id, keys, preview, selected)
        columns = [{"name": column["name"], "type": column["type"]} for column in layout]
        for row in page["items"]:
            del row["h3"]
            row["attributes"], truncated = values[row["object_id"]]
            if truncated:
                row["truncated_fields"] = truncated
        return {**page, "columns": columns, "hidden_columns": sorted(hidden_columns),
                "total": session["query"]["counts"].get(table_id, 0)}

    def _check_record(self, job, session, table_id, key):
        self.check_table(session, table_id)
        matching = self._matching(job, session, table_id=table_id, key=key)
        rows = self.storage.query(job, "record_membership", matching.sql + " SELECT object_id FROM matches LIMIT 1",
                                  matching.args, 1)
        if not rows:
            raise HTTPException(404, "Record is outside this search")

    def record(self, job, session, table_id, key):
        """Resolve one frozen record with bounded variable-width values."""
        self._check_record(job, session, table_id, key)
        layout = session["publication"]["columns"][table_id]
        _, preview = size_plan(self.storage.settings, layout, 1)
        snapshot, columns, values = self._wide(job, session, table_id, [key], preview, layout)
        attributes, truncated = values[str(key)]
        fields = [{**column, "value": attributes[column["name"]]} for column in columns]
        for field in fields:
            if field["name"] in truncated:
                field.update(truncated=True, **truncated[field["name"]])
        return {"table_id": table_id, "object_id": str(key), "snapshot_id": str(snapshot), "fields": fields}

    def field(self, job, session, table_id, key, index, offset, limit):
        """Read a bounded exact slice of a text or binary field from one matching record."""

        self._check_record(job, session, table_id, key)
        publication = session["publication"]
        columns = publication["columns"][table_id]
        if index >= len(columns):
            raise HTTPException(404, "Record field not found")
        column = columns[index]
        kind = value_kind(column)
        if kind == "scalar":
            raise HTTPException(422, "This field is available in the record details")
        limit = min(limit, max(1, (self.storage.settings.wide_response_budget_bytes - 512) // 6))
        projection, length_expr = slice_projection(column, kind, self.storage.local, offset, limit)
        source = self.storage.relation(_wide_name(session["publication"], table_id), publication["wide_snapshots"][table_id],
                                       [column["physical_name"]])
        sql = f"SELECT {projection}, {length_expr} FROM {source.sql} WHERE table_id = ? AND object_id = ? LIMIT 2"
        rows = self.storage.query(job, "wide_field", sql, (*source.args, table_id, key), 1)
        if not rows:
            raise RuntimeError("Frozen search and wide snapshots disagree")
        value, length = rows[0]
        return {"value": source_value(value), "offset": offset, "length": length, "unit": length_unit(kind),
                "encoding": "base64" if kind == "binary" else "text",
                "next_offset": offset + limit if length is not None and offset + limit < length else None}
