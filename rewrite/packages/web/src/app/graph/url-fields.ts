/**
 * The stream grammar. Every record is one presence bitmap (six optional fields
 * per character), then its non-default values in schema order. Both directions
 * walk these same tables; scalar codecs alone know how to represent a value.
 */
import { canonicalViewFor, viewsFor, type Modality } from '@mriqc/shared';
import { defaultDashboard } from './reducer';
import { formsFor, panelForms } from './panel-shapes';
import { deriveLayout, type DashboardLayout } from './layout';
import {
  defaultPanelOptions,
  isDerivedCohort,
  MAX_COHORTS,
  type Panel,
  type PanelOptions,
} from './state';
import { OPEN_LO, OPEN_HI } from './filters';
import type { UrlState } from './url';
import {
  BitReader,
  BitWriter,
  tokenCodec,
  textCodec,
  enumeration,
  unsigned,
  exactNumber,
  roundedNumber,
  dateCodec,
  categoryValues,
  clampBins,
  uniqueIds,
  METRIC_TOKENS,
  FIELD_TOKENS,
  COLUMN_TOKENS,
  MODALITY_TOKENS,
  VIEW_TOKENS,
  CHART_TOKENS,
  CLIP_TOKENS,
  GRANULARITY_TOKENS,
  OP_TOKENS,
  MAX_PANELS,
  MAX_FILTER_VALUES,
  MAX_COHORT_FILTERS,
  MAX_COHORT_NAME,
  MAX_ID_LENGTH,
  MAX_COHORT_ID_LENGTH,
  MAX_PARAM_LENGTH,
} from './url-tokens';

type RecordValue = Record<string, unknown>;
export interface Context {
  index: number;
  draft: RecordValue;
  root: RecordValue;
  baseline?: RecordValue;
}
interface ContextCodec {
  write(writer: BitWriter, value: any, ctx: Context): void;
  read(reader: BitReader, ctx: Context): any;
}
export interface SchemaField {
  field: string;
  codec: ContextCodec;
  default: unknown | ((ctx: Context) => unknown);
  /** Implied constants have no optional presence slot. */
  required?: boolean;
}
export type Schema = readonly SchemaField[];

function fallback(field: SchemaField, ctx: Context): unknown {
  return typeof field.default === 'function' ? field.default(ctx) : field.default;
}

