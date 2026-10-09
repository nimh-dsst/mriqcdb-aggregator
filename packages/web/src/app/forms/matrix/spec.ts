import type { CorrelationResult } from "@mriqc/shared";
import type { TopLevelSpec } from "vega-lite";


import { correlationOrder } from "../matrix/correlation-order";


import { baseConfig, FILLS_CONTAINER, LIGHT_THEME, type ChartTheme, VL_SCHEMA } from "../shared/palette";

type CorrelationShape = {
  metrics: string[];
  pearson?: number[][];
  spearman?: number[][];
  pairN: number[][];
  minPairN: number;
};


const asCorrelation = (result: CorrelationResult): CorrelationShape => result as unknown as CorrelationShape;
const chartConfig = (theme: ChartTheme) => baseConfig(theme);
import type { AnalysisChartResult } from '../heatmap/analysis-charts';

type CorrelationRow = {
  xMetric: string;
  yMetric: string;
  xLabel: string;
  yLabel: string;
  xAxisLabel: string;
  yAxisLabel: string;
  pearson: number | null;
  spearman: number | null;
  n: number;
  value: number | null;
  label: string;
  textColor: string;
  metricCount: number;
};

const matrixValue = (matrix: number[][] | undefined, row: number, column: number): number | null => {
  const value = matrix?.[row]?.[column];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const VIK_11 = [
  "#001261",
  "#023a7b",
  "#116496",
  "#5496b7",
  "#a7c9da",
  "#ece5e0",
  "#e1b8a0",
  "#cd8961",
  "#b75a26",
  "#852206",
  "#590008",
];

/** Keep long metric names readable without abbreviating the axis vocabulary. */
function wrapCorrelationLabel(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return value;
  const breakAt = Math.ceil(words.length / 2);
  return `${words.slice(0, breakAt).join(" ")}\n${words.slice(breakAt).join(" ")}`;
}

export function correlationChart(
  result: CorrelationResult,
  labels: Readonly<Record<string, string>>,
  order: boolean,
  theme: ChartTheme = LIGHT_THEME,
  coefficient: "spearman" | "pearson" = "spearman",
  colorOptions: { colorScale?: 'linear' | 'log' | 'sqrt'; colorDomain?: 'auto' | readonly [number, number] } = {},
): AnalysisChartResult {
  const correlation = asCorrelation(result);
  const source = correlation[coefficient] ?? [];
  const indices = order && source.length > 0 ? correlationOrder(source) : correlation.metrics.map((_, index) => index);
  const metrics = indices.map((index) => correlation.metrics[index]);
  const rows: CorrelationRow[] = [];

  for (const yIndex of indices) {
    for (const xIndex of indices) {
      if (indices.indexOf(yIndex) <= indices.indexOf(xIndex)) continue;
      const pearson = matrixValue(correlation.pearson, yIndex, xIndex);
      const spearman = matrixValue(correlation.spearman, yIndex, xIndex);
      const value = matrixValue(source, yIndex, xIndex);
      const xLabel = labels[correlation.metrics[xIndex]] ?? correlation.metrics[xIndex];
      const yLabel = labels[correlation.metrics[yIndex]] ?? correlation.metrics[yIndex];
      rows.push({
        xMetric: correlation.metrics[xIndex],
        yMetric: correlation.metrics[yIndex],
        xLabel,
        yLabel,
        xAxisLabel: wrapCorrelationLabel(xLabel),
        yAxisLabel: wrapCorrelationLabel(yLabel),
        pearson,
        spearman,
        n: matrixValue(correlation.pairN, yIndex, xIndex) ?? 0,
        value,
        label: value === null ? "—" : value.toFixed(2),
        textColor: value !== null && Math.abs(value) >= 0.5 ? "#ffffff" : theme.labelInk,
        metricCount: metrics.length,
      });
    }
  }

  const labelDomain = metrics.map((metric) => wrapCorrelationLabel(labels[metric] ?? metric));
  const coefficientTitle = coefficient === "spearman" ? "Spearman ρ" : "Pearson r";
  const colorType = colorOptions.colorScale ?? 'linear';
  const domain = colorOptions.colorDomain && colorOptions.colorDomain !== 'auto' ? colorOptions.colorDomain : colorType === 'log' ? [0.001, 1] : [-1, 1];
  const colorDomain = VIK_11.map((_, i) => colorType === 'log'
    ? Math.exp(Math.log(Math.max(Number.MIN_VALUE, domain[0])) + i / 10 * (Math.log(domain[1]) - Math.log(Math.max(Number.MIN_VALUE, domain[0]))))
    : domain[0] + (domain[1] - domain[0]) * i / 10);
  const matrixScale = { domain: labelDomain, paddingInner: 0, paddingOuter: 0,
    range: [0, { expr: "min(width, height)" }] };
  return {
    datasets: { "correlation-cells": rows },
    spec: {
      $schema: VL_SCHEMA,
      ...FILLS_CONTAINER,
      data: { name: "correlation-cells" },
      layer: [
        {
          mark: { type: "rect" },
          encoding: {
            x: { field: "xAxisLabel", type: "ordinal", scale: matrixScale, sort: labelDomain, axis: { title: null, labelAngle: -40, labelExpr: "split(datum.label, '\\n')", labelLineHeight: 13, labelOverlap: false, labelLimit: 0, grid: false } },
            y: { field: "yAxisLabel", type: "ordinal", scale: matrixScale, sort: labelDomain, axis: { title: null, labelExpr: "split(datum.label, '\\n')", labelLineHeight: 13, labelOverlap: false, labelLimit: 0, grid: false } },
            color: {
              field: "value",
              type: "quantitative",
              title: `${coefficientTitle} (${colorType})`,
              legend: { orient: "right" },
              scale: {
                type: colorType,
                domain: colorDomain,
                range: VIK_11,
                clamp: true,
              },
            },
            tooltip: [
              { field: "xLabel", type: "nominal", title: "Metric x" },
              { field: "yLabel", type: "nominal", title: "Metric y" },
              { field: "value", type: "quantitative", title: coefficientTitle, format: ".3f" },
              { field: "n", type: "quantitative", title: "Paired observations" },
            ],
          },
        },
        {
          mark: { type: "text", baseline: "middle", fontSize: 12 },
          encoding: {
            x: { field: "xAxisLabel", type: "ordinal", scale: matrixScale, sort: labelDomain },
            y: { field: "yAxisLabel", type: "ordinal", scale: matrixScale, sort: labelDomain },
            text: { field: "label", type: "nominal" },
            color: { value: { expr: "datum.textColor" } },
          },
        },
      ],
      ...chartConfig(theme),
    } as unknown as TopLevelSpec,
  };
}

