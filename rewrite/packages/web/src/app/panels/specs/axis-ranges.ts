import type { TopLevelSpec } from 'vega-lite';
import type { Panel } from '../../graph/state';

/** Count/probability axes have no server bin grid; retain their scale mode. */
export function withCountRange(spec: TopLevelSpec, panel: Panel): TopLevelSpec {
  if (panel.y !== null || panel.options.yRange === 'auto') return spec;
  const range = panel.options.yRange;
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== 'object') return value;
    const out = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
    const encoding = out['encoding'] as Record<string, any> | undefined;
    if (encoding?.['y']?.type === 'quantitative') {
      encoding['y'] = { ...encoding['y'], scale: { ...encoding['y'].scale, domain: [...range], nice: false, zero: false } };
      if (out['mark']) out['mark'] = typeof out['mark'] === 'string' ? { type: out['mark'], clip: true } : { ...(out['mark'] as object), clip: true };
    }
    return out;
  };
  return visit(spec) as TopLevelSpec;
}
