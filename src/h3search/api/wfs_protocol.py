"""Bounded, read-only WFS 2.0 / 1.1 requests and GML point responses."""

from datetime import date, datetime, timezone
from decimal import Decimal
import math
import re
from urllib.parse import urlencode
from xml.etree import ElementTree as ET

import anyio
from fastapi import HTTPException, Request, Response

from .execution import Unavailable

WFS2 = "http://www.opengis.net/wfs/2.0"
WFS1 = "http://www.opengis.net/wfs"
GML32 = "http://www.opengis.net/gml/3.2"
GML31 = "http://www.opengis.net/gml"
OWS = "http://www.opengis.net/ows/1.1"
FES = "http://www.opengis.net/fes/2.0"
OGC = "http://www.opengis.net/ogc"
XSD = "http://www.w3.org/2001/XMLSchema"
XSI = "http://www.w3.org/2001/XMLSchema-instance"
XLINK = "http://www.w3.org/1999/xlink"
AZ = "https://azimuth.local/features"
MAX_REQUEST_BYTES = 65536
MAX_FILTER_NODES = 128
for _prefix, _namespace in (("wfs", WFS2), ("gml", GML32), ("ows", OWS), ("fes", FES),
                             ("xsd", XSD), ("xsi", XSI), ("xlink", XLINK), ("az", AZ)):
    ET.register_namespace(_prefix, _namespace)


class WFSException(ValueError):
    def __init__(self, message, locator="request", code="InvalidParameterValue", status=400):
        super().__init__(message)
        self.locator, self.code, self.status = locator, code, status


def element(parent, tag_namespace, tag_name, text=None, **attributes):
    child = ET.SubElement(parent, f"{{{tag_namespace}}}{tag_name}", attributes)
    if text is not None:
        child.text = str(text)
    return child


def xml_response(root, status=200):
    return Response(ET.tostring(root, encoding="utf-8", xml_declaration=True), status_code=status,
                    media_type="application/xml")


def exception_response(error):
    root = ET.Element(f"{{{OWS}}}ExceptionReport", version="1.1.0")
    exception = element(root, OWS, "Exception", exceptionCode=error.code, locator=error.locator)
    element(exception, OWS, "ExceptionText", str(error))
    return xml_response(root, error.status)


def local(tag):
    return tag.rsplit("}", 1)[-1]


def safe_xml(body):
    if len(body) > MAX_REQUEST_BYTES:
        raise WFSException("XML request exceeds the byte limit", status=413)
    try:
        text = body.decode("utf-8-sig")
        if "\x00" in text or re.search(r"<!\s*(?:DOCTYPE|ENTITY)", text, re.I):
            raise ValueError()
        root = ET.fromstring(text)
        stack, nodes = [(root, 0)], 0
        while stack:
            node, depth = stack.pop()
            nodes += 1
            if nodes > MAX_FILTER_NODES or depth > 16:
                raise ValueError()
            stack.extend((child, depth + 1) for child in node)
        return root
    except (UnicodeError, ET.ParseError, ValueError):
        raise WFSException("Malformed or unsupported XML", "request") from None


def name(value):
    # Property paths, XPath expressions and function calls are deliberately unsupported.
    if not re.fullmatch(r"(?:[A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*", value or "", re.ASCII):
        raise WFSException("Expected a single feature type or property name", "typeNames")
    return value.split(":")[-1]


def crs(value):
    value = (value or "urn:ogc:def:crs:EPSG::4326").upper()
    if value in {"CRS:84", "OGC:CRS84", "URN:OGC:DEF:CRS:OGC:1.3:CRS84", "HTTP://WWW.OPENGIS.NET/DEF/CRS/OGC/1.3/CRS84"}:
        return "CRS84"
    match = re.fullmatch(r"(?:EPSG:|URN:OGC:DEF:CRS:EPSG:(?:[^:]*):|HTTP://WWW.OPENGIS.NET/DEF/CRS/EPSG/0/)(4326|3857)", value)
    if match:
        return match[1]
    raise WFSException("Supported coordinate systems are CRS84, EPSG:4326 and EPSG:3857", "srsName")


