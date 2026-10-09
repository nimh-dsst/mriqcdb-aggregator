import { describe, expect, it } from 'vitest';
import {
  canonicalViewFor,
  exportableColumnsFor,
  fieldsFor,
  getAuthoredCatalog,
  isValidField,
  isValidMetric,
  metricsFor,
  viewsFor,
} from './authored.js';
import { CATALOG_VERSION, MODALITIES, type Modality, type View } from '../types.js';
import { normalizeColumnName } from '../normalize.js';

const catalog = getAuthoredCatalog();

/** The modality/view pairs that actually exist, per backend-graph.md. */
const PAIRS: ReadonlyArray<readonly [Modality, View]> = [
  ['bold', 'raw'],
  ['bold', 'k4plus'],
  ['bold', 'k4plus_all'],
  ['T1w', 'raw'],
  ['T1w', 'k3pp'],
  ['T1w', 'k3pp_all'],
  ['T2w', 'raw'],
  ['T2w', 'k3pp'],
  ['T2w', 'k3pp_all'],
];

/** Fields the catalog offers as binned numeric group-bys. */
const NUMERIC_GROUPABLES = [
  'echo_time',
  'repetition_time',
  'spacing_x',
  'spacing_y',
  'spacing_z',
  'spacing_tr',
  'size_x',
  'size_y',
  'size_z',
  'size_t',
];

