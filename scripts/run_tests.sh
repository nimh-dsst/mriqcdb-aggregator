#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

docker compose up -d --no-recreate postgres >/dev/null

for _ in $(seq 1 60); do
  postgres_container_id="$(docker compose ps -q postgres 2>/dev/null || true)"
  status=""
  if [[ -n "$postgres_container_id" ]]; then
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$postgres_container_id" 2>/dev/null || true)"
  fi
  if [[ "$status" == "healthy" ]]; then
    exec python -m pytest "$@"
  fi
  sleep 1
done

echo "Postgres container did not become healthy in time" >&2
exit 1