def crs_uri(system):
    return "urn:ogc:def:crs:OGC:1.3:CRS84" if system == "CRS84" else f"urn:ogc:def:crs:EPSG::{system}"


def bbox_values(values, system):
    try:
        a, b, c, d = map(float, values)
        if not all(math.isfinite(value) for value in (a, b, c, d)):
            raise ValueError()
        if system == "4326":
            a, b, c, d = b, a, d, c
        elif system == "3857":
            if any(abs(value) > 20037508.34278925 for value in (a, b, c, d)):
                raise ValueError()
            a, c = [math.degrees(value / 6378137) for value in (a, c)]
            b, d = [math.degrees(math.atan(math.sinh(value / 6378137))) for value in (b, d)]
        if not (-180 <= a <= c <= 180 and -90 <= b <= d <= 90):
            raise ValueError()
        return (a, b, c, d)
    except (ValueError, OverflowError):
        raise WFSException("Invalid bounding box or coordinate axis order", "bbox") from None


def _reference(node):
    if local(node.tag) not in {"ValueReference", "PropertyName"} or list(node):
        raise WFSException("Expected a property reference", "filter")
    return name(node.text)


def parse_filter(root, default_crs):
    """Return a conjunction/scalar predicate tree and one canonical WGS84 box."""
    boxes = []
    operators = {"PropertyIsEqualTo": "eq", "PropertyIsNotEqualTo": "ne", "PropertyIsLessThan": "lt",
                 "PropertyIsLessThanOrEqualTo": "le", "PropertyIsGreaterThan": "gt",
                 "PropertyIsGreaterThanOrEqualTo": "ge"}

    def parse(node):
        kind, children = local(node.tag), list(node)
        if kind == "Filter":
            if not children:
                raise WFSException("An empty filter is unsupported", "filter")
            if len(children) > 1 and not all(local(child.tag) in {"ResourceId", "FeatureId"} for child in children):
                raise WFSException("Use And to combine predicates", "filter")
            if len(children) > 1:
                return {"op": "ids", "values": [parse(child)["values"][0] for child in children]}
            return parse(children[0])
        if kind == "And":
            if len(children) < 2:
                raise WFSException("And requires at least two predicates", "filter")
            predicates = [predicate for child in children if (predicate := parse(child)) is not None]
            return {"op": "and", "args": predicates} if len(predicates) > 1 else (predicates[0] if predicates else None)
        if kind in operators:
            if len(children) != 2 or local(children[1].tag) != "Literal" or list(children[1]):
                raise WFSException("Expected a property and scalar literal", "filter")
            if node.get("matchCase", "true").lower() != "true":
                raise WFSException("Case-insensitive comparisons are unsupported", "filter")
            return {"op": operators[kind], "property": _reference(children[0]), "value": children[1].text or ""}
        if kind == "PropertyIsBetween":
            if len(children) != 3 or [local(child.tag) for child in children[1:]] != ["LowerBoundary", "UpperBoundary"]:
                raise WFSException("Invalid range predicate", "filter")
            prop = _reference(children[0])
            bounds = []
            for boundary in children[1:]:
                if len(boundary) != 1 or local(boundary[0].tag) != "Literal" or list(boundary[0]):
                    raise WFSException("Expected scalar range limits", "filter")
                bounds.append(boundary[0].text or "")
            return {"op": "and", "args": [{"op": op, "property": prop, "value": val} for op, val in zip(("ge", "le"), bounds)]}
        if kind in {"ResourceId", "FeatureId"}:
            value = node.get("rid" if kind == "ResourceId" else "fid")
            if not value or children or len(value) > 256:
                raise WFSException("Invalid feature identifier", "filter")
            return {"op": "ids", "values": [value]}
        if kind == "BBOX":
            if children and local(children[0].tag) in {"PropertyName", "ValueReference"}:
                if _reference(children.pop(0)) != "geometry":
                    raise WFSException("BBOX requires geometry", "filter")
            if len(children) != 1 or local(children[0].tag) != "Envelope":
                raise WFSException("BBOX requires a GML Envelope", "filter")
            envelope = children[0]
            if [local(child.tag) for child in envelope] != ["lowerCorner", "upperCorner"]:
                raise WFSException("Invalid GML Envelope", "filter")
            values = (envelope[0].text or "").split() + (envelope[1].text or "").split()
            if len(values) != 4:
                raise WFSException("A two-dimensional envelope is required", "filter")
            boxes.append(bbox_values(values, crs(envelope.get("srsName") or crs_uri(default_crs))))
            return None
        raise WFSException(f"Unsupported filter operator: {kind}", "filter", "OperationNotSupported")

    predicate = parse(root)
    if len(boxes) > 1:
        raise WFSException("Only one bounding box is supported", "filter")
    return predicate, boxes[0] if boxes else None


