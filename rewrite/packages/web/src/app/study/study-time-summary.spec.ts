import {
  asColumnId,
  getAuthoredCatalog,
  statementsOf,
  type TimeSummaryQuery,
} from "@mriqc/shared";
import { describe, expect, it } from "vitest";

import { metricExpression, predicate } from "./study-sql";
import { compileStudyTimeSummary, shapeTimeSummary } from "./study-time-summary";

type StatementParts = {
  readonly template: "time_summary";
  readonly statement: "buckets";
  readonly sql: string;
  readonly params: readonly unknown[];
};

function queryAndColumns(): { query: TimeSummaryQuery; columns: ReadonlySet<string> } {
  return {
    query: { source: 'study', proc: 'timeSummary', modality: 'bold', view: 'raw', filters: [],
      metric: asColumnId('fd_mean'), granularity: 'month' } as TimeSummaryQuery,
    columns: new Set(['created_at', 'fd_mean', 'tsnr', 'manufacturer']),
  };
}

describe("compileStudyTimeSummary", () => {
  it("uses the registered buckets template with exact hole substitution", () => {
    const { query, columns } = queryAndColumns();
    const statement = compileStudyTimeSummary(query, columns);
    const template = statementsOf("time_summary").get("buckets");
    expect(template).toBeDefined();

    const where = predicate(query, columns).where;
    const expected = template!
      .replaceAll("{{table}}", '"study"')
      .replaceAll("{{where}}", where)
      .replaceAll("{{metric}}", metricExpression(query.modality, query.metric, columns))
      .replaceAll("{{granularity}}", "'month'")
      .replaceAll("{{group_expr}}", "NULL::VARCHAR")
      .replaceAll("{{group_numeric}}", "FALSE")
      .replaceAll("{{group_bins}}", "10")
      .replaceAll("{{max_groups}}", "50");
    expect(statement).toEqual({
      template: "time_summary",
      statement: "buckets",
      sql: expected,
      params: predicate(query, columns).params,
    } satisfies StatementParts);
  });

  it("binds filters, selections, then the inclusive window", () => {
    const { query, columns } = queryAndColumns();
    const selected: TimeSummaryQuery = { ...query,
      filters: [{ field: asColumnId('manufacturer'), op: 'in', values: ['SIEMENS'] }],
      selections: [{ metric: asColumnId('fd_mean'), range: [0.4, 1.2] }, { metric: asColumnId('tsnr'), range: [20, 60] }],
      window: ['2024-01-01', '2024-01-31'] };
    const statement = compileStudyTimeSummary(selected, columns);
    expect(statement.params).toEqual(['SIEMENS', 0.4, 1.2, 20, 60, '2024-01-01', '2024-01-31']);
    expect(statement.sql).toContain('created_at BETWEEN CAST(? AS TIMESTAMP) AND CAST(? AS TIMESTAMP)');
  });

  it("rejects absent timestamps, invalid granularity, and invalid windows", () => {
    const { query, columns } = queryAndColumns();
    expect(() => compileStudyTimeSummary(query, new Set())).toThrow("created_at");
    expect(() =>
      compileStudyTimeSummary({ ...query, granularity: "hour" as never }, columns),
    ).toThrow("granularity");
    expect(() =>
      compileStudyTimeSummary(
        {
          ...query,
          window: ["2024-02-01", "2024-01-01"],
        },
        columns,
      ),
    ).toThrow("window");
  });
});

describe("shapeTimeSummary", () => {
  it("shapes iterable quantiles, timestamps, nulls, Other, and numeric group labels", () => {
    const result = shapeTimeSummary([
      {
        bucket: 1704067200000,
        value: null,
        is_other: false,
        n: 3n,
        qs: new Set([1, 2, 3, 4, 5]),
        mean: 3,
        thin: true,
      },
      {
        bucket: new Date("2024-02-01T00:00:00.000Z"),
        value: "ignored",
        is_other: true,
        n: 2n,
        qs: [2, 3, 4, 5, 6],
        mean: 4,
        thin: false,
      },
      {
        bucket: "2024-03-01T00:00:00.000Z",
        value: 10,
        is_other: false,
        n: 1n,
        qs: [1, 1, 1, 1, 1],
        mean: 1,
        thin: false,
        group_lo: 0,
        group_width: 0.25,
      },
    ]);

    expect(result.buckets).toEqual([
      {
        start: "2024-01-01",
        group: null,
        isOther: false,
        n: 3,
        quantiles: { p05: 1, p25: 2, p50: 3, p75: 4, p95: 5 },
        mean: 3,
        thin: true,
      },
      {
        start: "2024-02-01",
        group: "Other",
        isOther: true,
        n: 2,
        quantiles: { p05: 2, p25: 3, p50: 4, p75: 5, p95: 6 },
        mean: 4,
        thin: false,
      },
      {
        start: "2024-03-01",
        group: "2.5–2.75",
        isOther: false,
        n: 1,
        quantiles: { p05: 1, p25: 1, p50: 1, p75: 1, p95: 1 },
        mean: 1,
        thin: false,
      },
    ]);
  });
});
