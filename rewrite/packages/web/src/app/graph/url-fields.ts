import { shapeOf } from './panel-shapes';
/**
 * The URL grammar: one field table per record, driving both directions.
 *
 * A field says what key it is written under, how a value becomes text, how text
 * becomes a value, and what the field is when the payload leaves it out -- and
 * that last one is also the rule for leaving it out, because a field whose text
 * equals its fallback's text is simply not written. So the default dashboard
 * writes almost nothing, and nothing can drift between the two directions: both
 * read the same table.
 *
 * The text is a flat, delimited grammar rather than JSON, one separator per
 * nesting level ({@link SEP}), with every catalog-drawn identifier written as a
 * token (`url-tokens.ts`). `url.ts` deflates and base64s the result.
 */

import {
  asColumnId,
  canonicalViewFor,
  viewsFor,
  type ColumnId,
  type Filter,
  type FilterValue,
  type Modality,
  type PanelKind,
  type Selection,
  type View,
} from '@mriqc/shared';
import { OPEN_HI, OPEN_LO } from './filters';
import { CHARTS_BY_KIND, PANEL_KINDS, chartForKind } from './panel-shapes';
import {
  MAX_COHORTS,
  defaultPanelOptions,
  isDerivedCohort,
  type Cohort,
  type CohortId,
  type Panel,
  type PanelChart,
  type SelectionState,
} from './state';
import {
  CHART_TOKENS,
  CLIP_TOKENS,
  FIELD_TOKENS,
  GRANULARITY_TOKENS,
  KIND_TOKENS,
  MAX_COHORT_FILTERS,
  MAX_COHORT_ID_LENGTH,
  MAX_COHORT_NAME,
  MAX_FILTER_VALUES,
  MAX_ID_LENGTH,
  MAX_PANELS,
  METRIC_TOKENS,
  MODALITY_TOKENS,
  OP_TOKENS,
  SEP,
  SOURCE_TOKENS,
  VIEW_TOKENS,
  clampBins,
  escapeText,
  fromToken,
  isWellFormed,
  normalizeSelection,
  readDate,
  readNumber,
  splitList,
  toToken,
  unescapeText,
  uniqueIds,
  writeDate,
  writeRounded,
  type TokenTable,
} from './url-tokens';
import type { UrlState } from './url';

/** What a field's fallback may depend on: the modality, its index, its record. */
interface Ctx {
  /** The modality the payload names, which decides which views exist. */
  modality: Modality;
  /** This record's place in its list, which is what an omitted id means. */
  index: number;
  /** The record so far, so a later field's fallback can read an earlier one. */
  draft: Record<string, unknown>;
}

/** One field of one record. */
interface UrlField {
  /** The single character the payload writes it under. */
  key: string;
  /** This value, as text. */
  write: (value: unknown, ctx: Ctx) => string;
  /** The value this text names, or undefined when it names nothing usable. */
  read: (text: string, ctx: Ctx) => unknown;
  /** What the field is when the payload leaves it out -- and what is left out. */
  fallback: (ctx: Ctx) => unknown;
  /** How a decoded value changes what later fields read. */
  bind?: (ctx: Ctx, value: unknown) => void;
}

/** A record's fields, keyed by the property they carry. */
type FieldTable = Readonly<Record<string, UrlField>>;

/**
 * What a record writes when every one of its fields is its default.
 *
 * Without it such a record writes `''`, and a *list* holding one of them joins
 * to `''` too -- which is exactly the text the list field omits itself for, so
 * the one panel, or the one cohort, vanished from its own link. A character
 * that is neither a key nor a separator reads back as a record with nothing in
 * it, which is what it is.
 */
const EMPTY_RECORD = '.';

function writeRecord(
  table: FieldTable,
  source: Record<string, unknown>,
  ctx: Ctx,
  sep: string,
): string {
  ctx.draft = source;
  const parts: string[] = [];
  for (const prop of Object.keys(table)) {
    const field = table[prop];
    const text = field.write(source[prop], ctx);
    // The one rule that makes a link short: a field that says what the default
    // already says is not written at all.
    if (text === field.write(field.fallback(ctx), ctx)) continue;
    parts.push(field.key + text);
  }
  return parts.length === 0 ? EMPTY_RECORD : parts.join(sep);
}

