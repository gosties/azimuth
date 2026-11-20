"""Load and seed optional application release metadata."""

import json
from importlib.resources import files


def release_entries():
    resource = files(__package__).joinpath("data", "releases.json")
    return json.loads(resource.read_text(encoding="utf-8")) if resource.is_file() else []


def seed_release_notes(conn):
    conn.executemany(
        "INSERT INTO release_notes (version, released_on, title, changes, release_order) "
        "VALUES (?, ?, ?, ?, ?) ON CONFLICT (version) DO NOTHING",
        [(version, date, title, json.dumps(changes), index)
         for index, (version, date, title, changes) in enumerate(release_entries(), start=1)],
    ).close()