def parse_request(parameters, body=None):
    values = {}
    pairs = parameters.multi_items() if hasattr(parameters, "multi_items") else parameters.items()
    for key, value in pairs:
        key = key.lower()
        if key in values:
            raise WFSException("Duplicate request parameter", key)
        values[key] = value
    allowed = {"service", "request", "version", "acceptversions", "acceptformats", "sections", "updatesequence",
               "typename", "typenames", "namespaces", "namespace", "srsname", "bbox", "count", "maxfeatures", "startindex",
               "propertyname", "filter", "featureid", "resourceid", "resulttype", "outputformat", "sortby", "snapshot"}
    if values.keys() - allowed:
        raise WFSException("Unsupported request parameter", sorted(values.keys() - allowed)[0])
    if body is not None:
        root = safe_xml(body)
        if not root.tag.startswith(("{" + WFS2 + "}", "{" + WFS1 + "}")):
            raise WFSException("Expected a WFS XML operation", "request")
        operation = local(root.tag)
        if values.get("request", operation) != operation:
            raise WFSException("Conflicting operation parameters", "request")
        values["request"] = operation
        for key, value in root.attrib.items():
            if key.lower() in allowed:
                values[key.lower()] = value
            elif key not in {"handle", "{http://www.w3.org/2001/XMLSchema-instance}schemaLocation"}:
                raise WFSException("Unsupported XML request attribute", key)
        if operation == "GetFeature":
            if len(root) != 1 or local(root[0].tag) != "Query":
                raise WFSException("Exactly one Query is required", "typeNames")
            query = root[0]
            for key, value in query.attrib.items():
                if key.lower() not in {"typename", "typenames", "srsname"}:
                    raise WFSException("Unsupported Query attribute", key)
                values[key.lower()] = value
            properties = []
            for child in query:
                kind = local(child.tag)
                if kind in {"PropertyName", "ValueReference"}:
                    properties.append(_reference(child))
                elif kind == "Filter" and "filter" not in values:
                    values["filter"] = ET.tostring(child, encoding="unicode")
                else:
                    raise WFSException("Unsupported or duplicate Query clause", kind)
            if properties:
                values["propertyname"] = ",".join(properties)
        elif operation == "DescribeFeatureType":
            if any(local(child.tag) != "TypeName" for child in root):
                raise WFSException("Unsupported schema request", "request")
            if len(root):
                values["typenames"] = ",".join(child.text or "" for child in root)
        elif operation == "GetCapabilities":
            for child in root:
                if local(child.tag) == "AcceptVersions":
                    values["acceptversions"] = ",".join(item.text or "" for item in child)
                elif local(child.tag) not in {"Sections", "AcceptFormats"}:
                    raise WFSException("Unsupported capabilities clause", "request")
    if values.get("service", "WFS").upper() != "WFS":
        raise WFSException("Service must be WFS", "service")
    operation = values.get("request", "")
    operation = {key.lower(): key for key in ("GetCapabilities", "DescribeFeatureType", "GetFeature")}.get(operation.lower())
    if operation is None:
        raise WFSException("Supported operations: GetCapabilities, DescribeFeatureType, GetFeature", "request", "OperationNotSupported")
    version = values.get("version", "2.0.0")
    if operation == "GetCapabilities" and values.get("acceptversions"):
        version = next((version for version in values["acceptversions"].split(",") if version in {"2.0.0", "1.1.0"}), "")
    if version not in {"2.0.0", "1.1.0"}:
        raise WFSException("Supported versions: 2.0.0, 1.1.0", "version", "VersionNegotiationFailed")
    values.update(request=operation, version=version)
    return values


