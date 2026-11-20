"""Bounded world-anchored Mercator grids shared with map rendering."""

import math

from .storage import Relation

WORLD = 40075016.68557849
RADIUS = 6378137.0
MAX_LATITUDE = 85.05112878
MAX_CELLS = 4000
MAX_GROUPS = 100000


def projected_y(latitude):
    latitude = max(-MAX_LATITUDE, min(MAX_LATITUDE, latitude))
    return RADIUS * math.log(math.tan(math.pi * (latitude + 90) / 360))


def bounded_columns(columns, viewport, datasets, mode):
    """Conservatively bound output before scanning matching source records."""
    west, south, east, north = viewport
    span_x = (east - west if east >= west else east + 360 - west) / 360
    span_y = (projected_y(north) - projected_y(south)) / WORLD
    budget = min(MAX_CELLS, max(1, MAX_GROUPS // max(1, datasets)))

    def fits(value):
        width = min(value, math.ceil((span_x + (span_y / math.sqrt(3) if mode == "hexes" else 0)) * value) + 4)
        height = math.ceil(span_y * value * (2 / math.sqrt(3) if mode == "hexes" else 1)) + 4
        return width * height <= budget

    low, high = 1, columns
    while low < high:
        middle = (low + high + 1) // 2
        if fits(middle):
            low = middle
        else:
            high = middle - 1
    return low


def aggregate_relation(matching, mode, columns):
    """Use the same portable SQL template for server and browser-side grids."""
    from importlib.resources import files

    step = WORLD / columns
    template = files("h3search.api").joinpath("map_grid.sql").read_text(encoding="utf-8")
    sql = template.format(world=WORLD, half_world=WORLD / 2, sphere_radius=RADIUS,
                          max_latitude=MAX_LATITUDE, step=step, triple_hex_radius=3 * (step / math.sqrt(3)),
                          mode_hex=1 if mode == "hexes" else 0, columns=columns, limit=MAX_GROUPS + 1)
    return Relation(matching.sql + sql, matching.args)