function readRecord(
  table: FieldTable,
  text: string,
  ctx: Ctx,
  sep: string,
): Record<string, unknown> {
  const raw = new Map<string, string>();
  for (const part of text.split(sep)) {
    if (part.length === 0) continue;
    // First occurrence wins: a repeated key is a hand-edited payload, not one
    // this grammar writes.
    if (!raw.has(part[0])) raw.set(part[0], part.slice(1));
  }
  const out: Record<string, unknown> = {};
  ctx.draft = out;
  for (const prop of Object.keys(table)) {
    const field = table[prop];
    const encoded = raw.get(field.key);
    const value = encoded === undefined ? undefined : field.read(encoded, ctx);
    out[prop] = value === undefined ? field.fallback(ctx) : value;
    field.bind?.(ctx, out[prop]);
  }
  return out;
}

/* ------------------------------------------------------------------ scalars */

/** A token field: an identifier from one catalog list, or null for none. */
function tokenField(key: string, table: TokenTable): UrlField {
  return {
    key,
    write: (value) => toToken(table, value as string | null),
    read: (text) => fromToken(table, text),
    fallback: () => null,
  };
}

function flagField(key: string, fallback: boolean): UrlField {
  return {
    key,
    write: (value) => (value === true ? '1' : '0'),
    read: (text) => text === '1',
    fallback: () => fallback,
  };
}

/**
 * A view field: a view token, but only one the modality actually has.
 *
 * A link naming a view this modality lacks degrades to that modality's
 * canonical one, which is also what an empty URL opens on -- so an old or
 * hand-edited link lands on the same dashboard a cold load would.
 */
function viewField(key: string): UrlField {
  return {
    key,
    write: (value) => toToken(VIEW_TOKENS, value as string),
    read: (text, ctx) => {
      const view = fromToken(VIEW_TOKENS, text) as View | null;
      if (view === null) return undefined;
      return viewsFor(ctx.modality).some((def) => def.id === view) ? view : undefined;
    },
    fallback: (ctx) => canonicalViewFor(ctx.modality),
  };
}

/** A free-text id, bounded and well-formed, with a positional fallback. */
function idField(key: string, prefix: 'p' | 'c', limit: number): UrlField {
  return {
    key,
    write: (value) => escapeText(String(value ?? '')),
    read: (text) => {
      const id = unescapeText(text);
      return id.length > 0 && id.length <= limit && isWellFormed(id) ? id : undefined;
    },
    fallback: (ctx) => `${prefix}${ctx.index + 1}`,
  };
}

const OPEN_LO_TOKEN = '_';
const OPEN_HI_TOKEN = '^';

/**
 * A `between` bound: the two open-end sentinels as one character each, a date
 * as digits, and anything else as its own text with a type prefix.
 *
 * Exactly, never rounded: a bound is typed or is a sentinel, and rounding
 * either would change which rows the filter matches -- and would stop
 * `formFromGlobal` reading an open end back as empty.
 */
function writeBound(bound: number | string): string {
  if (bound === OPEN_LO) return OPEN_LO_TOKEN;
  if (bound === OPEN_HI) return OPEN_HI_TOKEN;
  if (typeof bound === 'string') {
    const date = writeDate(bound);
    return date ?? `s${escapeText(bound)}`;
  }
  // A number that happens to be eight or fourteen digits would read back as a
  // date, so it says it is a number.
  return /^\d{8}$|^\d{14}$/.test(String(bound)) ? `n${bound}` : String(bound);
}

function readBound(text: string): number | string | null {
  if (text === OPEN_LO_TOKEN) return OPEN_LO;
  if (text === OPEN_HI_TOKEN) return OPEN_HI;
  const date = readDate(text);
  if (date !== null) return date;
  if (text.startsWith('s')) {
    const value = unescapeText(text.slice(1));
    return isWellFormed(value) ? value : null;
  }
  if (text.startsWith('n')) return readNumber(text.slice(1));
  return readNumber(text);
}

