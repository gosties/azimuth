"""Size budgets and SQL projections for variable-width feature values."""

import json

from fastapi import HTTPException

from .storage import quote

TEXT = frozenset({
    "char", "nchar", "varchar", "nvarchar", "text", "ntext", "xml", "uniqueidentifier",
    "datetime", "datetime2", "datetimeoffset", "smalldatetime", "time", "string", "large_string", "string_view",
})
BINARY = frozenset({"binary", "varbinary", "image", "timestamp", "rowversion", "geometry", "geography",
                    "large_binary", "fixed_size_binary", "binary_view"})
SCALAR = frozenset({"bigint", "int", "smallint", "tinyint", "bit", "real", "float", "double", "halffloat",
                    "decimal", "numeric", "money", "smallmoney", "date", "decimal128", "decimal256",
                    "bool", "int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64",
                    "date32", "date64", "time32", "time64", "duration"})


def value_kind(column):
    """Resolve a storage kind from immutable metadata or a known legacy declaration."""
    kind = column.get("value_kind")
    if kind in {"text", "binary", "scalar"}:
        return kind
    declaration = column["type"].lower()
    base = declaration.split("(", 1)[0].split("[", 1)[0]
    if base in TEXT:
        return "text"
    if base in BINARY:
        return "scalar" if declaration.startswith("timestamp[") else "binary"
    if base in SCALAR:
        return "scalar"
    raise HTTPException(409, "This publication needs source type metadata. Remove and reload the dataset.")


def size_plan(settings, columns, requested_rows, *, headers=None):
    """Bound wire size before execution, adjusting page length for very wide schemas."""
    def encoded_size(value):
        return len(json.dumps(value, ensure_ascii=False).encode("utf-8"))

    names = [(encoded_size(column["name"]), encoded_size(column["type"])) for column in columns]
    variable_count = sum(value_kind(column) != "scalar" for column in columns)
    # Include column headers, identity/cursor fields, scalar encodings and the
    # per-field truncation envelope. Escaped JSON strings can use 6 bytes per character.
    headers = columns if headers is None else headers
    header = 2048 + sum(encoded_size(column["name"]) + encoded_size(column["type"]) + 32 for column in headers)
    row = 256 + sum(2 * name + datatype + 160 for name, datatype in names)
    available = settings.wide_response_budget_bytes - header
    limit = min(requested_rows, available // (row + variable_count * 6))
    if limit < 1:
        raise HTTPException(413, "The source schema exceeds the configured wide response budget")
    preview = settings.wide_value_preview_chars
    if variable_count:
        preview = min(preview, (available // limit - row) // (variable_count * 6))
    return limit, preview


def slice_projection(column, kind, local, offset, limit):
    """Project a bounded text or binary slice and its original length in SQL."""
    name = quote(column["physical_name"])
    if local and kind == "binary":
        return f"{name}[{offset + 1}:{offset + limit}]", f"octet_length({name})"
    return f"substr({name}, {offset + 1}, {limit})", f"length({name})"


def length_unit(kind):
    """Return the offset unit of a variable-width source field."""
    return "bytes" if kind == "binary" else "characters"
