/**
 * The statistics SQL templates and the splitter that turns one into its named
 * statements.
 *
 * The texts live here, in the shared package, rather than as files beside the
 * server's query path, because two runners compile them: the server's pooled
 * DuckDB connections and -- for an uploaded study, whose rows never leave the
 * browser -- the dashboard's DuckDB-WASM instance, which has no filesystem to
 * read a `.sql` file from. See `docs/comparison-design.md`, "Query model", and
 * `docs/backend-graph.md`, "Query templates and the filter compiler".
 *
 * The holes are unchanged by the move: `{{table}}` comes from the view map,
 * identifier holes are catalog-validated and quoted, and data values are
 * positional `?` parameters. SAMPLE's size/seed grammar instead requires
 * validated integer literals. Substituting holes is the runner's job (`fill`
 * on the server).
 *
 * The canonicalization policy SQL is *not* here. It is server-only -- it builds
 * the database -- and stays under `packages/server/src/sql/canonical/`.
 */

import { COVERAGE_SQL } from './coverage.js';
import { CORRELATION_SQL } from './correlation.js';
import { DENSITY2D_SQL } from './density2d.js';
import { DISTRIBUTION_SQL } from './distribution.js';
import { EXPORT_SQL } from './export.js';
import { GROUPED_SUMMARY_SQL } from './grouped_summary.js';
import { SAMPLE_SQL } from './sample.js';
import { TIME_SUMMARY_SQL } from './time_summary.js';

export { CORRELATION_SQL, COVERAGE_SQL, DENSITY2D_SQL, DISTRIBUTION_SQL, EXPORT_SQL, GROUPED_SUMMARY_SQL, SAMPLE_SQL, TIME_SUMMARY_SQL };

/** The statistics templates, one per procedure. */
export type TemplateName = 'distribution' | 'density2d' | 'correlation' | 'grouped_summary' | 'coverage' | 'sample' | 'export' | 'time_summary';

/** Every template text, keyed by name. */
export const SQL_TEMPLATES: Readonly<Record<TemplateName, string>> = {
  density2d: DENSITY2D_SQL,
  correlation: CORRELATION_SQL,
  distribution: DISTRIBUTION_SQL,
  grouped_summary: GROUPED_SUMMARY_SQL,
  coverage: COVERAGE_SQL,
  time_summary: TIME_SUMMARY_SQL,
  sample: SAMPLE_SQL,
  export: EXPORT_SQL,
};

/**
 * Split one template into its named statements. A statement begins at a
 * `-- @statement <name>` line and runs to the next one.
 */
export function parseStatements(source: string): Map<string, string> {
  const statements = new Map<string, string>();
  let current: string | null = null;
  let lines: string[] = [];
  const flush = (): void => {
    if (current !== null) statements.set(current, lines.join('\n').trim());
  };
  for (const line of source.split(/\r?\n/)) {
    const header = /^--\s*@statement\s+(\w+)\s*$/.exec(line);
    if (header !== null) {
      flush();
      current = header[1] as string;
      lines = [];
    } else if (current !== null) {
      lines.push(line);
    }
  }
  flush();
  return statements;
}

const cache = new Map<TemplateName, ReadonlyMap<string, string>>();

/** One template's named statements, split once and cached. */
export function statementsOf(template: TemplateName): ReadonlyMap<string, string> {
  let statements = cache.get(template);
  if (statements === undefined) {
    statements = parseStatements(SQL_TEMPLATES[template]);
    cache.set(template, statements);
  }
  return statements;
}
