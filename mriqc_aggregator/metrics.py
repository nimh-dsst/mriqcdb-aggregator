from __future__ import annotations

from dataclasses import asdict, dataclass

from .parsing import BOLD_TOP_LEVEL_FIELDS, STRUCTURAL_TOP_LEVEL_FIELDS


QC_METRIC_FIELDS = {
    "T1w": STRUCTURAL_TOP_LEVEL_FIELDS,
    "T2w": STRUCTURAL_TOP_LEVEL_FIELDS,
    "bold": BOLD_TOP_LEVEL_FIELDS,
}


TOKEN_LABELS = {
    "aor": "AFNI outlier ratio",
    "aqi": "AFNI quality index",
    "avg": "Average",
    "bg": "Background",
    "cjv": "Coefficient of joint variation",
    "cnr": "Contrast-to-noise ratio",
    "csf": "CSF",
    "dvars": "DVARS",
    "efc": "Entropy-focus criterion",
    "fber": "Foreground-background energy ratio",
    "fd": "Framewise displacement",
    "fg": "Foreground",
    "fwhm": "Full-width at half maximum",
    "gcor": "Global correlation",
    "gm": "Gray matter",
    "gsr": "Ghost-to-signal ratio",
    "icvs": "Intracranial volume fraction",
    "inu": "Intensity non-uniformity",
    "mad": "MAD",
    "nstd": "Standardized",
    "p05": "P05",
    "p95": "P95",
    "perc": "Percent",
    "qi": "Quality index",
    "rpve": "Residual partial volume error",
    "snr": "Signal-to-noise ratio",
    "snrd": "Dietrich SNR",
    "std": "Standard",
    "stdv": "Standard deviation",
    "tpm": "TPM overlap",
    "tr": "TR",
    "tsnr": "Temporal SNR",
    "vstd": "Voxelwise standardized",
    "wm": "White matter",
    "wm2max": "White-matter to max ratio",
}


@dataclass(frozen=True)
class MetricDescriptor:
    field: str
    label: str
    family: str
    subfamily: str
    unit_hint: str | None = None

    def to_dict(self) -> dict[str, str | None]:
        return asdict(self)


def supported_metric_fields(modality: str) -> tuple[str, ...]:
    try:
        return QC_METRIC_FIELDS[modality]
    except KeyError as exc:
        raise ValueError(f"Unsupported modality: {modality}") from exc


def metric_descriptors_for_modality(modality: str) -> tuple[MetricDescriptor, ...]:
    return tuple(
        MetricDescriptor(
            field=field,
            label=humanize_metric_field(field),
            family=_metric_family(field, modality),
            subfamily=_metric_subfamily(field, modality),
            unit_hint=_metric_unit_hint(field),
        )
        for field in supported_metric_fields(modality)
    )


def humanize_metric_field(field_name: str) -> str:
    if field_name in TOKEN_LABELS:
        return TOKEN_LABELS[field_name]

    parts = field_name.split("_")
    labels: list[str] = []
    for token in parts:
        if token in TOKEN_LABELS:
            labels.append(TOKEN_LABELS[token])
        elif len(token) == 1 and token.isalpha():
            labels.append(token.upper())
        elif token.isdigit():
            labels.append(token)
        else:
            labels.append(token.replace("stdv", "stdv").title())
    return " ".join(labels)


def _metric_family(field_name: str, modality: str) -> str:
    if field_name.startswith("fd_") or field_name == "dummy_trs":
        return "Motion"
    if field_name.startswith("dvars") or field_name in {"aor", "aqi", "gcor", "gsr_x", "gsr_y", "tsnr"}:
        return "Temporal Stability"
    if field_name.startswith("fwhm") or field_name.startswith("size_") or field_name.startswith("spacing_"):
        return "Resolution"
    if field_name.startswith("summary_"):
        return "Tissue Summaries" if modality in {"T1w", "T2w"} else "Signal Summaries"
    if field_name.startswith("snr") or field_name.startswith("snrd"):
        return "Signal Quality"
    if field_name.startswith("icvs") or field_name.startswith("rpve") or field_name.startswith("tpm_overlap"):
        return "Tissue Composition"
    if field_name.startswith("inu") or field_name in {"cjv", "cnr", "efc", "fber", "qi_1", "qi_2", "wm2max"}:
        return "Artifacts and Contrast"
    return "Other"


def _metric_subfamily(field_name: str, modality: str) -> str:
    if field_name.startswith("fd_"):
        return "Framewise displacement"
    if field_name == "dummy_trs":
        return "Pre-steady-state volumes"
    if field_name.startswith("dvars"):
        return "DVARS"
    if field_name in {"aor", "aqi"}:
        return "AFNI quality"
    if field_name in {"gcor", "gsr_x", "gsr_y"}:
        return "Global signal"
    if field_name == "tsnr":
        return "Temporal SNR"
    if field_name.startswith("fwhm"):
        return "Smoothness"
    if field_name.startswith("size_"):
        return "Matrix size"
    if field_name.startswith("spacing_"):
        return "Voxel spacing"
    if field_name.startswith("summary_bg_"):
        return "Background"
    if field_name.startswith("summary_fg_"):
        return "Foreground"
    if field_name.startswith("summary_csf_"):
        return "CSF"
    if field_name.startswith("summary_gm_"):
        return "Gray matter"
    if field_name.startswith("summary_wm_"):
        return "White matter"
    if field_name.startswith("snrd_"):
        return "Dietrich SNR"
    if field_name.startswith("snr_"):
        return "Tissue SNR"
    if field_name == "snr":
        return "Overall SNR"
    if field_name.startswith("icvs_"):
        return "Intracranial volume fractions"
    if field_name.startswith("rpve_"):
        return "Partial volume error"
    if field_name.startswith("tpm_overlap_"):
        return "TPM overlap"
    if field_name.startswith("inu_"):
        return "Intensity non-uniformity"
    if field_name.startswith("qi_"):
        return "Artifact detection"
    if field_name in {"cjv", "cnr", "efc", "fber", "wm2max"}:
        return "Global quality"
    return "Other"


def _metric_unit_hint(field_name: str) -> str | None:
    if field_name.startswith("spacing_"):
        return "mm"
    if field_name.startswith("size_") or field_name in {"dummy_trs", "fd_num"}:
        return "count"
    if field_name == "spacing_tr":
        return "s"
    if field_name.endswith("_perc"):
        return "percent"
    return None
