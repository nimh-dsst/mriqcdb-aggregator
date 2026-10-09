import { describe, expect, it } from 'vitest';
import { DROPPED_COLUMNS, isDroppedColumn, normalizeColumnName } from './normalize.js';

describe('normalizeColumnName', () => {
  it('drops the bids_meta prefix and snake_cases what is left', () => {
    expect(normalizeColumnName('bids_meta.EchoTime')).toBe('echo_time');
    expect(normalizeColumnName('bids_meta.ManufacturersModelName')).toBe(
      'manufacturers_model_name',
    );
    expect(normalizeColumnName('bids_meta.MagneticFieldStrength')).toBe('magnetic_field_strength');
    expect(normalizeColumnName('bids_meta.Manufacturer')).toBe('manufacturer');
    expect(normalizeColumnName('bids_meta.InstitutionName')).toBe('institution_name');
    expect(normalizeColumnName('bids_meta.ProtocolName')).toBe('protocol_name');
  });

  it('replaces remaining dots with underscores', () => {
    expect(normalizeColumnName('provenance.version')).toBe('provenance_version');
    expect(normalizeColumnName('provenance.md5sum')).toBe('provenance_md5sum');
    expect(normalizeColumnName('provenance.settings.fd_thres')).toBe('provenance_settings_fd_thres');
    expect(normalizeColumnName('provenance.warnings.small_air_mask')).toBe(
      'provenance_warnings_small_air_mask',
    );
  });

  it('renames the leading-underscore metadata columns', () => {
    expect(normalizeColumnName('_created')).toBe('created_at');
    expect(normalizeColumnName('_updated')).toBe('updated_at');
    expect(normalizeColumnName('_id')).toBe('id');
    expect(normalizeColumnName('_etag')).toBe('etag');
  });

  it('leaves already-normalized names alone', () => {
    for (const name of [
      'summary_bg_p05',
      'summary_wm_stdv',
      'wm2max',
      'qi_1',
      'size_t',
      'spacing_tr',
      'dvars_nstd',
      'fd_perc',
      'canonical_hmc_mode',
      'tpm_overlap_csf',
    ]) {
      expect(normalizeColumnName(name)).toBe(name);
    }
  });

  it('splits on case transitions only, never on digit boundaries', () => {
    expect(normalizeColumnName('bids_meta.MRAcquisitionType')).toBe('mr_acquisition_type');
    expect(normalizeColumnName('bids_meta.InPlanePhaseEncodingDirectionDICOM')).toBe(
      'in_plane_phase_encoding_direction_dicom',
    );
    expect(normalizeColumnName('bids_meta.PercentPhaseFOV')).toBe('percent_phase_fov');
    expect(normalizeColumnName('bids_meta.AcquisitionMatrixPE')).toBe('acquisition_matrix_pe');
    expect(normalizeColumnName('bids_meta.SAR')).toBe('sar');
    expect(normalizeColumnName('bids_meta.TxRefAmp')).toBe('tx_ref_amp');
  });

  it('collapses the repeated underscores of the case-collision column', () => {
    expect(normalizeColumnName('bids_meta.Modality__altcase1')).toBe('modality_altcase1');
  });

  it('is idempotent on its own output', () => {
    for (const name of [
      'bids_meta.EchoTime',
      'provenance.settings.fd_thres',
      'bids_meta.MRAcquisitionType',
      'summary_bg_p05',
    ]) {
      const once = normalizeColumnName(name);
      expect(normalizeColumnName(once)).toBe(once);
    }
  });
});

describe('isDroppedColumn', () => {
  it('flags the case-collision column and T1w’s exploded ImageType', () => {
    expect(isDroppedColumn('bids_meta.Modality__altcase1')).toBe(true);
    expect(isDroppedColumn('bids_meta.ImageType.value')).toBe(true);
    expect(isDroppedColumn('bids_meta.ImageType.units')).toBe(true);
    expect(DROPPED_COLUMNS).toHaveLength(6);
  });

  it('keeps the T2w and bold ImageType JSON text', () => {
    expect(isDroppedColumn('bids_meta.ImageType')).toBe(false);
    expect(isDroppedColumn('bids_meta.EchoTime')).toBe(false);
    expect(isDroppedColumn('_created')).toBe(false);
  });
});
