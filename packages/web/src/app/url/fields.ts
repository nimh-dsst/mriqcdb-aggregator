/**
 * The stream grammar. Every record is one presence bitmap (six optional fields
 * per character), then its non-default values in schema order. Both directions
 * walk these same tables; scalar codecs alone know how to represent a value.
 */
import {
  BitReader,
  BitWriter,
  MAX_PARAM_LENGTH,
  MODALITY_TOKENS,
  tokenCodec,
  uniqueIds,
} from '../codec/tokens';
import { isDerivedCohort } from '../graph/state';
import { deriveLayout, type DashboardLayout } from '../slices/layout/geometry';
import { defaultDashboard } from '../slices/panels/defaults';
import type { UrlState } from './url';

import {
  currentView,
  fallback,
  readRecord,
  reference,
  sameValue,
  viewCodec,
  writeRecord,
  type Context,
  type RecordValue,
  type Schema,
} from '../codec/records';
import { cohorts } from '../slices/cohorts/url';
import { filters, selections } from '../slices/filters/url';
import { layout } from '../slices/layout/url';
import { panels } from '../slices/panels/url';
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
      options: Object.fromEntries(Object.entries(options).filter(([key, value]) =>
        !(key === 'colorScale' && value === (form === 'matrix' ? 'linear' : 'log')))),
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

export * from '../codec/records';
export * from '../slices/cohorts/url';
export * from '../slices/filters/url';
export * from '../slices/layout/url';
export * from '../slices/panels/url';
export * from '../slices/series/url';
