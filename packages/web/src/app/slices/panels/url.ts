import { commonOptionFields } from '../../forms/common-options';
import { FORM_DEFS } from '../../forms/registry';
/**
 * The stream grammar. Every record is one presence bitmap (six optional fields
 * per character), then its non-default values in schema order. Both directions
 * walk these same tables; scalar codecs alone know how to represent a value.
 */
import {
CHART_TOKENS,
clampBins,
CLIP_TOKENS,
enumeration,
exactNumber,
GRANULARITY_TOKENS,
MAX_ID_LENGTH,
MAX_PANELS,
roundedNumber,
textCodec,
tokenCodec,
unsigned
} from '../../codec/tokens';
import {
defaultPanelOptions,
type Panel,
type PanelOptions
} from '../../graph/state';
import { defaultDashboard } from './defaults';
import { formsFor,panelForms } from './shapes';

import { bool,columnToken,fallback,list,metricToken,pair,record,reference,shortText,type Context,type ContextCodec,type RecordValue,type Schema } from '../../codec/records';
import { filterValue } from '../filters/url';
import { series } from '../series/url';
const optionDefault = (key: keyof PanelOptions) => () => defaultPanelOptions()[key];
const optionCodecs = { clampBins, enumeration, pair, roundedNumber, unsigned, optionDefault, tokenCodec,
  CLIP_TOKENS, bool, GRANULARITY_TOKENS, filterValue, shortText, list, metricToken, exactNumber };
export type OptionCodecs = typeof optionCodecs;
/** Form ownership is separate from pinned version-1 wire positions. */
export const EXTRA_OPTION_FIELDS: Schema = [
  ...commonOptionFields(optionCodecs),
  ...FORM_DEFS.flatMap(def => def.options.url(optionCodecs)),
].sort((a, b) => a.slot - b.slot);
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
export const panels = list(
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

