"""Optional partition pruning with a conservative H3 rectangle cover."""

import math

from h3 import H3BaseException
from h3.api import basic_int as h3

from h3search.geo import EARTH_RADIUS_M

MAX_WORLD_CELLS = 300_000
MAX_QUERY_CELLS = 512


def fine_join_cover(bounds, resolution):
    """Cover tiny nonpolar rectangles directly, with guards before allocation."""
    if not 1 <= resolution <= 9:
        return ()
    area_per_cell = h3.average_hexagon_area(resolution, unit="m^2")
    estimate = 0.0
    for west, south, east, north in bounds:
        if not (-80 < south <= north < 80 and 0 < east - west <= 0.12 and 0 < north - south <= 0.02):
            return ()
        latitude = 0 if south <= 0 <= north else min(abs(south), abs(north))
        width = math.radians(east - west) * EARTH_RADIUS_M * math.cos(math.radians(latitude))
        height = math.radians(north - south) * EARTH_RADIUS_M
        if width > 2100 or height > 2100:
            return ()
        # A deliberately generous area/perimeter estimate rejects expensive high
        # resolution covers before H3 allocates its polygon-cover buffer. Hard
        # angle, latitude, metric-size and resolution ceilings also bound that
        # allocator independently of the returned-cell count.
        latitude_cos = math.cos(math.radians(max(abs(south), abs(north))))
        # H3's polygon-size estimator expands longitude toward high latitudes;
        # include that expansion rather than estimating spherical area alone.
        estimate += (8 * width * height / (latitude_cos**2 * area_per_cell)
                     + 8 * (2 * width + 2 * height) / (latitude_cos * math.sqrt(area_per_cell)) + 64)
        if estimate > MAX_QUERY_CELLS:
            return ()
    cells = set()
    try:
        for west, south, east, north in bounds:
            rectangle = h3.LatLngPoly([(south, west), (south, east), (north, east), (north, west)])
            cells.update(h3.h3shape_to_cells_experimental(rectangle, resolution, contain="bbox_overlap"))
            if len(cells) > MAX_QUERY_CELLS:
                return ()
    except (H3BaseException, ValueError):
        return ()
    return tuple(sorted(cells))


def partition_cover(bounds, resolution):
    """Return direct-resolution candidates, or the reason to use coordinate filters alone."""
    # h3-py preallocates a cover buffer. Limit the entire resolution as a hard
    # ceiling and skip broad rectangles early using a rough workload estimate.
    if h3.get_num_cells(resolution) > MAX_WORLD_CELLS:
        return (), "resolution_budget"
    estimated_cells = 0.0
    area_per_cell = h3.average_hexagon_area(resolution, unit="m^2")
    for west, south, east, north in bounds:
        if south <= -85 or north >= 85 or east - west >= 180:
            return (), "pole_or_wide_rectangle"
        estimated_cells += (math.radians(east - west) * math.radians(north - south) * EARTH_RADIUS_M**2
                            / math.cos(math.radians(max(abs(north), abs(south)))) / area_per_cell)
    if estimated_cells > MAX_QUERY_CELLS:
        return (), "cover_estimate_budget"

    cells = set()
    try:
        for west, south, east, north in bounds:
            rectangle = h3.LatLngPoly([(south, west), (south, east), (north, east), (north, west)])
            # Each point in the rectangle lies in a direct H3 cell whose
            # bounding box intersects the rectangle, including boundary points.
            cells.update(h3.h3shape_to_cells_experimental(rectangle, resolution, contain="bbox_overlap"))
            if len(cells) > MAX_QUERY_CELLS:
                return (), "cover_size_budget"
    except (H3BaseException, ValueError):
        return (), "cover_error"
    return (tuple(sorted(cells)), "h3_bbox_overlap") if cells else ((), "empty_cover")