/** Structural equality, independent of object insertion order. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as RecordValue,
    right = b as RecordValue;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  return (
    keys.length === Object.keys(right).filter((key) => right[key] !== undefined).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
  );
}

export function writeRecord(
  writer: BitWriter,
  schema: Schema,
  source: RecordValue,
  context: Context,
): void {
  const ctx = { ...context, draft: source };
  const optional = schema.filter((field) => !field.required);
  const present = optional.map(
    (field) =>
      source[field.field] !== undefined && !sameValue(source[field.field], fallback(field, ctx)),
  );
  for (let start = 0; start < optional.length; start += 6) {
    let mask = 0;
    for (let bit = 0; bit < 6; bit++) if (present[start + bit]) mask |= 1 << bit;
    writer.write(6, mask);
  }
  let slot = 0;
  for (const field of schema) {
    if (field.required || present[slot++])
      field.codec.write(writer, source[field.field] ?? fallback(field, ctx), ctx);
  }
}

export function readRecord(reader: BitReader, schema: Schema, context: Context): RecordValue {
  const optionalCount = schema.filter((field) => !field.required).length;
  const masks: number[] = [];
  for (let start = 0; start < optionalCount; start += 6) masks.push(reader.read(6));
  const remainder = optionalCount % 6;
  if (remainder && masks[masks.length - 1] >= 2 ** remainder)
    throw new Error('Unknown record field');
  const draft: RecordValue = {};
  const ctx = { ...context, draft };
  let slot = 0;
  for (const field of schema) {
    const present = field.required || (masks[Math.floor(slot / 6)] & (1 << (slot % 6))) !== 0;
    if (!field.required) slot++;
    const value = present ? field.codec.read(reader, ctx) : fallback(field, ctx);
    if (value !== undefined) draft[field.field] = value;
  }
  return draft;
}

function record(schema: Schema): ContextCodec {
  return {
    write: (writer, value, ctx) => writeRecord(writer, schema, value, ctx),
    read: (reader, ctx) => readRecord(reader, schema, ctx),
  };
}
function list(codec: ContextCodec, limit: number): ContextCodec {
  return {
    write(writer, value: readonly unknown[], ctx) {
      if (!Array.isArray(value) || value.length > limit) throw new Error('List limit exceeded');
      unsigned.write(writer, value.length);
      value.forEach((item, index) => codec.write(writer, item, { ...ctx, index }));
    },
    read(reader, ctx) {
      const length = unsigned.read(reader);
      if (length > limit) throw new Error('List limit exceeded');
      return Array.from({ length }, (_, index) => codec.read(reader, { ...ctx, index }));
    },
  };
}
function pair(codec: ContextCodec): ContextCodec {
  return {
    write(writer, value: readonly unknown[], ctx) {
      if (!Array.isArray(value) || value.length !== 2) throw new Error('Invalid pair');
      value.forEach((item) => codec.write(writer, item, ctx));
    },
    read: (reader, ctx) => [codec.read(reader, ctx), codec.read(reader, ctx)],
  };
}
const bool = enumeration([false, true], 1);
const fieldToken = tokenCodec(FIELD_TOKENS);
const metricToken = tokenCodec(METRIC_TOKENS);
const columnToken = tokenCodec(COLUMN_TOKENS);
const shortText = textCodec(MAX_COHORT_ID_LENGTH);
const modality = (ctx: Context) => (ctx.root['modality'] ?? 'bold') as Modality;
const viewCodec: ContextCodec = {
  write: (writer, value) => tokenCodec(VIEW_TOKENS).write(writer, value),
  read(reader, ctx) {
    const view = tokenCodec(VIEW_TOKENS).read(reader);
    return viewsFor(modality(ctx)).some((item) => item.id === view)
      ? view
      : canonicalViewFor(modality(ctx));
  },
};
const currentView = (ctx: Context) => canonicalViewFor(modality(ctx));

/** Category index, typed exact decimal, date, open bound, or escaped text. */
const filterValue: ContextCodec = {
  write(writer, value: string | number | boolean, ctx) {
    const values = categoryValues(String(ctx.draft['field']));
    const index = values.indexOf(value);
    if (index >= 0 && index < 56) {
      writer.write(6, index);
      return;
    }
    if (value === OPEN_LO) {
      writer.write(6, 61);
      return;
    }
    if (value === OPEN_HI) {
      writer.write(6, 62);
      return;
    }
    if (typeof value === 'boolean') {
      writer.write(6, value ? 59 : 58);
      return;
    }
    if (typeof value === 'number') {
      writer.write(6, 56);
      exactNumber.write(writer, value);
      return;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      writer.write(6, 60);
      dateCodec.write(writer, value);
      return;
    }
    writer.write(6, 57);
    textCodec().write(writer, value);
  },
  read(reader, ctx) {
    const tag = reader.read(6);
    if (tag < 56) {
      const value = categoryValues(String(ctx.draft['field']))[tag];
      if (value === undefined) throw new Error('Unknown categorical index');
      return value;
    }
    switch (tag) {
      case 56:
        return exactNumber.read(reader);
      case 57:
        return textCodec().read(reader);
      case 58:
        return false;
      case 59:
        return true;
      case 60:
        return dateCodec.read(reader);
      case 61:
        return OPEN_LO;
      case 62:
        return OPEN_HI;
      default:
        throw new Error('Unknown scalar tag');
    }
  },
};
export const FILTER_FIELDS: Schema = [
  { field: 'field', codec: fieldToken, default: 'manufacturer' },
  { field: 'op', codec: tokenCodec(OP_TOKENS), default: 'in' },
  { field: 'values', codec: list(filterValue, MAX_FILTER_VALUES), default: undefined },
  { field: 'lo', codec: filterValue, default: undefined },
  { field: 'hi', codec: filterValue, default: undefined },
];
const filterRecord = record(FILTER_FIELDS);
const filters: ContextCodec = list(
  {
    write: filterRecord.write,
    read(reader, ctx) {
      const value = filterRecord.read(reader, ctx) as RecordValue;
      if (value['op'] === 'in') {
        if (
          !Array.isArray(value['values']) ||
          !value['values'].length ||
          value['lo'] !== undefined ||
          value['hi'] !== undefined
        )
          throw new Error('Invalid in filter');
      } else if (value['op'] === 'between') {
        if (
          !['number', 'string'].includes(typeof value['lo']) ||
          !['number', 'string'].includes(typeof value['hi']) ||
          value['values'] !== undefined
        )
          throw new Error('Invalid between filter');
      } else if (
        value['values'] !== undefined ||
        value['lo'] !== undefined ||
        value['hi'] !== undefined
      )
        throw new Error('Invalid null filter');
      return value;
    },
  },
  MAX_COHORT_FILTERS,
);

