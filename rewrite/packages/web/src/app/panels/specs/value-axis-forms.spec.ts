import { parse, View } from "vega";
import { compile } from "vega-lite";
import { describe, expect, it } from "vitest";

import {
  countsSpec,
  densitySpec,
  ecdfSpec,
  histogramSpec,
  type MetricAxis,
} from "./index";
import { withValueAxes } from "./value-axis";

const axis: MetricAxis = {
  label: "Metric",
  logScale: false,
  countTitle: "Count",
  xScale: "log",
  yMode: "logCount",
  yScale: "linear",
};

const population = [
  { lo: 1, hi: 2, count: 0, value: 1, density: 0, p: 0 },
  { lo: 2, hi: 3, count: 4, value: 2, density: 1, p: 1 },
];

const counts = [
  { cohort: "a", label: "A", lo: 1, hi: 2, count: 0, value: 1, share: 0 },
  { cohort: "a", label: "A", lo: 2, hi: 3, count: 4, value: 2, share: 1 },
];

const datasets = { population, counts };

describe("value axes on chart builders", () => {
  it.each([{ rows: population }, { rows: population.map(row => ({ ...row, count: row.count + 1 })) }])(
    "renders every log-count histogram bin against scale zero", async ({ rows }) => {
      const spec = histogramSpec({ ...axis, countTitle: "Scans", constant: 0.01 });
      expect(spec).toMatchObject({ encoding: { y: {
        scale: { type: "symlog", constant: 1, zero: true }, axis: { title: "Scans (log)" },
      } } });
      const compiled = compile({ ...spec, width: 320, height: 180, datasets: { population: rows } } as never).spec;
      const view = new View(parse(compiled), { renderer: "none" });
      try {
        await view.runAsync();
        const bars: any[] = [];
        const visit = (item: any) => {
          if (item.mark?.marktype === "rect" && typeof item.datum?.count === "number") bars.push(item);
          item.items?.forEach(visit);
        };
        visit((view.scenegraph() as unknown as { root: unknown }).root);
        expect(bars).toHaveLength(rows.length);
        const zero = view.scale("y")(0);
        for (const bar of bars) {
          expect(Number.isFinite(bar.x)).toBe(true);
          expect(Number.isFinite(bar.y)).toBe(true);
          expect(bar.width).toBeGreaterThan(0);
          expect(bar.y + bar.height).toBeCloseTo(zero);
          if (bar.datum.count > 0) expect(bar.height).toBeGreaterThan(0);
        }
      } finally {
        view.finalize();
      }
    },
  );
  it("keeps histogram x logarithmic and its quantitative y scales valid", async () => {
    const spec = transformed(histogramSpec(axis));

    expect(quantitativeYScaleTypes(spec)).toEqual(expect.arrayContaining(["symlog"]));
    expect(quantitativeXScaleTypes(spec)).toEqual(expect.arrayContaining(["log"]));
    await expectRuntimeValueScales(spec, "x");
    await expectRuntimeValueScales(spec, "y");
  });

  it.each([
    ["density", densitySpec(axis)],
    ["ECDF", ecdfSpec(axis)],
    ["line counts", countsSpec(axis, "line", [{ id: "a", label: "A", color: "#000" }])],
    ["area counts", countsSpec(axis, "area", [{ id: "a", label: "A", color: "#000" }])],
  ] as const)("uses a log-family y scale for %s", async (_name, input) => {
    const spec = transformed(input);
    const yScaleTypes = quantitativeYScaleTypes(spec);

    expect(yScaleTypes.length).toBeGreaterThan(0);
    expect(yScaleTypes.every(isLogFamily)).toBe(true);
    await expectRuntimeValueScales(spec, "y");
  });
});

function transformed<T extends object>(spec: T): T {
  return withValueAxes({ ...spec, datasets }, axis, datasets) as unknown as T;
}

function quantitativeYScaleTypes(spec: object): string[] {
  return quantitativeScaleTypes(spec, "y");
}

function quantitativeXScaleTypes(spec: object): string[] {
  return quantitativeScaleTypes(spec, "x");
}

function quantitativeScaleTypes(spec: object, dimension: "x" | "y"): string[] {
  const types: string[] = [];
  visitVegaLiteSpec(spec, (encoding) => {
    const channel = encoding[dimension];
    if (!isRecord(channel) || channel["type"] !== "quantitative") {
      return;
    }
    const scale = channel["scale"];
    if (isRecord(scale) && typeof scale["type"] === "string") {
      types.push(scale["type"]);
    }
  });
  return types;
}

async function expectRuntimeValueScales(spec: object, dimension: "x" | "y"): Promise<void> {
  const compiled = compile(spec as never).spec;
  const view = new View(parse(compiled), { renderer: "none" });
  await view.runAsync();

  const scaleDefinitions = compiledScaleDefinitions(compiled).filter(
    (scale) => new RegExp(`(?:^|_)${dimension}$`).test(scale.name),
  );
  expect(scaleDefinitions.length).toBeGreaterThan(0);
  for (const scale of scaleDefinitions) {
    expect(isLogFamily(scale.type)).toBe(true);
    const runtimeScale = view.scale(scale.name) as unknown as { type?: unknown } | undefined;
    expect(runtimeScale).toBeDefined();
    expect(isLogFamily(runtimeScale?.type)).toBe(true);
  }
}

function visitVegaLiteSpec(
  value: unknown,
  onEncoding: (encoding: Record<string, unknown>) => void,
): void {
  if (!isRecord(value)) {
    return;
  }
  const encoding = value["encoding"];
  if (isRecord(encoding)) {
    onEncoding(encoding);
  }
  for (const key of ["spec", "layer", "concat", "hconcat", "vconcat"] as const) {
    const child = value[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        visitVegaLiteSpec(item, onEncoding);
      }
    } else {
      visitVegaLiteSpec(child, onEncoding);
    }
  }
}

function compiledScaleDefinitions(value: unknown): Array<{ name: string; type: string }> {
  const scales: Array<{ name: string; type: string }> = [];
  visitVegaSpec(value, scales);
  return scales;
}

function visitVegaSpec(value: unknown, scales: Array<{ name: string; type: string }>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      visitVegaSpec(item, scales);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const definitions = value["scales"];
  if (Array.isArray(definitions)) {
    for (const definition of definitions) {
      if (
        isRecord(definition) &&
        typeof definition["name"] === "string" &&
        typeof definition["type"] === "string"
      ) {
        scales.push({ name: definition["name"], type: definition["type"] });
      }
    }
  }
  for (const child of Object.values(value)) {
    visitVegaSpec(child, scales);
  }
}

function isLogFamily(value: unknown): value is "log" | "symlog" {
  return value === "log" || value === "symlog";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
