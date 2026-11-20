"""Validate browser-visible map services and supported source projections."""

import math
import re
from copy import deepcopy
from html import escape
from html.parser import HTMLParser
from urllib.parse import urlsplit


COMMON = {"projection", "attributions", "crossOrigin"}
OPTIONS = {
    "xyz": COMMON | {"minZoom", "maxZoom"},
    "mvt": COMMON | {"minZoom", "maxZoom"},
    "wms": COMMON | {"layers", "styles", "format", "version", "params"},
    "wmts": COMMON | {"layer", "matrixSet", "tileMatrixSet", "style", "format", "version"},
    "arcgis": COMMON | {"params"},
}


class _AttributionText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


def configured_maps(items, default_map_id):
    """Normalize configured attribution markup to safe browser-visible text."""
    normalized = deepcopy(items)
    if isinstance(normalized, list):
        for item in normalized:
            if not isinstance(item, dict) or not isinstance(item.get("options"), dict):
                continue
            attribution = item["options"].get("attributions")
            if isinstance(attribution, str):
                parser = _AttributionText()
                parser.feed(attribution)
                parser.close()
                # OpenLayers treats attribution strings as HTML. Encode any text
                # produced from character references so it remains inert text.
                item["options"]["attributions"] = escape("".join(parser.parts), quote=False)
    return public_maps(normalized, default_map_id)


def public_maps(items, default_map_id):
    """Return validated public settings without fetching remote services."""
    if not isinstance(items, list) or len(items) > 100:
        raise ValueError("Configure at most 100 maps")
    result, ids = [], set()
    for item in items:
        if not isinstance(item, dict) or set(item) - {"id", "name", "type", "url", "options"}:
            raise ValueError("Invalid basemap fields")
        if any(not isinstance(item.get(key), str) or not item[key].strip() for key in ("id", "name", "type", "url")):
            raise ValueError("Map ID, name, type and URL are required")
        identifier, name, kind, url = (item[key] for key in ("id", "name", "type", "url"))
        if (not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", identifier) or len(name) > 200
                or identifier in ids or kind not in OPTIONS or len(url) > 4096):
            raise ValueError("Invalid map ID, name or type")
        try:
            parts = urlsplit(url)
            valid_url = (parts.scheme in {"http", "https"} and parts.hostname and parts.username is None
                         and parts.password is None and parts.port != 0 and not parts.fragment)
        except ValueError:
            valid_url = False
        if not valid_url or any(character.isspace() or ord(character) < 32 for character in url):
            raise ValueError("Use an HTTP(S) map URL without credentials or fragments")
        options = item.get("options", {})
        if not isinstance(options, dict) or set(options) - OPTIONS[kind]:
            raise ValueError("Unsupported options for this map type")
        for key, value in options.items():
            if key in {"minZoom", "maxZoom"}:
                if type(value) not in {int, float} or not math.isfinite(value) or not 0 <= value <= 30:
                    raise ValueError("Map zoom must be between 0 and 30")
            elif key == "params":
                if not isinstance(value, dict) or len(value) > 50:
                    raise ValueError("Map parameters must be an object with at most 50 entries")
                for parameter, parameter_value in value.items():
                    if (not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,127}", parameter)
                            or type(parameter_value) not in {str, int, float, bool}
                            or len(str(parameter_value)) > 2048
                            or (type(parameter_value) is float and not math.isfinite(parameter_value))):
                        raise ValueError("Invalid map parameter")
            elif not isinstance(value, str) or len(value) > 4096 or "\x00" in value:
                raise ValueError("Map text options must be strings of at most 4096 characters")
        if options.get("projection", "EPSG:3857") not in {"EPSG:3857", "EPSG:4326"}:
            raise ValueError("Supported map projections are EPSG:3857 and EPSG:4326")
        if "crossOrigin" in options and options["crossOrigin"] not in {"anonymous", "use-credentials"}:
            raise ValueError("Invalid map crossOrigin option")
        if any(character in options.get("attributions", "") for character in "<>"):
            raise ValueError("Map attribution must be plain text")
        if options.get("minZoom", 0) > options.get("maxZoom", 30):
            raise ValueError("Minimum zoom must not exceed maximum zoom")
        result.append({"id": identifier, "name": name.strip(), "type": kind, "url": url, "options": options})
        ids.add(identifier)
    if default_map_id is not None and (not isinstance(default_map_id, str) or default_map_id not in ids):
        raise ValueError("The default basemap is not configured")
    return result