/** An `in` value, which may be text, a number or a flag. */
function writeValue(value: FilterValue): string {
  if (typeof value === 'number') return `#${value}`;
  if (typeof value === 'boolean') return value ? '?1' : '?0';
  return escapeText(value);
}

function readValue(text: string): FilterValue | null {
  if (text.startsWith('#')) return readNumber(text.slice(1));
  if (text.startsWith('?')) return text === '?1';
  const value = unescapeText(text);
  return isWellFormed(value) ? value : null;
}

/* ------------------------------------------------------------------ filters */

function writeFilter(filter: Filter, partSep: string, valueSep: string): string {
  const head = [toToken(FIELD_TOKENS, String(filter.field)), toToken(OP_TOKENS, filter.op)];
  if (filter.op === 'in') {
    return [...head, filter.values.map(writeValue).join(valueSep)].join(partSep);
  }
  if (filter.op === 'between') {
    return [...head, writeBound(filter.lo), writeBound(filter.hi)].join(partSep);
  }
  return head.join(partSep);
}

function readFilter(text: string, partSep: string, valueSep: string): Filter | null {
  const parts = text.split(partSep);
  const field = fromToken(FIELD_TOKENS, parts[0] ?? '');
  const op = fromToken(OP_TOKENS, parts[1] ?? '');
  if (field === null || op === null) return null;
  const column: ColumnId = asColumnId(field);
  if (op === 'in') {
    // The slot's own presence, not `splitList`: `''` in the slot is the one
    // empty value the "Not reported" bucket filters on, where no slot at all is
    // a filter with no values -- which is not a filter.
    const values = (parts.length > 2 ? (parts[2] ?? '').split(valueSep) : [])
      .map(readValue)
      .filter((value): value is FilterValue => value !== null);
    return values.length > 0 && values.length <= MAX_FILTER_VALUES
      ? { field: column, op, values }
      : null;
  }
  if (op === 'between') {
    const lo = readBound(parts[2] ?? '');
    const hi = readBound(parts[3] ?? '');
    return lo === null || hi === null ? null : { field: column, op, lo, hi };
  }
  return { field: column, op: op as 'isNull' | 'notNull' };
}

/** A filter list field, at whichever nesting level its record sits. */
function filterListField(key: string, listSep: string, partSep: string, valueSep: string): UrlField {
  return {
    key,
    write: (value) =>
      ((value ?? []) as readonly Filter[])
        .map((filter) => writeFilter(filter, partSep, valueSep))
        .join(listSep),
    read: (text) =>
      splitList(text, listSep)
        .slice(0, MAX_COHORT_FILTERS)
        .map((part) => readFilter(part, partSep, valueSep))
        .filter((filter): filter is Filter => filter !== null),
    fallback: () => [],
  };
}

/* --------------------------------------------------------------- selections */

/** A cohort's metric range: the metric and two rounded bounds. */
function metricRangeField(key: string, sep: string): UrlField {
  return {
    key,
    write: (value) => {
      const selection = value as Selection | null;
      if (!selection) return '';
      const metric = toToken(METRIC_TOKENS, String(selection.metric));
      return [metric, writeRounded(selection.range[0]), writeRounded(selection.range[1])].join(sep);
    },
    read: (text) => {
      const parts = text.split(sep);
      const metric = fromToken(METRIC_TOKENS, parts[0] ?? '');
      const lo = readNumber(parts[1] ?? '');
      const hi = readNumber(parts[2] ?? '');
      if (metric === null || lo === null || hi === null) return null;
      return { metric: asColumnId(metric), range: lo <= hi ? [lo, hi] : [hi, lo] };
    },
    fallback: () => null,
  };
}

/* ------------------------------------------------------------------- panels */

