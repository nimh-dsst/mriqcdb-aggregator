from __future__ import annotations

import argparse
from pathlib import Path

from .loading import load_raw_run
from .workflows import MODALITIES, pull_representative_sample


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="mriqc-aggregator",
        description="MRIQC representative sampling and raw database loading.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    pull_parser = subparsers.add_parser(
        "pull-representative",
        help="Pull representative raw pages from the MRIQC Web API.",
    )
    pull_parser.add_argument(
        "--output-root",
        type=Path,
        default=Path("data"),
        help="Root directory for ignored local outputs.",
    )
    pull_parser.add_argument(
        "--modalities",
        nargs="+",
        default=list(MODALITIES),
        choices=list(MODALITIES),
        help="Modalities to sample.",
    )
    pull_parser.add_argument(
        "--pages-per-modality",
        type=int,
        default=64,
        help="Number of archive-spanning raw pages to fetch per modality.",
    )
    pull_parser.add_argument(
        "--target-total-gb",
        type=float,
        default=None,
        help="Optional total raw size budget across modalities.",
    )
    pull_parser.add_argument(
        "--max-pages-per-modality",
        type=int,
        default=128,
        help="Hard cap on sampled raw pages per modality.",
    )
    pull_parser.add_argument(
        "--max-probe-rounds",
        type=int,
        default=12,
        help="Maximum exponential page probes per modality.",
    )

    load_parser = subparsers.add_parser(
        "load-raw-run",
        help="Load a sampled raw run into PostgreSQL without normalization.",
    )
    load_parser.add_argument(
        "--run-id",
        help="Run identifier under data/runs/<run-id>.",
    )
    load_parser.add_argument(
        "--run-root",
        type=Path,
        help="Explicit path to a sampled run directory.",
    )
    load_parser.add_argument(
        "--database-url",
        help="Database URL override. Defaults to MRIQC_DATABASE_URL.",
    )
    load_parser.add_argument(
        "--modalities",
        nargs="+",
        default=list(MODALITIES),
        choices=list(MODALITIES),
        help="Modalities to load.",
    )
    load_parser.add_argument(
        "--batch-size",
        type=int,
        default=250,
        help="Batch size for idempotent upsert operations.",
    )
    load_parser.add_argument(
        "--skip-schema",
        action="store_true",
        help="Do not create database tables before loading.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "pull-representative":
        layout = pull_representative_sample(
            output_root=args.output_root,
            modalities=args.modalities,
            pages_per_modality=args.pages_per_modality,
            target_total_gb=args.target_total_gb,
            max_pages_per_modality=args.max_pages_per_modality,
            max_probe_rounds=args.max_probe_rounds,
        )
        print(f"Representative sample written to {layout.root}")
        return 0

    if args.command == "load-raw-run":
        summary = load_raw_run(
            run_id=args.run_id,
            run_root=args.run_root,
            database_url=args.database_url,
            modalities=args.modalities,
            batch_size=args.batch_size,
            create_schema_first=not args.skip_schema,
        )
        print(summary.to_dict())
        return 0

    parser.error(f"Unsupported command: {args.command}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
