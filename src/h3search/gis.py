"""Revocable GIS credentials and durable WFS service limits."""

import hashlib
import hmac
import json
import secrets

from .auth import Accounts, PermissionDenied, _token_hash
from .models import utc_now

DEFAULTS = dict(enabled=True, max_features=10000, max_diagonal_m=10000,
                page_size=1000, timeout_sec=10, max_response_bytes=10 * 1024 * 1024,
                max_concurrent=2, paging_ttl_sec=300, max_paging_sessions=256,
                max_paging_sessions_per_user=8)


class GisAccess:
    def __init__(self, registry):
        self.registry = registry
        self.accounts = Accounts(registry)

    def settings(self):
        with self.registry.connect() as conn:
            row = conn.execute("SELECT payload FROM app_settings WHERE key='wfs'").fetchone()
        return {**DEFAULTS, **(json.loads(row['payload']) if row else {})}

    def save_settings(self, token, value):
        with self.accounts._write() as conn:
            self.accounts._superadmin(conn, token)
            conn.execute("INSERT INTO app_settings (key,payload) VALUES ('wfs',?) "
                         "ON CONFLICT(key) DO UPDATE SET payload=excluded.payload", (json.dumps(value),))
        return value

    def credential(self, token, rotate=False, revoke=False):
        with self.accounts._write() as conn:
            user = self.accounts._session(conn, _token_hash(token))
            if user is None:
                raise PermissionDenied()
            if rotate or revoke:
                conn.execute("DELETE FROM gis_credentials WHERE account_id=?", (user['id'],))
            if rotate:
                username, password = 'gis_' + secrets.token_hex(12), secrets.token_urlsafe(32)
                created = utc_now()
                conn.execute("INSERT INTO gis_credentials (account_id,username,secret_hash,created_at) VALUES (?,?,?,?)",
                             (user['id'], username, hashlib.sha256(password.encode()).hexdigest(), created))
                return dict(username=username, password=password, created_at=created)
            row = conn.execute("SELECT username,created_at FROM gis_credentials WHERE account_id=?", (user['id'],)).fetchone()
            return dict(row) if row else None

    def authenticate(self, username, password, address):
        digest = hashlib.sha256(password.encode('utf-8')).hexdigest()
        with self.registry.connect() as conn:
            row = conn.execute("SELECT a.id,a.email,a.role,g.secret_hash FROM gis_credentials g "
                               "JOIN accounts a ON a.id=g.account_id WHERE g.username=? AND a.active=1", (username,)).fetchone()
        if row and hmac.compare_digest(digest, row['secret_hash']):
            return {key: row[key] for key in ('id', 'email', 'role')}
        with self.accounts._write() as conn:
            self.accounts._consume_attempt(conn, 'gis:' + (username[:254] or address), 'gis:' + address)
        return None
