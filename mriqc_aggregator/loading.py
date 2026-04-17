from __future__ import annotations

import json
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from decimal import Decimal
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Iterable

import ijson
from psycopg.types.json import Jsonb
from sqlalchemy import select, text
from sqlalchemy.engine import Connection
from sqlalchemy.orm import Session
from sqlalchemy.sql.sqltypes import Enum as SQLAlchemyEnum
from sqlalchemy.sql.sqltypes import JSON as SQLAlchemyJSON

from .database import (
    create_database_engine,
    create_database_schema,
    default_database_url,
)
from .models import BoldRecord, T1wRecord, T2wRecord
from .parsing import ParsedObservation, parse_observation, parse_page_number


MODALITY_MODEL_MAP = {
    "T1w": T1wRecord,
    "T2w": T2wRecord,
    "bold": BoldRecord,
}

DUMP_FILENAME_MAP = {
    "T1w": "mriqc_api.T1w.json",
    "T2w": "mriqc_api.T2w.json",
    "bold": "mriqc_api.bold.json",
}

EXCLUDED_INSERT_COLUMNS = {"id", "inserted_at"}


@dataclass
class ModalityLoadSummary:
    modality: str
    page_count: int = 0
    observation_count: int = 0
    inserted_count: int = 0
    updated_count: int = 0


@dataclass
class LoadSummary:
    run_root: str
    database_url: str
    per_modality: dict[str, ModalityLoadSummary] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_root": self.run_root,
            "database_url": self.database_url,
            "per_modality": {
                modality: asdict(summary)
                for modality, summary in self.per_modality.items()
            },
        }


def resolve_run_root(
    *,
    run_id: str | None = None,
    run_root: str | Path | None = None,
    data_root: str | Path = Path("data") / "runs",
) -> Path:
    if run_id and run_root:
        raise ValueError("Specify either run_id or run_root, not both")
    if run_root:
        resolved = Path(run_root)
    elif run_id:
        resolved = Path(data_root) / run_id
    else:
        candidates = sorted(path for path in Path(data_root).iterdir() if path.is_dir())
        if not candidates:
            raise FileNotFoundError(f"No runs found under {data_root}")
        resolved = candidates[-1]

    if not (resolved / "raw").exists():
        raise FileNotFoundError(f"Run root does not contain raw payloads: {resolved}")
    return resolved


def resolve_dump_root(
    *,
    dump_root: str | Path | None = None,
    data_root: str | Path = Path("data") / "dump",
) -> Path:
    resolved = Path(dump_root) if dump_root else Path(data_root)
    if not resolved.exists():
        raise FileNotFoundError(f"Dump root does not exist: {resolved}")

    if not any(
        (resolved / filename).exists() for filename in DUMP_FILENAME_MAP.values()
    ):
        raise FileNotFoundError(
            f"Dump root does not contain expected modality dumps: {resolved}"
        )
    return resolved


def iter_parsed_run_observations(
    run_root: str | Path,
    *,
    modalities: Iterable[str] | None = None,
) -> Iterable[ParsedObservation]:
    resolved_run_root = Path(run_root)
    selected_modalities = list(modalities or MODALITY_MODEL_MAP)
    for modality in selected_modalities:
        raw_dir = resolved_run_root / "raw" / modality
        if not raw_dir.exists():
            continue
        for page_path in sorted(raw_dir.glob("page-*.json")):
            source_page = parse_page_number(page_path)
            payload = json.loads(page_path.read_text(encoding="utf-8"))
            for item in payload.get("_items", []):
                yield parse_observation(
                    modality,
                    item,
                    raw_payload_path=str(page_path),
                    source_page=source_page,
                )


def _normalize_extended_json_date(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict) and set(value) == {"$numberLong"}:
        value = int(value["$numberLong"])
    if isinstance(value, (int, float)):
        normalized = datetime.fromtimestamp(value / 1000, tz=timezone.utc)
        return normalized.isoformat().replace("+00:00", "Z")
    raise ValueError(f"Unsupported extended JSON $date payload: {value!r}")