const PANEL_FIELDS: FieldTable = {
  // First, because the charts a panel may draw -- and the one it opens on --
  // are a fact about its kind.
  kind: {
    key: 'k',
    write: (value) => toToken(KIND_TOKENS, value as string),
    read: (text) => fromToken(KIND_TOKENS, text) ?? undefined,
    fallback: () => 'distribution',
  },
  id: idField('i', 'p', MAX_ID_LENGTH),
  metric: tokenField('m', METRIC_TOKENS),
  yAxis: tokenField('D', METRIC_TOKENS),
  chart: {
    key: 'c',
    write: (value) => toToken(CHART_TOKENS, value as string),
    read: (text, ctx) => {
      const chart = fromToken(CHART_TOKENS, text) as PanelChart | null;
      const charts = CHARTS_BY_KIND[ctx.draft['kind'] as PanelKind] ?? [];
      if (chart && ['density2d','scatter','hexbin','correlation','clusters','line'].includes(chart)) return chart;
      // A chart this kind does not allow leaves the panel on the chart it opens
      // on, rather than dropping the card a link asked for.
      return chart !== null && charts.includes(chartForKind(ctx.draft['kind'] as PanelKind, chart))
        ? chartForKind(ctx.draft['kind'] as PanelKind, chart)
        : undefined;
    },
    fallback: (ctx) => ctx.draft['kind'] === 'distribution' ? 'density' : ctx.draft['kind'] === 'grouped' ? 'box' : PANEL_KINDS[ctx.draft['kind'] as PanelKind].defaultChart,
  },
  group: tokenField('g', FIELD_TOKENS),
  cohort: {
    key: 'j',
    write: (value) => escapeText(String(value ?? '')),
    read: (text) => {
      const id = unescapeText(text);
      return id.length > 0 && id.length <= MAX_COHORT_ID_LENGTH && isWellFormed(id) ? id : undefined;
    },
    fallback: () => 'current',
  },
  bins: {
    key: 'b',
    write: (value) => String(value),
    read: (text) => clampBins(text),
    fallback: () => defaultPanelOptions().bins,
  },
  clip: {
    key: 'l',
    write: (value) => toToken(CLIP_TOKENS, value as string),
    read: (text) => fromToken(CLIP_TOKENS, text) ?? undefined,
    fallback: () => defaultPanelOptions().clip,
  },
  logScale: flagField('o', false), // read-only legacy token
  xScale: { key: 'X', write: value => value === 'log' ? 'g' : value === 'symlog' ? 's' : '', read: text => text === 'g' ? 'log' : text === 's' ? 'symlog' : 'linear', fallback: () => 'linear' },
  yScale: { key: 'Y', write: value => value === 'log' ? 'g' : value === 'symlog' ? 's' : '', read: text => text === 'g' ? 'log' : text === 's' ? 'symlog' : 'linear', fallback: () => 'linear' },
  xRange: { key: 'R', write: value => Array.isArray(value) ? value.join(SEP[3]) : '', read: text => { const v = text.split(SEP[3]).map(Number); return v.length === 2 && v.every(Number.isFinite) && v[0] < v[1] ? v : 'auto'; }, fallback: () => 'auto' },
  yRange: { key: 'S', write: value => Array.isArray(value) ? value.join(SEP[3]) : '', read: text => { const v = text.split(SEP[3]).map(Number); return v.length === 2 && v.every(Number.isFinite) && v[0] < v[1] ? v : 'auto'; }, fallback: () => 'auto' },
  yMode: { key: 'M', write: value => value === 'share' ? 's' : value === 'logCount' ? 'g' : '', read: text => text === 's' ? 'share' : text === 'g' ? 'logCount' : 'count', fallback: () => 'count' },
  layout: { key: 'L', write: value => value === 'stacked' ? 's' : value === 'stacked100' ? 'p' : '', read: text => text === 's' ? 'stacked' : text === 'p' ? 'stacked100' : 'overlaid', fallback: () => 'overlaid' },
  coefficient: { key: 'C', write: value => value === 'pearson' ? 'p' : '', read: text => text === 'p' ? 'pearson' : undefined, fallback: () => undefined },
  useSelection: flagField('u', true),
  granularity: {
    key: 'n',
    write: (value) => toToken(GRANULARITY_TOKENS, value as string),
    read: (text) => fromToken(GRANULARITY_TOKENS, text) ?? undefined,
    fallback: () => defaultPanelOptions().granularity,
  },
  splitPresentation: flagField('f', false),
  cumulative: flagField('a', false),
  share: flagField('s', false),
  coverageWindow: {
    key: 'w',
    write: (value) => String(value ?? ''),
    read: (text) => (text === '12m' || text === '5y' || text === 'all' || text === 'custom' ? text : undefined),
    fallback: () => defaultPanelOptions().coverageWindow,
  },
  coverageCustom: {
    key: 'd',
    write: (value) => {
      const range = value as readonly [string, string] | null;
      if (!range) return '';
      const lo = writeDate(range[0]);
      const hi = writeDate(range[1]);
      return lo !== null && hi !== null ? `${lo}${SEP[3]}${hi}` : '';
    },
    read: (text) => {
      const [lo, hi] = text.split(SEP[3]).map(readDate);
      return lo !== null && hi !== null ? (lo <= hi ? [lo, hi] : [hi, lo]) : null;
    },
    fallback: () => null,
  },
  coverageLogY: flagField('y', false),
  boxSort: flagField('q', false),
  cohorts: {
    key: 'h',
    write: (value) =>
      ((value ?? []) as readonly CohortId[]).map(escapeText).join(SEP[3]),
    read: (text) => {
      const out: CohortId[] = [];
      for (const part of splitList(text, SEP[3]).slice(0, MAX_COHORTS + 2)) {
        const id = unescapeText(part);
        if (id.length > 0 && id.length <= MAX_COHORT_ID_LENGTH && isWellFormed(id) && !out.includes(id)) {
          out.push(id);
        }
      }
      return out;
    },
    fallback: () => [],
  },
  reference: {
    key: 'r',
    write: (value) => (value === undefined ? '' : escapeText(String(value))),
    read: (text) => {
      const id = unescapeText(text);
      return id.length > 0 && id.length <= MAX_COHORT_ID_LENGTH && isWellFormed(id)
        ? id
        : undefined;
    },
    fallback: () => undefined,
  },
  analysis: {
    key: 'A',
    write: value => value && Object.keys(value).length ? escapeText(JSON.stringify(value)) : '',
    read: text => { try { const value: unknown = JSON.parse(unescapeText(text)); return value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => ['family','metrics','sampleSize','seed','k','showPoints','clusterOrder','clusterSplit'].includes(key))) : undefined; } catch { return undefined; } },
    fallback: () => undefined,
  },
};

