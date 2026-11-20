"""Storage layout and bounded row transformation."""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from hashlib import sha256
import json
import math
import re
from uuid import UUID

from h3ronpy.vector import coordinates_to_cells
import pyarrow as pa


search_name = "search_index"


def owned_table_name(name):
    """Recognize only physical identifiers owned by the ingestion service."""
    return isinstance(name, str) and (name in (search_name, "search_index_single_file") or bool(re.fullmatch(
        r"(?:wide_[0-9a-f]{32}(?:_[0-9a-f]{32})?|search_(?:r3|single)_[0-9a-f]{32})", name)))
SEARCH_SCHEMA = pa.schema(
    [
        pa.field("table_id", pa.string(), nullable=False),
        pa.field("object_id", pa.int64(), nullable=False),
        pa.field("lat", pa.float64(), nullable=False),
        pa.field("lon", pa.float64(), nullable=False),
    ]
    + [pa.field(f"h3_r{res}", pa.int64(), nullable=False) for res in range(16)]
)


def wide_name(table_id):
    """Return the owned table identifier for a registered UUID."""
    return "wide_" + UUID(table_id).hex


def publication_tables(publication):
    """Validate the dataset and role of each physical table before reclamation."""
    wide = publication.get("wide_table_names", {})
    names = set()
    for table_id in publication.get("wide_snapshots", {}):
        prefix = wide_name(table_id)
        name = wide.get(table_id, prefix)
        if name != prefix and not re.fullmatch(prefix + r"_[0-9a-f]{32}", name):
            raise ValueError("Invalid published wide table")
        names.add(name)
    lookup_names = [entry["search_table_name"] for entry in publication.get("lookup_publications", {}).values()]
    if publication.get("search_snapshot_id") is not None:
        lookup_names.append(publication.get("search_table_name", search_name))
    for name in lookup_names:
        if name not in (search_name, "search_index_single_file") and not re.fullmatch(r"search_(r3|single)_[0-9a-f]{32}", name):
            raise ValueError("Invalid published lookup table")
        names.add(name)
    return names


@dataclass(frozen=True)
class Column:
    """Source column identity, declaration, and Arrow representation."""

    name: str
    declaration: str
    type: pa.DataType
    nullable: bool = True
    identity: tuple = ()


@dataclass(frozen=True)
class SourceLayout:
    """Stable mapping of original fields to physical names by source ordinal."""

    columns: tuple[Column, ...]
    key: int
    lat: int
    lon: int
    identity: tuple = ()
    derived_geometry: bool = False

    @property
    def fingerprint(self):
        """Identify all source columns, types, nullability and source identity."""
        fields = [
            (column.name, column.declaration, str(column.type), column.nullable, column.identity)
            for column in self.columns
        ]
        return sha256(json.dumps((fields, self.identity), ensure_ascii=False).encode()).hexdigest()

    @property
    def fields(self):
        """Return the original field descriptions used by a frozen publication."""
        return [
            {
                "name": column.name, "type": column.declaration, "physical_name": f"src_{index}",
                "value_kind": _value_kind(column.type),
            }
            for index, column in enumerate(self.columns, 1)
        ]

    @property
    def schema(self):
        """Return the canonical fields plus safely named original fields."""
        return pa.schema(
            list(SEARCH_SCHEMA)
            + [
                pa.field(f"src_{index}", column.type, nullable=column.nullable)
                for index, column in enumerate(self.columns, 1)
            ]
        )


def _value_kind(arrow_type):
    if pa.types.is_string(arrow_type) or pa.types.is_large_string(arrow_type):
        return "text"
    if pa.types.is_binary(arrow_type) or pa.types.is_large_binary(arrow_type) or pa.types.is_fixed_size_binary(arrow_type):
        return "binary"
    return "scalar"


def make_layout(dataset, columns, identity=()):
    """Resolve configured source names exactly and require a signed integer key."""
    fields = {column.name: index for index, column in enumerate(columns)}
    if len(fields) != len(columns):
        raise ValueError("Source column names must be unique.")
    geometry = dataset.get("geometry_column")
    try:
        key = fields[dataset["object_id_column"]]
        if geometry:
            column = columns[fields[geometry]]
            if not column.identity or column.identity[1] not in ("geometry", "geography"):
                raise ValueError("The configured geometry column must have SQL Server geometry or geography type.")
            if int(dataset.get("source_srid", 4326)) != 4326:
                raise ValueError("Source coordinates must use EPSG:4326.")
            lat, lon = len(columns), len(columns) + 1
        else:
            lat = fields[dataset["latitude_column"]]
            lon = fields[dataset["longitude_column"]]
    except KeyError as error:
        raise ValueError("A configured source column does not exist. Check the exact column names.") from error
    if not pa.types.is_integer(columns[key].type) or columns[key].type.bit_width > 64:
        raise ValueError("The OBJECTID column must contain integer values representable as signed 64-bit IDs.")
    return SourceLayout(tuple(columns), key, lat, lon, identity, bool(geometry))


def position(lat, lon):
    """Validate EPSG:4326 coordinates and return a private reject reason."""
    try:
        lat, lon = float(lat), float(lon)
    except (TypeError, ValueError, OverflowError):
        return None, None, "missing or nonnumeric coordinates"
    if not (math.isfinite(lat) and math.isfinite(lon)):
        return None, None, "nonfinite coordinates"
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None, None, "out-of-range coordinates"
    return lat, lon, None


def transform(table_id, layout, changes, workers):
    """Collapse a bounded ordered change batch and compute direct cells in parallel."""
    latest = {int(values[layout.key]): (operation, values) for operation, values in changes}
    items = list(latest.items())

    def chunk(entries):
        valid, latitudes, longitudes, rejects = [], [], [], []
        for key, (operation, values) in entries:
            if operation in (1, 3):
                continue
            lat, lon, reason = position(values[layout.lat], values[layout.lon])
            if reason:
                rejects.append((key, reason))
                continue
            valid.append((key, values))
            latitudes.append(lat)
            longitudes.append(lon)
        if not valid:
            return layout.schema.empty_table(), rejects
        lat = pa.array(latitudes, type=pa.float64())
        lon = pa.array(longitudes, type=pa.float64())
        arrays = [
            pa.repeat(pa.scalar(table_id), len(valid)),
            pa.array((key for key, _ in valid), type=pa.int64()),
            lat, lon,
        ]
        arrays.extend(
            pa.array(coordinates_to_cells(lat, lon, resolution)).cast(pa.int64())
            for resolution in range(16)
        )
        arrays.extend(
            pa.array((values[index] for _, values in valid), type=column.type)
            for index, column in enumerate(layout.columns)
        )
        return pa.Table.from_arrays(arrays, schema=layout.schema), rejects

    step = max(1, (len(items) + workers - 1) // workers)
    with ThreadPoolExecutor(max_workers=workers) as executor:
        results = list(executor.map(chunk, (items[i:i + step] for i in range(0, len(items), step))))
    tables = [table for table, _ in results]
    return (
        pa.concat_tables(tables) if tables else pa.Table.from_batches([], schema=layout.schema),
        list(latest),
        [reject for _, rejects in results for reject in rejects],
    )
