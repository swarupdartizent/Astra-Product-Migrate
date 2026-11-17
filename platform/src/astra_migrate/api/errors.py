"""RFC 9457 problem details for every error the API returns."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger(__name__)
MEDIA = "application/problem+json"


class Problem(Exception):
    def __init__(self, status: int, slug: str, title: str, detail: str | None = None,
                 errors: list[dict[str, Any]] | None = None, headers: dict[str, str] | None = None) -> None:
        super().__init__(title)
        self.status, self.slug, self.title, self.detail = status, slug, title, detail
        self.errors, self.headers = errors, headers


def invalid(field: str, message: str) -> Problem:
    """A 422 about one input field, in the same shape as request validation errors."""
    return Problem(422, "validation", "Some fields need attention", message,
                   errors=[{"field": field, "message": message}])


def not_found(what: str) -> Problem:
    return Problem(404, "not-found", f"{what} not found")


def forbidden(detail: str = "You do not have permission to do this.") -> Problem:
    return Problem(403, "forbidden", "Permission denied", detail)


def conflict(title: str, detail: str | None = None) -> Problem:
    return Problem(409, "conflict", title, detail)


def _body(request: Request, status: int, slug: str, title: str, detail: str | None,
          errors: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {"type": f"/problems/{slug}", "title": title, "status": status,
                            "instance": request.url.path}
    if detail:
        body["detail"] = detail
    if errors:
        body["errors"] = errors
    return body


def install(app: FastAPI) -> None:
    @app.exception_handler(Problem)
    async def _problem(request: Request, exc: Problem) -> JSONResponse:
        return JSONResponse(_body(request, exc.status, exc.slug, exc.title, exc.detail, exc.errors),
                            status_code=exc.status, media_type=MEDIA, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        errors = [{"field": ".".join(str(p) for p in e["loc"] if p != "body"), "message": e["msg"]}
                  for e in exc.errors()]
        return JSONResponse(_body(request, 422, "validation", "Some fields need attention",
                                  "Correct the fields listed and try again.", errors),
                            status_code=422, media_type=MEDIA)

    @app.exception_handler(StarletteHTTPException)
    async def _http(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        slug = {404: "not-found", 405: "method-not-allowed"}.get(exc.status_code, "http-error")
        return JSONResponse(_body(request, exc.status_code, slug, str(exc.detail), None),
                            status_code=exc.status_code, media_type=MEDIA)

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error on %s %s", request.method, request.url.path)
        return JSONResponse(_body(request, 500, "internal", "Something went wrong on our side",
                                  "The error has been logged with its trace. Try again, or contact support."),
                            status_code=500, media_type=MEDIA)
