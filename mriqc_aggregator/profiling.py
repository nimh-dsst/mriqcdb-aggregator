from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any

from sqlalchemy import Select, String, Text, case, cast, func, or_, select
from sqlalchemy.orm import Session, sessionmaker

from .canonical_views import canonical_view_table, supports_canonical_views
from .database import create_session_factory
from .metrics import supported_metric_fields
from .models import BoldRecord, T1wRecord, T2wRecord
from .storage import make_run_id, write_json


class ObservationView(str, Enum):
    RAW = "raw"
    EXACT = "exact"
    SERIES = "series"


class DuplicateKind(str, Enum):
    EXACT = "exact"
    SERIES = "series"


MODALITY_MODEL_MAP = {
    "T1w": T1wRecord,
    "T2w": T2wRecord,
    "bold": BoldRecord,
}

IMPORTANT_FIELDS = {
    "T1w": (
        "session_id",
        "run_id",
        "acq_id",
        "manufacturer",
        "manufacturers_model_name",
        "magnetic_field_strength",
        "echo_time",
        "inversion_time",
        "repetition_time",
    ),
    "T2w": (
        "session_id",
        "run_id",
        "acq_id",
        "manufacturer",
        "manufacturers_model_name",
        "magnetic_field_strength",
        "echo_time",
        "repetition_time",
    ),
    "bold": (
        "session_id",
        "run_id",
        "acq_id",
        "task_id",
        "task_name",
        "manufacturer",
        "manufacturers_model_name",
        "magnetic_field_strength",
        "echo_time",
        "repetition_time",
    ),
}

TOP_VALUE_FIELDS = {
    "T1w": ("manufacturer", "manufacturers_model_name", "mriqc_version"),
    "T2w": ("manufacturer", "manufacturers_model_name", "mriqc_version"),
    "bold": (
        "manufacturer",
        "manufacturers_model_name",
        "mriqc_version",
        "task_id",
        "task_name",
    ),
}

EXTRA_FIELDS = {
    "T1w": (
        "payload_extra",
        "bids_meta_extra",
        "provenance_settings_extra",
        "provenance_extra",
    ),
    "T2w": (
        "payload_extra",
        "bids_meta_extra",
        "provenance_settings_extra",
        "provenance_extra",
    ),
    "bold": (
        "payload_extra",
        "bids_meta_extra",
        "provenance_settings_extra",
        "provenance_extra",
        "rating_extra",
    ),
}

DUPLICATE_SAMPLE_FIELDS = (
    "source_api_id",
    "source_created_at",
    "subject_id",
    "session_id",
    "run_id",
    "acq_id",
    "task_id",
    "task_name",
    "manufacturer",
    "manufacturers_model_name",
    "mriqc_version",
)


@dataclass(frozen=True)
class ObservationFilters:
    manufacturers: tuple[str, ...] = ()
    mriqc_versions: tuple[str, ...] = ()
    task_ids: tuple[str, ...] = ()
    source_created_from: datetime | None = None
    source_created_to: datetime | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "manufacturers": list(self.manufacturers),
            "mriqc_versions": list(self.mriqc_versions),
            "task_ids": list(self.task_ids),
            "source_created_from": (
                self.source_created_from.isoformat()
                if self.source_created_from is not None
                else None
            ),
            "source_created_to": (
                self.source_created_to.isoformat()
                if self.source_created_to is not None
                else None
            ),
        }


def supported_modalities() -> tuple[str, ...]:
    return tuple(MODALITY_MODEL_MAP)


def supported_distribution_fields(modality: str) -> tuple[str, ...]:
    _model_for_modality(modality)
    return TOP_VALUE_FIELDS[modality]


def supported_extra_fields(modality: str) -> tuple[str, ...]:
    _model_for_modality(modality)
    return EXTRA_FIELDS[modality]


def _model_for_modality(
    modality: str,
) -> type[T1wRecord] | type[T2wRecord] | type[BoldRecord]:
    try:
        return MODALITY_MODEL_MAP[modality]
    except KeyError as exc:
        raise ValueError(f"Unsupported modality: {modality}") from exc


