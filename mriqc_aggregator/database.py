from __future__ import annotations

import os

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import sessionmaker

from .models import Base


DEFAULT_DATABASE_URL = (
    "postgresql+psycopg://mriqc:mriqc@localhost:5432/mriqc_aggregator"
)


def default_database_url() -> str:
    return os.environ.get("MRIQC_DATABASE_URL", DEFAULT_DATABASE_URL)


def create_database_engine(
    url: str | None = None,
    *,
    echo: bool = False,
) -> Engine:
    return create_engine(
        url or default_database_url(),
        echo=echo,
        pool_pre_ping=True,
        future=True,
    )


def create_database_schema(url: str | None = None, *, echo: bool = False) -> None:
    engine = create_database_engine(url=url, echo=echo)
    with engine.begin() as connection:
        Base.metadata.create_all(connection)


def create_session_factory(
    url: str | None = None,
    *,
    echo: bool = False,
) -> sessionmaker:
    return sessionmaker(
        bind=create_database_engine(url=url, echo=echo),
        autoflush=False,
        expire_on_commit=False,
        future=True,
    )
