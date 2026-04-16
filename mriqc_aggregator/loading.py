from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

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

    statement = dialect_insert(model).values(rows)
    update_columns = {
        column.name: getattr(statement.excluded, column.name)
        for column in model.__table__.columns
        if column.name not in {"id", "inserted_at"}
    }
    statement = statement.on_conflict_do_update(
        index_elements=[model.__table__.c.source_api_id],
        set_=update_columns,
    )
    session.execute(statement)
    return inserted_count, updated_count


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
                        inserted, updated = _upsert_rows(session, model, batch)
                        summary.per_modality[modality].inserted_count += inserted
                        summary.per_modality[modality].updated_count += updated
                        session.commit()
                        batch.clear()

            if batch:
                inserted, updated = _upsert_rows(session, model, batch)
                summary.per_modality[modality].inserted_count += inserted
                summary.per_modality[modality].updated_count += updated
                session.commit()

    return summary