def normalize_dump_payload(value: Any) -> Any:
    if isinstance(value, list):
        return [normalize_dump_payload(item) for item in value]
    if isinstance(value, Decimal):
        if value == value.to_integral_value():
            return int(value)
        return float(value)
    if not isinstance(value, dict):
        return value

    if len(value) == 1:
        key, wrapped = next(iter(value.items()))
        if key == "$oid":
            if not isinstance(wrapped, str):
                raise ValueError(f"Unsupported extended JSON $oid payload: {wrapped!r}")
            return wrapped
        if key == "$date":
            return _normalize_extended_json_date(wrapped)
        if key in {"$numberInt", "$numberLong"}:
            return int(wrapped)
        if key in {"$numberDouble", "$numberDecimal"}:
            return float(wrapped)
        if key.startswith("$"):
            raise ValueError(f"Unsupported extended JSON wrapper: {key}")

    return {key: normalize_dump_payload(item) for key, item in value.items()}


def iter_parsed_dump_observations(
    dump_root: str | Path,
    *,
    modalities: Iterable[str] | None = None,
    start_item_by_modality: dict[str, int] | None = None,
) -> Iterable[ParsedObservation]:
    resolved_dump_root = Path(dump_root)
    selected_modalities = list(modalities or MODALITY_MODEL_MAP)
    for modality in selected_modalities:
        start_item = (start_item_by_modality or {}).get(modality, 0)
        dump_path = resolved_dump_root / DUMP_FILENAME_MAP[modality]
        if not dump_path.exists():
            continue
        with dump_path.open("rb") as handle:
            for item_index, item in enumerate(ijson.items(handle, "item"), start=1):
                if item_index <= start_item:
                    continue
                try:
                    normalized = normalize_dump_payload(item)
                    yield parse_observation(
                        modality,
                        normalized,
                        raw_payload_path=f"{dump_path}#item={item_index}",
                        source_page=None,
                    )
                except Exception as exc:
                    raise ValueError(
                        f"Failed to parse {modality} item {item_index} from {dump_path}: {exc}"
                    ) from exc


def _insertable_columns(
    model: type[T1wRecord] | type[T2wRecord] | type[BoldRecord],
) -> list[Any]:
    return [
        column
        for column in model.__table__.columns
        if column.name not in EXCLUDED_INSERT_COLUMNS
    ]


def _normalize_rows_for_model(
    model: type[T1wRecord] | type[T2wRecord] | type[BoldRecord],
    rows: list[dict[str, Any]],
) -> tuple[list[Any], list[dict[str, Any]]]:
    columns = _insertable_columns(model)
    normalized_rows = [
        {column.name: row.get(column.name) for column in columns} for row in rows
    ]
    return columns, normalized_rows


def _upsert_rows(
    session: Session,
    model: type[T1wRecord] | type[T2wRecord] | type[BoldRecord],
    rows: list[dict[str, Any]],
) -> tuple[int, int]:
    if not rows:
        return 0, 0

    source_ids = [row["source_api_id"] for row in rows]
    existing_ids = set(
        session.execute(
            select(model.source_api_id).where(model.source_api_id.in_(source_ids))
        ).scalars()
    )
    inserted_count = sum(1 for source_id in source_ids if source_id not in existing_ids)
    updated_count = len(source_ids) - inserted_count

    dialect_name = session.bind.dialect.name
    if dialect_name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert as dialect_insert
    elif dialect_name == "sqlite":
        from sqlalchemy.dialects.sqlite import insert as dialect_insert
    else:
        raise ValueError(f"Unsupported SQL dialect for upsert: {dialect_name}")

    insertable_columns, normalized_rows = _normalize_rows_for_model(model, rows)

    statement = dialect_insert(model).values(normalized_rows)
    update_columns = {
        column.name: getattr(statement.excluded, column.name)
        for column in insertable_columns
    }
    statement = statement.on_conflict_do_update(
        index_elements=[model.__table__.c.source_api_id],
        set_=update_columns,
    )
    session.execute(statement)
    return inserted_count, updated_count


