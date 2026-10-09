import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  MODALITIES,
  NONE_FILTER_VALUE,
  categoryLabel,
  fieldValueLabel,
  type Modality,
} from './index.js';

describe('@mriqc/shared', () => {
  it('exposes a catalog version and every modality', () => {
    expect(CATALOG_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const bold: Modality = 'bold';
    expect(MODALITIES).toContain(bold);
    expect(MODALITIES).toHaveLength(3);
  });
});

describe('how a categorical value is written', () => {
  it('calls the empty bucket "Not reported", not "(none)"', () => {
    // "(none)" read as a value of zero, or as an empty filter. The bucket is a
    // fact about the upload: nobody wrote the field down.
    expect(categoryLabel(null)).toBe('Not reported');
    expect(categoryLabel(undefined)).toBe('Not reported');
    expect(categoryLabel('')).toBe('Not reported');
    expect(fieldValueLabel('manufacturer', null)).toBe('Not reported');
    expect(fieldValueLabel('manufacturer', '')).toBe('Not reported');
  });

  it('gives a field its own names for its values where it has them', () => {
    expect(fieldValueLabel('canonical_hmc_mode', 'afni')).toBe('AFNI (3dvolreg)');
    expect(fieldValueLabel('canonical_hmc_mode', 'fsl')).toBe('FSL (MCFLIRT)');
    expect(fieldValueLabel('canonical_hmc_mode', 'unknown')).toBe('Unknown');
  });

  it('leaves the stored value alone, so a filter still matches', () => {
    // Display only: the sentinel the wire carries is unchanged.
    expect(NONE_FILTER_VALUE).toBe('');
    expect(fieldValueLabel('manufacturer', 'Siemens')).toBe('Siemens');
    expect(fieldValueLabel('canonical_hmc_mode', 'something-new')).toBe('something-new');
    expect(fieldValueLabel(null, 'Siemens')).toBe('Siemens');
    expect(fieldValueLabel(undefined, 42)).toBe('42');
  });
});
