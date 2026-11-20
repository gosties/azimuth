"""Input validation and session-scoped keyset cursors."""

import base64
import binascii
import hashlib
import hmac
import json
import re
from datetime import date
from typing import Annotated, Literal
from uuid import UUID

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class CenterInput(Input):
    latitude: float = Field(ge=-90, le=90, strict=True)
    longitude: float = Field(ge=-180, le=180, strict=True)


class TimeFilterInput(Input):
    start_at: str | None = None
    end_at: str | None = None

    @field_validator("start_at", "end_at", mode="before")
    @classmethod
    def instant(cls, value):
        from .temporal import canonical_instant
        return canonical_instant(value) if value is not None else None

    start_date: date | None = None
    end_date: date | None = None

    @field_validator("start_date", "end_date", mode="before")
    @classmethod
    def calendar_date(cls, value):
        if value is not None and (not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value)):
            raise ValueError("Use YYYY-MM-DD")
        return value

    @model_validator(mode="after")
    def ordered(self):
        if (self.start_at or self.end_at) and (self.start_date or self.end_date):
            raise ValueError("Choose calendar dates or UTC instants, not both")
        if self.start_at and self.end_at and self.start_at > self.end_at:
            raise ValueError("Start instant must be at or before end instant")
        if self.start_date and self.end_date and self.start_date > self.end_date:
            raise ValueError("Start date must be at or before end date")
        return self


class SearchInput(Input):
    latitude: float | None = Field(default=None, ge=-90, le=90, strict=True)
    longitude: float | None = Field(default=None, ge=-180, le=180, strict=True)
    centers: list[CenterInput] | None = Field(default=None, min_length=1)
    radius_m: float = Field(gt=0, strict=True)
    dataset_ids: list[UUID] | None = Field(default=None, max_length=1000)
    time_filter: TimeFilterInput | None = None
    lookup_mode: Literal["partitioned", "single_file"] = "partitioned"

    @field_validator("dataset_ids")
    @classmethod
    def unique_ids(cls, value):
        return None if value is None else list(dict.fromkeys(value))

    @model_validator(mode="after")
    def center_selection(self):
        if self.centers is not None:
            if self.latitude is not None or self.longitude is not None:
                raise ValueError("Choose centers or a single latitude and longitude")
        elif self.latitude is None or self.longitude is None:
            raise ValueError("Latitude and longitude are required")
        return self



def validate_search_limits(body, settings):
    if body.radius_m > settings.max_radius_m:
        raise HTTPException(422, "Search radius exceeds the configured maximum")
    if body.centers is not None and len(body.centers) > settings.max_search_centers:
        raise HTTPException(422, "Search exceeds the configured center limit")


class CSVInput(Input):
    text: str


class CSVLocationsInput(CSVInput):
    mode: Literal["latlon", "mgrs"]
    latitude_column: str | None = None
    longitude_column: str | None = None
    mgrs_column: str | None = None


class DatasetMetadataInput(Input):
    description: str | None = Field(default=None, max_length=4000)
    datetime_column: str | None = Field(default=None, min_length=1, max_length=256)
    category_ids: list[UUID] | None = Field(default=None, max_length=100)

    @model_validator(mode="after")
    def valid_update(self):
        if not self.model_fields_set:
            raise ValueError("Specify description, datetime_column or category_ids")
        if "description" in self.model_fields_set and self.description is None:
            raise ValueError("Description must be text")
        if "category_ids" in self.model_fields_set and self.category_ids is None:
            raise ValueError("Categories must be a list")
        return self


class CategoryInput(Input):
    name: str = Field(min_length=1, max_length=200)


class ExportSettingsInput(Input):
    source: Literal["iceberg", "sqlserver"]


class MapsInput(Input):
    maps: list[dict] = Field(max_length=100)
    default_map_id: str | None = Field(max_length=128)


class PointsInput(Input):
    west: float = Field(ge=-180, le=180, strict=True)
    south: float = Field(ge=-90, le=90, strict=True)
    east: float = Field(ge=-180, le=180, strict=True)
    north: float = Field(ge=-90, le=90, strict=True)
    zoom: float = Field(ge=0, le=30, strict=True)
    limit: int = Field(default=3000, ge=1, strict=True)
    dataset_ids: list[UUID] | None = Field(default=None, max_length=1000)


class AggregatesInput(Input):
    west: float = Field(ge=-180, le=180, strict=True)
    south: float = Field(ge=-90, le=90, strict=True)
    east: float = Field(ge=-180, le=180, strict=True)
    north: float = Field(ge=-90, le=90, strict=True)
    zoom: float = Field(ge=0, le=30, strict=True)
    mode: Literal["clusters", "hexes"]
    columns: int = Field(ge=1, le=2**40, strict=True)
    dataset_ids: list[UUID] | None = Field(default=None, max_length=1000)


class PointsStreamInput(PointsInput):
    limit: int = Field(default=3000, ge=0, strict=True)
    cursor: str | None = Field(default=None, max_length=768)

    @model_validator(mode="after")
    def checkpoint_required(self):
        if self.limit == 0 and self.cursor is None:
            raise ValueError("A cursor is required when no additional points are requested")
        return self