/** References to known IDs use positional indices, custom IDs retain their text. */
function reference(kind: 'panels' | 'cohorts'): ContextCodec {
  return {
    write(writer, value, ctx) {
      const items = (ctx.root[kind] ?? []) as { id: string }[];
      const index = items.findIndex((item) => item.id === value);
      if (index >= 0 && index < 62) writer.write(6, index);
      else {
        writer.write(6, 63);
        shortText.write(writer, value);
      }
    },
    read(reader, ctx) {
      const index = reader.read(6);
      if (index === 63) return shortText.read(reader);
      const item = ((ctx.root[kind] ?? []) as { id: string }[])[index];
      if (!item) throw new Error('Unknown reference');
      return item.id;
    },
  };
}
export const SELECTION_FIELDS: Schema = [
  { field: 'from', codec: reference('panels'), default: undefined },
  { field: 'metric', codec: metricToken, default: 'fd_mean' },
  { field: 'range', codec: pair(roundedNumber), default: undefined },
];
const selectionRecord = record(SELECTION_FIELDS);
const selections = list(
  {
    write: selectionRecord.write,
    read(reader, ctx) {
      const value = selectionRecord.read(reader, ctx);
      if (!Array.isArray(value.range)) throw new Error('Missing selection range');
      value.range.sort((a: number, b: number) => a - b);
      return value;
    },
  },
  4,
);

export const SERIES_FIELDS: Schema = [
  {
    field: 'kind',
    codec: enumeration(['field', 'values', 'population', 'cohort', 'study', 'span']),
    default: (ctx: Context) => ((ctx.root['cohorts'] as unknown[]).length ? 'cohort' : 'field'),
  },
  { field: 'field', codec: fieldToken, default: undefined },
  { field: 'values', codec: list(filterValue, MAX_FILTER_VALUES), default: undefined },
  {
    field: 'id',
    codec: reference('cohorts'),
    default: (ctx: Context) =>
      ctx.draft['kind'] === 'cohort'
        ? (ctx.root['cohorts'] as { id: string }[])[ctx.index]?.id
        : undefined,
  },
  { field: 'from', codec: dateCodec, default: undefined },
  { field: 'to', codec: dateCodec, default: undefined },
];
const seriesRecord = record(SERIES_FIELDS);
const series = list(
  {
    write: seriesRecord.write,
    read(reader, ctx) {
      const value = seriesRecord.read(reader, ctx);
      const expected: Record<string, string[]> = {
        field: ['kind', 'field'],
        values: ['kind', 'field', 'values'],
        population: ['kind'],
        cohort: ['kind', 'id'],
        study: ['kind'],
        span: ['kind', 'from', 'to'],
      };
      const keys = expected[value.kind];
      if (
        !keys ||
        keys.length !== Object.keys(value).length ||
        !keys.every((key) => value[key] !== undefined)
      )
        throw new Error('Invalid series');
      if (
        value.kind === 'values' &&
        (!value.values.length || value.values.some((item: unknown) => typeof item !== 'string'))
      )
        throw new Error('Invalid selected values');
      if (value.kind === 'span' && value.from > value.to) throw new Error('Invalid date span');
      return value;
    },
  },
  6,
);

