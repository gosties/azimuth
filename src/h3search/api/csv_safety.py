"""Spreadsheet-safe text cells shared by the CSV export paths."""


def spreadsheet_cell(value):
    """Quote formula and leading whitespace/control text without changing numbers."""
    if isinstance(value, str) and value:
        first = value[0]
        if first in "=+-@" or first.isspace() or ord(first) < 32 or 127 <= ord(first) <= 159 or first in "\u200b\u200c\u200d\u2060\ufeff":
            return "'" + value
    return value
