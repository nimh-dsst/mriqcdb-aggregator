import {
  MODALITIES,
  canonicalViewFor,
  type CompletedCatalog,
  type Modality,
  type View,
} from '@mriqc/shared';
import type { State } from '../graph/state';
import { latestUpload } from '../slices/filters/view';
import { CATALOG_KEY } from '../slices/history/results';

/** A complete category partition counts all rows, including the missing-value bucket.
 * The catalog caps lists at 200, so a capped partition cannot establish a total.
 */
export function catalogCount(
  catalog: CompletedCatalog,
  modality: Modality,
  view: View,
): number | null {
  const values = catalog.fieldValues['magnetic_field_strength']?.[modality]?.[view];
  return !values || values.length >= 200 ? null : values.reduce((sum, value) => sum + value.n, 0);
}

export function aboutView(state: State) {
  const catalog = state.catalog;
  const entry = state.datasets[CATALOG_KEY];
  return {
    catalog,
    error: entry?.status === 'error' ? entry.error : null,
    version: catalog?.dataVersion ?? state.dataVersion,
    latest: latestUpload(catalog),
    populations: MODALITIES.map((modality) => ({
      modality,
      label:
        modality === 'bold'
          ? 'BOLD (functional)'
          : modality === 'T1w'
            ? 'T1-weighted'
            : 'T2-weighted',
      uploads: catalog ? catalogCount(catalog, modality, 'raw') : null,
      scans: catalog ? catalogCount(catalog, modality, canonicalViewFor(modality)) : null,
      quarantine: catalog?.quarantine[modality] ?? null,
    })),
  };
}

export function aboutEquals(
  a: ReturnType<typeof aboutView>,
  b: ReturnType<typeof aboutView>,
): boolean {
  return a.catalog === b.catalog && a.version === b.version && a.error === b.error;
}