def feature_query(values, page_size):
    types = values.get("typenames", values.get("typename", ""))
    if not types or "," in types or " " in types:
        raise WFSException("Exactly one feature type is required", "typeNames")
    layer = name(types)
    system = crs(values.get("srsname"))
    output = values.get("outputformat", "").lower().replace(" ", "")
    accepted = {"", "gml3", "gml32", "application/gml+xml;version=3.2", "text/xml;subtype=gml/3.2.1", "text/xml;subtype=gml/3.1.1"}
    if output not in accepted:
        raise WFSException("Only GML output is supported", "outputFormat")
    try:
        count = int(values.get("count", values.get("maxfeatures", page_size)))
        start = int(values.get("startindex", "0"))
        if count < 0 or count > page_size or start < 0 or start > 1000000:
            raise ValueError()
    except ValueError:
        raise WFSException("Page size or start index exceeds the configured limit", "count") from None
    result_type = values.get("resulttype", "results").lower()
    if result_type not in {"hits", "results"}:
        raise WFSException("Result type must be hits or results", "resultType")
    bbox, predicate = None, None
    if values.get("bbox"):
        parts = values["bbox"].split(",")
        if len(parts) not in {4, 5}:
            raise WFSException("BBOX requires four coordinates and an optional CRS", "bbox")
        bbox = bbox_values(parts[:4], crs(parts[4]) if len(parts) == 5 else system)
    if values.get("filter"):
        predicate, filter_bbox = parse_filter(safe_xml(values["filter"].encode()), system)
        if filter_bbox is not None:
            if bbox is not None:
                raise WFSException("Only one bounding box is supported", "bbox")
            bbox = filter_bbox
    ids = values.get("resourceid", values.get("featureid"))
    if ids and predicate is not None:
        raise WFSException("Combine identifiers and predicates with an XML And filter", "filter")
    properties = [name(prop) for prop in values["propertyname"].split(",")] if values.get("propertyname") else None
    if values.get("sortby"):
        sort = values["sortby"].strip().split()
        if not sort or len(sort) > 2 or name(sort[0]) != "object_id" or (len(sort) == 2 and sort[1].lower() not in {"a", "asc"}):
            raise WFSException("Only ascending object_id order is supported", "sortBy")
    return layer, system, {"bbox": bbox, "object_ids": ids.split(",") if ids else None, "start_index": start,
                           "count": count, "properties": properties, "result_type": result_type,
                           "filters": predicate, "snapshot": values.get("snapshot")}


