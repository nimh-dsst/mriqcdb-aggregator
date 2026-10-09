/**
 * The `(modality, view)` to table map.
 *
 * See `docs/backend-graph.md`, "Serving schema": views are the only names the
 * procedures address, and a pair maps through this fixed table in code. No user
 * string ever reaches a table name.
 */

import type { Modality, View } from '@mriqc/shared';

/**
 * The table each servable pair reads from. Keys are `${modality}/${view}`.
 *
 * The `canon_*` tables and the `v_*_all` views are both written by the build
 * (`db/build.ts`, which materializes each policy's `canonical` view and defines
 * the union view over it); the names are the ones `db/canonical.ts` derives
 * from each policy, which `canonical.test.ts` checks against this map.
 */
const TABLES: Readonly<Record<string, string>> = {
  'bold/raw': 'raw_bold',
  'bold/k4plus': 'canon_bold_k4plus',
  'bold/k4plus_all': 'v_bold_k4plus_all',
  'T1w/raw': 'raw_t1w',
  'T1w/k3pp': 'canon_t1w_k3pp',
  'T1w/k3pp_all': 'v_t1w_k3pp_all',
  'T2w/raw': 'raw_t2w',
  'T2w/k3pp': 'canon_t2w_k3pp',
  'T2w/k3pp_all': 'v_t2w_k3pp_all',
};

/** Every servable pair, in catalog order. */
export const VIEW_PAIRS: ReadonlyArray<readonly [Modality, View]> = [
  ['bold', 'raw'],
  ['bold', 'k4plus'],
  ['bold', 'k4plus_all'],
  ['T1w', 'raw'],
  ['T1w', 'k3pp'],
  ['T1w', 'k3pp_all'],
  ['T2w', 'raw'],
  ['T2w', 'k3pp'],
  ['T2w', 'k3pp_all'],
] as const;

/** Thrown for a `(modality, view)` pair that has no table. */
export class UnknownViewError extends Error {
  constructor(modality: string, view: string) {
    super(`no table for (${modality}, ${view})`);
    this.name = 'UnknownViewError';
  }
}

/** The table backing `(modality, view)`. Throws on any pair that does not exist. */
export function tableFor(modality: Modality, view: View): string {
  const table = TABLES[`${modality}/${view}`];
  if (table === undefined) throw new UnknownViewError(modality, view);
  return table;
}

/** True when `(modality, view)` names a real table. */
export function isServableView(modality: Modality, view: View): boolean {
  return TABLES[`${modality}/${view}`] !== undefined;
}
