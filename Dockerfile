FROM python:3.12-slim
COPY --from=ghcr.io/prefix-dev/pixi:latest /usr/local/bin/pixi /usr/local/bin/pixi

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