def _apply_filters(
    statement: Select[Any],
    columns: Any,
    filters: ObservationFilters,
) -> Select[Any]:
    if filters.manufacturers:
        statement = statement.where(columns.manufacturer.in_(filters.manufacturers))
    if filters.mriqc_versions:
        statement = statement.where(columns.mriqc_version.in_(filters.mriqc_versions))
    if filters.task_ids and hasattr(columns, "task_id"):
        statement = statement.where(columns.task_id.in_(filters.task_ids))
    if filters.source_created_from is not None:
        statement = statement.where(
            columns.source_created_at >= filters.source_created_from
        )
    if filters.source_created_to is not None:
        statement = statement.where(
            columns.source_created_at <= filters.source_created_to
        )
    return statement


def _filtered_subquery(
    model: type[T1wRecord] | type[T2wRecord] | type[BoldRecord],
    filters: ObservationFilters,
    *,
    name: str,
) -> Any:
    table = model.__table__
    statement = select(*table.c)
    statement = _apply_filters(statement, table.c, filters)
    return statement.subquery(name)


def _view_subquery(
    model: type[T1wRecord] | type[T2wRecord] | type[BoldRecord],
    view: ObservationView,
    filters: ObservationFilters,
    *,
    name: str,
    use_canonical_views: bool = False,
) -> Any:
    if view is ObservationView.RAW:
        return _filtered_subquery(model, filters, name=f"{name}_filtered")

    if use_canonical_views:
        canonical_table = canonical_view_table(model, view.value)
        statement = select(*canonical_table.c)
        statement = _apply_filters(statement, canonical_table.c, filters)
        return statement.subquery(name)

    filtered = _filtered_subquery(model, filters, name=f"{name}_filtered")
    key_column_name = (
        "dedupe_exact_key" if view is ObservationView.EXACT else "dedupe_series_key"
    )
    group_key = func.coalesce(
        filtered.c[key_column_name],
        filtered.c.source_api_id,
    )
    ranked = select(
        *filtered.c,
        func.row_number()
        .over(
            partition_by=group_key,
            order_by=(
                filtered.c.source_created_at.desc().nullslast(),
                filtered.c.id.desc(),
            ),
        )
        .label("row_number"),
    ).subquery(f"{name}_ranked")
    selected_columns = [ranked.c[column.name] for column in model.__table__.columns]
    return select(*selected_columns).where(ranked.c.row_number == 1).subquery(name)


def _duplicate_group_subquery(
    raw_base: Any,
    kind: DuplicateKind,
    *,
    name: str,
) -> Any:
    key_column_name = (
        "dedupe_exact_key" if kind is DuplicateKind.EXACT else "dedupe_series_key"
    )
    group_key = func.coalesce(raw_base.c[key_column_name], raw_base.c.source_api_id)
    return (
        select(
            group_key.label("group_key"),
            func.count().label("group_size"),
            func.min(raw_base.c.source_created_at).label("first_created_at"),
            func.max(raw_base.c.source_created_at).label("last_created_at"),
        )
        .group_by(group_key)
        .having(func.count() > 1)
        .subquery(name)
    )


def _serialize_value(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Enum):
        return value.value
    return value


def _float_or_none(value: Any) -> float | None:
    if value is None:
        return None
    numeric_value = float(value)
    if not math.isfinite(numeric_value):
        return None
    return numeric_value


def _finite_metric_value_condition(session: Session, column: Any) -> Any:
    condition = column.is_not(None)
    if session.get_bind().dialect.name == "postgresql":
        text_value = func.lower(cast(column, Text))
        condition = condition & ~text_value.in_(("nan", "infinity", "-infinity"))
    return condition


