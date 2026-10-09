import { deflateSync } from "fflate";
import { describe, expect, it } from "vitest";

import { asColumnId } from "@mriqc/shared";

import { defaultDashboard, initialState, reduce } from "./reducer";
import { defaultPanelOptions } from "./state";
import { writeUrlRecord } from "./url-fields";
import {
  RAW_TOKEN_VERSION,
  TOKEN_VERSION,
  toBase64Url,
} from "./url-tokens";
import {
  decodeUrlState,
  encodeUrlState,
  type UrlState,
} from "./url";

const legacyToken = (state: UrlState) =>
  `1${toBase64Url(
    deflateSync(new TextEncoder().encode(writeUrlRecord(state)), { level: 9 }),
  )}`;

const roundTrip = (name: string, state: UrlState) => {
  const oldToken = legacyToken(state);
  const token = encodeUrlState(state);
  const decoded = decodeUrlState(token);

  console.log(
    JSON.stringify({
      name,
      oldLength: oldToken.length,
      newLength: token.length,
    }),
  );
  expect(decoded).not.toBeNull();
  if (!decoded) {
    throw new Error("Encoded URL token did not decode");
  }
  expect(decoded).toEqual(state);
  return { token, decoded };
};

describe("short graph URL tokens", () => {
  it("round-trips representative dashboard states and hydrates them", () => {
    const defaultState = defaultDashboard();
    const filteredState: UrlState = {
      ...defaultDashboard(),
      global: {
        ...defaultDashboard().global,
        filters: [
          {
            field: asColumnId("manufacturer"),
            op: "in",
            values: ["Siemens", "GE", "Philips"],
          },
          {
            field: asColumnId("magnetic_field_strength"),
            op: "in",
            values: [1.5, 3],
          },
          {
            field: asColumnId("created_at"),
            op: "between",
            lo: "2020-01-01",
            hi: "2024-01-01",
          },
        ],
      },
    };
    const cohortsState: UrlState = {
      ...defaultDashboard(),
      cohorts: [
        {
          id: "c1",
          name: "Siemens cohort",
          color: 2,
          source: "population",
          view: defaultDashboard().global.view,
          filters: [
            {
              field: asColumnId("manufacturer"),
              op: "in",
              values: ["Siemens"],
            },
          ],
          selections: [],
        },
        {
          id: "c2",
          name: "GE cohort",
          color: 3,
          source: "population",
          view: defaultDashboard().global.view,
          filters: [
            {
              field: asColumnId("manufacturer"),
              op: "in",
              values: ["GE"],
            },
          ],
          selections: [],
        },
      ],
      panels: [
        {
          ...defaultDashboard().panels[0],
          cohorts: ["c1", "c2"],
        },
      ],
    };
    const splitState: UrlState = {
      ...defaultDashboard(),
      panels: [
        {
          ...defaultDashboard().panels[0],
          split: asColumnId("manufacturer"),
          chart: "histogram",
          options: {
            ...defaultPanelOptions(),
            layout: "stacked",
            xRange: [0.1, 2.5],
            xScale: "symlog",
          },
        },
      ],
    };
    const layoutState: UrlState = {
      ...defaultDashboard(),
      panels: [
        {
          ...defaultDashboard().panels[0],
          id: "left",
        },
        {
          ...defaultDashboard().panels[0],
          id: "right",
          x: asColumnId("tsnr"),
          y: null,
          chart: "histogram",
        },
      ],
      layout: {
        left: { x: 0, y: 0, w: 6, h: 12 },
        right: { x: 6, y: 0, w: 6, h: 10 },
      },
      maximizedPanel: "right",
    };

    const cases = [
      ["default", defaultState],
      ["three-filters", filteredState],
      ["cohort-comparison", cohortsState],
      ["split-custom-range", splitState],
      ["explicit-layout", layoutState],
    ] as const;

    for (const [name, state] of cases) {
      const { decoded } = roundTrip(name, state);
      expect(reduce(initialState, { t: "hydrate", url: decoded })).toMatchObject(
        decoded,
      );
    }
  });

  it("uses the raw form when the record is smaller than its compressed form", () => {
    const state: UrlState = {
      global: { ...defaultDashboard().global, filters: [] },
      cohorts: [],
      panels: [],
      selections: [],
    };

    const token = encodeUrlState(state);

    expect(token.startsWith(RAW_TOKEN_VERSION)).toBe(true);
    expect(token.startsWith(TOKEN_VERSION)).toBe(false);
    expect(decodeUrlState(token)).toEqual(state);
  });

  it("refuses compressed tokens from an older token version", () => {
    expect(decodeUrlState(legacyToken(defaultDashboard()))).toBeNull();
  });
});