def _insert_or_skip_rows(
    session: Session,
    model: type[T1wRecord] | type[T2wRecord] | type[BoldRecord],
    rows: list[dict[str, Any]],
) -> tuple[int, int]:
    if not rows:
        return 0, 0

    dialect_name = session.bind.dialect.name
    if dialect_name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert as dialect_insert
    elif dialect_name == "sqlite":
        from sqlalchemy.dialects.sqlite import insert as dialect_insert
    else:
        raise ValueError(f"Unsupported SQL dialect for insert/skip: {dialect_name}")

    insertable_columns, normalized_rows = _normalize_rows_for_model(model, rows)

    statement = dialect_insert(model).values(normalized_rows)
    statement = statement.on_conflict_do_nothing(
        index_elements=[model.__table__.c.source_api_id]
    )
    result = session.execute(statement.returning(model.source_api_id))
    inserted_count = len(result.scalars().all())
    skipped_count = len(rows) - inserted_count
    return inserted_count, skipped_count


def _quote_identifier(connection: Connection, identifier: str) -> str:
    return connection.dialect.identifier_preparer.quote(identifier)


def _quote_table_name(
    connection: Connection,
    model: type[T1wRecord] | type[T2wRecord] | type[BoldRecord],
) -> str:
    table = model.__table__
    if table.schema:
        return (
            f"{_quote_identifier(connection, table.schema)}."
            f"{_quote_identifier(connection, table.name)}"
        )
    return _quote_identifier(connection, table.name)


def _quoted_columns_sql(connection: Connection, columns: list[Any]) -> str:
    return ", ".join(_quote_identifier(connection, column.name) for column in columns)


def _prepare_copy_value(column: Any, value: Any) -> Any:
    if value is None:
        return None
    if isinstance(column.type, SQLAlchemyEnum) and isinstance(value, Enum):
        return value.name
    if isinstance(value, Enum):
        return value.value
    if isinstance(column.type, SQLAlchemyJSON):
        return Jsonb(value)
    return value


def _create_copy_staging_table(
    connection: Connection,
    model: type[T1wRecord] | type[T2wRecord] | type[BoldRecord],
) -> str:
    columns = _insertable_columns(model)
    stage_name = f"_load_stage_{model.__table__.name}_{uuid.uuid4().hex[:12]}"
    quoted_stage_name = _quote_identifier(connection, stage_name)
    quoted_target_name = _quote_table_name(connection, model)
    quoted_columns = _quoted_columns_sql(connection, columns)
    connection.exec_driver_sql(
        f"CREATE TEMP TABLE {quoted_stage_name} AS "
        f"SELECT {quoted_columns} FROM {quoted_target_name} WITH NO DATA"
    )
    return stage_name


def _copy_insert_or_skip_rows(
    connection: Connection,
    model: type[T1wRecord] | type[T2wRecord] | type[BoldRecord],
    staging_table_name: str,
    rows: list[dict[str, Any]],
) -> tuple[int, int]:
    if not rows:
        return 0, 0

    columns, normalized_rows = _normalize_rows_for_model(model, rows)
    quoted_stage_name = _quote_identifier(connection, staging_table_name)
    quoted_target_name = _quote_table_name(connection, model)
    quoted_columns = _quoted_columns_sql(connection, columns)

    raw_connection = connection.connection.driver_connection
    with raw_connection.cursor() as cursor:
        with cursor.copy(
            f"COPY {quoted_stage_name} ({quoted_columns}) FROM STDIN"
        ) as copy:
            for row in normalized_rows:
                copy.write_row(
                    [
                        _prepare_copy_value(column, row.get(column.name))
                        for column in columns
                    ]
                )

    inserted_count = connection.exec_driver_sql(
        f"WITH inserted AS ("
        f"  INSERT INTO {quoted_target_name} ({quoted_columns}) "
        f"  SELECT {quoted_columns} FROM {quoted_stage_name} "
        f"  ON CONFLICT ({_quote_identifier(connection, 'source_api_id')}) DO NOTHING "
        f"  RETURNING 1"
        f") "
        f"SELECT count(*) FROM inserted"
    ).scalar_one()
    connection.exec_driver_sql(f"TRUNCATE {quoted_stage_name}")
    skipped_count = len(rows) - inserted_count
    return inserted_count, skipped_count


