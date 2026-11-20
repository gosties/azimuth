"""Parse and render WGS84 coordinates for search and map readouts."""

import math
import re
from functools import lru_cache
from threading import Lock
from warnings import catch_warnings, simplefilter

import h3
import mgrs


class CoordinateError(ValueError):
    """The coordinate could not be interpreted within its format's bounds."""


_NUMBER = r"[+-]?(?:[0-9]{1,3}(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]{1,3})?"
_PAIR_SEPARATOR = r"(?:\s*[,;]\s*|\s+)"
_GRID = re.compile(r"(?:[0-9]{1,2}[C-HJ-NP-X]|[ABYZ])[A-HJ-NP-Z]{2}(?:[0-9]{2}){0,5}", re.ASCII)
_MGRS_LOCK = Lock()


def _component(index, body, hemispheres):
    return rf"(?:(?P<pre{index}>[{hemispheres}])\s*)?{body}(?:\s*(?P<post{index}>[{hemispheres}]))?"


def _pair(body, *, swapped=False, adjacent=False):
    hemispheres = ("EW", "NS") if swapped else ("NS", "EW")
    patterns = [
        _component(index, body(index, 3 if hemi == "EW" else 2), hemi)
        for index, hemi in enumerate(hemispheres)
    ]
    separator = rf"(?:{_PAIR_SEPARATOR})?" if adjacent else _PAIR_SEPARATOR
    return re.compile(separator.join(patterns), re.ASCII | re.IGNORECASE)


def _dd(index, width):
    return rf"(?P<value{index}>{_NUMBER})(?:\s*°)?"


def _dms(index, width):
    return (
        rf"(?P<value{index}>[+-]?[0-9]{{1,{width}}})"
        rf"(?:\s*[°ºd:\-]\s*|\s+)(?P<min{index}>[0-9]{{1,2}})"
        rf"(?:\s*['′’m:\-]\s*|\s+)(?P<sec{index}>[0-9]{{1,2}}(?:\.[0-9]+)?)"
        r"(?:\s*[\"″”s])?"
    )


def _compact(index, width):
    return rf"(?P<value{index}>[0-9]{{{width + 4}}}(?:\.[0-9]+)?)"


_FORMATS = [
    (kind, swapped, compact, _pair(body, swapped=swapped, adjacent=compact))
    for kind, body, compact in (("dms", _compact, True), ("dms", _dms, False), ("dd", _dd, False))
    for swapped in (False, True)
]


def _signed(value, magnitude, prefix, suffix):
    if prefix and suffix and prefix != suffix:
        raise CoordinateError("Conflicting hemispheres")
    hemisphere = prefix or suffix
    if hemisphere:
        negative = hemisphere in "SW"
        if (value.startswith("-") and not negative) or (value.startswith("+") and negative):
            raise CoordinateError("Conflicting sign and hemisphere")
    else:
        negative = value.startswith("-")
    return -magnitude if negative else magnitude


def _values(match, kind, compact, swapped):
    groups = match.groupdict()
    values = []
    for index in range(2):
        value = groups[f"value{index}"]
        if compact:
            whole, _, fraction = value.partition(".")
            degrees, minutes, seconds = whole[:-4], whole[-4:-2], whole[-2:]
            if fraction:
                seconds += "." + fraction
        else:
            degrees, minutes, seconds = value, groups.get(f"min{index}"), groups.get(f"sec{index}")
        magnitude = abs(float(degrees))
        if kind == "dms":
            minute, second = float(minutes), float(seconds)
            if minute >= 60 or second >= 60:
                raise CoordinateError("Minutes and seconds must be below 60")
            boundary = 90 if index == int(swapped) else 180
            if magnitude == boundary and (minute or second):
                raise CoordinateError("Minutes and seconds must be zero at the poles or antimeridian")
            magnitude += minute / 60 + second / 3600
        values.append(_signed(degrees, magnitude, groups[f"pre{index}"], groups[f"post{index}"]))
    return values


def _validated(latitude, longitude):
    if not math.isfinite(latitude) or not -90 <= latitude <= 90:
        raise CoordinateError("Latitude must be between -90 and 90 degrees")
    if not math.isfinite(longitude) or not -180 <= longitude <= 180:
        raise CoordinateError("Longitude must be between -180 and 180 degrees")
    return latitude, longitude


def _grid_reference(text):
    return re.sub(r"\s+", "", text.upper())


def parse_coordinate(text):
    """Return the format and exact WGS84 latitude and longitude."""
    text = text.strip().upper()
    grid = _grid_reference(text)
    if _GRID.fullmatch(grid):
        if grid[0].isdigit() and not 1 <= int(re.match(r"[0-9]+", grid)[0]) <= 60:
            raise CoordinateError("Invalid MGRS zone")
        try:
            # The native projection code shares mutable parameters across calls.
            with _MGRS_LOCK, catch_warnings():
                simplefilter("error", RuntimeWarning)
                latitude, longitude = mgrs.MGRS().toLatLon(grid)
        except (mgrs.core.MGRSError, RuntimeWarning):
            raise CoordinateError("Invalid MGRS grid reference") from None
        return "mgrs", *_validated(latitude, longitude)
    for kind, swapped, compact, pattern in _FORMATS:
        if not (match := pattern.fullmatch(text)):
            continue
        if (swapped or compact) and not all(match[f"pre{i}"] or match[f"post{i}"] for i in range(2)):
            continue
        values = _values(match, kind, compact, swapped)
        if swapped:
            values.reverse()
        return kind, *_validated(*values)
    raise CoordinateError("Enter a complete DD, DMS, or MGRS coordinate")


def _format_dms(value, positive, negative, width):
    direction = negative if math.copysign(1, value) < 0 else positive
    degrees, remainder = divmod(round(abs(value) * 3_600_000), 3_600_000)
    minutes, milliseconds = divmod(remainder, 60_000)
    return f"{degrees:0{width}d}°{minutes:02d}'{milliseconds / 1000:06.3f}\"{direction}"


@lru_cache(maxsize=200)
def format_mgrs(latitude: float, longitude: float) -> str | None:
    """Render one WGS84 point as a one-meter MGRS grid reference."""
    _validated(latitude, longitude)
    try:
        with _MGRS_LOCK, catch_warnings():
            simplefilter("error", RuntimeWarning)
            return mgrs.MGRS().toMGRS(latitude, longitude, MGRSPrecision=5) or None
    except (mgrs.core.MGRSError, RuntimeWarning):
        return None


def coordinate_info(latitude, longitude, kind="dd", *, grid=None):
    """Render alternate notations and decimal H3 cells at resolutions 0 through 15."""
    _validated(latitude, longitude)
    if grid is None:
        grid = format_mgrs(latitude, longitude)
    h3_resolutions = [
        str(h3.str_to_int(h3.latlng_to_cell(latitude, longitude, resolution)))
        for resolution in range(16)
    ]
    return {
        "format": kind,
        "latitude": latitude,
        "longitude": longitude,
        "dd": f"{latitude:.10f}, {longitude:.10f}",
        "dms": f"{_format_dms(latitude, 'N', 'S', 2)} {_format_dms(longitude, 'E', 'W', 3)}",
        "mgrs": grid or None,
        "h3": h3_resolutions[9],
        "h3_resolutions": h3_resolutions,
    }


def parse_coordinate_info(text):
    """Render the parsed point and preserve its supplied MGRS grid reference."""
    kind, latitude, longitude = parse_coordinate(text)
    grid = _grid_reference(text) if kind == "mgrs" else None
    return coordinate_info(latitude, longitude, kind, grid=grid)
