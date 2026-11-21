"""Control-store account and authentication session operations."""

import hashlib
import hmac
import re
import secrets
import time
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

from .control import ConflictError
from .models import new_id, utc_now

COOKIE_NAME = "azimuth_session"
ROLES = {"user": 0, "admin": 1, "superadmin": 2}
PASSWORD_MAX = 1024
ITERATIONS = 600_000
LOGIN_WINDOW_SEC = 300
_MAX_LOGIN_SUBJECTS = 8192
_EMAIL = re.compile(r"[^@\s\x00-\x1f\x7f]+@[^@\s\x00-\x1f\x7f]+")
_TOKEN = re.compile(r"[A-Za-z0-9_-]{43}", re.ASCII)
_DUMMY_HASH = "pbkdf2-sha256$600000$" + "0" * 32 + "$" + "0" * 64
_PUBLIC = ("id", "email", "role", "active", "created_at")


class AccountError(ValueError):
    """An invalid account input or an account that does not exist."""


class PermissionDenied(Exception):
    """The actor's management session is no longer authorized."""


class LoginThrottled(Exception):
    """Too many attempts in the fixed login window."""


def _email(value):
    return value.strip().casefold()


def _new_email(value):
    value = _email(value)
    if len(value) > 254 or not _EMAIL.fullmatch(value):
        raise AccountError("Enter a valid email address")
    return value


def _password_hash(password):
    if not 1 <= len(password) <= PASSWORD_MAX or not password.strip():
        raise AccountError(f"Password must contain between 1 and {PASSWORD_MAX} characters")
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, ITERATIONS)
    return f"pbkdf2-sha256${ITERATIONS}${salt.hex()}${digest.hex()}"


def _password_matches(password, stored):
    algorithm, iterations, salt, digest = stored.split("$")
    if algorithm != "pbkdf2-sha256" or int(iterations) != ITERATIONS:
        return False
    candidate = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), ITERATIONS)
    return hmac.compare_digest(candidate, bytes.fromhex(digest))


def _token_hash(token):
    return hashlib.sha256(token.encode("ascii")).hexdigest() if token and _TOKEN.fullmatch(token) else None


def _public(row):
    account = {key: row[key] for key in _PUBLIC}
    account["active"] = bool(account["active"])
    return account