def capabilities(layers, url, version, page_size):
    wfs, gml = (WFS2, GML32) if version == "2.0.0" else (WFS1, GML31)
    ows = OWS if version == "2.0.0" else "http://www.opengis.net/ows"
    root = ET.Element(f"{{{wfs}}}WFS_Capabilities", version=version, attrib={"xmlns:az": AZ, "xmlns:gml": gml})
    identification = element(root, ows, "ServiceIdentification")
    element(identification, ows, "Title", "Azimuth feature service")
    element(identification, ows, "ServiceType", "WFS")
    element(identification, ows, "ServiceTypeVersion", version)
    operations = element(root, ows, "OperationsMetadata")
    for operation in ("GetCapabilities", "DescribeFeatureType", "GetFeature"):
        op = element(operations, ows, "Operation", name=operation)
        http = element(element(op, ows, "DCP"), ows, "HTTP")
        element(http, ows, "Get", **{f"{{{XLINK}}}href": url + "?"})
        element(http, ows, "Post", **{f"{{{XLINK}}}href": url})
    if version == "2.0.0":
        for key, val in (("ImplementsBasicWFS", "FALSE"), ("ImplementsTransactionalWFS", "FALSE"),
                         ("ImplementsResultPaging", "TRUE"), ("PagingIsTransactionSafe", "TRUE"),
                         ("CountDefault", str(page_size))):
            constraint = element(operations, ows, "Constraint", name=key)
            element(constraint, ows, "NoValues")
            element(constraint, ows, "DefaultValue", val)
    feature_list = element(root, wfs, "FeatureTypeList")
    for layer in layers:
        feature = element(feature_list, wfs, "FeatureType")
        element(feature, wfs, "Name", "az:" + layer["name"])
        element(feature, wfs, "Title", layer["title"])
        element(feature, wfs, "DefaultCRS" if version == "2.0.0" else "DefaultSRS", crs_uri("4326"))
        for system in ("CRS84", "3857"):
            element(feature, wfs, "OtherCRS" if version == "2.0.0" else "OtherSRS", crs_uri(system))
        formats = element(feature, wfs, "OutputFormats")
        element(formats, wfs, "Format", "application/gml+xml; version=3.2" if version == "2.0.0" else "text/xml; subtype=gml/3.1.1")
    ns = FES if version == "2.0.0" else OGC
    filters = element(root, ns, "Filter_Capabilities")
    if version == "2.0.0":
        spatial = element(filters, ns, "Spatial_Capabilities")
        operands = element(spatial, ns, "GeometryOperands")
        element(operands, ns, "GeometryOperand", name="gml:Envelope")
        ops = element(spatial, ns, "SpatialOperators")
        element(ops, ns, "SpatialOperator", name="BBOX")
        scalar = element(filters, ns, "Scalar_Capabilities")
        element(scalar, ns, "LogicalOperators")
        comparison = element(scalar, ns, "ComparisonOperators")
        for op in ("PropertyIsEqualTo", "PropertyIsNotEqualTo", "PropertyIsLessThan", "PropertyIsLessThanOrEqualTo",
                   "PropertyIsGreaterThan", "PropertyIsGreaterThanOrEqualTo", "PropertyIsBetween"):
            element(comparison, ns, "ComparisonOperator", name=op)
    return root


def xsd_type(value):
    value = str(value).lower().strip()
    if value.startswith("xsd:"):
        return value
    if value in {"uint64", "uint(64)"}:
        return "xsd:unsignedLong"
    if any(kind in value for kind in ("bigint", "smallint", "tinyint", "integer")) or value == "int" or re.fullmatch(r"u?int(?:8|16|32|64|\((?:8|16|32|64)\))", value):
        return "xsd:long"
    if any(kind in value for kind in ("numeric", "decimal", "money")):
        return "xsd:decimal"
    if any(kind in value for kind in ("float", "double", "real")):
        return "xsd:double"
    if "datetime" in value or value.startswith("timestamp["):
        return "xsd:dateTime"
    if value == "date" or re.fullmatch(r"date(?:32|64)(?:\[[^\]]+\])?", value):
        return "xsd:date"
    if re.fullmatch(r"time(?:\([0-7]\)|(?:32|64)(?:\[[^\]]+\])?)?", value):
        return "xsd:time"
    if value in {"bool", "boolean", "bit"}:
        return "xsd:boolean"
    return "xsd:string"


