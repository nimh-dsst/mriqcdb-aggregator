import { asColumnId } from "@mriqc/shared";
import { describe, expect, it } from "vitest";

import { axisType, formsFor, panelForms, validForm } from "../../graph/panel-shapes";
import { reduce } from "../../graph/reducer";
import { seriesKey } from "../../graph/series";
import {
  defaultPanelOptions,
  INITIAL_STATE,
  type MetricId,
  type Panel,
} from "../../graph/state";

const snr = asColumnId("snr");
const tsnr = asColumnId("tsnr") as unknown as MetricId;
const manufacturer = asColumnId("manufacturer");
const magneticFieldStrength = asColumnId("magnetic_field_strength");
const acquisitionDate = asColumnId("created_at");
const metricAxis = [tsnr] as readonly MetricId[];

const panel = (
  x: Panel["x"],
  y: Panel["y"],
  form: Panel["form"],
): Panel => ({
  id: "panel",
  x,
  y,
  form,
  series: [],
  options: defaultPanelOptions(),
  cursors: [],
});

const firstPanel = (state: { readonly panels: readonly Panel[] }): Panel =>
  state.panels[0]!;

const withPanel = (x = snr) =>
  reduce(INITIAL_STATE, { t: "addPanel", x });

const noticeOf = (state: unknown): string | undefined =>
  (state as { readonly notice?: string }).notice;

