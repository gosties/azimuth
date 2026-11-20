"""Account community HTTP routes with bounded plain text and raster images."""

import base64
import binascii
import io
import warnings
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Query, Request, Response
from pydantic import Field, field_validator, model_validator
from PIL import Image, UnidentifiedImageError

from h3search.community import Community
from .models import Input

MAX_IMAGE_BYTES = 2 * 1024 * 1024


def text(value):
    value = value.strip()
    if not value or "\x00" in value:
        raise ValueError("Enter nonempty text without null characters")
    return value


class CommentInput(Input):
    body: str = Field(min_length=1, max_length=10000)
    submission_id: UUID | None = None
    _body = field_validator("body")(text)


class FeedbackInput(CommentInput):
    category: Literal["bug", "idea", "question", "experience", "other"]
    subject: str = Field(min_length=1, max_length=160)
    _subject = field_validator("subject")(text)


class StatusInput(Input):
    status: Literal["new", "reviewing", "resolved"]


class DismissInput(Input):
    revision: int = Field(ge=1, strict=True)


class AnnouncementInput(Input):
    title: str = Field(min_length=1, max_length=160)
    body: str = Field(min_length=1, max_length=20000)
    image_data_url: str | None = Field(default=None, max_length=2800000)
    image_alt: str = Field(default="", max_length=300)
    _title = field_validator("title")(text)
    _body = field_validator("body")(text)

    @model_validator(mode="after")
    def accessible_image(self):
        self.image_alt = self.image_alt.strip()
        if self.image_data_url and not self.image_alt:
            raise ValueError("Describe the announcement image")
        return self

    @field_validator("image_data_url")
    @classmethod
    def raster(cls, value):
        if value is None:
            return None
        try:
            header, data = value.split(",", 1)
            formats = {"data:image/png;base64": "PNG", "data:image/jpeg;base64": "JPEG", "data:image/webp;base64": "WEBP"}
            if header not in formats:
                raise ValueError
            raw = base64.b64decode(data, validate=True)
            if not raw or len(raw) > MAX_IMAGE_BYTES:
                raise ValueError
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(raw), formats=[formats[header]]) as image:
                    if image.width * image.height > 16000000 or getattr(image, "n_frames", 1) != 1:
                        raise ValueError
                    image.load()
                    # Reencode pixels to strip active metadata and appended content.
                    output = io.BytesIO()
                    clean = image.convert("RGBA" if "A" in image.getbands() else "RGB")
                    clean.save(output, format="PNG" if formats[header] == "PNG" else formats[header])
                    sanitized = output.getvalue()
                    if len(sanitized) > MAX_IMAGE_BYTES:
                        raise ValueError
                    return header + "," + base64.b64encode(sanitized).decode("ascii")
        except (ValueError, OSError, binascii.Error, UnidentifiedImageError, Image.DecompressionBombWarning, Image.DecompressionBombError):
            raise ValueError("Upload a valid PNG, JPEG, or WebP image under 2 MiB and 16 million pixels") from None


def register_community(router: APIRouter, registry, auth):
    community = Community(registry)

    async def work(request, method, *args):
        return await auth.account_work(method, request.state.auth_token, *args)

    @router.get("/feedback")
    async def feedback(request: Request, limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0, le=1000000)):
        return await work(request, community.list_feedback, limit, offset)

    @router.post("/feedback", status_code=201)
    async def create_feedback(request: Request, body: FeedbackInput):
        return await work(request, community.create_feedback, body.model_dump(mode="json"))

    @router.get("/feedback/{feedback_id}")
    async def get_feedback(request: Request, feedback_id: UUID):
        return await work(request, community.get_feedback, str(feedback_id))

    @router.post("/feedback/{feedback_id}/comments", status_code=201)
    async def comment(request: Request, feedback_id: UUID, body: CommentInput):
        return await work(request, community.comment, str(feedback_id), body.model_dump(mode="json"))

    @router.get("/admin/feedback")
    async def admin_feedback(request: Request, limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0, le=1000000)):
        return await work(request, community.list_feedback, limit, offset, True)

    @router.patch("/admin/feedback/{feedback_id}")
    async def status(request: Request, feedback_id: UUID, body: StatusInput):
        return await work(request, community.status, str(feedback_id), body.status)

    @router.get("/announcements")
    async def announcements(request: Request):
        return await work(request, community.announcements)

    @router.get("/announcements/history")
    async def history(request: Request):
        return await work(request, community.announcements, "history")

    @router.post("/announcements/{announcement_id}/dismiss", status_code=204)
    async def dismiss(request: Request, announcement_id: UUID, body: DismissInput):
        await work(request, community.dismiss, str(announcement_id), body.revision)
        return Response(status_code=204)

    @router.get("/admin/announcements")
    async def admin_announcements(request: Request):
        return await work(request, community.announcements, "admin")

    @router.post("/admin/announcements", status_code=201)
    async def create_announcement(request: Request, body: AnnouncementInput):
        return await work(request, community.save_announcement, body.model_dump())

    @router.put("/admin/announcements/{announcement_id}")
    async def edit_announcement(request: Request, announcement_id: UUID, body: AnnouncementInput):
        return await work(request, community.save_announcement, body.model_dump(), str(announcement_id))

    @router.post("/admin/announcements/{announcement_id}/publish")
    async def publish(request: Request, announcement_id: UUID, body: Input):
        return await work(request, community.save_announcement, None, str(announcement_id), "publish")

    @router.post("/admin/announcements/{announcement_id}/unpublish")
    async def unpublish(request: Request, announcement_id: UUID, body: Input):
        return await work(request, community.save_announcement, None, str(announcement_id), "unpublish")
