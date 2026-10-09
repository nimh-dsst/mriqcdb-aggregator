import { parse, View } from "vega";
import { compile } from "vega-lite";
import { describe, expect, it } from "vitest";

import { withValueAxes } from "./value-axis";
import { valueScale } from "./palette";

const logCounts = {
  label: "Intensity",
  xScale: "linear",
  yScale: "linear",
  yMode: "logCount",
  countTitle: "Count",
} as const;

function chart(mark: string, values: readonly Record<string, number>[]) {
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    data: { values },
    mark,
    encoding: {
      x: { field: "value", type: "quantitative" },
      y: { field: "count", type: "quantitative", axis: { title: "Count" } },
    },
  };
}

function histogram() {
  return {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    data: { values: [{ intensity: 1 }, { intensity: 2 }] },
    mark: "bar",
    encoding: {
      x: { field: "intensity", type: "quantitative", bin: true },
      y: { aggregate: "count", type: "quantitative", axis: { title: "Count" } },
    },
  };
}

describe("withValueAxes", () => {
  it("uses symlog constant 1 for log domains touching zero", () => {
    expect(valueScale("log", [0, 10], 0.01)).toMatchObject({ type: "symlog", constant: 1 });
    expect(valueScale("log", [-10, 10], 0.01)).toMatchObject({ type: "symlog", constant: 1 });
    expect(valueScale("log", [1, 10])).toMatchObject({ type: "log" });
    const output = withValueAxes(chart("line", [{ value: 1, count: 2 }]), { ...logCounts, yRange: [1, 10], constant: 0.01 });
    expect(output.encoding.y).toMatchObject({ scale: { type: "symlog", constant: 1 }, axis: { title: "Count (log)" } });
  });
  it.each([
    ["histogram", histogram(), "symlog"],
    ["density", chart("line", [{ value: 1, count: 0 }, { value: 2, count: 1 }]), "symlog"],
    ["ECDF", chart("line", [{ value: 1, count: 0 }, { value: 2, count: 1 }]), "symlog"],
    ["line", chart("line", [{ value: 1, count: 1 }, { value: 2, count: 2 }]), "symlog"],
    ["area", chart("area", [{ value: 1, count: 1 }]), "symlog"],
    ["bars", chart("bar", [{ value: 1, count: 1 }]), "symlog"],
  ] as const)("uses %s y scale for %s", async (_name, input, expected) => {
    const output = withValueAxes(input, logCounts);
    const y = output.encoding.y as unknown as {
      axis: { title: string };
      scale: { type: string };
    };

    expect(y.scale.type).toBe(expected);
    expect(y.axis.title).toBe("Count (log)");

    const compiled = compile(output as never).spec;
    await new View(parse(compiled), { renderer: "none" }).runAsync();
  });

  it("uses log x scales for a positive histogram domain", () => {
    const output = withValueAxes(
      {
        data: { values: [{ intensity: 1 }, { intensity: 100 }] },
        mark: "bar",
        encoding: {
          x: { field: "intensity", type: "quantitative", bin: true },
          y: { aggregate: "count", type: "quantitative" },
        },
      },
      { label: "Intensity", xScale: "log" },
    );

    expect(
      (output.encoding.x as unknown as { scale: { type: string } }).scale.type,
    ).toBe("log");
  });

  it("uses symlog when a selected log scale includes zero", () => {
    const output = withValueAxes(
      chart("line", [{ value: 0, count: 1 }, { value: 2, count: 2 }]),
      { label: "Value", xScale: "log" },
    );

    const x = output.encoding.x as unknown as {
      axis: { title: string };
      scale: { type: string };
    };
    expect(x.scale.type).toBe("symlog");
    expect(x.axis.title).toBe("Value (symlog)");
  });

  it("uses the configured range over a default domain and preserves pixel range", () => {
    const output = withValueAxes(
      {
        mark: "line",
        encoding: {
          x: {
            field: "value",
            type: "quantitative",
            scale: { domain: [0, 1], range: [0, 160] },
          },
        },
      },
      { label: "Value", xScale: "log", xRange: [1, 100] },
    );

    expect((output.encoding.x as unknown as { scale: unknown }).scale).toMatchObject({
      type: "log",
      domain: [1, 100],
      range: [0, 160],
    });
  });

  it("uses a channel title before the count-title fallback", () => {
    const output = withValueAxes(
      {
        data: { values: [{ value: 1, count: 1 }] },
        mark: "bar",
        encoding: {
          x: { field: "value", type: "quantitative" },
          y: {
            field: "count",
            type: "quantitative",
            title: "Observed count",
          },
        },
      },
      logCounts,
    );

    expect(
      (output.encoding.y as unknown as { axis: { title: string } }).axis.title,
    ).toBe("Observed count (log)");
  });

  it("replaces a previous log type when the selected scale is linear", () => {
    const output = withValueAxes(
      {
        mark: "line",
        encoding: {
          x: {
            field: "value",
            type: "quantitative",
            scale: { type: "log", domain: [1, 10] },
          },
        },
      },
      { label: "Value", xScale: "linear" },
    );

    expect(
      (output.encoding.x as unknown as { scale: { type: string } }).scale.type,
    ).toBe("linear");
  });

  it("uses one true log scale for a positive ranged area and its median line", () => {
    const output = withValueAxes(
      {
        data: {
          values: [
            { value: 1, lower: 1, upper: 3, median: 2 },
            { value: 2, lower: 2, upper: 4, median: 3 },
          ],
        },
        layer: [
          {
            mark: "area",
            encoding: {
              x: { field: "value", type: "quantitative" },
              y: { field: "lower", type: "quantitative" },
              y2: { field: "upper" },
            },
          },
          {
            mark: "line",
            encoding: {
              x: { field: "value", type: "quantitative" },
              y: { field: "median", type: "quantitative" },
            },
          },
        ],
      },
      { label: "Value", yScale: "log" },
    );
    const layers = output.layer as unknown as Array<{
      encoding: { y: { scale: { type: string } } };
    }>;

    expect(layers.map((layer) => layer.encoding.y.scale.type)).toEqual(["log", "log"]);
  });

  it("uses the UTC scale for temporal y encodings", () => {
    const output = withValueAxes(
      {
        data: { values: [{ value: 1, recordedAt: "2025-01-01" }] },
        mark: "line",
        encoding: {
          x: { field: "value", type: "quantitative" },
          y: { field: "recordedAt", type: "temporal" },
        },
      },
      { label: "Recorded at", yScale: "log" },
    );

    expect(
      (output.encoding.y as unknown as { scale: { type: string } }).scale.type,
    ).toBe("utc");
  });

  it("visits quantitative encodings beneath facet and layer specs only", () => {
    const output = withValueAxes(
      {
        data: { values: [{ group: "A", value: 1, count: 1 }] },
        facet: { field: "group", type: "nominal" },
        spec: {
          layer: [
            chart("line", [{ value: 1, count: 1 }]),
            chart("line", [{ value: 2, count: 2 }]),
          ],
        },
      },
      { label: "Value", xScale: "log", yScale: "log" },
    );
    const nested = output.spec as unknown as {
      layer: Array<{ encoding: { x: { scale: { type: string } } } }>;
    };

    expect((output.facet as unknown as { scale?: unknown }).scale).toBeUndefined();
    expect(nested.layer.map((layer) => layer.encoding.x.scale.type)).toEqual(["log", "log"]);
  });
});
