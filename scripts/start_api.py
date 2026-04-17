from __future__ import annotations

import os

from mriqc_aggregator.database import create_database_schema, default_database_url


def _exec_server() -> None:
    app_module = os.environ.get("APP_MODULE", "mriqc_aggregator.app:app")
    api_port = os.environ.get("API_PORT", "8000")
    app_server = os.environ.get("APP_SERVER", "uvicorn").strip().lower()

    if app_server == "gunicorn":
        os.execvp(
            "gunicorn",
            [
                "gunicorn",
                app_module,
                "--bind",
                f"0.0.0.0:{api_port}",
                "--worker-class",
                "uvicorn.workers.UvicornWorker",
                "--workers",
                os.environ.get("GUNICORN_WORKERS", "3"),
                "--timeout",
                os.environ.get("GUNICORN_TIMEOUT", "120"),
                "--access-logfile",
                "-",
                "--error-logfile",
                "-",
            ],
        )

    if app_server == "uvicorn":
        os.execvp(
            "uvicorn",
            [
                "uvicorn",
                app_module,
                "--host",
                "0.0.0.0",
                "--port",
                api_port,
            ],
        )

    raise SystemExit(f"Unsupported APP_SERVER value: {app_server}")


if __name__ == "__main__":
    create_database_schema(url=default_database_url())
    _exec_server()