def _resume_item_index(
    connection: Connection,
    model: type[T1wRecord] | type[T2wRecord] | type[BoldRecord],
    dump_path: Path,
) -> int:
    quoted_target_name = _quote_table_name(connection, model)
    result = connection.execute(
        text(
            f"SELECT COALESCE("
            f"  max(CAST(substring(raw_payload_path FROM '#item=([0-9]+)$') AS integer)),"
            f"  0"
            f") "
            f"FROM {quoted_target_name} "
            f"WHERE raw_payload_path LIKE :pattern"
        ),
        {"pattern": f"{dump_path}#item=%"},
    ).scalar_one()
    return int(result or 0)


def _flush_batch(
    session: Session,
    model: type[T1wRecord] | type[T2wRecord] | type[BoldRecord],
    batch: list[dict[str, Any]],
    summary: ModalityLoadSummary,
    *,
    write_rows: Callable[
        [
            Session,
            type[T1wRecord] | type[T2wRecord] | type[BoldRecord],
            list[dict[str, Any]],
        ],
        tuple[int, int],
    ] = _upsert_rows,
) -> None:
    inserted, updated = write_rows(session, model, batch)
    summary.inserted_count += inserted
    summary.updated_count += updated
    session.commit()
    batch.clear()


def _flush_copy_batch(
    connection: Connection,
    model: type[T1wRecord] | type[T2wRecord] | type[BoldRecord],
    staging_table_name: str,
    batch: list[dict[str, Any]],
    summary: ModalityLoadSummary,
) -> None:
    inserted, updated = _copy_insert_or_skip_rows(
        connection,
        model,
        staging_table_name,
        batch,
    )
    summary.inserted_count += inserted
    summary.updated_count += updated
    connection.commit()
    batch.clear()


def load_raw_run(
    *,
    run_id: str | None = None,
    run_root: str | Path | None = None,
    database_url: str | None = None,
    modalities: Iterable[str] | None = None,
    batch_size: int = 250,
    create_schema_first: bool = True,
) -> LoadSummary:
    resolved_run_root = resolve_run_root(run_id=run_id, run_root=run_root)
    url = database_url or default_database_url()
    if create_schema_first:
        create_database_schema(url=url)

    selected_modalities = list(modalities or MODALITY_MODEL_MAP)
    summary = LoadSummary(
        run_root=str(resolved_run_root),
        database_url=url,
        per_modality={
            modality: ModalityLoadSummary(modality=modality)
            for modality in selected_modalities
        },
    )

    engine = create_database_engine(url=url)
    with Session(engine) as session:
        for modality in selected_modalities:
            model = MODALITY_MODEL_MAP[modality]
            raw_dir = resolved_run_root / "raw" / modality
            if not raw_dir.exists():
                continue

            batch: list[dict[str, Any]] = []
            page_files = sorted(raw_dir.glob("page-*.json"))
            summary.per_modality[modality].page_count = len(page_files)
            for page_path in page_files:
                source_page = parse_page_number(page_path)
                payload = json.loads(page_path.read_text(encoding="utf-8"))
                for item in payload.get("_items", []):
                    parsed = parse_observation(
                        modality,
                        item,
                        raw_payload_path=str(page_path),
                        source_page=source_page,
                    )
                    batch.append(parsed.values)
                    summary.per_modality[modality].observation_count += 1
                    if len(batch) >= batch_size:
                        _flush_batch(
                            session,
                            model,
                            batch,
                            summary.per_modality[modality],
                        )

            if batch:
                _flush_batch(
                    session,
                    model,
                    batch,
                    summary.per_modality[modality],
                )

    return summary


