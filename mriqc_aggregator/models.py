from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum as SQLEnum,
    Float,
    Integer,
    JSON,
    MetaData,
)
from sqlalchemy import String, Text, UniqueConstraint, Index, func
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class DedupeStatus(str, Enum):
    PENDING = "pending"
    CANONICAL = "canonical"
    DUPLICATE = "duplicate"
    REVIEW = "review"


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


STRUCTURAL_SERIES_KEY_FIELDS = (
    "subject_id",
    "session_id",
    "run_id",
    "acq_id",
    "manufacturer",
    "manufacturers_model_name",
    "magnetic_field_strength",
    "echo_time",
    "repetition_time",
    "inversion_time",
    "flip_angle",
    "size_x",
    "size_y",
    "size_z",
    "spacing_x",
    "spacing_y",
    "spacing_z",
)


BOLD_SERIES_KEY_FIELDS = (
    "subject_id",
    "session_id",
    "run_id",
    "acq_id",
    "task_id",
    "task_name",
    "manufacturer",
    "manufacturers_model_name",
    "magnetic_field_strength",
    "echo_time",
    "repetition_time",
    "flip_angle",
    "size_t",
    "size_x",
    "size_y",
    "size_z",
    "spacing_tr",
    "spacing_x",
    "spacing_y",
    "spacing_z",
)