def describe(layers, version):
    gml = GML32 if version == "2.0.0" else GML31
    root = ET.Element(f"{{{XSD}}}schema", targetNamespace=AZ, elementFormDefault="qualified",
                      attrib={"xmlns:az": AZ, "xmlns:gml": gml})
    element(root, XSD, "import", namespace=gml, schemaLocation=(
        "http://schemas.opengis.net/gml/3.2.1/gml.xsd" if version == "2.0.0" else "http://schemas.opengis.net/gml/3.1.1/base/gml.xsd"))
    for layer in layers:
        type_name = layer["name"] + "Type"
        element(root, XSD, "element", name=layer["name"], type="az:" + type_name,
                substitutionGroup="gml:AbstractFeature" if version == "2.0.0" else "gml:_Feature")
        complex_type = element(root, XSD, "complexType", name=type_name)
        sequence = element(element(element(complex_type, XSD, "complexContent"), XSD, "extension", base="gml:AbstractFeatureType"), XSD, "sequence")
        element(sequence, XSD, "element", name="geometry", type="gml:PointPropertyType", minOccurs="0", nillable="true")
        for column in layer["columns"]:
            field = element(sequence, XSD, "element", name=column["name"], type=xsd_type(column["type"]), minOccurs="0", nillable="true")
            if column.get("source_name"):
                element(element(field, XSD, "annotation"), XSD, "documentation", column["source_name"])
    return root


def _text(value, declaration=None):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, bytes):
        return value.hex()
    if isinstance(value, (float, Decimal)) and not math.isfinite(float(value)):
        return None
    text = str(value)
    if declaration is not None and xsd_type(declaration) == "xsd:dateTime":
        # Arrow timestamp strings use a space; XML Schema requires T. Replace
        # only that separator so SQL's seventh fractional digit is preserved.
        text = re.sub(r"^(\d{4}-\d{2}-\d{2}) ", r"\1T", text)
    # XML 1.0 excludes control characters that can occur in source text.
    return re.sub(r"[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD\U00010000-\U0010FFFF]", "\ufffd", text)


def collection(result, layer_name, system, version, next_url=None, include_geometry=True):
    wfs, gml = (WFS2, GML32) if version == "2.0.0" else (WFS1, GML31)
    items = result.get("items", [])
    attrs = {"timeStamp": datetime.now(timezone.utc).isoformat()}
    if version == "2.0.0":
        attrs.update(numberMatched="unknown" if result.get("total") is None else str(result["total"]), numberReturned=str(len(items)))
    elif result.get("total") is not None:
        attrs["numberOfFeatures"] = str(result["total"])
    if next_url:
        attrs["next"] = next_url
    root = ET.Element(f"{{{wfs}}}FeatureCollection", attrs)
    declarations = {column["name"]: column["type"] for column in result.get("columns", [])}
    for item in items:
        member = element(root, wfs if version == "2.0.0" else gml, "member" if version == "2.0.0" else "featureMember")
        identifier = str(item["id"])
        fid = identifier if identifier.startswith(layer_name + ".") else layer_name + "." + identifier
        feature = element(member, AZ, layer_name, **{f"{{{gml}}}id": fid})
        longitude, latitude = item["longitude"], item["latitude"]
        if include_geometry and longitude is not None and latitude is not None:
            if system == "4326":
                point = (latitude, longitude)
            elif system == "3857":
                if abs(latitude) > 85.0511287798066:
                    raise WFSException("Feature latitude is outside EPSG:3857; request EPSG:4326 or CRS84", "srsName")
                point = (6378137 * math.radians(longitude), 6378137 * math.asinh(math.tan(math.radians(latitude))))
            else:
                point = (longitude, latitude)
            geometry = element(feature, AZ, "geometry")
            geom = element(geometry, gml, "Point", srsName=crs_uri(system), srsDimension="2",
                           **{f"{{{gml}}}id": fid + ".geometry"})
            element(geom, gml, "pos", " ".join(format(value, ".15g") for value in point))
        for key, value in item["properties"].items():
            text = None if value is None else _text(value, declarations.get(key))
            prop = element(feature, AZ, key, text)
            if text is None:
                prop.set(f"{{{XSI}}}nil", "true")
    return root


