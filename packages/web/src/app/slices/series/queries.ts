import {
asColumnId,
fieldValueLabel,isNoneValue,NONE_FILTER_VALUE
} from '@mriqc/shared';
import { groupCohortId,type Cohort,type Panel,type State } from '../../graph/state';
import { panelCohort } from "../cohorts/queries";
import { cohortById } from '../cohorts/scopes';
import { studyFormReason } from "../study/queries";
import { seriesKey,seriesLabel } from './model';

export type ResolvedSeries = Cohort & { descriptorKey?: string };

export function groupingSeries(panel: Panel) { return panel.series.find(series => series.kind === 'field' || series.kind === 'values' || series.kind === 'buckets'); }


/** The id a custom-split group's cohort carries; `bucketName` reads it back. */
export const BUCKET_PREFIX = 'b\u0000';

export function bucketCohortId(name: string): string { return BUCKET_PREFIX + name; }

export function bucketName(id: string): string | null { return id.startsWith(BUCKET_PREFIX) ? id.slice(BUCKET_PREFIX.length) : null; }


/** One expansion for every form. A grouping partitions the dashboard curve; its aggregate still supplies stats. */
export function panelCohorts(state: State, panel: Panel): readonly ResolvedSeries[] {
  const base = panelCohort(state, panel);
  const grouped = groupingSeries(panel);
  const out: ResolvedSeries[] = grouped ? [] : [base];
  for (const descriptor of panel.series) {
    if (descriptor.kind === 'study' && studyFormReason(panel, state)) continue;
    const descriptorKey = seriesKey(descriptor);
    if (descriptor.kind === 'field' || descriptor.kind === 'values') {
      const entries = state.catalog?.fieldValues?.[descriptor.field]?.[state.global.modality]?.[state.global.view] ?? [];
      const wire = (value: string | number | boolean | null) => isNoneValue(value) ? NONE_FILTER_VALUE : value!;
      const ranked = [...entries].sort((a, b) => b.n - a.n || String(a.value).localeCompare(String(b.value)));
      const selected = descriptor.kind === 'values' ? descriptor.values.map(value =>
        entries.find(entry => String(wire(entry.value)) === value) ?? { value, n: 0 }) : ranked.slice(0, 5);
      for (const entry of selected) {
        const value = wire(entry.value);
        out.push({ ...base, id: groupCohortId(descriptor.field, String(value)),
          name: fieldValueLabel(String(descriptor.field), entry.value), color: out.length,
          filters: [...base.filters, { field: descriptor.field, op: 'in', values: [value] }], descriptorKey });
      }
      if (descriptor.kind === 'field' && ranked.length > 5) {
        const values = ranked.slice(5).map(entry => wire(entry.value));
        out.push({ ...base, id: groupCohortId(descriptor.field, 'other:' + JSON.stringify(values)), name: 'Other', color: 6,
          filters: [...base.filters, { field: descriptor.field, op: 'in', values }], descriptorKey });
      }
      continue;
    }
    if (descriptor.kind === 'buckets') {
      // Each group narrows the dashboard by its own filters. A group that names
      // a field the top bar also filters gets the intersection, as everywhere.
      for (const bucket of descriptor.buckets) {
        out.push({ ...base, id: bucketCohortId(bucket.name), name: bucket.name, color: out.length,
          filters: [...base.filters, ...bucket.filters],
          selections: [...(bucket.selections ?? []), ...base.selections].slice(0, 4), descriptorKey });
      }
      continue;
    }
    if (descriptor.kind === 'span') {
      out.push({ ...base, id: descriptorKey, name: seriesLabel(descriptor), color: out.length, descriptorKey,
        filters: [...base.filters.filter(filter => filter.field !== 'created_at'),
          { field: asColumnId('created_at'), op: 'between', lo: descriptor.from, hi: descriptor.to }] });
      continue;
    }
    const id = descriptor.kind === 'population' ? 'all' : descriptor.kind === 'study' ? 'study' : descriptor.id;
    const cohort = cohortById(state, id);
    // A saved group keeps the colour picked for it; the rest take their slot.
    if (cohort) out.push({ ...cohort, color: descriptor.kind === 'cohort' ? cohort.color : out.length, descriptorKey });
  }
  return out;
}

export function splitDistributionCohorts(state: State, panel: Panel): readonly Cohort[] {
  return groupingSeries(panel) ? panelCohorts(state, panel).filter(cohort => cohort.descriptorKey === seriesKey(groupingSeries(panel)!)) : [];
}
