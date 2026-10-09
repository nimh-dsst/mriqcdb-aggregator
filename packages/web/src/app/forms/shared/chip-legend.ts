import type { TopLevelSpec } from 'vega-lite';

/** Chips own series labels when present; quantitative colour keys still belong to the chart. */
export function withChipLegend(spec: TopLevelSpec): TopLevelSpec {
  function visit(node: Record<string, unknown>): Record<string, unknown> {
    const result = { ...node };
    if (node['encoding']) {
      const encoding = { ...(node['encoding'] as Record<string, unknown>) };
      for (const channel of ['color', 'fill', 'stroke']) {
        const field = encoding[channel] as Record<string, unknown> | undefined;
        if (field && (field['type'] === 'nominal' || field['type'] === 'ordinal')) {
          encoding[channel] = { ...field, legend: null };
        }
      }
      result['encoding'] = encoding;
    }
    for (const key of ['layer', 'concat', 'hconcat', 'vconcat']) {
      if (Array.isArray(node[key])) result[key] = (node[key] as Record<string, unknown>[]).map(visit);
    }
    if (node['spec']) result['spec'] = visit(node['spec'] as Record<string, unknown>);
    return result;
  }
  return visit(spec as unknown as Record<string, unknown>) as unknown as TopLevelSpec;
}