class SourceRecordMixin:
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)

    source_api_id: Mapped[str] = mapped_column(String(24), nullable=False)
    source_page: Mapped[int | None] = mapped_column(Integer)
    source_etag: Mapped[str | None] = mapped_column(String(40))
    source_created_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    source_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    raw_payload_path: Mapped[str | None] = mapped_column(String(512))

    source_md5sum: Mapped[str] = mapped_column(String(32), nullable=False)
    mriqc_version: Mapped[str] = mapped_column(String(64), nullable=False)
    mriqc_software: Mapped[str] = mapped_column(String(32), nullable=False)
    mriqc_pred: Mapped[int | None] = mapped_column(Integer)
    provenance_email: Mapped[str | None] = mapped_column(String(320))

    settings_fd_thres: Mapped[float | None] = mapped_column(Float)
    settings_hmc_fsl: Mapped[bool | None] = mapped_column(Boolean)
    settings_testing: Mapped[bool | None] = mapped_column(Boolean)
    provenance_settings_extra: Mapped[dict[str, Any]] = mapped_column(
        JSON, nullable=False, default=dict
    )
    provenance_extra: Mapped[dict[str, Any]] = mapped_column(
        JSON, nullable=False, default=dict
    )
    payload_extra: Mapped[dict[str, Any]] = mapped_column(
        JSON, nullable=False, default=dict
    )

    dedupe_exact_key: Mapped[str | None] = mapped_column(String(64))
    dedupe_series_key: Mapped[str | None] = mapped_column(String(64))
    dedupe_status: Mapped[DedupeStatus] = mapped_column(
        SQLEnum(DedupeStatus, name="dedupe_status"),
        nullable=False,
        default=DedupeStatus.PENDING,
    )
    canonical_source_api_id: Mapped[str | None] = mapped_column(String(24))
    inserted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class CommonBidsMixin:
    subject_id: Mapped[str] = mapped_column(String(64), nullable=False)
    session_id: Mapped[str | None] = mapped_column(String(64))
    run_id: Mapped[str | None] = mapped_column(String(64))
    acq_id: Mapped[str | None] = mapped_column(String(64))
    task_id: Mapped[str | None] = mapped_column(String(128))

    accel_num_reference_lines: Mapped[int | None] = mapped_column(Integer)
    acceleration_factor_pe: Mapped[int | None] = mapped_column(Integer)
    acquisition_matrix: Mapped[str | None] = mapped_column(String(64))
    cog_atlas_id: Mapped[str | None] = mapped_column(String(128))
    cog_poid: Mapped[str | None] = mapped_column(String(128))
    coil_combination_method: Mapped[str | None] = mapped_column(String(128))
    contrast_bolus_ingredient: Mapped[str | None] = mapped_column(String(128))
    conversion_software: Mapped[str | None] = mapped_column(String(128))
    conversion_software_version: Mapped[str | None] = mapped_column(String(64))
    delay_time: Mapped[float | None] = mapped_column(Float)
    device_serial_number: Mapped[str | None] = mapped_column(String(128))
    echo_time: Mapped[float | None] = mapped_column(Float)
    echo_train_length: Mapped[int | None] = mapped_column(Integer)
    effective_echo_spacing: Mapped[float | None] = mapped_column(Float)
    flip_angle: Mapped[int | None] = mapped_column(Integer)
    gradient_set_type: Mapped[str | None] = mapped_column(String(128))
    hardcopy_device_software_version: Mapped[str | None] = mapped_column(String(64))
    imaging_frequency: Mapped[int | None] = mapped_column(Integer)
    in_plane_phase_encoding_direction: Mapped[str | None] = mapped_column(String(32))
    institution_address: Mapped[str | None] = mapped_column(Text)
    institution_name: Mapped[str | None] = mapped_column(String(255))
    instructions: Mapped[str | None] = mapped_column(Text)
    inversion_time: Mapped[float | None] = mapped_column(Float)
    mr_acquisition_type: Mapped[str | None] = mapped_column(String(32))
    mr_transmit_coil_sequence: Mapped[str | None] = mapped_column(String(128))
    magnetic_field_strength: Mapped[float | None] = mapped_column(Float)
    manufacturer: Mapped[str | None] = mapped_column(String(64))
    manufacturers_model_name: Mapped[str | None] = mapped_column(String(128))
    matrix_coil_mode: Mapped[str | None] = mapped_column(String(64))
    multiband_acceleration_factor: Mapped[float | None] = mapped_column(Float)
    number_of_averages: Mapped[int | None] = mapped_column(Integer)
    number_of_phase_encoding_steps: Mapped[int | None] = mapped_column(Integer)
    number_of_volumes_discarded_by_scanner: Mapped[float | None] = mapped_column(Float)
    number_of_volumes_discarded_by_user: Mapped[float | None] = mapped_column(Float)
    number_shots: Mapped[int | None] = mapped_column(Integer)
    parallel_acquisition_technique: Mapped[str | None] = mapped_column(String(64))
    parallel_reduction_factor_in_plane: Mapped[float | None] = mapped_column(Float)
    partial_fourier: Mapped[bool | None] = mapped_column(Boolean)
    partial_fourier_direction: Mapped[str | None] = mapped_column(String(32))
    patient_position: Mapped[str | None] = mapped_column(String(128))
    percent_phase_field_of_view: Mapped[int | None] = mapped_column(Integer)
    percent_sampling: Mapped[int | None] = mapped_column(Integer)
    phase_encoding_direction: Mapped[str | None] = mapped_column(String(32))
    pixel_bandwidth: Mapped[int | None] = mapped_column(Integer)
    protocol_name: Mapped[str | None] = mapped_column(String(255))
    pulse_sequence_details: Mapped[str | None] = mapped_column(Text)
    pulse_sequence_type: Mapped[str | None] = mapped_column(String(128))
    receive_coil_name: Mapped[str | None] = mapped_column(String(128))
    repetition_time: Mapped[float | None] = mapped_column(Float)
    scan_options: Mapped[str | None] = mapped_column(String(255))
    scanning_sequence: Mapped[str | None] = mapped_column(String(128))
    sequence_name: Mapped[str | None] = mapped_column(String(128))
    sequence_variant: Mapped[str | None] = mapped_column(String(128))
    slice_encoding_direction: Mapped[str | None] = mapped_column(String(32))
    software_versions: Mapped[str | None] = mapped_column(String(255))
    task_description: Mapped[str | None] = mapped_column(Text)
    total_readout_time: Mapped[float | None] = mapped_column(Float)
    total_scan_time_sec: Mapped[int | None] = mapped_column(Integer)
    transmit_coil_name: Mapped[str | None] = mapped_column(String(128))
    variable_flip_angle_flag: Mapped[str | None] = mapped_column(String(32))
    bids_meta_extra: Mapped[dict[str, Any]] = mapped_column(
        JSON, nullable=False, default=dict
    )