describe("panel form scheme", () => {
  it("maps each axis shape to its complete form row", () => {
    expect(axisType(snr)).toBe("numeric");
    expect(axisType(acquisitionDate)).toBe("time");
    expect(axisType(manufacturer)).toBe("categorical");
    expect(axisType(metricAxis)).toBe("metrics");

    expect(formsFor(snr, null)).toEqual([
      "histogram",
      "line",
      "area",
      "density",
      "ecdf",
      "box",
      "table",
    ]);
    expect(formsFor(acquisitionDate, null)).toEqual([
      "histogram",
      "line",
      "area",
      "density",
      "ecdf",
      "box",
      "table",
      "band",
    ]);
    expect(formsFor(acquisitionDate, tsnr)).toEqual([
      "heatmap",
      "scatter",
      "clusters",
      "band",
      "lines",
    ]);
    expect(formsFor(snr, tsnr)).toEqual([
      "heatmap",
      "scatter",
      "clusters",
      "band",
      "lines",
    ]);
    expect(formsFor(manufacturer, null)).toEqual([
      "bars",
      "share",
    ]);
    expect(formsFor(metricAxis, null)).toEqual(["matrix"]);
  });

  it("derives panel forms and rejects forms that do not fit its axes", () => {
    const oneNumeric = panel(snr, null, "box");
    const twoNumeric = panel(snr, tsnr, "heatmap");

    expect(panelForms(oneNumeric)).toEqual([
      "histogram",
      "line",
      "area",
      "density",
      "ecdf",
      "box",
      "table",
    ]);
    expect(validForm(oneNumeric)).toBe(oneNumeric);
    expect(validForm(twoNumeric)).toBe(twoNumeric);
    expect(validForm(panel(snr, tsnr, "ecdf"))).toMatchObject({
      form: "heatmap",
    });
  });

  it("keeps valid forms and resets invalid forms when axes change", () => {
    const initial = withPanel();
    const id = firstPanel(initial).id;
    const ecdf = reduce(initial, { t: "setPanelForm", id, form: "ecdf" });
    const paired = reduce(ecdf, {
      t: "setPanelAxis",
      id,
      axis: "y",
      value: tsnr,
    });
    const categorical = reduce(paired, {
      t: "setPanelAxis",
      id,
      axis: "x",
      value: manufacturer,
    });

    expect(firstPanel(ecdf).form).toBe("ecdf");
    expect(firstPanel(paired).form).toBe("heatmap");
    expect(firstPanel(categorical)).toMatchObject({
      y: null,
      form: "bars",
    });
  });

  it.each([snr, acquisitionDate])("rejects disabled forms without changing the axes on %s", x => {
    const initial = withPanel(x);
    // Counts over time may be a band (spread of daily counts); a metric x may not.
    const disabled = ['heatmap', 'scatter', 'clusters', ...(x === acquisitionDate ? [] : ['band' as const]), 'lines'] as const;
    for (const form of disabled) {
      expect(reduce(initial, { t: 'setPanelForm', id: firstPanel(initial).id, form })).toBe(initial);
      expect(reduce(initial, { t: 'patchPanel', id: firstPanel(initial).id, patch: { form } })).toBe(initial);
    }
  });

  it("rejects a hidden form instead of changing the quantity", () => {
    const initial = withPanel();
    expect(reduce(initial, { t: 'setPanelForm', id: firstPanel(initial).id, form: 'matrix' })).toBe(initial);
  });

  it("keeps ECDF, box, and table forms when a series is added or removed", () => {
    const chosenValues = {
      kind: "values" as const,
      field: manufacturer,
      values: ["Siemens", "GE"],
    };

    for (const form of ["ecdf", "box", "table"] as const) {
      const initial = withPanel();
      const id = firstPanel(initial).id;
      const configured = reduce(initial, { t: "setPanelForm", id, form });
      const withSeries = reduce(configured, {
        t: "addPanelSeries",
        id,
        series: chosenValues,
      });
      const removed = reduce(withSeries, {
        t: "removePanelSeries",
        id,
        key: seriesKey(chosenValues),
      });

      expect(firstPanel(withSeries).form).toBe(form);
      expect(firstPanel(removed)).toMatchObject({ form, series: [] });
    }
  });

  it("changes density to a histogram only when its grouping layout is stacked", () => {
    const initial = withPanel();
    const id = firstPanel(initial).id;
    const density = reduce(initial, { t: "setPanelForm", id, form: "density" });
    const grouped = reduce(density, {
      t: "addPanelSeries",
      id,
      series: { kind: "field", field: manufacturer },
    });
    const stacked = reduce(grouped, {
      t: "setPanelOptions",
      id,
      options: { layout: "stacked" },
    });

    expect(firstPanel(grouped)).toMatchObject({ form: "density" });
    expect(firstPanel(stacked)).toMatchObject({ form: "histogram" });
  });

  it("allows chosen values with an against series but refuses grouping and cap violations", () => {
    const values = {
      kind: "values" as const,
      field: manufacturer,
      values: ["Siemens", "GE"],
    };
    const initial = withPanel();
    const id = firstPanel(initial).id;
    const compared = reduce(
      reduce(initial, { t: "addPanelSeries", id, series: values }),
      { t: "addPanelSeries", id, series: { kind: "population" } },
    );
    const firstGrouping = reduce(initial, {
      t: "addPanelSeries",
      id,
      series: { kind: "field", field: manufacturer },
    });
    const secondGrouping = reduce(firstGrouping, {
      t: "addPanelSeries",
      id,
      series: { kind: "field", field: magneticFieldStrength },
    });
    const capped = reduce(firstGrouping, {
      t: "addPanelSeries",
      id,
      series: { kind: "population" },
    });

    expect(firstPanel(compared).series).toHaveLength(2);
    expect(firstPanel(secondGrouping).series).toHaveLength(1);
    expect(noticeOf(secondGrouping)).toMatch(/one grouping/i);
    expect(firstPanel(capped).series).toHaveLength(1);
    expect(noticeOf(capped)).toMatch(/Six coloured series plus Other maximum/i);
  });

  it("refuses a missing study and normalizes an axis patch", () => {
    const initial = withPanel();
    const id = firstPanel(initial).id;
    const missingStudy = reduce(initial, {
      t: "addPanelSeries",
      id,
      series: { kind: "study" },
    });
    const patched = reduce(initial, {
      t: "patchPanel",
      id,
      patch: { x: manufacturer, y: tsnr, form: "density" },
    });

    expect(firstPanel(missingStudy).series).toEqual([]);
    expect(noticeOf(missingStudy)).toMatch(/study/i);
    expect(firstPanel(patched)).toMatchObject({
      x: manufacturer,
      y: null,
      form: "bars",
    });
  });
});
