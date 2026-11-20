"""Bounded, in-memory CSV preview and mapped coordinate validation."""

import csv
import io
import math

from fastapi import HTTPException

from h3search.coordinates import CoordinateError, parse_coordinate


def read_csv(text, settings):
    try:
        size = len(text.encode("utf-8"))
    except UnicodeEncodeError:
        raise HTTPException(422, "CSV must contain valid Unicode text") from None
    if size > settings.max_csv_bytes:
        raise HTTPException(422, "CSV exceeds the configured byte limit")
    reader = csv.reader(io.StringIO(text.removeprefix("\ufeff"), newline=""), strict=True)
    try:
        columns = next(reader)
        if (not columns or len(columns) > settings.max_csv_columns or any(not column.strip() for column in columns)
                or len(set(columns)) != len(columns)):
            raise HTTPException(422, "CSV requires unique, nonblank column headers within the configured limit")
        rows = []
        while True:
            row_number = reader.line_num + 1
            try:
                row = next(reader)
            except StopIteration:
                break
            if len(rows) >= settings.max_csv_rows:
                raise HTTPException(422, "CSV exceeds the configured row limit")
            if any(len(cell) > settings.max_csv_cell_chars for cell in row):
                raise HTTPException(422, f"CSV row {row_number} exceeds the configured cell limit")
            rows.append((row_number, row))
        if any(len(column) > settings.max_csv_cell_chars for column in columns):
            raise HTTPException(422, "CSV header exceeds the configured cell limit")
        return columns, rows
    except StopIteration:
        raise HTTPException(422, "CSV requires a header row") from None
    except csv.Error:
        raise HTTPException(422, "CSV contains malformed quoting or an oversized field") from None


def locations(body, settings):
    columns, rows = read_csv(body.text, settings)
    mapped = [body.latitude_column, body.longitude_column] if body.mode == "latlon" else [body.mgrs_column]
    if any(name is None or name not in columns for name in mapped):
        raise HTTPException(422, "Select existing CSV coordinate columns")
    if len(set(mapped)) != len(mapped):
        raise HTTPException(422, "Latitude and longitude require different columns")
    indices = [columns.index(name) for name in mapped]
    centers, issues = [], []
    for row_number, row in rows:
        try:
            if len(row) != len(columns):
                raise ValueError("Column count does not match the header")
            if body.mode == "latlon":
                try:
                    latitude, longitude = (float(row[index].strip()) for index in indices)
                except ValueError:
                    raise ValueError("Latitude and longitude must be decimal numbers") from None
                if not math.isfinite(latitude) or not math.isfinite(longitude) or not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
                    raise ValueError("Latitude or longitude is outside WGS84 bounds")
            else:
                kind, latitude, longitude = parse_coordinate(row[indices[0]])
                if kind != "mgrs":
                    raise ValueError("Expected an MGRS coordinate")
            centers.append({"latitude": latitude, "longitude": longitude, "row": row_number})
        except (ValueError, CoordinateError) as error:
            issues.append({"row": row_number, "message": str(error)})
    if len(centers) > settings.max_search_centers:
        raise HTTPException(422, "CSV exceeds the configured search center limit")
    return {"centers": centers, "issues": issues, "total_rows": len(rows), "valid_rows": len(centers)}