class StructuralIQMMixin:
    cjv: Mapped[float] = mapped_column(Float, nullable=False)
    cnr: Mapped[float] = mapped_column(Float, nullable=False)
    efc: Mapped[float] = mapped_column(Float, nullable=False)
    fber: Mapped[float] = mapped_column(Float, nullable=False)
    fwhm_avg: Mapped[float] = mapped_column(Float, nullable=False)
    fwhm_x: Mapped[float] = mapped_column(Float, nullable=False)
    fwhm_y: Mapped[float] = mapped_column(Float, nullable=False)
    fwhm_z: Mapped[float] = mapped_column(Float, nullable=False)
    icvs_csf: Mapped[float] = mapped_column(Float, nullable=False)
    icvs_gm: Mapped[float] = mapped_column(Float, nullable=False)
    icvs_wm: Mapped[float] = mapped_column(Float, nullable=False)
    inu_med: Mapped[float] = mapped_column(Float, nullable=False)
    inu_range: Mapped[float] = mapped_column(Float, nullable=False)
    qi_1: Mapped[float] = mapped_column(Float, nullable=False)
    qi_2: Mapped[float] = mapped_column(Float, nullable=False)
    rpve_csf: Mapped[float] = mapped_column(Float, nullable=False)
    rpve_gm: Mapped[float] = mapped_column(Float, nullable=False)
    rpve_wm: Mapped[float] = mapped_column(Float, nullable=False)
    size_x: Mapped[int] = mapped_column(Integer, nullable=False)
    size_y: Mapped[int] = mapped_column(Integer, nullable=False)
    size_z: Mapped[int] = mapped_column(Integer, nullable=False)
    snr_csf: Mapped[float] = mapped_column(Float, nullable=False)
    snr_gm: Mapped[float] = mapped_column(Float, nullable=False)
    snr_total: Mapped[float] = mapped_column(Float, nullable=False)
    snr_wm: Mapped[float] = mapped_column(Float, nullable=False)
    snrd_csf: Mapped[float] = mapped_column(Float, nullable=False)
    snrd_gm: Mapped[float] = mapped_column(Float, nullable=False)
    snrd_total: Mapped[float] = mapped_column(Float, nullable=False)
    snrd_wm: Mapped[float] = mapped_column(Float, nullable=False)
    spacing_x: Mapped[float] = mapped_column(Float, nullable=False)
    spacing_y: Mapped[float] = mapped_column(Float, nullable=False)
    spacing_z: Mapped[float] = mapped_column(Float, nullable=False)
    summary_bg_k: Mapped[float] = mapped_column(Float, nullable=False)
    summary_bg_mean: Mapped[float] = mapped_column(Float, nullable=False)
    summary_bg_median: Mapped[float | None] = mapped_column(Float)
    summary_bg_mad: Mapped[float | None] = mapped_column(Float)
    summary_bg_p05: Mapped[float] = mapped_column(Float, nullable=False)
    summary_bg_p95: Mapped[float] = mapped_column(Float, nullable=False)
    summary_bg_stdv: Mapped[float] = mapped_column(Float, nullable=False)
    summary_bg_n: Mapped[float | None] = mapped_column(Float)
    summary_csf_k: Mapped[float] = mapped_column(Float, nullable=False)
    summary_csf_mean: Mapped[float] = mapped_column(Float, nullable=False)
    summary_csf_median: Mapped[float | None] = mapped_column(Float)
    summary_csf_mad: Mapped[float | None] = mapped_column(Float)
    summary_csf_p05: Mapped[float] = mapped_column(Float, nullable=False)
    summary_csf_p95: Mapped[float] = mapped_column(Float, nullable=False)
    summary_csf_stdv: Mapped[float] = mapped_column(Float, nullable=False)
    summary_csf_n: Mapped[float | None] = mapped_column(Float)
    summary_gm_k: Mapped[float] = mapped_column(Float, nullable=False)
    summary_gm_mean: Mapped[float] = mapped_column(Float, nullable=False)
    summary_gm_median: Mapped[float | None] = mapped_column(Float)
    summary_gm_mad: Mapped[float | None] = mapped_column(Float)
    summary_gm_p05: Mapped[float] = mapped_column(Float, nullable=False)
    summary_gm_p95: Mapped[float] = mapped_column(Float, nullable=False)
    summary_gm_stdv: Mapped[float] = mapped_column(Float, nullable=False)
    summary_gm_n: Mapped[float | None] = mapped_column(Float)
    summary_wm_k: Mapped[float] = mapped_column(Float, nullable=False)
    summary_wm_mean: Mapped[float] = mapped_column(Float, nullable=False)
    summary_wm_median: Mapped[float | None] = mapped_column(Float)
    summary_wm_mad: Mapped[float | None] = mapped_column(Float)
    summary_wm_p05: Mapped[float] = mapped_column(Float, nullable=False)
    summary_wm_p95: Mapped[float] = mapped_column(Float, nullable=False)
    summary_wm_stdv: Mapped[float] = mapped_column(Float, nullable=False)
    summary_wm_n: Mapped[float | None] = mapped_column(Float)
    tpm_overlap_csf: Mapped[float] = mapped_column(Float, nullable=False)
    tpm_overlap_gm: Mapped[float] = mapped_column(Float, nullable=False)
    tpm_overlap_wm: Mapped[float] = mapped_column(Float, nullable=False)
    wm2max: Mapped[float] = mapped_column(Float, nullable=False)