function panelRecord(panel: Omit<Panel, 'cursors'>): Record<string, unknown> {
  return {
    kind: panel.x === 'created_at' ? 'coverage' : ['bivariate', 'correlation'].includes(shapeOf(panel)) ? 'distribution' : shapeOf(panel),
    id: panel.id,
    metric: panel.x === 'created_at' ? null : panel.x,
    yAxis: panel.y,
    chart: panel.chart,
    group: panel.split,
    cohort: panel.cohorts[0] ?? 'current',
    bins: panel.options.bins,
    clip: panel.options.clip,
    xScale: panel.options.xScale, xRange: panel.options.xRange,
    yScale: panel.options.yScale, yRange: panel.options.yRange,
    yMode: panel.options.yMode, layout: panel.options.layout,
    coefficient: panel.options.coefficient,
    useSelection: panel.options.useSelection,
    granularity: panel.options.granularity,
    splitPresentation: panel.options.splitPresentation === 'facets',
    cumulative: panel.options.cumulative,
    share: panel.options.share,
    coverageWindow: panel.options.coverageWindow,
    coverageCustom: panel.options.coverageCustom,
    coverageLogY: panel.options.coverageLogY,
    boxSort: panel.options.boxSort === 'n',
    cohorts: panel.cohorts,
    reference: panel.reference,
    analysis: Object.fromEntries(Object.entries(panel.options).filter(([key]) =>
      ['family','metrics','sampleSize','seed','k','showPoints','clusterOrder','clusterSplit'].includes(key))),
  };
}

