import type { TopLevelSpec } from 'vega-lite';
import type { MetricAxis } from '../histogram/histogram';
import { valueScale } from './palette';

/**
 * One tick per label unit, so a yearly chart is labelled once per year and a
 * monthly one every few months. Without this Vega places ticks by pixel
 * spacing and the `%Y` format repeats "2020 2020 2020" across one year.
 */
function timeTicks(granularity: MetricAxis['granularity']) {
  switch (granularity) {
    case 'year': return { interval: 'year', step: 1 };
    case 'month': return { interval: 'month', step: 6 };
    default: return { interval: 'month', step: 1 };
  }
}

export function continuousX(axis: MetricAxis, field: string) {
  const time = axis.xScale === 'time';
  const custom = Array.isArray(axis.xRange);
  return { field, type: time ? 'temporal' : 'quantitative',
    title: axis.label,
    scale: { ...valueScale(axis.xScale ?? axis.logScale, axis.xRange, axis.constant),
      ...(time && !custom && axis.timeDomain ? { domain: [...axis.timeDomain] } : {}) },
    ...(time ? { axis: {
      format: axis.granularity === 'year' ? '%Y' : axis.granularity === 'month' ? '%b %Y' : '%d %b %Y',
      tickCount: timeTicks(axis.granularity), labelOverlap: 'parity' } } : {}) };
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
        // `clip` keeps a bucket that straddles a custom range inside the plot.
        out['mark'] = { ...out['mark'], orient: 'vertical', clip: true };
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
