import { histogram } from './histogram';
import { line } from './line';
import { area } from './area';
import { density } from './density';
import { ecdf } from './ecdf';
import { box } from './box';
import { table } from './table';
import { heatmap } from './heatmap';
import { scatter } from './scatter';
import { hexbin } from './hexbin';
import { clusters } from './clusters';
import { band } from './band';
import { lines } from './lines';
import { bars } from './bars';
import { share } from './share';
import { matrix } from './matrix';
import type { ColumnRef, MetricId } from '../graph/state';
import type { Series } from '../graph/series';
import type { Availability, FormDef } from './types';

/** Append forms here: existing indices are version-1 URL tokens. */
export const FORM_DEFS = [
  histogram, line, area, density, ecdf, box, table, heatmap, scatter, hexbin, clusters, band, lines, bars, share, matrix
] as const;
export type FormId = (typeof FORM_DEFS)[number]['id'];
export const FORM_ORDER: readonly FormId[] = FORM_DEFS.map(def => def.id);
const definitions: ReadonlyMap<string, FormDef> = new Map(FORM_DEFS.map(def => [def.id, def]));
export function formDef(id: FormId): FormDef {
  const def = definitions.get(id);
  if (!def) throw new Error('Unknown form: ' + id);
  return def;
}
export type FormAvailability = Availability & { form: FormId };
export function formAvailability(x: ColumnRef | readonly MetricId[], y: MetricId | null, series: readonly Series[] = []): readonly FormAvailability[] {
  return FORM_DEFS.map(def => ({ form: def.id, ...def.availability(x, y, series) }));
}
