from __future__ import annotations

import sys

from mriqc_aggregator.cli import main


if __name__ == "__main__":
    raise SystemExit(main(["load-raw-run", *sys.argv[1:]]))
