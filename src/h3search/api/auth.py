"""Authentication, CSRF checks, and account management HTTP routes."""

import hmac
import base64
import binascii
import logging
from typing import Literal
from uuid import UUID

import anyio
from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import Field, model_validator

from h3search.auth import AccountError, Accounts, COOKIE_NAME, LoginThrottled, PASSWORD_MAX, PermissionDenied, ROLES
from h3search.control import ConflictError
from h3search.gis import GisAccess

from .models import Input

Role = Literal["user", "admin", "superadmin"]
_PUBLIC = {("GET", "/api/health"), ("GET", "/api/auth/me"), ("POST", "/api/auth/login")}
_MUTATIONS = {"POST", "PATCH", "PUT", "DELETE"}
_UNAUTHENTICATED = {"user": None, "csrf_token": None}
LOG = logging.getLogger(__name__)


class PasswordInput(Input):
    password: str = Field(min_length=1, max_length=PASSWORD_MAX)


class LoginInput(PasswordInput):
    email: str = Field(min_length=1, max_length=254)

class ChangePasswordInput(PasswordInput):
    current_password: str = Field(min_length=1, max_length=PASSWORD_MAX)


class CreateAccount(LoginInput):
    role: Role


class UpdateAccount(Input):
    role: Role | None = None
    active: bool | None = Field(default=None, strict=True)

    @model_validator(mode="after")
    def nonempty(self):
        if not self.model_fields_set or any(getattr(self, key) is None for key in self.model_fields_set):
            raise ValueError("Provide a role or active state")
        return self


class WfsSettings(Input):
    enabled: bool = Field(strict=True)
    max_features: int = Field(ge=1, le=100000, strict=True)
    max_diagonal_m: int = Field(ge=1, le=100000, strict=True)
    page_size: int = Field(ge=1, le=10000, strict=True)
    timeout_sec: int = Field(ge=1, le=60, strict=True)
    max_response_bytes: int = Field(ge=1024, le=104857600, strict=True)
    max_concurrent: int = Field(ge=1, le=16, strict=True)
    paging_ttl_sec: int = Field(default=300, ge=30, le=3600, strict=True)
    max_paging_sessions: int = Field(default=256, ge=1, le=4096, strict=True)
    max_paging_sessions_per_user: int = Field(default=8, ge=1, le=128, strict=True)

    @model_validator(mode="after")
    def page_limit(self):
        if self.page_size > self.max_features:
            raise ValueError("Page size cannot exceed the feature limit")
        return self


def require_role(request, role):
    if ROLES[request.state.user["role"]] < ROLES[role]:
        raise HTTPException(403, "This account does not have the required role")


def minimum_role(method: str, path: str) -> str:
    """Apply role floors independently of individual endpoint implementations.

    All backend routes require a session unless their exact method and path are
    in _PUBLIC. New administration routes inherit the administration floor;
    account and category subtrees always require a superadministrator.
    """
    parts = path.strip("/").split("/")
    if parts[:2] == ["api", "admin"]:
        return "superadmin" if len(parts) > 2 and parts[2] in {"users", "categories", "feedback", "announcements", "wfs"} else "admin"
    if parts[:2] == ["api", "datasets"]:
        if method in {"POST", "PUT", "PATCH", "DELETE"} or (len(parts) == 4 and parts[3] == "columns"):
            return "admin"
    return "user"


