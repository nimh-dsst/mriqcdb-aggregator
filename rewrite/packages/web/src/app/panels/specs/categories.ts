import type { TopLevelSpec } from 'vega-lite';

import { baseConfig, type ChartTheme } from "./palette";

export interface CategorySeries {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly counts: readonly { readonly category: string; readonly n: number }[];
}

interface CategoryDatum {
  readonly category: string;
  readonly series: string;
  readonly label: string;
  readonly n: number;
  readonly share: number;
}

const countRows = (series: readonly CategorySeries[]): readonly CategoryDatum[] => {
  const rows: CategoryDatum[] = [];

  for (const item of series) {
    const total = item.counts.reduce((sum, count) => sum + count.n, 0);
    for (const count of item.counts) {
      rows.push({
        category: count.category,
        series: item.id,
        label: item.name,
        n: count.n,
        share: total === 0 ? 0 : count.n / total,
      });
    }
  }

  return rows;
};

const categoryOrder = (series: readonly CategorySeries[]): readonly string[] => {
  const seen = new Set<string>();
  const categories: string[] = [];

  for (const item of series) {
    for (const count of item.counts) {
      if (!seen.has(count.category)) {
        seen.add(count.category);
        categories.push(count.category);
      }
    }
  }

  return categories;
};

/** Builds a grouped categorical bar chart backed by a named in-memory dataset. */
export const categoryChart = (
  series: readonly CategorySeries[],
  label: string,
  share: boolean,
  countTitle = "Scans",
  theme?: ChartTheme,
): { spec: TopLevelSpec; datasets: Record<string, readonly unknown[]> } => {
  const rows = countRows(series);
  const categories = categoryOrder(series);
  const ids = series.map((item) => item.id);

  const spec: TopLevelSpec = {
    ...baseConfig(theme), width: 'container', height: 'container',
    data: { name: "categories" },
    mark: { type: "bar", tooltip: true },
    encoding: {
      x: {
        field: "category",
        type: "nominal",
        title: label,
        sort: [...categories],
      },
      ...(series.length >= 2
        ? {
            xOffset: {
              field: "series",
              type: "nominal",
              sort: ids,
            },
          }
        : {}),
      y: {
        field: share ? "share" : "n",
        type: "quantitative",
        title: share ? "Share" : countTitle,
        ...(share ? { axis: { format: ".0%" } } : {}),
      },
      color: {
        field: "series",
        type: "nominal",
        scale: {
          domain: ids,
          range: series.map((item) => item.color),
        },
        legend: null,
      },
      tooltip: [
        { field: "category", type: "nominal", title: label },
        { field: "label", type: "nominal", title: "Series" },
        { field: "n", type: "quantitative", title: countTitle },
        { field: "share", type: "quantitative", title: "Share", format: ".1%" },
      ],
    },
  };

  return { spec, datasets: { categories: rows } };
};
