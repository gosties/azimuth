"""Published temporal declarations and precision-preserving calendar dates."""

import re

from .storage import quote


def temporal_kind(column):
    """Recognize SQL date families; SQL timestamp is a binary row version."""
    declaration = column["type"].lower().strip()
    if re.fullmatch(r"date|datetime|smalldatetime|(?:datetime2|datetimeoffset)(?:\([0-7]\))?", declaration):
        return declaration.split("(", 1)[0]
    return None


def day_expression(column, local):
    value = quote(column["physical_name"])
    kind = temporal_kind(column)
    if kind == "date":
        return value
    if kind != "datetimeoffset":
        return f"substr({value}, 1, 10)"
    # Whole seconds suffice for a UTC calendar day: offsets have minute precision.
    # Truncating the fraction avoids rounding datetimeoffset(7) across midnight.
    stamp = f"CAST(replace(substr({value}, 1, 19), 'T', ' ') AS TIMESTAMP)"
    suffix = f"substr({value}, length({value}) - 5, 6)"
    offset = (f"CASE WHEN substr({value}, length({value}), 1) = 'Z' THEN 0 ELSE "
              f"(CASE WHEN substr({suffix}, 1, 1) = '-' THEN -1 ELSE 1 END) * "
              f"(CAST(substr({suffix}, 2, 2) AS INTEGER) * 60 + CAST(substr({suffix}, 5, 2) AS INTEGER)) END")
    utc = f"({stamp} - ({offset}) * INTERVAL '1 minute')" if local else f"date_add('minute', -({offset}), {stamp})"
    return f"CAST(CAST({utc} AS DATE) AS VARCHAR)"


def canonical_instant(value):
    """Normalize explicit-offset ISO instants without losing SQL's seventh digit."""
    from datetime import datetime, timedelta, timezone
    if not isinstance(value, str):
        raise ValueError("Use an ISO datetime with an explicit UTC offset")
    match = re.fullmatch(r"(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}:\d{2})", value)
    if not match:
        raise ValueError("Use an ISO datetime with an explicit UTC offset and at most seven fractional digits")
    day, clock, fraction, offset = match.groups()
    if offset != "Z" and (int(offset[1:3]) > 23 or int(offset[4:]) > 59):
        raise ValueError("Invalid UTC offset")
    try:
        whole = datetime.fromisoformat(day + "T" + clock + ("+00:00" if offset == "Z" else offset)).astimezone(timezone.utc)
    except OverflowError as error:
        raise ValueError("UTC instant is outside the supported date range") from error
    return whole.isoformat(timespec="seconds")[:19] + "." + (fraction or "").ljust(7, "0") + "Z"


def instant_expression(column, local):
    """Canonical UTC string: second arithmetic and untouched seven-digit fraction."""
    value = quote(column["physical_name"])
    if temporal_kind(column) == "date":
        return f"CASE WHEN {value} IS NULL THEN NULL ELSE concat(CAST({value} AS VARCHAR), 'T00:00:00.0000000Z') END"
    stamp = f"CAST(replace(substr({value}, 1, 19), 'T', ' ') AS TIMESTAMP)"
    if temporal_kind(column) == "datetimeoffset":
        suffix = f"substr({value}, length({value}) - 5, 6)"
        offset = (f"CASE WHEN substr({value}, length({value}), 1) = 'Z' THEN 0 ELSE "
                  f"(CASE WHEN substr({suffix}, 1, 1) = '-' THEN -1 ELSE 1 END) * "
                  f"(CAST(substr({suffix}, 2, 2) AS INTEGER) * 60 + CAST(substr({suffix}, 5, 2) AS INTEGER)) END")
        stamp = f"({stamp} - ({offset}) * INTERVAL '1 minute')" if local else f"date_add('minute', -({offset}), {stamp})"
    whole = f"strftime({stamp}, '%Y-%m-%dT%H:%M:%S')" if local else f"format_datetime({stamp}, 'yyyy-MM-dd''T''HH:mm:ss')"
    fraction = f"regexp_extract(substr({value}, 20), '^\\.([0-9]+)', 1)"
    return f"CASE WHEN {value} IS NULL THEN NULL ELSE concat({whole}, '.', rpad(coalesce({fraction}, ''), 7, '0'), 'Z') END"
