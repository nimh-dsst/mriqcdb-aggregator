from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any

from .models import (
    BOLD_SERIES_KEY_FIELDS,
    STRUCTURAL_SERIES_KEY_FIELDS,
    BoldRecord,
    DedupeStatus,
    T1wRecord,
    T2wRecord,
)


PAGE_FILENAME_RE = re.compile(r"page-(\d+)\.json$")

MODALITY_MODEL_MAP = {
    "T1w": T1wRecord,
    "T2w": T2wRecord,
    "bold": BoldRecord,
}

STRUCTURAL_TOP_LEVEL_FIELDS = (
    "cjv",
    "cnr",
    "efc",
    "fber",
    "fwhm_avg",
    "fwhm_x",
    "fwhm_y",
    "fwhm_z",
    "icvs_csf",
    "icvs_gm",
    "icvs_wm",
    "inu_med",
    "inu_range",
    "qi_1",
    "qi_2",
    "rpve_csf",
    "rpve_gm",
    "rpve_wm",
    "size_x",
    "size_y",
    "size_z",
    "snr_csf",
    "snr_gm",
    "snr_total",
    "snr_wm",
    "snrd_csf",
    "snrd_gm",
    "snrd_total",
    "snrd_wm",
    "spacing_x",
    "spacing_y",
    "spacing_z",
    "summary_bg_k",
    "summary_bg_mean",
    "summary_bg_median",
    "summary_bg_mad",
    "summary_bg_p05",
    "summary_bg_p95",
    "summary_bg_stdv",
    "summary_bg_n",
    "summary_csf_k",
    "summary_csf_mean",
    "summary_csf_median",
    "summary_csf_mad",
    "summary_csf_p05",
    "summary_csf_p95",
    "summary_csf_stdv",
    "summary_csf_n",
    "summary_gm_k",
    "summary_gm_mean",
    "summary_gm_median",
    "summary_gm_mad",
    "summary_gm_p05",
    "summary_gm_p95",
    "summary_gm_stdv",
    "summary_gm_n",
    "summary_wm_k",
    "summary_wm_mean",
    "summary_wm_median",
    "summary_wm_mad",
    "summary_wm_p05",
    "summary_wm_p95",
    "summary_wm_stdv",
    "summary_wm_n",
    "tpm_overlap_csf",
    "tpm_overlap_gm",
    "tpm_overlap_wm",
    "wm2max",
)

BOLD_TOP_LEVEL_FIELDS = (
    "aor",
    "aqi",
    "dummy_trs",
    "dvars_nstd",
    "dvars_std",
    "dvars_vstd",
    "efc",
    "fber",
    "fd_mean",
    "fd_num",
    "fd_perc",
    "fwhm_avg",
    "fwhm_x",
    "fwhm_y",
    "fwhm_z",
    "gcor",
    "gsr_x",
    "gsr_y",
    "size_t",
    "size_x",
    "size_y",
    "size_z",
    "snr",
    "spacing_tr",
    "spacing_x",
    "spacing_y",
    "spacing_z",
    "summary_bg_k",
    "summary_bg_mean",
    "summary_bg_median",
    "summary_bg_mad",
    "summary_bg_p05",
    "summary_bg_p95",
    "summary_bg_stdv",
    "summary_bg_n",
    "summary_fg_k",
    "summary_fg_mean",
    "summary_fg_median",
    "summary_fg_mad",
    "summary_fg_p05",
    "summary_fg_p95",
    "summary_fg_stdv",
    "summary_fg_n",
    "tsnr",
)

