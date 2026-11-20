"""Shared serialization helpers for immutable data publications."""

from datetime import datetime, timezone
from uuid import uuid4


def utc_now() -> str:
    """Return an ISO 8601 UTC timestamp suitable for durable state."""
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    """Return a new globally unique immutable identifier."""
    return str(uuid4())