def register_wfs(router, run, gis_settings, auth_origins=()):
    """Register using the application's authenticated, leased worker runner."""
    active = 0

    async def execute(request, operation, limits):
        nonlocal active
        # Admission occurs without an await, so a single ASGI event loop cannot
        # oversubscribe the configured number of in-flight GIS operations.
        if active >= limits["max_concurrent"]:
            raise WFSException("Feature service is busy; retry shortly", code="NoApplicableCode", status=503)
        active += 1
        try:
            with anyio.fail_after(limits["timeout_sec"]):
                return await run(request, operation, lease=True)
        except TimeoutError:
            raise WFSException("Feature request exceeded its time limit", code="NoApplicableCode", status=504) from None
        finally:
            active -= 1

    @router.api_route("/wfs", methods=["GET", "POST"])
    async def wfs(request: Request):
        try:
            body = None
            if request.method == "POST":
                content_type = request.headers.get("content-type", "").split(";", 1)[0].lower()
                if content_type not in {"text/xml", "application/xml"}:
                    raise WFSException("POST requires an XML content type", "request", status=415)
                chunks, size = [], 0
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_REQUEST_BYTES:
                        raise WFSException("XML request exceeds the byte limit", status=413)
                    chunks.append(chunk)
                body = b"".join(chunks)
            elif len(request.url.query.encode()) > MAX_REQUEST_BYTES:
                raise WFSException("Request exceeds the byte limit", status=413)
            values = parse_request(request.query_params, body)
            limits = getattr(request.state, "wfs_settings", None)
            if limits is None:
                limits = await run(request, lambda job: gis_settings())
            if not limits.get("enabled", False):
                raise WFSException("Feature service is disabled", code="OperationNotSupported", status=503)
            data = request.app.state.wfs_data
            version, operation = values["version"], values["request"]
            origin = str(request.base_url).rstrip("/")
            trusted = next((item.rstrip("/") for item in auth_origins if item.startswith("https://") and item.rstrip("/") == origin), None)
            trusted = trusted or next((item.rstrip("/") for item in auth_origins if item.startswith("https://")), None)
            if trusted is None:
                raise WFSException("Feature service has no configured HTTPS origin", code="NoApplicableCode", status=503)
            endpoint = trusted + request.url.path
            if operation == "GetFeature":
                layer_name, system, query = feature_query(values, limits["page_size"])
                properties = query["properties"]
                include_geometry = properties is None or "geometry" in properties
                if properties is not None:
                    query["properties"] = [prop for prop in properties if prop != "geometry"]
                metadata_probe = query["count"] == 1 and query["bbox"] is None and not query["object_ids"] and not query["filters"] and not query["snapshot"]
                if query["count"] == 0 or metadata_probe:
                    layers = await execute(request, lambda job: data.layers(job), limits)
                    if not any(layer["name"] == layer_name for layer in layers):
                        raise WFSException("Unknown or unpublished feature type", "typeNames")
                    result = {"items": [], "total": None}
                else:
                    result = await execute(request, lambda job: data.features(job, request.state.user["id"], layer_name, **query), limits)
                next_url = None
                if result.get("next_start") is not None and result.get("snapshot"):
                    params = {key: value for key, value in values.items() if key not in {"startindex", "snapshot"}}
                    params.update(startindex=str(result["next_start"]), snapshot=result["snapshot"])
                    next_url = endpoint + "?" + urlencode(params)
                root = collection(result, layer_name, system, version, next_url, include_geometry)
            else:
                layers = await execute(request, lambda job: data.layers(job), limits)
                if operation == "GetCapabilities":
                    root = capabilities(layers, endpoint, version, limits["page_size"])
                else:
                    requested = values.get("typenames", values.get("typename"))
                    if requested:
                        names = [name(value) for value in requested.split(",")]
                        selected = [layer for layer in layers if layer["name"] in names]
                        if len(selected) != len(set(names)):
                            raise WFSException("Unknown or unpublished feature type", "typeNames")
                        layers = selected
                    root = describe(layers, version)
            response = xml_response(root)
            if len(response.body) > limits["max_response_bytes"]:
                raise WFSException("Response exceeds the byte limit; request fewer features or properties", "count", status=413)
            return response
        except WFSException as error:
            return exception_response(error)
        except HTTPException as error:
            return exception_response(WFSException(str(error.detail), "request", "NoApplicableCode", error.status_code))
        except Unavailable:
            return exception_response(WFSException("Feature storage is temporarily unavailable", "request", "NoApplicableCode", 503))
