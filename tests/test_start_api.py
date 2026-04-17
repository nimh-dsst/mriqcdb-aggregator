from __future__ import annotations

import os

import pytest

from scripts import start_api


def test_exec_server_uses_uvicorn_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, list[str]] = {}

    def fake_execvp(program: str, argv: list[str]) -> None:
        captured["program"] = program
        captured["argv"] = argv
        raise SystemExit(0)

    monkeypatch.delenv("APP_SERVER", raising=False)
    monkeypatch.setenv("API_PORT", "8010")
    monkeypatch.setattr(os, "execvp", fake_execvp)

    with pytest.raises(SystemExit) as exc_info:
        start_api._exec_server()

    assert exc_info.value.code == 0
    assert captured["program"] == "uvicorn"
    assert captured["argv"] == [
        "uvicorn",
        "mriqc_aggregator.app:app",
        "--host",
        "0.0.0.0",
        "--port",
        "8010",
    ]


def test_exec_server_uses_gunicorn_when_requested(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, list[str]] = {}

    def fake_execvp(program: str, argv: list[str]) -> None:
        captured["program"] = program
        captured["argv"] = argv
        raise SystemExit(0)

    monkeypatch.setenv("APP_SERVER", "gunicorn")
    monkeypatch.setenv("API_PORT", "9000")
    monkeypatch.setenv("GUNICORN_WORKERS", "5")
    monkeypatch.setenv("GUNICORN_TIMEOUT", "240")
    monkeypatch.setattr(os, "execvp", fake_execvp)

    with pytest.raises(SystemExit) as exc_info:
        start_api._exec_server()

    assert exc_info.value.code == 0
    assert captured["program"] == "gunicorn"
    assert captured["argv"] == [
        "gunicorn",
        "mriqc_aggregator.app:app",
        "--bind",
        "0.0.0.0:9000",
        "--worker-class",
        "uvicorn.workers.UvicornWorker",
        "--workers",
        "5",
        "--timeout",
        "240",
        "--access-logfile",
        "-",
        "--error-logfile",
        "-",
    ]


def test_exec_server_rejects_unknown_server(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APP_SERVER", "unknown")

    with pytest.raises(SystemExit, match="Unsupported APP_SERVER value: unknown"):
        start_api._exec_server()