const optionDefault = (key: keyof PanelOptions) => () => defaultPanelOptions()[key];
export const EXTRA_OPTION_FIELDS: Schema = [
  { field: 'quantiles', codec: enumeration(['quartiles', 'tails'], 1), default: optionDefault('quantiles') },
  {
    field: 'bins',
    codec: {
      write: (w, v) => unsigned.write(w, clampBins(v)),
      read: (r) => clampBins(unsigned.read(r)),
    },
    default: optionDefault('bins'),
  },
  { field: 'clip', codec: tokenCodec(CLIP_TOKENS), default: optionDefault('clip') },
  {
    field: 'yMode',
    codec: enumeration(['count', 'share', 'logCount']),
    default: optionDefault('yMode'),
  },
  { field: 'useSelection', codec: bool, default: optionDefault('useSelection') },
  {
    field: 'granularity',
    codec: tokenCodec(GRANULARITY_TOKENS),
    default: optionDefault('granularity'),
  },
  {
    field: 'splitPresentation',
    codec: enumeration(['overlay', 'facets']),
    default: optionDefault('splitPresentation'),
  },
  { field: 'cumulative', codec: bool, default: optionDefault('cumulative') },
  { field: 'share', codec: bool, default: optionDefault('share') },
  {
    field: 'coverageWindow',
    codec: enumeration(['all', '12m', '5y', 'custom']),
    default: optionDefault('coverageWindow'),
  },
  { field: 'coverageCustom', codec: pair(filterValue), default: optionDefault('coverageCustom') },
  { field: 'coverageLogY', codec: bool, default: optionDefault('coverageLogY') },
  { field: 'boxSort', codec: enumeration(['median', 'n']), default: optionDefault('boxSort') },
  { field: 'coefficient', codec: enumeration(['spearman', 'pearson']), default: undefined },
  { field: 'family', codec: shortText, default: undefined },
  { field: 'metrics', codec: list(metricToken, 63), default: undefined },
  { field: 'sampleSize', codec: exactNumber, default: undefined },
  { field: 'seed', codec: exactNumber, default: undefined },
  { field: 'k', codec: unsigned, default: undefined },
  { field: 'showPoints', codec: bool, default: undefined },
  { field: 'clusterOrder', codec: bool, default: undefined },
  { field: 'clusterSplit', codec: bool, default: undefined },
];
const extraDefaults = () =>
  Object.fromEntries(
    EXTRA_OPTION_FIELDS.map((field) => [field.field, fallback(field, {} as Context)]),
  );
export const OPTION_FIELDS: Schema = [
  { field: 'xRange', codec: pair(roundedNumber), default: 'auto' },
  { field: 'xScale', codec: enumeration(['linear', 'log', 'symlog']), default: 'linear' },
  {
    field: 'layout',
    codec: enumeration(['overlaid', 'stacked', 'stacked100']),
    default: 'overlaid',
  },
  { field: 'yRange', codec: pair(roundedNumber), default: 'auto' },
  { field: 'yScale', codec: enumeration(['linear', 'log', 'symlog']), default: 'linear' },
  { field: 'extra', codec: record(EXTRA_OPTION_FIELDS), default: extraDefaults },
];
const optionRecord = record(OPTION_FIELDS);
const options: ContextCodec = {
  write(writer, value: RecordValue, ctx) {
    const extra = Object.fromEntries(
      EXTRA_OPTION_FIELDS.map((field) => [field.field, value[field.field] ?? fallback(field, ctx)]),
    );
    optionRecord.write(writer, { ...value, extra }, ctx);
  },
  read(reader, ctx) {
    const { extra, ...value } = optionRecord.read(reader, ctx);
    return { ...extra, ...value };
  },
};
const defaultPanel = (ctx: Context) =>
  defaultDashboard().panels[ctx.index] ?? {
    ...defaultDashboard().panels[0],
    id: 'p' + (ctx.index + 1),
  };
