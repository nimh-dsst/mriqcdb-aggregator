/**
 * The name a cohort gets when nobody types one.
 *
 * Saving the dashboard as a cohort is meant to be one click, which means the
 * name cannot be a question. It is composed from the only things that make this
 * slice different from any other -- the modality, the view, the filters in
 * force, the date range and the brush -- in that order, because that is the
 * order of how much each one narrows the corpus.
 *
 * Pure, and in its own file, so every combination is a table-driven unit test
 * rather than something that has to be read out of a rendered chip.
 */

import {
fieldValueLabel,
fieldsFor,
metricsFor,
type ColumnId,
type CompletedCatalog,
type Filter,
type Modality,
type Selection,
type View,
} from '@mriqc/shared';

/**
 * How a view is written in a cohort name.
 *
 * Short enough for a chip, and the policy id rather than the sentence: a reader
 * assembling cohorts is choosing between views by name, and "Deduplicated,
 * plus the raw uploads of groups the policy refused" is not a name.
 */
const VIEW_SHORT: Record<View, string> = {
  raw: 'raw',
  k4plus: 'K4+',
  k3pp: 'K3++',
  k4plus_all: 'K4+ +unstable',
  k3pp_all: 'K3++ +unstable',
};

/** The separator between a name's parts. */
const SEP = ' · ';

/** What a cohort with nothing narrowing it is called. */
export const UNFILTERED_SUMMARY = 'all';

/**
 * Fields whose values do not identify themselves.
 *
 * "Siemens" is obviously a manufacturer and "3T" is obviously a field strength,
 * so neither needs its column named. "1" as a value of "Times uploaded" is not
 * obviously anything, so that one does. The rule is the flag: a value that
 * reads as a bare number or a bare word with no domain needs its field.
 */
function needsFieldName(value: string): boolean {
  // A value that is only digits, or digits with a unit a reader cannot place,
  // says nothing on its own.
  return /^[\d.]+$/.test(value);
}

/** One categorical filter, written for a name. */
function summariseIn(
  filter: Extract<Filter, { op: 'in' }>,
  label: (field: string) => string,
): string {
  const values = filter.values.map((value) => fieldValueLabel(filter.field, value));
  // Two or three values are still readable as a list; past that the count is
  // the honest summary, because a chip cannot hold nine manufacturers.
  const written =
    values.length <= 3 ? values.join(', ') : `${values.length} ${label(filter.field)}`;
  return needsFieldName(written) ? `${label(filter.field)}: ${written}` : written;
}

/** The year, or the span of years, a date range covers. */
export function yearsOf(lo: string | number, hi: string | number): string | null {
  const from = new Date(lo);
  const to = new Date(hi);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  const a = from.getUTCFullYear();
  const b = to.getUTCFullYear();
  return a === b ? String(a) : `${a}–${b}`;
}

/** Two significant figures, which is all a name has room for. */
function brief(value: number): string {
  if (!Number.isFinite(value)) return '?';
  const rounded = Number(value.toPrecision(2));
  return String(rounded);
}

/**
 * The auto-generated name for the dashboard as it stands.
 *
 * "K4+ · Siemens · 2019–2021 · FD mean 0.1–0.4". Every part is dropped
 * when it says nothing: an unfiltered dashboard on its canonical view is
 * "K4+ · all", because a name with no distinguishing part at all would
 * be indistinguishable from the next one.
 */
export function cohortAutoName(
  modality: Modality,
  view: View,
  filters: readonly Filter[],
  selections: readonly Selection[],
  catalog: CompletedCatalog | null = null,
): string {
  const fields = fieldsFor(modality, view, 'filter');
  const label = (field: string) =>
    fields.find((def) => def.id === field)?.label ?? String(field);
  // Cohorts are valid only within one modality, so the modality adds no
  // distinction; the view remains because raw and deduplicated are comparable.
  const parts: string[] = [VIEW_SHORT[view] ?? view];

  const summaries: string[] = [];
  let years: string | null = null;
  for (const filter of filters) {
    if (filter.field === 'created_at' && filter.op === 'between') {
      years = yearsOf(filter.lo, filter.hi);
      continue;
    }
    if (filter.op === 'in') {
      summaries.push(summariseIn(filter, label));
      continue;
    }
    if (filter.op === 'between') {
      summaries.push(`${label(filter.field)} ${brief(Number(filter.lo))}–${brief(Number(filter.hi))}`);
      continue;
    }
    summaries.push(filter.op === 'isNull' ? `no ${label(filter.field)}` : `has ${label(filter.field)}`);
  }

  const brushes = selections.map(selection => {
    const metric = metricsFor(modality).find((m) => m.id === selection.metric);
    const name = metric?.shortLabel ?? metric?.label ?? String(selection.metric);
    return `${name} ${brief(selection.range[0])}–${brief(selection.range[1])}`;
  });

  const narrowing = [...summaries, years, ...brushes].filter(
    (part): part is string => part !== null && part !== '',
  );
  // `catalog` is accepted so a future rule can read a field's value list -- to
  // tell an ambiguous value from an unambiguous one by how many fields carry
  // it -- without changing every caller. Nothing needs it yet.
  void catalog;
  return [...parts, ...(narrowing.length > 0 ? narrowing : [UNFILTERED_SUMMARY])].join(SEP);
}

/**
 * The same name, made unique against the names already taken.
 *
 * " (2)", " (3)" and so on. Two cohorts with one name are indistinguishable in
 * a legend and in every row of the statistics table, and the one-click path
 * will produce the same name twice the moment a reader saves the dashboard,
 * changes nothing, and saves it again.
 */
export function uniqueCohortName(name: string, taken: readonly string[]): string {
  if (!taken.includes(name)) return name;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${name} (${n})`;
    if (!taken.includes(candidate)) return candidate;
  }
  return name;
}

/** The metric ids a name may mention, for the type of `selection`. */
export type NamedMetric = ColumnId;
