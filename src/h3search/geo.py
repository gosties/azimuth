"""Consistent spherical distances and conservative coordinate bounds."""

from __future__ import annotations

import math

EARTH_RADIUS_M = 6_371_000.0


def valid_coordinates(latitude: object, longitude: object) -> bool:
    """Return whether both coordinates are finite geographic degrees."""
    try:
        lat, lon = float(latitude), float(longitude)
    except (TypeError, ValueError, OverflowError):
        return False
    return math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Return great-circle distance using the application's spherical model."""
    a, b = math.radians(lat1), math.radians(lat2)
    dlat, dlon = b - a, math.radians(lon2 - lon1)
    value = math.sin(dlat / 2) ** 2 + math.cos(a) * math.cos(b) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(max(0.0, min(1.0, value))))


def circle_bounds(latitude: float, longitude: float, radius_m: float) -> list[tuple[float, float, float, float]]:
    """Return conservative (west,south,east,north) bounds, split at the dateline."""
    if not valid_coordinates(latitude, longitude) or not math.isfinite(radius_m) or radius_m < 0:
        raise ValueError("A finite location and nonnegative radius are required")
    angular = radius_m / EARTH_RADIUS_M
    if angular >= math.pi:
        return [(-180.0, -90.0, 180.0, 90.0)]
    lat = math.radians(latitude)
    south = max(-90.0, math.degrees(lat - angular) - 1e-10)
    north = min(90.0, math.degrees(lat + angular) + 1e-10)
    if lat - angular <= -math.pi / 2 or lat + angular >= math.pi / 2:
        return [(-180.0, south, 180.0, north)]
    delta = math.degrees(math.asin(min(1.0, math.sin(angular) / math.cos(lat)))) + 1e-10
    west, east = longitude - delta, longitude + delta
    if west < -180:
        return [(west + 360, south, 180.0, north), (-180.0, south, east, north)]
    if east > 180:
        return [(west, south, 180.0, north), (-180.0, south, east - 360, north)]
    return [(west, south, east, north)]


def h3_cells(latitude: float, longitude: float) -> dict[str, int]:
    """Compute each direct H3 resolution from the original location."""
    import h3
    if not valid_coordinates(latitude, longitude):
        raise ValueError("Invalid geographic coordinates")
    return {f"h3_r{resolution}": int(h3.latlng_to_cell(latitude, longitude, resolution), 16) for resolution in range(16)}