class AuthAPI:
    """Check a current login for each request and bound expensive password work."""

    def __init__(self, registry):
        self.accounts = Accounts(registry)
        self.gis = GisAccess(registry)
        self.settings = registry.settings
        self.origins = frozenset(self.settings.auth_origins)
        self.hash_workers = anyio.Semaphore(2)

    async def authorize(self, request):
        """Return an error response or attach the current principal to the request."""
        path, method = request.url.path, request.method
        if path == "/api/wfs":
            return await self.authorize_gis(request)
        token = request.cookies.get(COOKIE_NAME)
        request.state.auth_token = token
        public = (method, path) in _PUBLIC
        user = await anyio.to_thread.run_sync(self.accounts.session, token) if token and path != "/api/health" else None
        request.state.user = user
        if user is None and not public:
            return JSONResponse({"detail": "Sign in required"}, status_code=401)
        if not public and ROLES[user["role"]] < ROLES[minimum_role(method, path)]:
            return JSONResponse({"detail": "This account does not have the required role"}, status_code=403)
        if method in _MUTATIONS:
            origin = request.headers.get("origin")
            fetch_site = request.headers.get("sec-fetch-site")
            if origin not in self.origins or (fetch_site is not None and fetch_site != "same-origin"):
                return JSONResponse({"detail": "Request origin is not allowed"}, status_code=403)
            content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
            if content_type != "application/json":
                return JSONResponse({"detail": "Send an application/json request body"}, status_code=415)
            if not public:
                supplied = request.headers.get("x-csrf-token", "").encode()
                if not hmac.compare_digest(supplied, user["csrf_token"].encode()):
                    return JSONResponse({"detail": "Invalid CSRF token"}, status_code=403)
        return None

    @staticmethod
    def gis_error(message, status=401, retry=None):
        from xml.sax.saxutils import escape
        headers = {"Cache-Control": "no-store"}
        if status == 401:
            headers["WWW-Authenticate"] = 'Basic realm="Azimuth GIS", charset="UTF-8"'
        if retry is not None:
            headers["Retry-After"] = str(retry)
        return Response('<?xml version="1.0" encoding="UTF-8"?>'
                        '<ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/1.1" version="2.0.0">'
                        '<ows:Exception exceptionCode="OperationProcessingFailed"><ows:ExceptionText>'
                        + escape(message) + '</ows:ExceptionText></ows:Exception></ows:ExceptionReport>',
                        status_code=status, media_type="application/xml", headers=headers)

    async def authorize_gis(self, request):
        # Only ASGI's scheme is authoritative; the server validates trusted proxy headers.
        if request.url.scheme != "https":
            return self.gis_error("GIS connections require HTTPS", 403)
        try:
            authorization = request.headers.get("authorization", "")
            scheme, encoded = authorization.split(" ", 1)
            if scheme.lower() != "basic" or len(encoded) > 4096:
                raise ValueError()
            username, password = base64.b64decode(encoded, validate=True).decode("utf-8").split(":", 1)
        except (ValueError, UnicodeError, binascii.Error):
            username, password = "", ""
        address = request.client.host if request.client else ""
        try:
            user = await anyio.to_thread.run_sync(self.gis.authenticate, username, password, address)
        except LoginThrottled as error:
            return self.gis_error("Too many invalid GIS credentials. Try again later.", 429, error.args[0])
        except Exception:
            return self.gis_error("GIS authentication is temporarily unavailable", 503)
        if user is None:
            return self.gis_error("Valid GIS credentials are required")
        request.state.user = user
        return None

    async def password_work(self, fn, *args):
        try:
            self.hash_workers.acquire_nowait()
        except anyio.WouldBlock:
            raise HTTPException(503, "Authentication is busy. Try again shortly.", headers={"Retry-After": "1"}) from None
        try:
            return await self.account_work(fn, *args)
        finally:
            self.hash_workers.release()

    @staticmethod
    async def account_work(fn, *args):
        try:
            return await anyio.to_thread.run_sync(fn, *args)
        except (HTTPException, AccountError, ConflictError, LoginThrottled, PermissionDenied, KeyError):
            raise
        except Exception as error:
            LOG.warning("account_storage_error=%s", type(error).__name__)
            raise HTTPException(503, "Account storage is temporarily unavailable") from None

    def router(self):
        router = APIRouter()
        accounts = self.accounts

        @router.get("/account/gis-credential")
        async def gis_credential(request: Request, response: Response):
            response.headers["Cache-Control"] = "no-store"
            return {"credential": await self.account_work(self.gis.credential, request.state.auth_token)}

        @router.post("/account/gis-credential")
        async def rotate_gis_credential(request: Request, body: Input, response: Response):
            response.headers["Cache-Control"] = "no-store"
            return await self.account_work(self.gis.credential, request.state.auth_token, True)

        @router.delete("/account/gis-credential", status_code=204)
        async def revoke_gis_credential(request: Request, body: Input):
            await self.account_work(self.gis.credential, request.state.auth_token, False, True)
            return Response(status_code=204, headers={"Cache-Control": "no-store"})

        @router.get("/admin/wfs")
        async def wfs_settings(request: Request):
            require_role(request, "superadmin")
            return await self.account_work(self.gis.settings)

        @router.put("/admin/wfs")
        async def save_wfs_settings(request: Request, body: WfsSettings):
            require_role(request, "superadmin")
            return await self.account_work(self.gis.save_settings, request.state.auth_token, body.model_dump())

        @router.get("/auth/me")
        async def me(request: Request):
            user = request.state.user
            if user is None:
                return _UNAUTHENTICATED
            return {"user": {key: user[key] for key in ("id", "email", "role")},
                    "csrf_token": user["csrf_token"], "expires_at": user["expires_at"]}

        @router.post("/auth/login")
        async def login(request: Request, response: Response, body: LoginInput):
            address = request.client.host if request.client else ""
            try:
                result = await self.password_work(accounts.login, body.email, body.password, address,
                                                  request.state.auth_token)
            except LoginThrottled as error:
                raise HTTPException(429, "Too many sign-in attempts. Try again later.",
                                    headers={"Retry-After": str(error.args[0])}) from None
            if result is None:
                raise HTTPException(401, "Invalid email or password")
            token, envelope = result
            response.set_cookie(
                COOKIE_NAME, token, max_age=self.settings.auth_session_ttl_sec, path="/api",
                httponly=True, samesite="strict",
                secure=self.settings.auth_cookie_secure or request.url.scheme == "https",
            )
            return envelope

        @router.post("/auth/logout", status_code=204)
        async def logout(request: Request, body: Input):
            await self.account_work(accounts.logout, request.state.auth_token)
            response = Response(status_code=204)
            response.delete_cookie(COOKIE_NAME, path="/api", httponly=True, samesite="strict",
                                   secure=self.settings.auth_cookie_secure or request.url.scheme == "https")
            return response

        @router.post("/auth/password", status_code=204)
        async def change_password(request: Request, body: ChangePasswordInput):
            address = request.client.host if request.client else ""
            try:
                await self.password_work(accounts.change_password, request.state.auth_token,
                                         body.current_password, body.password, address)
            except LoginThrottled as error:
                raise HTTPException(429, "Too many password change attempts. Try again later.",
                                    headers={"Retry-After": str(error.args[0])}) from None
            return Response(status_code=204)

        @router.get("/admin/users")
        async def list_accounts(request: Request):
            require_role(request, "superadmin")
            return {"items": await self.account_work(accounts.list, request.state.auth_token)}

        @router.post("/admin/users", status_code=201)
        async def create_account(request: Request, body: CreateAccount):
            require_role(request, "superadmin")
            return await self.password_work(
                lambda: accounts.create(body.email, body.password, body.role, token=request.state.auth_token),
            )

        @router.patch("/admin/users/{account_id}")
        async def update_account(request: Request, account_id: UUID, body: UpdateAccount):
            require_role(request, "superadmin")
            return await self.account_work(
                lambda: accounts.update(request.state.auth_token, str(account_id), role=body.role, active=body.active),
            )

        @router.post("/admin/users/{account_id}/password", status_code=204)
        async def reset_password(request: Request, account_id: UUID, body: PasswordInput):
            require_role(request, "superadmin")
            await self.password_work(accounts.reset_password, request.state.auth_token, str(account_id), body.password)
            return Response(status_code=204)

        @router.delete("/admin/users/{account_id}", status_code=204)
        async def delete_account(request: Request, account_id: UUID, body: Input):
            require_role(request, "superadmin")
            await self.account_work(accounts.delete, request.state.auth_token, str(account_id))
            return Response(status_code=204)

        return router

    @staticmethod
    def register_handlers(app):
        @app.exception_handler(AccountError)
        async def invalid_account(request, error):
            return JSONResponse({"detail": str(error)}, status_code=422)

        @app.exception_handler(KeyError)
        async def missing_account(request, error):
            return JSONResponse({"detail": "Account not found"}, status_code=404)

        @app.exception_handler(PermissionDenied)
        async def no_account_permission(request, error):
            return JSONResponse({"detail": "This session is no longer authorized"}, status_code=403)