def load_dump(
    *,
    dump_root: str | Path | None = None,
    database_url: str | None = None,
    modalities: Iterable[str] | None = None,
    batch_size: int = 1000,
    create_schema_first: bool = True,
    progress_every: int | None = 5000,
) -> LoadSummary:
    resolved_dump_root = resolve_dump_root(dump_root=dump_root)
    url = database_url or default_database_url()
    if create_schema_first:
        create_database_schema(url=url)

    selected_modalities = list(modalities or MODALITY_MODEL_MAP)
    summary = LoadSummary(
        run_root=str(resolved_dump_root),
        database_url=url,
        per_modality={
            modality: ModalityLoadSummary(modality=modality)
            for modality in selected_modalities
        },
    )

    engine = create_database_engine(url=url)
    if engine.dialect.name == "postgresql":
        with engine.connect() as connection:
            for modality in selected_modalities:
                model = MODALITY_MODEL_MAP[modality]
                dump_path = resolved_dump_root / DUMP_FILENAME_MAP[modality]
                if not dump_path.exists():
                    continue

                batch: list[dict[str, Any]] = []
                summary.per_modality[modality].page_count = 1
                staging_table_name = _create_copy_staging_table(connection, model)
                resume_item = _resume_item_index(connection, model, dump_path)
                if resume_item > 0:
                    summary.per_modality[modality].updated_count += resume_item
                    print(
                        f"{modality}: resuming from item {resume_item + 1:,} "
                        f"based on existing raw_payload_path entries"
                    )

                for observation in iter_parsed_dump_observations(
                    resolved_dump_root,
                    modalities=[modality],
                    start_item_by_modality={modality: resume_item},
                ):
                    batch.append(observation.values)
                    summary.per_modality[modality].observation_count += 1
                    total_processed = (
                        resume_item + summary.per_modality[modality].observation_count
                    )
                    if (
                        progress_every is not None
                        and total_processed % progress_every == 0
                    ):
                        print(f"{modality}: processed {total_processed:,} rows")
                    if len(batch) >= batch_size:
                        _flush_copy_batch(
                            connection,
                            model,
                            staging_table_name,
                            batch,
                            summary.per_modality[modality],
                        )

                if batch:
                    _flush_copy_batch(
                        connection,
                        model,
                        staging_table_name,
                        batch,
                        summary.per_modality[modality],
                    )

        return summary

    with Session(engine) as session:
        for modality in selected_modalities:
            model = MODALITY_MODEL_MAP[modality]
            dump_path = resolved_dump_root / DUMP_FILENAME_MAP[modality]
            if not dump_path.exists():
                continue

            batch: list[dict[str, Any]] = []
            summary.per_modality[modality].page_count = 1
            for observation in iter_parsed_dump_observations(
                resolved_dump_root, modalities=[modality]
            ):
                batch.append(observation.values)
                summary.per_modality[modality].observation_count += 1
                if (
                    progress_every is not None
                    and summary.per_modality[modality].observation_count
                    % progress_every
                    == 0
                ):
                    print(
                        f"{modality}: processed "
                        f"{summary.per_modality[modality].observation_count:,} rows"
                    )
                if len(batch) >= batch_size:
                    # Dump backfills are append-only in practice; skipping existing
                    # source IDs is much cheaper than update-style upserts.
                    _flush_batch(
                        session,
                        model,
                        batch,
                        summary.per_modality[modality],
                        write_rows=_insert_or_skip_rows,
                    )

            if batch:
                _flush_batch(
                    session,
                    model,
                    batch,
                    summary.per_modality[modality],
                    write_rows=_insert_or_skip_rows,
                )

    return summary