class DatabaseProfiler:
    def __init__(
        self,
        *,
        session_factory: sessionmaker | None = None,
        database_url: str | None = None,
    ) -> None:
        self._session_factory = session_factory or create_session_factory(
            url=database_url
        )

    def close(self) -> None:
        bind = self._session_factory.kw.get("bind")
        if bind is not None:
            bind.dispose()

    def __enter__(self) -> "DatabaseProfiler":
        return self

    def __exit__(self, *_exc_info: object) -> None:
        self.close()

    def overview(self, *, filters: ObservationFilters | None = None) -> dict[str, Any]:
        effective_filters = filters or ObservationFilters()
        with self._session_factory() as session:
            return {
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "filters": effective_filters.to_dict(),
                "modalities": [
                    self._modality_overview(session, modality, effective_filters)
                    for modality in supported_modalities()
                ],
            }

    def modality_profile(
        self,
        modality: str,
        *,
        view: ObservationView = ObservationView.RAW,
        filters: ObservationFilters | None = None,
        top_n: int = 10,
        duplicate_group_limit: int = 10,
        duplicate_member_limit: int = 5,
        extra_key_limit: int = 25,
    ) -> dict[str, Any]:
        _model_for_modality(modality)
        effective_filters = filters or ObservationFilters()
        with self._session_factory() as session:
            use_canonical = supports_canonical_views(session.get_bind())
            raw_base = _view_subquery(
                MODALITY_MODEL_MAP[modality],
                ObservationView.RAW,
                effective_filters,
                name=f"{modality.lower()}_raw",
            )
            view_base = _view_subquery(
                MODALITY_MODEL_MAP[modality],
                view,
                effective_filters,
                name=f"{modality.lower()}_{view.value}",
                use_canonical_views=use_canonical,
            )
            return {
                "generated_at": datetime.now(timezone.utc).isoformat(),
                "modality": modality,
                "view": view.value,
                "filters": effective_filters.to_dict(),
                "overview": self._modality_overview(
                    session,
                    modality,
                    effective_filters,
                ),
                "selected_view": self._view_summary(session, view_base),
                "missingness": self._missingness(session, modality, view_base),
                "qc_metric_summaries": self._metric_summaries(
                    session,
                    modality,
                    view_base,
                ),
                "top_values": {
                    field: self._distribution(session, view_base, field, limit=top_n)
                    for field in TOP_VALUE_FIELDS[modality]
                },
                "extra_key_counts": {
                    column_name: self._extra_key_counts(
                        session,
                        view_base,
                        column_name,
                        limit=extra_key_limit,
                    )
                    for column_name in EXTRA_FIELDS[modality]
                },
                "duplicates": {
                    kind.value: self._duplicate_summary(
                        session,
                        raw_base,
                        kind,
                        modality=modality,
                        group_limit=duplicate_group_limit,
                        member_limit=duplicate_member_limit,
                    )
                    for kind in DuplicateKind
                },
            }

    def distribution(
        self,
        modality: str,
        field_name: str,
        *,
        view: ObservationView = ObservationView.RAW,
        filters: ObservationFilters | None = None,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        if field_name not in supported_distribution_fields(modality):
            raise ValueError(
                f"Unsupported distribution field for {modality}: {field_name}"
            )
        effective_filters = filters or ObservationFilters()
        with self._session_factory() as session:
            use_canonical = supports_canonical_views(session.get_bind())
            base = _view_subquery(
                MODALITY_MODEL_MAP[modality],
                view,
                effective_filters,
                name=f"{modality.lower()}_{field_name}_{view.value}",
                use_canonical_views=use_canonical,
            )
            return self._distribution(session, base, field_name, limit=limit)

    def metric_summaries(
        self,
        modality: str,
        *,
        view: ObservationView = ObservationView.RAW,
        filters: ObservationFilters | None = None,
    ) -> list[dict[str, Any]]:
        _model_for_modality(modality)
        effective_filters = filters or ObservationFilters()
        with self._session_factory() as session:
            use_canonical = supports_canonical_views(session.get_bind())
            base = _view_subquery(
                MODALITY_MODEL_MAP[modality],
                view,
                effective_filters,
                name=f"{modality.lower()}_metric_summaries_{view.value}",
                use_canonical_views=use_canonical,
            )
            return self._metric_summaries(session, modality, base)

    def metric_distribution(
        self,
        modality: str,
        field_name: str,
        *,
        view: ObservationView = ObservationView.RAW,
        filters: ObservationFilters | None = None,
        bins: int = 20,
    ) -> dict[str, Any]:
        _validate_metric_field(modality, field_name)
        effective_filters = filters or ObservationFilters()
        with self._session_factory() as session:
            use_canonical = supports_canonical_views(session.get_bind())
            base = _view_subquery(
                MODALITY_MODEL_MAP[modality],
                view,
                effective_filters,
                name=f"{modality.lower()}_{field_name}_metric_{view.value}",
                use_canonical_views=use_canonical,
            )
            return self._metric_distribution(session, base, field_name, bins=bins)

    def missingness(
        self,
        modality: str,
        *,
        view: ObservationView = ObservationView.RAW,
        filters: ObservationFilters | None = None,
    ) -> list[dict[str, Any]]:
        effective_filters = filters or ObservationFilters()
        with self._session_factory() as session:
            use_canonical = supports_canonical_views(session.get_bind())
            base = _view_subquery(
                MODALITY_MODEL_MAP[modality],
                view,
                effective_filters,
                name=f"{modality.lower()}_missingness_{view.value}",
                use_canonical_views=use_canonical,
            )
            return self._missingness(session, modality, base)

    def extra_key_counts(
        self,
        modality: str,
        column_name: str,
        *,
        view: ObservationView = ObservationView.RAW,
        filters: ObservationFilters | None = None,
        limit: int = 25,
    ) -> dict[str, Any]:
        if column_name not in supported_extra_fields(modality):
            raise ValueError(f"Unsupported extra field for {modality}: {column_name}")
        effective_filters = filters or ObservationFilters()
        with self._session_factory() as session:
            use_canonical = supports_canonical_views(session.get_bind())
            base = _view_subquery(
                MODALITY_MODEL_MAP[modality],
                view,
                effective_filters,
                name=f"{modality.lower()}_{column_name}_{view.value}",
                use_canonical_views=use_canonical,
            )
            return self._extra_key_counts(session, base, column_name, limit=limit)

    def duplicate_summary(
        self,
        modality: str,
        kind: DuplicateKind,
        *,
        filters: ObservationFilters | None = None,
        group_limit: int = 10,
        member_limit: int = 5,
    ) -> dict[str, Any]:
        effective_filters = filters or ObservationFilters()
        with self._session_factory() as session:
            raw_base = _view_subquery(
                MODALITY_MODEL_MAP[modality],
                ObservationView.RAW,
                effective_filters,
                name=f"{modality.lower()}_duplicates_raw",
            )
            return self._duplicate_summary(
                session,
                raw_base,
                kind,
                modality=modality,
                group_limit=group_limit,
                member_limit=member_limit,
            )

    def _modality_overview(
        self,
        session: Session,
        modality: str,
        filters: ObservationFilters,
    ) -> dict[str, Any]:
        model = MODALITY_MODEL_MAP[modality]
        use_canonical = supports_canonical_views(session.get_bind())
        raw_base = _view_subquery(
            model, ObservationView.RAW, filters, name=f"{modality.lower()}_overview_raw"
        )
        exact_base = _view_subquery(
            model,
            ObservationView.EXACT,
            filters,
            name=f"{modality.lower()}_overview_exact",
            use_canonical_views=use_canonical,
        )
        series_base = _view_subquery(
            model,
            ObservationView.SERIES,
            filters,
            name=f"{modality.lower()}_overview_series",
            use_canonical_views=use_canonical,
        )
        return {
            "modality": modality,
            "row_counts": {
                ObservationView.RAW.value: self._count_rows(session, raw_base),
                ObservationView.EXACT.value: self._count_rows(session, exact_base),
                ObservationView.SERIES.value: self._count_rows(session, series_base),
            },
            "source_created_at_range": self._date_range(session, raw_base),
        }

    def _view_summary(self, session: Session, base: Any) -> dict[str, Any]:
        row_count = self._count_rows(session, base)
        date_range = self._date_range(session, base)
        return {
            "row_count": row_count,
            "source_created_at_range": date_range,
        }

    def _count_rows(self, session: Session, base: Any) -> int:
        return int(session.execute(select(func.count()).select_from(base)).scalar_one())

    def _date_range(self, session: Session, base: Any) -> dict[str, Any]:
        row = session.execute(
            select(
                func.min(base.c.source_created_at),
                func.max(base.c.source_created_at),
            )
        ).one()
        return {
            "min": _serialize_value(row[0]),
            "max": _serialize_value(row[1]),
        }

    def _missingness(
        self,
        session: Session,
        modality: str,
        base: Any,
    ) -> list[dict[str, Any]]:
        expressions: list[Any] = [func.count().label("row_count")]
        for field_name in IMPORTANT_FIELDS[modality]:
            column = base.c[field_name]
            is_string_like = isinstance(column.type, (String, Text))
            missing_condition = column.is_(None)
            if is_string_like:
                missing_condition = or_(missing_condition, column == "")
            expressions.append(
                func.sum(
                    case(
                        (missing_condition, 1),
                        else_=0,
                    )
                ).label(field_name)
            )
        row = session.execute(select(*expressions)).one()
        row_count = int(row._mapping["row_count"] or 0)
        results: list[dict[str, Any]] = []
        for field_name in IMPORTANT_FIELDS[modality]:
            missing_count = int(row._mapping[field_name] or 0)
            results.append(
                {
                    "field": field_name,
                    "missing_count": missing_count,
                    "missing_fraction": (
                        float(missing_count / row_count) if row_count else 0.0
                    ),
                }
            )
        return results

    def _metric_summaries(
        self,
        session: Session,
        modality: str,
        base: Any,
    ) -> list[dict[str, Any]]:
        expressions: list[Any] = [func.count().label("row_count")]
        for field_name in supported_metric_fields(modality):
            column = base.c[field_name]
            finite_value = _finite_metric_value_condition(session, column)
            expressions.extend(
                [
                    func.count(column)
                    .filter(finite_value)
                    .label(f"{field_name}__value_count"),
                    func.min(case((finite_value, column), else_=None)).label(
                        f"{field_name}__min"
                    ),
                    func.max(case((finite_value, column), else_=None)).label(
                        f"{field_name}__max"
                    ),
                    func.avg(case((finite_value, column), else_=None)).label(
                        f"{field_name}__mean"
                    ),
                ]
            )
        row = session.execute(select(*expressions)).one()
        row_count = int(row._mapping["row_count"] or 0)
        summaries: list[dict[str, Any]] = []
        for field_name in supported_metric_fields(modality):
            value_count = int(row._mapping[f"{field_name}__value_count"] or 0)
            missing_count = row_count - value_count
            summaries.append(
                {
                    "field": field_name,
                    "value_count": value_count,
                    "missing_count": missing_count,
                    "missing_fraction": (
                        float(missing_count / row_count) if row_count else 0.0
                    ),
                    "min": _serialize_value(row._mapping[f"{field_name}__min"]),
                    "max": _serialize_value(row._mapping[f"{field_name}__max"]),
                    "mean": _serialize_value(row._mapping[f"{field_name}__mean"]),
                }
            )
        return summaries

    def _metric_distribution(
        self,
        session: Session,
        base: Any,
        field_name: str,
        *,
        bins: int,
    ) -> dict[str, Any]:
        column = base.c[field_name]
        finite_value = _finite_metric_value_condition(session, column)
        row_count = int(
            session.execute(select(func.count()).select_from(base)).scalar_one() or 0
        )
        valid_values = (
            select(column.label("value"))
            .select_from(base)
            .where(finite_value)
            .subquery(f"{field_name}_valid_values")
        )
        value_column = valid_values.c.value
        row = session.execute(
            select(
                func.count(value_column).label("value_count"),
                func.min(value_column).label("min"),
                func.max(value_column).label("max"),
                func.avg(value_column).label("mean"),
                func.stddev_pop(value_column).label("stddev"),
                func.percentile_cont(0.01).within_group(value_column).label("p01"),
                func.percentile_cont(0.05).within_group(value_column).label("p05"),
                func.percentile_cont(0.25).within_group(value_column).label("p25"),
                func.percentile_cont(0.50).within_group(value_column).label("p50"),
                func.percentile_cont(0.75).within_group(value_column).label("p75"),
                func.percentile_cont(0.95).within_group(value_column).label("p95"),
                func.percentile_cont(0.99).within_group(value_column).label("p99"),
            ).select_from(valid_values)
        ).one()
        value_count = int(row._mapping["value_count"] or 0)
        missing_count = row_count - value_count
        min_value = _float_or_none(row._mapping["min"])
        max_value = _float_or_none(row._mapping["max"])
        if value_count == 0:
            return {
                "field": field_name,
                "row_count": row_count,
                "value_count": 0,
                "missing_count": missing_count,
                "missing_fraction": (
                    float(missing_count / row_count) if row_count else 0.0
                ),
                "min": None,
                "max": None,
                "mean": None,
                "stddev": None,
                "quantiles": {
                    "p01": None,
                    "p05": None,
                    "p25": None,
                    "p50": None,
                    "p75": None,
                    "p95": None,
                    "p99": None,
                },
                "histogram": [],
            }
        histogram: list[dict[str, Any]]
        if min_value == max_value:
            histogram = [
                {
                    "start": min_value,
                    "end": max_value,
                    "count": value_count,
                }
            ]
        else:
            assert min_value is not None
            assert max_value is not None
            bin_width = (max_value - min_value) / bins
            bucket_index = case(
                (value_column >= max_value, bins - 1),
                else_=func.floor((value_column - min_value) / bin_width),
            ).label("bucket_index")
            bucket_rows = session.execute(
                select(
                    bucket_index,
                    func.count().label("bucket_count"),
                )
                .select_from(valid_values)
                .group_by(bucket_index)
                .order_by(bucket_index)
            ).all()
            bucket_counts = {
                int(row.bucket_index): int(row.bucket_count) for row in bucket_rows
            }
            histogram = []
            for index in range(bins):
                start = min_value + (index * bin_width)
                end = (
                    max_value
                    if index == bins - 1
                    else min_value + ((index + 1) * bin_width)
                )
                histogram.append(
                    {
                        "start": float(start),
                        "end": float(end),
                        "count": bucket_counts.get(index, 0),
                    }
                )
        return {
            "field": field_name,
            "row_count": row_count,
            "value_count": value_count,
            "missing_count": missing_count,
            "missing_fraction": (
                float(missing_count / row_count) if row_count else 0.0
            ),
            "min": min_value,
            "max": max_value,
            "mean": _float_or_none(row._mapping["mean"]),
            "stddev": _float_or_none(row._mapping["stddev"]),
            "quantiles": {
                "p01": _float_or_none(row._mapping["p01"]),
                "p05": _float_or_none(row._mapping["p05"]),
                "p25": _float_or_none(row._mapping["p25"]),
                "p50": _float_or_none(row._mapping["p50"]),
                "p75": _float_or_none(row._mapping["p75"]),
                "p95": _float_or_none(row._mapping["p95"]),
                "p99": _float_or_none(row._mapping["p99"]),
            },
            "histogram": histogram,
        }

    def _distribution(
        self,
        session: Session,
        base: Any,
        field_name: str,
        *,
        limit: int,
    ) -> list[dict[str, Any]]:
        column = base.c[field_name]
        statement = (
            select(column.label("value"), func.count().label("count"))
            .select_from(base)
            .where(column.is_not(None), column != "")
            .group_by(column)
            .order_by(func.count().desc(), column.asc())
            .limit(limit)
        )
        rows = session.execute(statement).all()
        return [
            {"value": _serialize_value(row.value), "count": int(row.count)}
            for row in rows
        ]

    def _extra_key_counts(
        self,
        session: Session,
        base: Any,
        column_name: str,
        *,
        limit: int,
    ) -> dict[str, Any]:
        key_counter: Counter[str] = Counter()
        nonempty_row_count = 0
        for payload in session.execute(select(base.c[column_name])).scalars():
            if not isinstance(payload, dict):
                continue
            if payload:
                nonempty_row_count += 1
            key_counter.update(payload.keys())
        return {
            "column": column_name,
            "nonempty_row_count": nonempty_row_count,
            "distinct_key_count": len(key_counter),
            "keys": [
                {"key": key, "row_count": count}
                for key, count in key_counter.most_common(limit)
            ],
        }

    def _duplicate_summary(
        self,
        session: Session,
        raw_base: Any,
        kind: DuplicateKind,
        *,
        modality: str,
        group_limit: int,
        member_limit: int,
    ) -> dict[str, Any]:
        grouped = _duplicate_group_subquery(
            raw_base,
            kind,
            name=f"{modality.lower()}_{kind.value}_groups",
        )
        histogram_rows = session.execute(
            select(
                grouped.c.group_size,
                func.count().label("group_count"),
            )
            .group_by(grouped.c.group_size)
            .order_by(grouped.c.group_size.desc())
        ).all()
        top_groups = session.execute(
            select(
                grouped.c.group_key,
                grouped.c.group_size,
                grouped.c.first_created_at,
                grouped.c.last_created_at,
            )
            .order_by(grouped.c.group_size.desc(), grouped.c.group_key.asc())
            .limit(group_limit)
        ).all()
        key_column_name = (
            "dedupe_exact_key" if kind is DuplicateKind.EXACT else "dedupe_series_key"
        )
        group_key_expression = func.coalesce(
            raw_base.c[key_column_name],
            raw_base.c.source_api_id,
        )
        sample_groups: list[dict[str, Any]] = []
        for row in top_groups:
            sample_columns = [
                raw_base.c[field_name]
                for field_name in DUPLICATE_SAMPLE_FIELDS
                if hasattr(raw_base.c, field_name)
            ]
            sample_rows = session.execute(
                select(*sample_columns)
                .where(group_key_expression == row.group_key)
                .order_by(
                    raw_base.c.source_created_at.desc().nullslast(),
                    raw_base.c.id.desc(),
                )
                .limit(member_limit)
            ).mappings()
            sample_groups.append(
                {
                    "group_key": row.group_key,
                    "group_size": int(row.group_size),
                    "first_created_at": _serialize_value(row.first_created_at),
                    "last_created_at": _serialize_value(row.last_created_at),
                    "samples": [
                        {
                            key: _serialize_value(value)
                            for key, value in sample_row.items()
                        }
                        for sample_row in sample_rows
                    ],
                }
            )
        duplicate_row_count = session.execute(
            select(func.coalesce(func.sum(grouped.c.group_size), 0))
        ).scalar_one()
        return {
            "kind": kind.value,
            "duplicate_group_count": self._count_rows(session, grouped),
            "duplicate_row_count": int(duplicate_row_count or 0),
            "histogram": [
                {
                    "group_size": int(row.group_size),
                    "group_count": int(row.group_count),
                }
                for row in histogram_rows
            ],
            "sample_groups": sample_groups,
        }


def write_database_profile(
    *,
    output_root: str | Path = Path("docs") / "temp",
    database_url: str | None = None,
    modalities: tuple[str, ...] | list[str] | None = None,
    view: ObservationView = ObservationView.RAW,
    top_n: int = 10,
    duplicate_group_limit: int = 10,
    duplicate_member_limit: int = 5,
    extra_key_limit: int = 25,
) -> Path:
    selected_modalities = tuple(modalities or supported_modalities())
    run_root = Path(output_root) / "db-profiles" / make_run_id()
    write_json(
        run_root / "config.json",
        {
            "modalities": list(selected_modalities),
            "view": view.value,
            "top_n": top_n,
            "duplicate_group_limit": duplicate_group_limit,
            "duplicate_member_limit": duplicate_member_limit,
            "extra_key_limit": extra_key_limit,
        },
    )
    with DatabaseProfiler(database_url=database_url) as profiler:
        write_json(run_root / "overview.json", profiler.overview())
        for modality in selected_modalities:
            write_json(
                run_root / f"{modality}.json",
                profiler.modality_profile(
                    modality,
                    view=view,
                    top_n=top_n,
                    duplicate_group_limit=duplicate_group_limit,
                    duplicate_member_limit=duplicate_member_limit,
                    extra_key_limit=extra_key_limit,
                ),
            )
    return run_root


def _validate_metric_field(modality: str, field_name: str) -> None:
    if field_name not in supported_metric_fields(modality):
        raise ValueError(f"Unsupported QC metric for {modality}: {field_name}")