COMMON_BIDS_FIELD_MAP = {
    "modality": "modality",
    "subject_id": "subject_id",
    "session_id": "session_id",
    "run_id": "run_id",
    "acq_id": "acq_id",
    "task_id": "task_id",
    "AccelNumReferenceLines": "accel_num_reference_lines",
    "AccelerationFactorPE": "acceleration_factor_pe",
    "AcquisitionMatrix": "acquisition_matrix",
    "CogAtlasID": "cog_atlas_id",
    "CogPOID": "cog_poid",
    "CoilCombinationMethod": "coil_combination_method",
    "ContrastBolusIngredient": "contrast_bolus_ingredient",
    "ConversionSoftware": "conversion_software",
    "ConversionSoftwareVersion": "conversion_software_version",
    "DelayTime": "delay_time",
    "DeviceSerialNumber": "device_serial_number",
    "EchoTime": "echo_time",
    "EchoTrainLength": "echo_train_length",
    "EffectiveEchoSpacing": "effective_echo_spacing",
    "FlipAngle": "flip_angle",
    "GradientSetType": "gradient_set_type",
    "HardcopyDeviceSoftwareVersion": "hardcopy_device_software_version",
    "ImagingFrequency": "imaging_frequency",
    "InPlanePhaseEncodingDirection": "in_plane_phase_encoding_direction",
    "InstitutionAddress": "institution_address",
    "InstitutionName": "institution_name",
    "Instructions": "instructions",
    "InversionTime": "inversion_time",
    "MRAcquisitionType": "mr_acquisition_type",
    "MRTransmitCoilSequence": "mr_transmit_coil_sequence",
    "MagneticFieldStrength": "magnetic_field_strength",
    "Manufacturer": "manufacturer",
    "ManufacturersModelName": "manufacturers_model_name",
    "MatrixCoilMode": "matrix_coil_mode",
    "MultibandAccelerationFactor": "multiband_acceleration_factor",
    "NumberOfAverages": "number_of_averages",
    "NumberOfPhaseEncodingSteps": "number_of_phase_encoding_steps",
    "NumberOfVolumesDiscardedByScanner": "number_of_volumes_discarded_by_scanner",
    "NumberOfVolumesDiscardedByUser": "number_of_volumes_discarded_by_user",
    "NumberShots": "number_shots",
    "ParallelAcquisitionTechnique": "parallel_acquisition_technique",
    "ParallelReductionFactorInPlane": "parallel_reduction_factor_in_plane",
    "PartialFourier": "partial_fourier",
    "PartialFourierDirection": "partial_fourier_direction",
    "PatientPosition": "patient_position",
    "PercentPhaseFieldOfView": "percent_phase_field_of_view",
    "PercentSampling": "percent_sampling",
    "PhaseEncodingDirection": "phase_encoding_direction",
    "PixelBandwidth": "pixel_bandwidth",
    "ProtocolName": "protocol_name",
    "PulseSequenceDetails": "pulse_sequence_details",
    "PulseSequenceType": "pulse_sequence_type",
    "ReceiveCoilName": "receive_coil_name",
    "RepetitionTime": "repetition_time",
    "ScanOptions": "scan_options",
    "ScanningSequence": "scanning_sequence",
    "SequenceName": "sequence_name",
    "SequenceVariant": "sequence_variant",
    "SliceEncodingDirection": "slice_encoding_direction",
    "SoftwareVersions": "software_versions",
    "TaskDescription": "task_description",
    "TaskName": "task_name",
    "TotalReadoutTime": "total_readout_time",
    "TotalScanTimeSec": "total_scan_time_sec",
    "TransmitCoilName": "transmit_coil_name",
    "VariableFlipAngleFlag": "variable_flip_angle_flag",
}

PROVENANCE_FIELD_MAP = {
    "md5sum": "source_md5sum",
    "version": "mriqc_version",
    "software": "mriqc_software",
    "mriqc_pred": "mriqc_pred",
    "email": "provenance_email",
}

PROVENANCE_SETTINGS_FIELD_MAP = {
    "fd_thres": "settings_fd_thres",
    "hmc_fsl": "settings_hmc_fsl",
    "testing": "settings_testing",
}

RATING_FIELD_MAP = {
    "rating": "rating_label",
    "name": "rating_name",
    "comment": "rating_comment",
    "md5sum": "rating_md5sum",
}

MODEL_REQUIRED_EXCLUSIONS = {
    "id",
    "inserted_at",
    "canonical_source_api_id",
    "dedupe_status",
    "dedupe_exact_key",
    "dedupe_series_key",
    "payload_extra",
    "provenance_extra",
    "bids_meta_extra",
    "provenance_settings_extra",
    "rating_extra",
}


class PayloadMappingError(ValueError):
    """Raised when a raw MRIQC observation cannot be mapped safely."""


@dataclass(frozen=True)
class ParsedObservation:
    modality: str
    model: type[T1wRecord] | type[T2wRecord] | type[BoldRecord]
    values: dict[str, Any]
    source_page: int | None
    raw_payload_path: str


def parse_page_number(page_path: Path) -> int:
    match = PAGE_FILENAME_RE.search(page_path.name)
    if not match:
        raise PayloadMappingError(f"Could not determine page number from {page_path}")
    return int(match.group(1))


def parse_datetime(value: str | None) -> Any:
    if value is None:
        return None
    if value.endswith("Z"):
        value = f"{value[:-1]}+00:00"
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return parsedate_to_datetime(value)