describe('authored catalog integrity', () => {
  it('carries the shared catalog version', () => {
    expect(catalog.version).toBe(CATALOG_VERSION);
  });

  it('has no duplicate metric id within a modality', () => {
    for (const modality of MODALITIES) {
      const ids = metricsFor(modality).map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('has no duplicate field id within a modality and view', () => {
    for (const [modality, view] of PAIRS) {
      for (const role of ['filter', 'group', 'export'] as const) {
        const ids = fieldsFor(modality, view, role).map((f) => f.id);
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });

  it('gives every metric at least one modality', () => {
    for (const metric of catalog.metrics) {
      expect(metric.modalities.length).toBeGreaterThan(0);
      expect(metric.label).not.toBe('');
      expect(metric.family).not.toBe('');
      expect(metric.clipDefault).toBe('p01p99');
    }
  });

  it('gives every field at least one modality', () => {
    for (const field of catalog.fields) {
      expect(field.modalities.length).toBeGreaterThan(0);
      expect(field.filterable || field.groupable || field.exportable).toBe(true);
    }
  });

  it('declares every numeric groupable with kind "numeric"', () => {
    for (const id of NUMERIC_GROUPABLES) {
      const field = catalog.fields.find((f) => f.id === id);
      expect(field, `missing numeric groupable ${id}`).toBeDefined();
      expect(field?.kind).toBe('numeric');
      expect(field?.groupable).toBe(true);
    }
    // And nothing claims to be groupable without a kind that can be grouped.
    for (const field of catalog.fields.filter((f) => f.groupable)) {
      expect(['categorical', 'numeric']).toContain(field.kind);
    }
  });

  it('uses normalized column names as ids throughout', () => {
    for (const { id } of [...catalog.metrics, ...catalog.fields]) {
      expect(normalizeColumnName(id)).toBe(id);
    }
  });

  it('marks every field and metric exportable-reachable', () => {
    for (const [modality, view] of PAIRS) {
      const columns = exportableColumnsFor(modality, view);
      expect(new Set(columns).size).toBe(columns.length);
      expect(columns).toContain('id');
      expect(columns).toContain('provenance_md5sum');
      expect(columns).toContain('created_at');
      for (const metric of metricsFor(modality)) {
        expect(columns).toContain(metric.id);
      }
    }
  });

  it('counts the metrics each modality has', () => {
    expect(metricsFor('bold')).toHaveLength(44);
    expect(metricsFor('T1w')).toHaveLength(68);
    expect(metricsFor('T2w')).toHaveLength(68);
  });

  it('restricts canonical_hmc_mode to bold canonical views', () => {
    expect(isValidField('bold', 'k4plus', 'canonical_hmc_mode', 'group')).toBe(true);
    expect(isValidField('bold', 'raw', 'canonical_hmc_mode', 'group')).toBe(false);
    expect(isValidField('T1w', 'k3pp', 'canonical_hmc_mode', 'group')).toBe(false);
  });

  it('restricts bold-only columns to bold', () => {
    expect(isValidMetric('bold', 'fd_mean')).toBe(true);
    expect(isValidMetric('T1w', 'fd_mean')).toBe(false);
    expect(isValidMetric('T1w', 'cjv')).toBe(true);
    expect(isValidMetric('bold', 'cjv')).toBe(false);
    expect(isValidField('bold', 'raw', 'task_id', 'filter')).toBe(true);
    expect(isValidField('T1w', 'raw', 'task_id', 'filter')).toBe(false);
    expect(isValidField('bold', 'raw', 'size_t', 'group')).toBe(true);
    expect(isValidField('T2w', 'raw', 'size_t', 'group')).toBe(false);
  });

  it('rejects unknown ids and mismatched roles', () => {
    expect(isValidMetric('bold', 'not_a_metric')).toBe(false);
    expect(isValidField('bold', 'raw', 'not_a_field', 'filter')).toBe(false);
    // `id` is export-only.
    expect(isValidField('bold', 'raw', 'id', 'export')).toBe(true);
    expect(isValidField('bold', 'raw', 'id', 'filter')).toBe(false);
    // The date field is filterable but not groupable.
    expect(isValidField('bold', 'raw', 'created_at', 'filter')).toBe(true);
    expect(isValidField('bold', 'raw', 'created_at', 'group')).toBe(false);
  });

  it('gives each modality its raw view, its canonical policy, and that policy plus quarantine', () => {
    expect(viewsFor('bold').map((v) => v.id)).toEqual(['raw', 'k4plus', 'k4plus_all']);
    expect(viewsFor('T1w').map((v) => v.id)).toEqual(['raw', 'k3pp', 'k3pp_all']);
    expect(viewsFor('T2w').map((v) => v.id)).toEqual(['raw', 'k3pp', 'k3pp_all']);
    expect(catalog.views.find((v) => v.id === 'k4plus')?.policy).toBe('K4+');
    expect(catalog.views.find((v) => v.id === 'k3pp')?.policy).toBe('K3++');
    expect(catalog.views.find((v) => v.id === 'raw')?.policy).toBeUndefined();
    // The `_all` view is the same policy with its quarantine, and says so.
    expect(catalog.views.find((v) => v.id === 'k4plus_all')?.policy).toBe('K4+');
    expect(catalog.views.find((v) => v.id === 'k3pp_all')?.policy).toBe('K3++');
    expect(catalog.views.filter((v) => v.includesQuarantined).map((v) => v.id)).toEqual([
      'k4plus_all',
      'k3pp_all',
    ]);
    expect(catalog.views.find((v) => v.id === 'k4plus')?.includesQuarantined).toBeUndefined();
  });

  it('restricts the canonical-only numeric fields to the canonical views', () => {
    for (const id of ['canonical_diameter', 'canonical_group_rows']) {
      const field = catalog.fields.find((f) => f.id === id);
      expect(field?.kind).toBe('numeric');
      expect(field?.filterable).toBe(true);
      expect(field?.groupable).toBe(true);
      for (const role of ['filter', 'group'] as const) {
        expect(isValidField('bold', 'k4plus', id, role)).toBe(true);
        expect(isValidField('T1w', 'k3pp', id, role)).toBe(true);
        expect(isValidField('T2w', 'k3pp', id, role)).toBe(true);
        // Present on the canonical-plus-quarantined views too, where it is NULL
        // on every quarantined row.
        expect(isValidField('bold', 'k4plus_all', id, role)).toBe(true);
        expect(isValidField('T1w', 'k3pp_all', id, role)).toBe(true);
        // The raw log has no canonical column at all.
        expect(isValidField('bold', 'raw', id, role)).toBe(false);
        expect(isValidField('T1w', 'raw', id, role)).toBe(false);
      }
      // Every policy view, so the modality/view cross product -- and not a
      // per-modality list -- is what keeps each one on its own table.
      expect(field?.views).toEqual(['k4plus', 'k3pp', 'k4plus_all', 'k3pp_all']);
      // Every pair that really exists is covered, which is what the top bar and
      // the filter compiler ask about.
      for (const [modality, view] of PAIRS) {
        expect(isValidField(modality, view, id, 'filter')).toBe(view !== 'raw');
      }
    }
    expect(catalog.fields.find((f) => f.id === 'canonical_diameter')?.label).toBe(
      'Run-to-run stability',
    );
    expect(catalog.fields.find((f) => f.id === 'canonical_group_rows')?.label).toBe(
      'Times uploaded',
    );
  });

  it('gives every long metric label a short one, and no short one to a short label', () => {
    // `shortLabel` exists for the chip-sized places -- the brush chip above
    // all. Anything without one falls back to `label`, so the rule is only
    // that a long label has one.
    const long = catalog.metrics.filter((m) => m.label.length > 24);
    expect(long.length).toBeGreaterThan(0);
    for (const metric of long) {
      expect(metric.shortLabel, metric.label).toBeTruthy();
      expect((metric.shortLabel ?? '').length).toBeLessThan(metric.label.length);
    }
    const short = (id: string) => {
      const metric = catalog.metrics.find((m) => m.id === id);
      return metric?.shortLabel ?? metric?.label;
    };
    expect(short('fd_mean')).toBe('FD mean');
    expect(short('tsnr')).toBe('tSNR');
    expect(short('dvars_std')).toBe('DVARS std');
    expect(short('snr')).toBe('SNR');
    // A label short enough already keeps its own, through the fallback.
    expect(catalog.metrics.find((m) => m.id === 'size_x')?.shortLabel).toBeUndefined();
    expect(short('size_x')).toBe('Size X');
  });

  it('gives every metric a real description, not a placeholder', () => {
    for (const metric of catalog.metrics) {
      const description = metric.description ?? '';
      // Long enough to say what the metric measures, and not the label again:
      // the two shapes every placeholder the catalog used to carry had.
      expect(description.length, metric.id).toBeGreaterThan(40);
      expect(description, metric.id).not.toBe(metric.label);
      expect(description, metric.id).not.toBe(metric.shortLabel);
      // Short enough for the info popover to show without a scrollbar.
      expect(description.length, metric.id).toBeLessThanOrEqual(320);
    }
  });

  it('points every metric at the MRIQC documentation', () => {
    for (const metric of catalog.metrics) {
      expect(metric.docsUrl, metric.id).toMatch(
        /^https:\/\/mriqc\.readthedocs\.io\/en\/latest\/iqms\/(t1w|bold)\.html(#[\w-]+)?$/,
      );
      expect(['mriqc-docs', 'authored']).toContain(metric.source);
      // A doc-sourced description deep-links to the section it paraphrases; the
      // few columns the IQM pages do not define link to the page itself.
      expect(metric.docsUrl?.includes('#'), metric.id).toBe(metric.source === 'mriqc-docs');
    }
  });

  it('states a direction only as boolean or explicit null', () => {
    for (const metric of catalog.metrics) {
      expect([true, false, null], metric.id).toContain(metric.higherIsBetter);
      // A direction always says where it came from, and a metric with no
      // direction never claims a provenance for one.
      if (metric.higherIsBetter === null) {
        expect(metric.directionSource, metric.id).toBeUndefined();
      } else {
        expect(['mriqc-docs', 'convention'], metric.id).toContain(metric.directionSource);
      }
    }
    // Spot checks against the MRIQC docs: the three directions it does state.
    const dir = (id: string) => catalog.metrics.find((m) => m.id === id)?.higherIsBetter;
    expect(dir('efc')).toBe(false);
    expect(dir('cnr')).toBe(true);
    expect(dir('fber')).toBe(true);
    expect(dir('tsnr')).toBe(true);
    expect(dir('aqi')).toBe(false);
    // `wm2max` has a target interval, not a direction.
    expect(dir('wm2max')).toBeNull();
    // Directions the field agrees on but the IQM pages only describe.
    const src = (id: string) => catalog.metrics.find((m) => m.id === id)?.directionSource;
    expect(dir('fd_mean')).toBe(false);
    expect(src('fd_mean')).toBe('convention');
    expect(dir('snr')).toBe(true);
    expect(src('snr')).toBe('convention');
    expect(src('efc')).toBe('mriqc-docs');
  });

  it('gives the same id the same description in every family it appears in', () => {
    const byId = new Map<string, string>();
    for (const metric of catalog.metrics) {
      const seen = byId.get(metric.id);
      if (seen !== undefined) expect(metric.description, metric.id).toBe(seen);
      byId.set(metric.id, metric.description ?? '');
    }
  });

  it('names the views the way the "Scans shown" select reads them', () => {
    const label = (id: string) => catalog.views.find((v) => v.id === id)?.label;
    expect(label('raw')).toBe('Every upload (raw)');
    expect(label('k4plus')).toBe('Deduplicated (K4+)');
    expect(label('k4plus_all')).toBe('Deduplicated + unstable uploads (K4+)');
    expect(label('k3pp_all')).toBe('Deduplicated + unstable uploads (K3++)');
  });

  it('names each modality a canonical default view', () => {
    expect(canonicalViewFor('bold')).toBe('k4plus');
    expect(canonicalViewFor('T1w')).toBe('k3pp');
    expect(canonicalViewFor('T2w')).toBe('k3pp');
  });

  it('marks every categorical field filterable and groupable, bar the identity columns', () => {
    for (const field of catalog.fields) {
      if (field.kind !== 'categorical') continue;
      if (field.id === 'id' || field.id === 'provenance_md5sum') {
        expect(field.filterable).toBe(false);
        continue;
      }
      expect(field.filterable).toBe(true);
      expect(field.groupable).toBe(true);
    }
  });
});
