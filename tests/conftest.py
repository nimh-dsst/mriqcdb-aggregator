from __future__ import annotations

import os
import uuid
from urllib.parse import quote

import psycopg
import pytest
from psycopg import sql


def _postgres_settings() -> dict[str, str]:
    return {
        "host": os.environ.get("TEST_POSTGRES_HOST", "127.0.0.1"),
        "port": os.environ.get(
            "TEST_POSTGRES_PORT", os.environ.get("POSTGRES_PORT", "5432")
        ),
        "user": os.environ.get(
            "TEST_POSTGRES_USER", os.environ.get("POSTGRES_USER", "mriqc")
        ),
        "password": os.environ.get(
            "TEST_POSTGRES_PASSWORD",
            os.environ.get("POSTGRES_PASSWORD", "mriqc"),
        ),
        "admin_db": os.environ.get("TEST_POSTGRES_ADMIN_DB", "postgres"),
    }


def _postgres_admin_conninfo() -> str:
    settings = _postgres_settings()
    return (
        f"host={settings['host']} "
        f"port={settings['port']} "
        f"dbname={settings['admin_db']} "
        f"user={settings['user']} "
        f"password={settings['password']}"
    )


def _postgres_database_url(database_name: str) -> str:
    settings = _postgres_settings()
    user = quote(settings["user"])
    password = quote(settings["password"])
    return (
        f"postgresql+psycopg://{user}:{password}"
        f"@{settings['host']}:{settings['port']}/{database_name}"
    )


@pytest.fixture
def postgres_database_url() -> str:
    database_name = f"mriqc_test_{uuid.uuid4().hex}"
    admin_conninfo = _postgres_admin_conninfo()
    try:
        with psycopg.connect(admin_conninfo, autocommit=True) as connection:
            connection.execute(
                sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database_name))
            )
    except psycopg.Error as exc:
        pytest.fail(
            f"Failed to create test database on local Postgres. "
            f"Make sure `docker compose up -d postgres` is running. {exc}"
        )

    try:
        yield _postgres_database_url(database_name)
    finally:
        with psycopg.connect(admin_conninfo, autocommit=True) as connection:
            connection.execute(
                "SELECT pg_terminate_backend(pid) "
                "FROM pg_stat_activity "
                "WHERE datname = %s AND pid <> pg_backend_pid()",
                (database_name,),
            )
            connection.execute(
                sql.SQL("DROP DATABASE IF EXISTS {}").format(
                    sql.Identifier(database_name)
                )
            )