def normalize_identity_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, str):
        normalized = " ".join(value.split()).strip().lower()
        return normalized or None
    if isinstance(value, float):
        return float(f"{value:.12g}")
    return value


def compute_dedupe_series_key(modality: str, values: dict[str, Any]) -> str:
    fields = (
        BOLD_SERIES_KEY_FIELDS if modality == "bold" else STRUCTURAL_SERIES_KEY_FIELDS
    )
    identity = {
        "modality": modality,
        "fields": {
            field: normalize_identity_value(values.get(field)) for field in fields
        },
    }
    payload = json.dumps(
        identity,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _mapped_column_names(
    model: type[T1wRecord] | type[T2wRecord] | type[BoldRecord],
) -> set[str]:
    return {column.name for column in model.__table__.columns}


def _validate_required_columns(
    model: type[T1wRecord] | type[T2wRecord] | type[BoldRecord],
    values: dict[str, Any],
) -> None:
    missing: list[str] = []
    for column in model.__table__.columns:
        if column.name in MODEL_REQUIRED_EXCLUSIONS:
            continue
        if column.nullable:
            continue
        if column.default is not None or column.server_default is not None:
            continue
        if values.get(column.name) is None:
            missing.append(column.name)
    if missing:
        raise PayloadMappingError(
            f"Missing required values for {model.__tablename__}: {', '.join(sorted(missing))}"
        )


def parse_observation(
    modality: str,
    payload: dict[str, Any],
    *,
    raw_payload_path: str,
    source_page: int | None,
) -> ParsedObservation:
    if modality not in MODALITY_MODEL_MAP:
        raise PayloadMappingError(f"Unsupported modality: {modality}")

    model = MODALITY_MODEL_MAP[modality]
    model_columns = _mapped_column_names(model)
    values: dict[str, Any] = {
        "raw_payload_path": raw_payload_path,
        "source_page": source_page,
        "source_api_id": payload["_id"],
        "source_etag": payload.get("_etag"),
        "source_created_at": parse_datetime(payload.get("_created")),
        "source_updated_at": parse_datetime(payload.get("_updated")),
        "modality": modality,
        "bids_meta_extra": {},
        "provenance_settings_extra": {},
        "provenance_extra": {},
        "payload_extra": {},
    }
    if model is BoldRecord:
        values["rating_extra"] = {}

    bids_meta = dict(payload.get("bids_meta", {}))
    provenance = dict(payload.get("provenance", {}))
    rating = dict(payload.get("rating", {}))

    for source_key, target_key in COMMON_BIDS_FIELD_MAP.items():
        if source_key in bids_meta and target_key in model_columns:
            values[target_key] = bids_meta.pop(source_key)
    values["bids_meta_extra"] = bids_meta

    settings = dict(provenance.get("settings", {}))
    for source_key, target_key in PROVENANCE_SETTINGS_FIELD_MAP.items():
        if source_key in settings:
            values[target_key] = settings.pop(source_key)
    values["provenance_settings_extra"] = settings

    for source_key, target_key in PROVENANCE_FIELD_MAP.items():
        if source_key in provenance:
            values[target_key] = provenance.pop(source_key)
    provenance.pop("settings", None)
    values["provenance_extra"] = provenance

    top_level_fields = (
        BOLD_TOP_LEVEL_FIELDS if modality == "bold" else STRUCTURAL_TOP_LEVEL_FIELDS
    )
    for field_name in top_level_fields:
        if field_name in payload:
            values[field_name] = payload[field_name]

    if model is BoldRecord:
        for source_key, target_key in RATING_FIELD_MAP.items():
            if source_key in rating:
                values[target_key] = rating.pop(source_key)
        values["rating_extra"] = rating

    handled_top_level = {
        "_id",
        "_etag",
        "_created",
        "_updated",
        "bids_meta",
        "provenance",
        "rating",
        *top_level_fields,
    }
    values["payload_extra"] = {
        key: value for key, value in payload.items() if key not in handled_top_level
    }

    values["dedupe_exact_key"] = values.get("source_md5sum")
    values["dedupe_series_key"] = compute_dedupe_series_key(modality, values)
    values["dedupe_status"] = DedupeStatus.PENDING

    _validate_required_columns(model, values)
    return ParsedObservation(
        modality=modality,
        model=model,
        values=values,
        source_page=source_page,
        raw_payload_path=raw_payload_path,
    )