export const PANEL_FIELDS: Schema = [
  { field: 'id', codec: textCodec(MAX_ID_LENGTH), default: (ctx: Context) => defaultPanel(ctx).id },
  { field: 'x', codec: columnToken, default: (ctx: Context) => defaultPanel(ctx).x },
  { field: 'y', codec: columnToken, default: null },
  {
    field: 'form',
    codec: tokenCodec(CHART_TOKENS),
    default: (ctx: Context) =>
      formsFor(
        (ctx.draft['x'] ?? defaultPanel(ctx).x) as Panel['x'],
        (ctx.draft['y'] ?? null) as Panel['y'],
      )[0],
  },
  { field: 'series', codec: series, default: [] },
  { field: 'options', codec: options, default: () => defaultPanelOptions() },
  { field: 'reference', codec: reference('cohorts'), default: undefined },
];
const panelRecord = record(PANEL_FIELDS);
const panels = list(
  {
    write: panelRecord.write,
    read(reader, ctx) {
      const panel = panelRecord.read(reader, ctx);
      if (!panel.id.length) throw new Error('Empty panel id');
      const forms = panelForms(panel);
      if (!forms.includes(panel.form)) panel.form = forms[0];
      return panel;
    },
  },
  MAX_PANELS,
);

export const COHORT_FIELDS: Schema = [
  {
    field: 'id',
    codec: textCodec(MAX_COHORT_ID_LENGTH),
    default: (ctx: Context) => 'c' + (ctx.index + 1),
  },
  { field: 'name', codec: textCodec(MAX_COHORT_NAME), default: 'Cohort' },
  { field: 'color', codec: unsigned, default: (ctx: Context) => ctx.index + 2 },
  {
    field: 'source',
    required: true,
    codec: {
      write(_writer, value) {
        if (value !== 'population') throw new Error('Study rows cannot be shared');
      },
      read: () => 'population',
    },
    default: 'population',
  },
  { field: 'view', codec: viewCodec, default: currentView },
  { field: 'filters', codec: filters, default: [] },
  { field: 'selections', codec: selections, default: [] },
];
const cohortRecord = record(COHORT_FIELDS);
const cohorts = list(
  {
    write: cohortRecord.write,
    read(reader, ctx) {
      const cohort = cohortRecord.read(reader, ctx);
      if (!cohort.id.length) throw new Error('Empty cohort id');
      if (cohort.selections.some((selection: RecordValue) => selection['from'] !== undefined))
        throw new Error('A saved selection has no source panel');
      return cohort;
    },
  },
  MAX_COHORTS,
);

