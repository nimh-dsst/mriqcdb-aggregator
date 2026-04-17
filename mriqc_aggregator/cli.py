from __future__ import annotations

import argparse
from pathlib import Path

from .loading import load_dump, load_raw_run
from .profiling import ObservationView, write_database_profile
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
        default=None,
        help=(
            "Optional hard cap on sampled raw pages per modality. "
            "If omitted, explicit page requests are honored as-is."
        ),
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

    dump_parser = subparsers.add_parser(
        "load-dump",
        help="Load a direct MRIQC dump into PostgreSQL without going through API pages.",
    )
    dump_parser.add_argument(
        "--dump-root",
        type=Path,
        default=Path("data") / "dump",
        help="Directory containing mriqc_api.<modality>.json dump files.",
    )
    dump_parser.add_argument(
        "--database-url",
        help="Database URL override. Defaults to MRIQC_DATABASE_URL.",
    )
    dump_parser.add_argument(
        "--modalities",
        nargs="+",
        default=list(MODALITIES),
        choices=list(MODALITIES),
        help="Modalities to load.",
    )
    dump_parser.add_argument(
        "--batch-size",
        type=int,
        default=1000,
        help="Batch size for bulk dump ingestion chunks.",
    )
    dump_parser.add_argument(
        "--skip-schema",
        action="store_true",
        help="Do not create database tables before loading.",
    )
    dump_parser.add_argument(
        "--progress-every",
        type=int,
        default=5000,
        help="Emit a progress line every N rows per modality. Use 0 to disable.",
    )

    profile_parser = subparsers.add_parser(
        "profile-db",
        help="Profile loaded PostgreSQL data for backend exploration.",
    )
    profile_parser.add_argument(
        "--output-root",
        type=Path,
        default=Path("docs") / "temp",
        help="Root directory for ignored profile outputs.",
    )
    profile_parser.add_argument(
        "--database-url",
        help="Database URL override. Defaults to MRIQC_DATABASE_URL.",
    )
    profile_parser.add_argument(
        "--modalities",
        nargs="+",
        default=list(MODALITIES),
        choices=list(MODALITIES),
        help="Modalities to profile.",
    )
    profile_parser.add_argument(
        "--view",
        choices=[view.value for view in ObservationView],
        default=ObservationView.RAW.value,
        help="Representative row mode to use for profile outputs.",
    )
    profile_parser.add_argument(
        "--top-n",
        type=int,
        default=10,
        help="Maximum number of categorical values to keep per field.",
    )
    profile_parser.add_argument(
        "--duplicate-group-limit",
        type=int,
        default=10,
        help="Maximum number of duplicate groups to sample per duplicate kind.",
    )
    profile_parser.add_argument(
        "--duplicate-member-limit",
        type=int,
        default=5,
        help="Maximum rows to sample inside each duplicate group.",
    )
    profile_parser.add_argument(
        "--extra-key-limit",
        type=int,
        default=25,
        help="Maximum number of extra JSON keys to keep per extra column.",
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

    if args.command == "load-dump":
        summary = load_dump(
            dump_root=args.dump_root,
            database_url=args.database_url,
            modalities=args.modalities,
            batch_size=args.batch_size,
            create_schema_first=not args.skip_schema,
            progress_every=args.progress_every or None,
        )
        print(summary.to_dict())
        return 0

    if args.command == "profile-db":
        run_root = write_database_profile(
            output_root=args.output_root,
            database_url=args.database_url,
            modalities=args.modalities,
            view=ObservationView(args.view),
            top_n=args.top_n,
            duplicate_group_limit=args.duplicate_group_limit,
            duplicate_member_limit=args.duplicate_member_limit,
            extra_key_limit=args.extra_key_limit,
        )
        print(f"Database profile written to {run_root}")
        return 0

    parser.error(f"Unsupported command: {args.command}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