class BoldIQMMixin:
    aor: Mapped[float] = mapped_column(Float, nullable=False)
    aqi: Mapped[float] = mapped_column(Float, nullable=False)
    dummy_trs: Mapped[int | None] = mapped_column(Integer)
    dvars_nstd: Mapped[float] = mapped_column(Float, nullable=False)
    dvars_std: Mapped[float] = mapped_column(Float, nullable=False)
    dvars_vstd: Mapped[float] = mapped_column(Float, nullable=False)
    efc: Mapped[float] = mapped_column(Float, nullable=False)
    fber: Mapped[float] = mapped_column(Float, nullable=False)
    fd_mean: Mapped[float] = mapped_column(Float, nullable=False)
    fd_num: Mapped[float] = mapped_column(Float, nullable=False)
    fd_perc: Mapped[float] = mapped_column(Float, nullable=False)
    fwhm_avg: Mapped[float] = mapped_column(Float, nullable=False)
    fwhm_x: Mapped[float] = mapped_column(Float, nullable=False)
    fwhm_y: Mapped[float] = mapped_column(Float, nullable=False)
    fwhm_z: Mapped[float] = mapped_column(Float, nullable=False)
    gcor: Mapped[float] = mapped_column(Float, nullable=False)
    gsr_x: Mapped[float] = mapped_column(Float, nullable=False)
    gsr_y: Mapped[float] = mapped_column(Float, nullable=False)
    size_t: Mapped[float] = mapped_column(Float, nullable=False)
    size_x: Mapped[float] = mapped_column(Float, nullable=False)
    size_y: Mapped[float] = mapped_column(Float, nullable=False)
    size_z: Mapped[float] = mapped_column(Float, nullable=False)
    snr: Mapped[float] = mapped_column(Float, nullable=False)
    spacing_tr: Mapped[float] = mapped_column(Float, nullable=False)
    spacing_x: Mapped[float] = mapped_column(Float, nullable=False)
    spacing_y: Mapped[float] = mapped_column(Float, nullable=False)
    spacing_z: Mapped[float] = mapped_column(Float, nullable=False)
    summary_bg_k: Mapped[float] = mapped_column(Float, nullable=False)
    summary_bg_mean: Mapped[float] = mapped_column(Float, nullable=False)
    summary_bg_median: Mapped[float] = mapped_column(Float, nullable=False)
    summary_bg_mad: Mapped[float] = mapped_column(Float, nullable=False)
    summary_bg_p05: Mapped[float] = mapped_column(Float, nullable=False)
    summary_bg_p95: Mapped[float] = mapped_column(Float, nullable=False)
    summary_bg_stdv: Mapped[float] = mapped_column(Float, nullable=False)
    summary_bg_n: Mapped[float] = mapped_column(Float, nullable=False)
    summary_fg_k: Mapped[float] = mapped_column(Float, nullable=False)
    summary_fg_mean: Mapped[float] = mapped_column(Float, nullable=False)
    summary_fg_median: Mapped[float] = mapped_column(Float, nullable=False)
    summary_fg_mad: Mapped[float] = mapped_column(Float, nullable=False)
    summary_fg_p05: Mapped[float] = mapped_column(Float, nullable=False)
    summary_fg_p95: Mapped[float] = mapped_column(Float, nullable=False)
    summary_fg_stdv: Mapped[float] = mapped_column(Float, nullable=False)
    summary_fg_n: Mapped[float] = mapped_column(Float, nullable=False)
    tsnr: Mapped[float] = mapped_column(Float, nullable=False)


