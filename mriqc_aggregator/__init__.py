"""MRIQC aggregator tooling."""

from .database import (
    create_database_engine,
    create_database_schema,
    create_session_factory,
    default_database_url,
)
from .loading import (
    LoadSummary,
    ModalityLoadSummary,
    load_dump,
    load_raw_run,
    resolve_dump_root,
    resolve_run_root,
)
from .models import Base, BoldRecord, DedupeStatus, T1wRecord, T2wRecord
from .parsing import ParsedObservation, PayloadMappingError, parse_observation
from .profiling import (
    DatabaseProfiler,
    DuplicateKind,
    ObservationFilters,
    ObservationView,
    write_database_profile,
)

__all__ = [
    "__version__",
    "Base",
    "BoldRecord",
    "create_database_engine",
    "create_database_schema",
    "create_session_factory",
    "DatabaseProfiler",
    "DedupeStatus",
    "default_database_url",
    "DuplicateKind",
    "LoadSummary",
    "load_dump",
    "load_raw_run",
    "ModalityLoadSummary",
    "ObservationFilters",
    "ObservationView",
    "ParsedObservation",
    "parse_observation",
    "PayloadMappingError",
    "resolve_run_root",
    "resolve_dump_root",
    "T1wRecord",
    "T2wRecord",
    "write_database_profile",
]

__version__ = "0.1.0"