function panelFromRecord(r: Record<string, unknown>): Omit<Panel, 'cursors'> {
  const kind = r['kind'] as PanelKind;
  const panel: Omit<Panel, 'cursors'> = {
    id: r['id'] as string,
    x: kind === 'coverage' ? 'created_at' : r['metric'] ? asColumnId(String(r['metric'])) : asColumnId('fd_mean'),
    y: r['yAxis'] ? asColumnId(String(r['yAxis'])) : null,
    chart: r['chart'] as PanelChart,
    split: (r['group'] as ColumnId | null) === null ? null : asColumnId(String(r['group'])),
    cohorts: (r['cohorts'] as readonly CohortId[]).length ? r['cohorts'] as readonly CohortId[] : [r['cohort'] as CohortId],
    options: {
      bins: r['bins'] as number,
      clip: r['clip'] as Panel['options']['clip'],
      xScale: r['logScale'] === true ? 'log' : r['xScale'] as Panel['options']['xScale'],
      xRange: r['xRange'] as Panel['options']['xRange'],
      yScale: r['yScale'] as Panel['options']['yScale'],
      yRange: r['yRange'] as Panel['options']['yRange'],
      yMode: r['yMode'] as Panel['options']['yMode'],
      layout: r['layout'] as Panel['options']['layout'],
      ...(r['coefficient'] ? { coefficient: r['coefficient'] as 'pearson' } : {}),
      useSelection: r['useSelection'] as boolean,
      granularity: r['granularity'] as Panel['options']['granularity'],
      splitPresentation: r['splitPresentation'] === true ? 'facets' : 'overlay',
      cumulative: r['cumulative'] === true,
      share: r['share'] === true,
      coverageWindow: r['coverageWindow'] as Panel['options']['coverageWindow'],
      coverageCustom: r['coverageCustom'] as Panel['options']['coverageCustom'],
      coverageLogY: r['coverageLogY'] === true,
      boxSort: r['boxSort'] === true ? 'n' : 'median',
      ...(r['analysis'] as Partial<Panel['options']> ?? {}),
    },
  };
  // Only the kind that draws cohorts carries the two cohort fields, so every
  // other panel is the same object it was before cohorts existed.
  const reference = r['reference'] as CohortId | undefined;
  return {
    ...panel,
    ...(reference === undefined ? {} : { reference }),
  };
}

/* ------------------------------------------------------------------ cohorts */

const COHORT_FIELDS: FieldTable = {
  id: idField('i', 'c', MAX_COHORT_ID_LENGTH),
  name: {
    key: 'n',
    write: (value) => escapeText(String(value ?? '')),
    read: (text) => {
      const name = unescapeText(text);
      if (!isWellFormed(name)) return undefined;
      return name.trim() === '' ? undefined : name.slice(0, MAX_COHORT_NAME);
    },
    fallback: () => 'Cohort',
  },
  color: {
    key: 'o',
    write: (value) => String(value),
    read: (text) => {
      const n = readNumber(text);
      return n === null ? undefined : Math.trunc(n);
    },
    fallback: () => 0,
  },
  source: {
    key: 'e',
    write: (value) => toToken(SOURCE_TOKENS, value as string),
    read: (text) => fromToken(SOURCE_TOKENS, text) ?? undefined,
    fallback: () => 'population',
  },
  view: viewField('v'),
  filters: filterListField('f', SEP[3], SEP[4], SEP[5]),
  selection: metricRangeField('s', SEP[3]),
  selections: { key: 'S', write: value => (value as readonly Selection[]).map(item => metricRangeField('s', SEP[4]).write(item, {} as Ctx)).join(SEP[3]),
    read: text => splitList(text, SEP[3]).slice(0, 4).map(part => metricRangeField('s', SEP[4]).read(part, {} as Ctx)).filter(Boolean), fallback: () => [] },
};