export const LAYOUT_FIELDS: Schema = [
  { field: 'missing', codec: { write() {}, read: () => true }, default: false },
  ...(['x', 'y', 'w', 'h'] as const).map((field) => ({
    field,
    codec: unsigned,
    default: (ctx: Context) => ctx.baseline?.[field],
  })),
];
const layout: ContextCodec = {
  write(writer, value: DashboardLayout, ctx) {
    const panels = ctx.root['panels'] as UrlState['panels'];
    const baseline = deriveLayout(panels, 3);
    // Length and IDs come from the panel list, so neither appears in geometry.
    panels.forEach((panel, index) =>
      writeRecord(
        writer,
        LAYOUT_FIELDS,
        value[panel.id] ? { ...value[panel.id] } : { missing: true },
        { ...ctx, index, baseline: { ...baseline[panel.id] } },
      ),
    );
  },
  read(reader, ctx) {
    const panels = ctx.root['panels'] as UrlState['panels'];
    const baseline = deriveLayout(panels, 3);
    return Object.fromEntries(
      panels.flatMap((panel, index) => {
        const { missing, ...position } = readRecord(reader, LAYOUT_FIELDS, {
          ...ctx,
          index,
          baseline: { ...baseline[panel.id] },
        });
        return missing ? [] : [[panel.id, position]];
      }),
    );
  },
};

export const DASHBOARD_FIELDS: Schema = [
  { field: 'modality', codec: tokenCodec(MODALITY_TOKENS), default: 'bold' },
  { field: 'view', codec: viewCodec, default: currentView },
  { field: 'filters', codec: filters, default: [] },
  { field: 'cohorts', codec: cohorts, default: [] },
  { field: 'panels', codec: panels, default: () => defaultDashboard().panels },
  { field: 'selections', codec: selections, default: [] },
  { field: 'layout', codec: layout, default: undefined },
  { field: 'maximizedPanel', codec: reference('panels'), default: undefined },
];

export function writeUrlRecord(url: UrlState): string {
  const source: RecordValue = {
    ...url.global,
    cohorts: url.cohorts.filter(
      (cohort) => cohort.source !== 'study' && !isDerivedCohort(cohort.id),
    ),
    panels: url.panels.map(({ id, x, y, form, series, options, reference }) => ({
      id,
      x,
      y,
      form,
      series,
      options,
      ...(reference === undefined ? {} : { reference }),
    })),
    selections: url.selections,
    ...(url.layout && !sameValue(url.layout, deriveLayout(url.panels, 3))
      ? { layout: url.layout }
      : {}),
    ...(url.maximizedPanel ? { maximizedPanel: url.maximizedPanel } : {}),
  };
  const ctx: Context = { index: 0, draft: source, root: source };
  if (DASHBOARD_FIELDS.every((field) => sameValue(source[field.field], fallback(field, ctx))))
    return '';
  const writer = new BitWriter();
  writeRecord(writer, DASHBOARD_FIELDS, source, ctx);
  const result = writer.finish();
  if (result.length >= MAX_PARAM_LENGTH) throw new Error('URL limit exceeded');
  return result;
}

export function readUrlRecord(text: string): UrlState | null {
  try {
    if (!text) return defaultDashboard();
    const reader = new BitReader(text);
    // Top-level fields bind as they are read so later schemas see their context.
    const root: RecordValue = {};
    const contextual: Schema = DASHBOARD_FIELDS.map((field) => ({
      ...field,
      codec: {
        write: field.codec.write,
        read(r, ctx) {
          const value = field.codec.read(r, ctx);
          root[field.field] = value;
          return value;
        },
      },
      default: (ctx: Context) => {
        const value = fallback(field, ctx);
        root[field.field] = value;
        return value;
      },
    }));
    const value = readRecord(reader, contextual, { index: 0, draft: root, root });
    reader.finish();
    return {
      global: {
        modality: value['modality'],
        view: value['view'],
        filters: value['filters'],
      } as UrlState['global'],
      cohorts: uniqueIds(
        (value['cohorts'] as UrlState['cohorts']).filter((cohort) => !isDerivedCohort(cohort.id)),
        'c',
      ),
      panels: uniqueIds(value['panels'] as UrlState['panels']),
      selections: value['selections'] as UrlState['selections'],
      ...(value['layout'] ? { layout: value['layout'] as DashboardLayout } : {}),
      ...(value['maximizedPanel'] ? { maximizedPanel: value['maximizedPanel'] as string } : {}),
    };
  } catch {
    return null;
  }
}
