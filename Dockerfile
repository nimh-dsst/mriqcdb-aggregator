FROM python:3.12-slim

ARG PIXI_VERSION=v0.67.0

RUN arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
        amd64) pixi_arch="x86_64-unknown-linux-musl" ;; \
        arm64) pixi_arch="aarch64-unknown-linux-musl" ;; \
        *) echo "Unsupported architecture for pixi: $arch" >&2; exit 1 ;; \
    esac \
    && python -c "import pathlib, urllib.request; pathlib.Path('/usr/local/bin/pixi').write_bytes(urllib.request.urlopen('https://github.com/prefix-dev/pixi/releases/download/${PIXI_VERSION}/pixi-${pixi_arch}').read())" \
    && chmod +x /usr/local/bin/pixi

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PIXI_HOME=/root/.pixi
ENV PATH="${PIXI_HOME}/bin:${PATH}"

WORKDIR /app

COPY pixi.toml pyproject.toml README.md /app/
COPY mriqc_aggregator /app/mriqc_aggregator
COPY scripts /app/scripts

RUN pixi install

EXPOSE 8000

CMD ["pixi", "run", "python", "scripts/start_api.py"]
