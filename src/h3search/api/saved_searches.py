"""Account-owned search definitions and their order."""

from uuid import UUID

from fastapi import HTTPException, Request
from pydantic import Field, field_validator

from h3search.control import SavedSearchInputError
from h3search.coordinates import format_mgrs

from .models import Input, SearchInput, TimeFilterInput, validate_search_limits


class RevisionInput(Input):
    expected_revision: int = Field(ge=0, le=(1 << 53) - 1, strict=True)


class SavedSearchInput(RevisionInput):
    name: str = Field(min_length=1, max_length=120)
    query: SearchInput
    time_filter: TimeFilterInput | None = None

    @field_validator("name", mode="before")
    @classmethod
    def printable_name(cls, value):
        if isinstance(value, str):
            value = value.strip()
            if value and not value.isprintable():
                raise ValueError("Use printable characters in the search name")
        return value

    @field_validator("query")
    @classmethod
    def nonempty_explicit_selection(cls, query):
        if query.dataset_ids == []:
            raise ValueError("Select at least one dataset or use all published datasets")
        return query

    def definition(self) -> dict:
        exclude = {"latitude", "longitude"} if self.query.centers is not None else {"centers"}
        if "lookup_mode" not in self.query.model_fields_set:
            exclude.add("lookup_mode")
        if self.query.time_filter is None:
            exclude.add("time_filter")
        date_filter = self.time_filter.model_dump(mode="json", exclude={"start_at", "end_at"} if not (self.time_filter.start_at or self.time_filter.end_at) else {"start_date", "end_date"}) if self.time_filter else None
        if date_filter and not any(date_filter.values()):
            date_filter = None
        return {"name": self.name, "query": self.query.model_dump(mode="json", exclude=exclude),
                "time_filter": date_filter}


class SearchOrderInput(RevisionInput):
    ids: list[UUID]


def register_saved_searches(router, registry, run):
    async def owned(request, operation, *args):
        def execute(job):
            try:
                library = operation(request.state.user["id"], *args)
            except KeyError:
                raise HTTPException(404, "Saved search not found") from None
            except SavedSearchInputError as error:
                raise HTTPException(422, str(error)) from None

            for item in library["items"]:
                query = item["query"]
                first = query["centers"][0] if "centers" in query else query
                item["first_center_mgrs"] = format_mgrs(first["latitude"], first["longitude"])
            return library

        return await run(request, execute)

    @router.get("/saved-searches")
    async def list_searches(request: Request):
        return await owned(request, registry.list_saved_searches)

    @router.post("/saved-searches", status_code=201)
    async def create_search(request: Request, body: SavedSearchInput):
        validate_search_limits(body.query, registry.settings)
        return await owned(request, registry.save_saved_search, body.expected_revision, body.definition())

    @router.put("/saved-searches/order")
    async def reorder_searches(request: Request, body: SearchOrderInput):
        return await owned(request, registry.reorder_saved_searches, body.expected_revision, list(map(str, body.ids)))

    @router.put("/saved-searches/{search_id}")
    async def update_search(request: Request, search_id: UUID, body: SavedSearchInput):
        validate_search_limits(body.query, registry.settings)
        return await owned(request, registry.save_saved_search, body.expected_revision, body.definition(), str(search_id))

    @router.delete("/saved-searches/{search_id}")
    async def delete_search(request: Request, search_id: UUID, body: RevisionInput):
        return await owned(request, registry.delete_saved_search, body.expected_revision, str(search_id))