function cohortRecord(cohort: Cohort): Record<string, unknown> {
  return { ...cohort };
}

function cohortFromRecord(r: Record<string, unknown>): Cohort {
  return {
    id: r['id'] as CohortId,
    name: r['name'] as string,
    color: r['color'] as number,
    source: r['source'] as Cohort['source'],
    view: r['view'] as View,
    filters: r['filters'] as readonly Filter[],
    selections: (r['selections'] as Selection[]).length ? r['selections'] as Selection[] : r['selection'] ? [r['selection'] as Selection] : [],
  };
}

/* ---------------------------------------------------------------- the whole */

const TOP_FIELDS: FieldTable = {
  layout: {
    key: 'G',
    write: value => value ? Object.entries(value as NonNullable<UrlState['layout']>)
      .map(([id, p]) => [escapeText(id), p.x, p.y, p.w, p.h].join(SEP[2])).join(SEP[1]) : '',
    read: text => Object.fromEntries(splitList(text, SEP[1]).slice(0, MAX_PANELS).flatMap(part => {
      const [rawId, ...coordinates] = part.split(SEP[2]);
      const id = unescapeText(rawId ?? '');
      const [x, y, w, h] = coordinates.map(Number);
      return id && id.length <= MAX_ID_LENGTH && isWellFormed(id) && coordinates.length === 4 &&
        [x, y, w, h].every(Number.isSafeInteger) && x >= 0 && y >= 0 && w >= 3 && w <= 12 && x + w <= 12 && h >= 5
        ? [[id, { x, y, w, h }]] : [];
    })),
    fallback: () => undefined,
  },
  maximizedPanel: {
    key: 'Z', write: value => value ? escapeText(String(value)) : '',
    read: text => { const id = unescapeText(text); return id.length <= MAX_ID_LENGTH && isWellFormed(id) ? id : undefined; },
    fallback: () => undefined,
  },
  // First, and it binds: which views exist, and what an omitted view means, are
  // facts about the modality.
  modality: {
    key: 'm',
    write: (value) => toToken(MODALITY_TOKENS, value as string),
    read: (text) => fromToken(MODALITY_TOKENS, text) ?? undefined,
    fallback: () => 'bold',
    bind: (ctx, value) => {
      ctx.modality = value as Modality;
    },
  },
  view: viewField('v'),
  filters: filterListField('f', SEP[1], SEP[2], SEP[3]),
  cohorts: {
    key: 'c',
    write: (value, ctx) =>
      (value as readonly Cohort[])
        .map((cohort, index) =>
          writeRecord(COHORT_FIELDS, cohortRecord(cohort), { ...ctx, index }, SEP[2]),
        )
        .join(SEP[1]),
    read: (text, ctx) =>
      splitList(text, SEP[1])
        .slice(0, MAX_COHORTS)
        .map((part, index) =>
          cohortFromRecord(readRecord(COHORT_FIELDS, part, { ...ctx, index, draft: {} }, SEP[2])),
        )
        // `current`, `all` and the split groups are derived, so a payload
        // claiming one of their ids is claiming to redefine the top bar -- and
        // the cohort it stored could then never be edited or deleted, because
        // every lookup by that id answers with the derived one.
        .filter((cohort) => !isDerivedCohort(cohort.id)),
    fallback: () => [],
  },
  panels: {
    key: 'p',
    write: (value, ctx) =>
      (value as readonly Omit<Panel, 'cursors'>[])
        .map((panel, index) =>
          writeRecord(PANEL_FIELDS, panelRecord(panel), { ...ctx, index }, SEP[2]),
        )
        .join(SEP[1]),
    read: (text, ctx) =>
      splitList(text, SEP[1])
        .slice(0, MAX_PANELS)
        .map((part, index) =>
          panelFromRecord(readRecord(PANEL_FIELDS, part, { ...ctx, index, draft: {} }, SEP[2])),
        ),
    fallback: () => [],
  },
  selection: {
    key: 's',
    write: (value) => {
      const selection = value as SelectionState | null;
      if (!selection) return '';
      return [
        escapeText(selection.from),
        toToken(METRIC_TOKENS, String(selection.metric)),
        writeRounded(selection.range[0]),
        writeRounded(selection.range[1]),
      ].join(SEP[1]);
    },
    read: (text) => {
      const parts = text.split(SEP[1]);
      const from = unescapeText(parts[0] ?? '');
      const metric = fromToken(METRIC_TOKENS, parts[1] ?? '');
      const lo = readNumber(parts[2] ?? '');
      const hi = readNumber(parts[3] ?? '');
      if (from === '' || from.length > MAX_ID_LENGTH || !isWellFormed(from)) return null;
      if (metric === null || lo === null || hi === null) return null;
      return normalizeSelection({ from, metric: asColumnId(metric), range: [lo, hi] });
    },
    fallback: () => null,
  },
  selections: {
    key: 'S',
    write: value => (value as readonly SelectionState[]).map(selection => [escapeText(selection.from),
      toToken(METRIC_TOKENS, String(selection.metric)), writeRounded(selection.range[0]), writeRounded(selection.range[1])].join(SEP[2])).join(SEP[1]),
    read: text => splitList(text, SEP[1]).slice(0, 4).flatMap(part => {
      const [fromText, metricText, loText, hiText] = part.split(SEP[2]);
      const from = unescapeText(fromText ?? '');
      const metric = fromToken(METRIC_TOKENS, metricText ?? '');
      const lo = readNumber(loText ?? ''), hi = readNumber(hiText ?? '');
      if (!from || from.length > MAX_ID_LENGTH || !isWellFormed(from) || metric === null || lo === null || hi === null) return [];
      return [{ from, metric: asColumnId(metric), range: [Math.min(lo, hi), Math.max(lo, hi)] }];
    }),
    fallback: () => [],
  },
};