def _common_table_args(
    table_name: str,
    *,
    include_task_identity: bool,
) -> tuple[object, ...]:
    identity_columns = ["subject_id", "session_id", "run_id", "acq_id"]
    if include_task_identity:
        identity_columns.append("task_id")
    indexes: list[object] = [
        UniqueConstraint("source_api_id", name=f"uq_{table_name}_source_api_id"),
        Index(f"ix_{table_name}_source_created_at", "source_created_at"),
        Index(f"ix_{table_name}_source_md5sum", "source_md5sum"),
        Index(f"ix_{table_name}_dedupe_exact_key", "dedupe_exact_key"),
        Index(f"ix_{table_name}_dedupe_series_key", "dedupe_series_key"),
        Index(f"ix_{table_name}_canonical_source_api_id", "canonical_source_api_id"),
        Index(f"ix_{table_name}_identity", *identity_columns),
        Index(f"ix_{table_name}_manufacturer", "manufacturer"),
        Index(
            f"ix_{table_name}_scanner",
            "manufacturer",
            "manufacturers_model_name",
            "magnetic_field_strength",
        ),
        Index(f"ix_{table_name}_mriqc_version", "mriqc_version"),
    ]
    if include_task_identity:
        indexes.append(Index(f"ix_{table_name}_task_id", "task_id"))
    return tuple(indexes)


class T1wRecord(SourceRecordMixin, CommonBidsMixin, StructuralIQMMixin, Base):
    __tablename__ = "t1w"
    __table_args__ = _common_table_args("t1w", include_task_identity=False)

    modality: Mapped[str] = mapped_column(String(8), nullable=False, default="T1w")


class T2wRecord(SourceRecordMixin, CommonBidsMixin, StructuralIQMMixin, Base):
    __tablename__ = "t2w"
    __table_args__ = _common_table_args("t2w", include_task_identity=False)

    modality: Mapped[str] = mapped_column(String(8), nullable=False, default="T2w")


class BoldRecord(SourceRecordMixin, CommonBidsMixin, BoldIQMMixin, Base):
    __tablename__ = "bold"
    __table_args__ = _common_table_args("bold", include_task_identity=True)

    modality: Mapped[str] = mapped_column(String(8), nullable=False, default="bold")
    task_name: Mapped[str | None] = mapped_column(String(255))

    rating_label: Mapped[str | None] = mapped_column(String(64))
    rating_name: Mapped[str | None] = mapped_column(String(255))
    rating_comment: Mapped[str | None] = mapped_column(Text)
    rating_md5sum: Mapped[str | None] = mapped_column(String(32))
    rating_extra: Mapped[dict[str, Any]] = mapped_column(
        JSON, nullable=False, default=dict
    )
