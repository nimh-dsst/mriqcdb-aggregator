import type { TopLevelSpec } from 'vega-lite';
import type { Panel } from '../../graph/state';

/** Count/probability axes have no server bin grid; retain their scale mode. */
export function withCountRange(spec: TopLevelSpec, panel: Panel): TopLevelSpec {
  if (panel.y !== null || (panel.options.yRange === 'auto' && panel.options.yScale === 'linear')) return spec;
  const range = panel.options.yRange;
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    const out = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
    const encoding = out['encoding'] as Record<string, any> | undefined;
    if (encoding?.['y']?.type === 'quantitative') {
      const log = panel.options.yScale === 'log' || panel.options.yMode === 'logCount';
      // Bars stand on 0, which a log axis has no place for: start it just
      // under the smallest non-empty bar and clamp the bases to the bottom.
      const floor = panel.options.yMode === 'share' ? 0.001 : 0.8;
      const domain = range === 'auto' ? null : log && range[0] <= 0 ? [floor, range[1]] : [...range];
      encoding['y'] = { ...encoding['y'], scale: { ...encoding['y'].scale,
        ...(panel.options.yScale !== 'linear' || panel.options.yMode === 'logCount' ? { type: panel.options.yMode === 'logCount' ? 'log' : panel.options.yScale } : {}),
        ...(log ? { clamp: true, ...(domain ? {} : { domainMin: floor }) } : {}),
        ...(domain ? { domain, nice: false, ...(log ? {} : { zero: false }) } : {}) } };
      if (out['mark']) out['mark'] = typeof out['mark'] === 'string' ? { type: out['mark'], clip: true } : { ...(out['mark'] as object), clip: true };
    }
    return out;
  };
  return visit(spec) as TopLevelSpec;
}