const TOP_KEYS = new Set(Object.keys(TOP_FIELDS).map((prop) => TOP_FIELDS[prop].key));

/** One URL state as the payload's text. */
export function writeUrlRecord(url: UrlState): string {
  const ctx: Ctx = { modality: url.global.modality, index: 0, draft: {} };
  const source = {
    modality: url.global.modality,
    view: url.global.view,
    filters: url.global.filters,
    cohorts: url.cohorts,
    panels: url.panels,
    selections: url.selections,
    layout: url.layout,
    maximizedPanel: url.maximizedPanel,
  };
  return writeRecord(TOP_FIELDS, source, ctx, SEP[0]);
}

/**
 * The URL state a payload's text names, or null when the text names no field
 * this grammar knows -- which is what a crafted payload that happens to inflate
 * looks like, and is read as "no URL state" rather than as an empty dashboard.
 */
export function readUrlRecord(text: string): UrlState | null {
  if (text === '') return null;
  const named = (part: string) => part === EMPTY_RECORD || (part.length > 0 && TOP_KEYS.has(part[0]));
  if (!text.split(SEP[0]).some(named)) return null;
  const ctx: Ctx = { modality: 'bold', index: 0, draft: {} };
  const record = readRecord(TOP_FIELDS, text, ctx, SEP[0]);
  return {
    global: {
      modality: record['modality'] as Modality,
      view: record['view'] as View,
      filters: record['filters'] as readonly Filter[],
    },
    // A repeated id would make two cohorts, or two panels, one in every lookup,
    // so the second occurrence is re-minted rather than dropped.
    cohorts: uniqueIds(record['cohorts'] as readonly Cohort[], 'c'),
    panels: uniqueIds(record['panels'] as readonly Omit<Panel, 'cursors'>[]),
    ...(record['layout'] ? { layout: record['layout'] as NonNullable<UrlState['layout']> } : {}),
    ...(record['maximizedPanel'] ? { maximizedPanel: record['maximizedPanel'] as string } : {}),
    selections: (record['selections'] as SelectionState[]).length ? record['selections'] as SelectionState[] : record['selection'] ? [record['selection'] as SelectionState] : [],
  };
}
