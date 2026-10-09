import type { TopLevelSpec } from 'vega-lite';
import type { MetricAxis } from '../histogram/histogram';
import { valueScale } from './palette';

export function continuousX(axis: MetricAxis, field: string) {
  return { field, type: axis.xScale === 'time' ? 'temporal' : 'quantitative',
    title: axis.label, scale: valueScale(axis.xScale ?? axis.logScale, axis.xRange, axis.constant),
    ...(axis.xScale === 'time' ? { axis: { format: axis.granularity === 'year' ? '%Y' : axis.granularity === 'month' ? '%b %Y' : '%d %b %Y' } } : {}) };
}

/** Apply the same continuous x contract to layered and faceted form builders. */
export function continuousAxisSpec(spec: TopLevelSpec, axis: MetricAxis, convertDatum?: (value: number) => number): TopLevelSpec {
  if (axis.xScale !== 'time') return spec;
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    const out = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
    if (out['encoding'] && typeof out['encoding'] === 'object') {
      const encoding = out['encoding'] as Record<string, any>;
      if (encoding['x']) {
        const x = encoding['x'];
        encoding['x'] = { ...x, ...continuousX(axis, x.field) };
        if (typeof x.datum === 'number' && convertDatum) encoding['x'].datum = convertDatum(x.datum);
        delete encoding['x'].bin;
      }
      // A ranged temporal x otherwise makes Vega infer horizontal bars, which
      // turns a counts histogram into fixed-height ticks at each count.
      if (encoding['x2'] && encoding['y']?.type === 'quantitative' && out['mark'] && typeof out['mark'] === 'object' && (out['mark'] as Record<string, unknown>)['type'] === 'bar') {
        out['mark'] = { ...out['mark'], orient: 'vertical' };
      }
      if (encoding['tooltip']) {
        const tips = Array.isArray(encoding['tooltip']) ? encoding['tooltip'] : [encoding['tooltip']];
        encoding['tooltip'] = tips.map((tip: Record<string, unknown>) =>
          ['value', 'lo', 'hi', 'p05', 'p25', 'p50', 'p75', 'p95', 'bucket', 'x', 'x2'].includes(String(tip['field']))
            ? { ...tip, type: 'temporal', format: '%d %b %Y' } : tip);
      }
    }
    // Time brushes would otherwise send milliseconds as numeric metric filters.
    delete out['params'];
    return out;
  };
  return visit(spec) as TopLevelSpec;
}