class Accounts:
    """Manage credentials separately from datasets and frozen search sessions."""

    def __init__(self, registry):
        self.registry = registry

    @contextmanager
    def _write(self):
        with self.registry.connect() as conn:
            # PostgreSQL locks this row; SQLite serializes writers on the first statement.
            conn.execute("UPDATE account_mutex SET singleton=1 WHERE singleton=1")
            yield conn

    @staticmethod
    def _session(conn, token_hash):
        if token_hash is None:
            return None
        row = conn.execute(
            "SELECT a.id,a.email,a.role,s.csrf_token,s.expires_at FROM login_sessions s "
            "JOIN accounts a ON a.id=s.account_id WHERE s.token_hash=? AND s.expires_at>? AND a.active=1",
            (token_hash, utc_now()),
        ).fetchone()
        return dict(row) if row else None

    def session(self, token):
        token_hash = _token_hash(token)
        if token_hash is None:
            return None
        with self.registry.connect() as conn:
            return self._session(conn, token_hash)

    @classmethod
    def _superadmin(cls, conn, token):
        session = cls._session(conn, _token_hash(token))
        if session is None or session["role"] != "superadmin":
            raise PermissionDenied

    @staticmethod
    def _consume_attempt(conn, email, address):
        now = int(time.time())
        conn.execute("DELETE FROM login_attempts WHERE window_start<=?", (now - LOGIN_WINDOW_SEC,))
        for scope, value, limit in (("email", email, 8), ("address", address, 30)):
            digest = hashlib.sha256(value.encode()).hexdigest()
            row = conn.execute(
                "SELECT window_start,attempts FROM login_attempts WHERE scope=? AND subject_hash=?", (scope, digest),
            ).fetchone()
            if row and row["attempts"] >= limit:
                raise LoginThrottled(row["window_start"] + LOGIN_WINDOW_SEC - now)
            if not row:
                count = conn.execute("SELECT count(*) AS total FROM login_attempts").fetchone()["total"]
                if count >= _MAX_LOGIN_SUBJECTS:
                    raise LoginThrottled(LOGIN_WINDOW_SEC)
            conn.execute(
                "INSERT INTO login_attempts (scope,subject_hash,window_start,attempts) VALUES (?,?,?,1) "
                "ON CONFLICT(scope,subject_hash) DO UPDATE SET attempts=login_attempts.attempts+1",
                (scope, digest, now),
            )

    def login(self, email, password, address, prior_token=None):
        email = _email(email)
        with self._write() as conn:
            self._consume_attempt(conn, email, address)
            observed = conn.execute("SELECT id,password_hash,active FROM accounts WHERE email=?", (email,)).fetchone()
        stored = observed["password_hash"] if observed and observed["active"] else _DUMMY_HASH
        if not _password_matches(password, stored) or not observed or not observed["active"]:
            return None

        with self._write() as conn:
            current = conn.execute(
                "SELECT id,email,role,password_hash FROM accounts WHERE id=? AND active=1", (observed["id"],),
            ).fetchone()
            if not current or current["password_hash"] != stored:
                return None
            token = secrets.token_urlsafe(32)
            csrf = secrets.token_urlsafe(32)
            expires = (datetime.now(UTC) + timedelta(seconds=self.registry.settings.auth_session_ttl_sec)).isoformat()
            conn.execute("DELETE FROM login_sessions WHERE expires_at<=? OR token_hash=?", (utc_now(), _token_hash(prior_token)))
            conn.execute(
                "INSERT INTO login_sessions (token_hash,account_id,csrf_token,expires_at) VALUES (?,?,?,?)",
                (_token_hash(token), current["id"], csrf, expires),
            )
            user = {key: current[key] for key in ("id", "email", "role")}
            return token, {"user": user, "csrf_token": csrf, "expires_at": expires}

    def change_password(self, token, current_password, new_password, address):
        token_hash = _token_hash(token)
        with self._write() as conn:
            session = self._session(conn, token_hash)
            if session is None:
                raise PermissionDenied()
            account_id = session["id"]
            self._consume_attempt(conn, "password:" + account_id, "password:" + address)
            stored = conn.execute("SELECT password_hash FROM accounts WHERE id=?", (account_id,)).fetchone()["password_hash"]
        if not _password_matches(current_password, stored):
            raise AccountError("Current password is incorrect.")
        new_hash = _password_hash(new_password)
        with self._write() as conn:
            if self._session(conn, token_hash) is None:
                raise PermissionDenied()
            changed = conn.execute(
                "UPDATE accounts SET password_hash=? WHERE id=? AND password_hash=?",
                (new_hash, account_id, stored),
            )
            if changed.rowcount != 1:
                raise ConflictError("Password changed elsewhere. Try again using your current password.")
            conn.execute("DELETE FROM login_sessions WHERE account_id=? AND token_hash<>?", (account_id, token_hash))

    def logout(self, token):
        token_hash = _token_hash(token)
        if token_hash is not None:
            with self._write() as conn:
                conn.execute("DELETE FROM login_sessions WHERE token_hash=?", (token_hash,))

    def list(self, token):
        with self.registry.connect() as conn:
            self._superadmin(conn, token)
            return [_public(row) for row in conn.execute(
                "SELECT id,email,role,active,created_at FROM accounts ORDER BY email",
            ).fetchall()]

    def create(self, email, password, role, *, token=None, bootstrap=False):
        email = _new_email(email)
        if role not in ROLES:
            raise AccountError("Invalid account role")
        password_hash = _password_hash(password)
        with self._write() as conn:
            if bootstrap:
                if role != "superadmin" or conn.execute("SELECT 1 FROM accounts LIMIT 1").fetchone():
                    raise ConflictError("An account already exists. Bootstrap only creates the first superadmin.")
            else:
                self._superadmin(conn, token)
            if conn.execute("SELECT 1 FROM accounts WHERE email=?", (email,)).fetchone():
                raise ConflictError("An account with that email already exists")
            account = {"id": new_id(), "email": email, "role": role, "active": True, "created_at": utc_now()}
            conn.execute(
                "INSERT INTO accounts (id,email,role,active,password_hash,created_at) VALUES (?,?,?,1,?,?)",
                (account["id"], email, role, password_hash, account["created_at"]),
            )
        return account

    @staticmethod
    def _account(conn, account_id):
        row = conn.execute(
            "SELECT id,email,role,active,created_at FROM accounts WHERE id=?", (account_id,),
        ).fetchone()
        if row is None:
            raise KeyError(account_id)
        return _public(row)

    @staticmethod
    def _retain_superadmin(conn, account):
        if account["active"] and account["role"] == "superadmin":
            other = conn.execute(
                "SELECT 1 FROM accounts WHERE active=1 AND role='superadmin' AND id<>? LIMIT 1", (account["id"],),
            ).fetchone()
            if not other:
                raise ConflictError("At least one active superadmin is required")

    def update(self, token, account_id, *, role=None, active=None):
        with self._write() as conn:
            self._superadmin(conn, token)
            account = self._account(conn, account_id)
            role = account["role"] if role is None else role
            active = account["active"] if active is None else active
            if role not in ROLES:
                raise AccountError("Invalid account role")
            if role != "superadmin" or not active:
                self._retain_superadmin(conn, account)
            conn.execute("UPDATE accounts SET role=?,active=? WHERE id=?", (role, int(active), account_id))
            if not active:
                conn.execute("DELETE FROM login_sessions WHERE account_id=?", (account_id,))
                conn.execute("DELETE FROM gis_credentials WHERE account_id=?", (account_id,))
            return self._account(conn, account_id)

    def reset_password(self, token, account_id, password):
        password_hash = _password_hash(password)
        with self._write() as conn:
            self._superadmin(conn, token)
            self._account(conn, account_id)
            conn.execute("UPDATE accounts SET password_hash=? WHERE id=?", (password_hash, account_id))
            conn.execute("DELETE FROM login_sessions WHERE account_id=?", (account_id,))

    def delete(self, token, account_id):
        with self._write() as conn:
            self._superadmin(conn, token)
            self._retain_superadmin(conn, self._account(conn, account_id))
            conn.execute("DELETE FROM accounts WHERE id=?", (account_id,))
