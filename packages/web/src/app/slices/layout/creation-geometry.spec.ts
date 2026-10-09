import { asColumnId } from "@mriqc/shared";
import { describe, expect, it } from "vitest";

import { deriveLayout } from './geometry';
import { defaultDashboard } from '../panels/defaults';
import { initialState, reduce } from '../../loop/reducer';

function hydrated() {
  return reduce(initialState, { t: "hydrate", url: defaultDashboard() });
}

describe("panel creation geometry", () => {
  it("hydrates the saved default panel geometry", () => {
    const state = hydrated();

    expect(Object.keys(state.layout ?? {})).toEqual(state.panels.map(panel => panel.id));
    expect(state.layout?.['p1']).toEqual({ x: 0, y: 0, w: 4, h: 10 });
  });

  it("preserves every geometry field when a panel becomes a heatmap", () => {
    const state = hydrated();
    const previousLayout = structuredClone(state.layout);

    const next = reduce(state, {
      t: "patchPanel",
      id: "p1",
      patch: { y: asColumnId("snr"), form: "heatmap" },
    });

    expect(next.layout).toEqual(previousLayout);
  });

  it("preserves geometry when a population series is added", () => {
    const state = hydrated();
    const previousLayout = structuredClone(state.layout);

    const next = reduce(state, {
      t: "addPanelSeries",
      id: "p1",
      series: { kind: "population" },
    });

    expect(next.layout).toEqual(previousLayout);
  });

  it("preserves geometry when a panel form changes to density", () => {
    const state = hydrated();
    const previousLayout = structuredClone(state.layout);

    const next = reduce(state, { t: "setPanelForm", id: "p1", form: "density" });

    expect(next.layout).toEqual(previousLayout);
  });

  it("redefaults geometry for the current forms on reset", () => {
    const state = reduce(hydrated(), {
      t: "patchPanel",
      id: "p1",
      patch: { y: asColumnId("snr"), form: "heatmap" },
    });

    const reset = reduce(state, { t: "resetLayout" });

    expect(state.layout?.['p1'].w).toBe(4);
    expect(reset.layout?.['p1'].w).toBe(8);
    expect(reset.layout).toEqual(deriveLayout(reset.panels, 3));
  });

  it("places an added panel in the first free slot without moving existing panels", () => {
    const source = hydrated();
    const state = {
      ...source,
      panels: source.panels.filter((panel) => panel.id === "p1"),
      layout: { p1: { x: 0, y: 0, w: 4, h: 10 } },
    };

    const next = reduce(state, { t: "addPanel", x: asColumnId("snr") });
    const added = Object.entries(next.layout ?? {}).find(([id]) => id !== "p1");

    expect(next.layout?.['p1']).toEqual(state.layout.p1);
    expect(added).toBeDefined();
    expect(added?.[1]).toMatchObject({ x: 4, y: 0 });
  });
});
