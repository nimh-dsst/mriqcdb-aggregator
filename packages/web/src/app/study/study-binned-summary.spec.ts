import { statementsOf, type BinnedSummaryQuery } from "@mriqc/shared";
import { describe, expect, it } from "vitest";

import {
  compileStudyBinnedSummary,
  shapeBinnedSummary,
} from "./study-binned-summary";

function query(overrides: Partial<BinnedSummaryQuery> = {}): BinnedSummaryQuery {
  return {
    source: "study",
    proc: "binnedSummary",
    modality: "bold",
    view: "raw",
    filters: [],
    x: "fd_mean",
    y: "snr",
    bins: 4,
    ...overrides,
  } as BinnedSummaryQuery;
}

const studyColumns = new Set(["created_at", "fd_mean", "snr"]);

describe("compileStudyBinnedSummary", () => {
  it("uses both statements from the shared binned-summary template", () => {
    const template = statementsOf("binned_summary");
    const statements = compileStudyBinnedSummary(query(), studyColumns);

    expect([...template.keys()]).toEqual(['stats', 'buckets']);
    expect(statements.stats.sql).toContain('quantile_cont(CAST("fd_mean" AS DOUBLE)');
    const buckets = statements.buckets([0, 40]);
    expect(buckets.sql).toContain('quantile_cont(y, [.05, .25, .5, .75, .95])');
    expect(buckets.sql).not.toContain('{{');
    expect(buckets.params.slice(-3)).toEqual([0, 40, 4]);
  });
});

describe("shapeBinnedSummary", () => {
  it("turns metric bucket indexes into data edges and numeric groups into ranges", () => {
    const result = shapeBinnedSummary(
      [{
        bucket: 1,
        value: 2,
        group_lo: 10,
        group_width: 5,
        n: 3n,
        qs: [1n, 2n, 3n, 4n, 5n],
        mean: 3n,
        thin: true,
        is_other: false,
      }],
      query(),
      [0, 40],
    );

    expect(result).toMatchObject({
      xKind: "metric",
      buckets: [{
        lo: 10,
        hi: 20,
        group: "20–25",
        n: 3,
        quantiles: { p05: 1, p25: 2, p50: 3, p75: 4, p95: 5 },
        thin: true,
      }],
    });
  });

  it("keeps time edges in epoch days and uses the server's YYYY-MM-DD start", () => {
    const result = shapeBinnedSummary(
      [{
        bucket: 0,
        bucket_hi: 31,
        value: null,
        n: 2n,
        qs: [1, 2, 3, 4, 5],
        mean: 3,
        thin: false,
        is_other: false,
      }],
      query({ x: "created_at", bins: "month" as never }),
      [0, 31],
    );

    expect(result.buckets[0]).toMatchObject({
      lo: 0,
      hi: 31,
      start: "2000-01-01",
    });
  });
});
