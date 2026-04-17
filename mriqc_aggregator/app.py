from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime
from functools import lru_cache

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from . import __version__
from .database import create_database_engine
from .metrics import metric_descriptors_for_modality
from .profiling import (
    DatabaseProfiler,
    DuplicateKind,
    ObservationFilters,
    ObservationView,
    supported_distribution_fields,
    supported_extra_fields,
    supported_metric_fields,
    supported_modalities,
)


def _filters_dependency(
    manufacturers: list[str] = Query(default_factory=list),
    mriqc_versions: list[str] = Query(default_factory=list),
    task_ids: list[str] = Query(default_factory=list),
    source_created_from: datetime | None = None,
    source_created_to: datetime | None = None,
) -> ObservationFilters:
    return ObservationFilters(
        manufacturers=tuple(manufacturers),
        mriqc_versions=tuple(mriqc_versions),
        task_ids=tuple(task_ids),
        source_created_from=source_created_from,
        source_created_to=source_created_to,
    )


def create_app(*, database_url: str | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        if get_profiler.cache_info().currsize:
            get_profiler().close()
            get_profiler.cache_clear()
        if get_engine.cache_info().currsize:
            get_engine().dispose()
            get_engine.cache_clear()

    app = FastAPI(
        title="MRIQC Aggregator API",
        version=__version__,
        docs_url="/docs",
        redoc_url="/redoc",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @lru_cache
    def get_profiler() -> DatabaseProfiler:
        return DatabaseProfiler(database_url=database_url)

    @lru_cache
    def get_engine():
        return create_database_engine(url=database_url)

    @app.get("/api/v1/health")
    def health() -> dict[str, str]:
        with get_engine().connect() as connection:
            connection.execute(text("select 1"))
        return {"status": "ok"}

    @app.get("/api/v1/modalities")
    def list_modalities() -> dict[str, object]:
        return {
            "modalities": [
                {
                    "name": modality,
                    "distribution_fields": list(
                        supported_distribution_fields(modality)
                    ),
                    "metric_fields": list(supported_metric_fields(modality)),
                    "metrics": [
                        descriptor.to_dict()
                        for descriptor in metric_descriptors_for_modality(modality)
                    ],
                    "extra_fields": list(supported_extra_fields(modality)),
                }
                for modality in supported_modalities()
            ]
        }

    @app.get("/api/v1/overview")
    def overview(
        filters: ObservationFilters = Depends(_filters_dependency),
        profiler: DatabaseProfiler = Depends(get_profiler),
    ) -> dict[str, object]:
        return profiler.overview(filters=filters)

    @app.get("/api/v1/modalities/{modality}/profile")
    def modality_profile(
        modality: str,
        view: ObservationView = ObservationView.RAW,
        top_n: int = Query(10, ge=1, le=100),
        duplicate_group_limit: int = Query(10, ge=1, le=100),
        duplicate_member_limit: int = Query(5, ge=1, le=25),
        extra_key_limit: int = Query(25, ge=1, le=100),
        filters: ObservationFilters = Depends(_filters_dependency),
        profiler: DatabaseProfiler = Depends(get_profiler),
    ) -> dict[str, object]:
        try:
            return profiler.modality_profile(
                modality,
                view=view,
                filters=filters,
                top_n=top_n,
                duplicate_group_limit=duplicate_group_limit,
                duplicate_member_limit=duplicate_member_limit,
                extra_key_limit=extra_key_limit,
            )
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/v1/modalities/{modality}/missingness")
    def modality_missingness(
        modality: str,
        view: ObservationView = ObservationView.RAW,
        filters: ObservationFilters = Depends(_filters_dependency),
        profiler: DatabaseProfiler = Depends(get_profiler),
    ) -> dict[str, object]:
        try:
            return {
                "modality": modality,
                "view": view.value,
                "filters": filters.to_dict(),
                "missingness": profiler.missingness(
                    modality,
                    view=view,
                    filters=filters,
                ),
            }
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/v1/modalities/{modality}/distributions/{field_name}")
    def modality_distribution(
        modality: str,
        field_name: str,
        view: ObservationView = ObservationView.RAW,
        limit: int = Query(20, ge=1, le=250),
        filters: ObservationFilters = Depends(_filters_dependency),
        profiler: DatabaseProfiler = Depends(get_profiler),
    ) -> dict[str, object]:
        try:
            return {
                "modality": modality,
                "field": field_name,
                "view": view.value,
                "filters": filters.to_dict(),
                "values": profiler.distribution(
                    modality,
                    field_name,
                    view=view,
                    filters=filters,
                    limit=limit,
                ),
            }
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/v1/modalities/{modality}/extras/{column_name}")
    def modality_extra_keys(
        modality: str,
        column_name: str,
        view: ObservationView = ObservationView.RAW,
        limit: int = Query(25, ge=1, le=250),
        filters: ObservationFilters = Depends(_filters_dependency),
        profiler: DatabaseProfiler = Depends(get_profiler),
    ) -> dict[str, object]:
        try:
            return {
                "modality": modality,
                "view": view.value,
                "filters": filters.to_dict(),
                "extra_keys": profiler.extra_key_counts(
                    modality,
                    column_name,
                    view=view,
                    filters=filters,
                    limit=limit,
                ),
            }
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/v1/modalities/{modality}/metrics")
    def modality_metric_summaries(
        modality: str,
        view: ObservationView = ObservationView.RAW,
        filters: ObservationFilters = Depends(_filters_dependency),
        profiler: DatabaseProfiler = Depends(get_profiler),
    ) -> dict[str, object]:
        try:
            return {
                "modality": modality,
                "view": view.value,
                "filters": filters.to_dict(),
                "metrics": profiler.metric_summaries(
                    modality,
                    view=view,
                    filters=filters,
                ),
            }
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/v1/modalities/{modality}/metrics/{field_name}")
    def modality_metric_distribution(
        modality: str,
        field_name: str,
        view: ObservationView = ObservationView.RAW,
        bins: int = Query(20, ge=1, le=200),
        filters: ObservationFilters = Depends(_filters_dependency),
        profiler: DatabaseProfiler = Depends(get_profiler),
    ) -> dict[str, object]:
        try:
            return {
                "modality": modality,
                "field": field_name,
                "view": view.value,
                "filters": filters.to_dict(),
                "distribution": profiler.metric_distribution(
                    modality,
                    field_name,
                    view=view,
                    filters=filters,
                    bins=bins,
                ),
            }
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/v1/modalities/{modality}/duplicates/{kind}")
    def modality_duplicates(
        modality: str,
        kind: DuplicateKind,
        group_limit: int = Query(10, ge=1, le=100),
        member_limit: int = Query(5, ge=1, le=25),
        filters: ObservationFilters = Depends(_filters_dependency),
        profiler: DatabaseProfiler = Depends(get_profiler),
    ) -> dict[str, object]:
        try:
            return {
                "modality": modality,
                "filters": filters.to_dict(),
                "duplicates": profiler.duplicate_summary(
                    modality,
                    kind,
                    filters=filters,
                    group_limit=group_limit,
                    member_limit=member_limit,
                ),
            }
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    return app


app = create_app()