class DescriptionInput(Input):
    description: str = Field(max_length=4000)


class ColumnPreferences(Input):
    hidden_columns: list[Annotated[str, Field(min_length=1, max_length=256)]] = Field(max_length=1100)


CORE_COLUMN_KEYS = {"core:object_id", "core:latitude", "core:longitude", "core:distance_m"}


class DatasetInput(DescriptionInput):
    description: str = ""
    name: str = Field(min_length=1, max_length=200)
    connection_name: str = Field(min_length=1, max_length=128)
    source_schema: str = Field(min_length=1, max_length=128)
    source_table: str = Field(min_length=1, max_length=128)
    object_id_column: str = Field(min_length=1, max_length=128)
    latitude_column: str | None = Field(default=None, min_length=1, max_length=128)
    longitude_column: str | None = Field(default=None, min_length=1, max_length=128)
    geometry_column: str | None = Field(default=None, min_length=1, max_length=128)
    source_srid: Literal[4326] = 4326
    mode: Literal["insert", "cdc"]
    capture_instance: str | None = Field(default=None, min_length=1, max_length=128)

    @field_validator("name", "connection_name", "source_schema", "source_table", "object_id_column", "latitude_column", "longitude_column", "capture_instance", "geometry_column")
    @classmethod
    def reject_blank(cls, value):
        if value is not None and (not value.strip() or "\x00" in value):
            raise ValueError("Must be nonblank and contain no NUL characters")
        return value

    @model_validator(mode="after")
    def validate_registration(self):
        if self.geometry_column:
            if self.latitude_column or self.longitude_column:
                raise ValueError("Choose one location source")
        elif not (self.latitude_column and self.longitude_column):
            raise ValueError("Latitude and longitude columns are required for coordinate locations")
        if self.mode == "cdc" and not self.capture_instance:
            raise ValueError("A capture instance is required for CDC mode")
        if self.mode == "insert" and self.capture_instance is not None:
            raise ValueError("A capture instance is available for CDC mode")
        return self


PUBLIC_DATASET_FIELDS = (
    "id", "name", "description", "status", "searchable_count", "mode",
    "source_schema", "source_table", "connection_name", "object_id_column",
    "latitude_column", "longitude_column", "geometry_column", "source_srid",
    "datetime_column", "category_ids",
)


def object_key(value: str) -> int:
    """Parse a canonical signed 64-bit decimal object key."""
    if len(value) <= 20 and re.fullmatch(r"0|-?[1-9][0-9]*", value):
        number = int(value)
        if -(1 << 63) <= number < (1 << 63):
            return number
    raise HTTPException(422, "Invalid OBJECTID")


def _sign_cursor(session, scope, values) -> str:
    payload = json.dumps([session["id"], scope, *values], separators=(",", ":")).encode()
    signature = hmac.digest(bytes.fromhex(session["query"]["cursor_secret"]), payload, hashlib.sha256)
    return base64.urlsafe_b64encode(signature + payload).decode().rstrip("=")


def _cursor_values(session, scope, token):
    raw = base64.b64decode(token + "=" * (-len(token) % 4), altchars=b"-_", validate=True)
    signature, payload = raw[:32], raw[32:]
    expected = hmac.digest(bytes.fromhex(session["query"]["cursor_secret"]), payload, hashlib.sha256)
    if not hmac.compare_digest(signature, expected):
        raise ValueError
    session_id, actual_scope, *values = json.loads(payload)
    if session_id != session["id"] or actual_scope != scope:
        raise ValueError
    return values


def encode_cursor(session, scope, key) -> str:
    """Sign a stable page boundary for a session and result scope."""
    return _sign_cursor(session, scope, (key[0], str(key[1])))


def decode_cursor(session, scope, token: str | None) -> tuple[str, int] | None:
    """Validate a page boundary against the current session and result scope."""
    if token is None:
        return None
    try:
        table, key = _cursor_values(session, scope, token)
        if table not in session["query"]["dataset_ids"]:
            raise ValueError
        return table, object_key(key)
    except (ValueError, TypeError, binascii.Error, HTTPException):
        raise HTTPException(422, "Invalid cursor for this result") from None


def encode_point_cursor(session, scope, key, matched_total, returned):
    rank, cell_hash, table, object_id = key
    return _sign_cursor(session, scope, (rank, cell_hash, table, str(object_id), matched_total, returned))


def decode_point_cursor(session, scope, token):
    try:
        rank, cell_hash, table, object_id, matched_total, returned = _cursor_values(session, scope, token)
        if (type(rank) is not int or type(cell_hash) is not int or type(matched_total) is not int
                or type(returned) is not int or not 0 < rank <= returned <= matched_total < 1 << 63
                or not 0 <= cell_hash < 2147483647 or table not in session["query"]["dataset_ids"]):
            raise ValueError
        return (rank, cell_hash, table, object_key(object_id)), matched_total, returned
    except (ValueError, TypeError, binascii.Error, HTTPException):
        raise HTTPException(422, "Invalid cursor for this viewport") from None
