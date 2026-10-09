import type { TimeSummaryQuery, TimeSummaryResult } from '@mriqc/shared';
import { Injectable } from '@angular/core';
import { defer, from, type Observable } from 'rxjs';
import {
  getAuthoredCatalog,
  quoteIdent,
  type DistributionResult,
  type Density2dResult,
  type CorrelationResult,
  type GroupedSummaryResult,
} from '@mriqc/shared';
import type { AsyncDuckDB, AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import type {
  StudyApi,
  StudyDistributionQuery,
  StudyGroupedSummaryQuery,
  StudyLoadResult,
  StudyDensity2dQuery,
  StudyCorrelationQuery,
} from '../api/api';
import type { ParsedStudy } from './study-parser';
import type { BoundStatement, StudyRow } from './study-sql';

const catalog = getAuthoredCatalog();
const metricIds = new Set(catalog.metrics.map((metric) => String(metric.id)));
const fieldById = new Map(catalog.fields.map((field) => [String(field.id), field]));

interface StudySchema {
  columns: ReadonlySet<string>;
}

async function createDatabase(): Promise<AsyncDuckDB> {
  const duckdb = await import('@duckdb/duckdb-wasm');
  // Angular copies these exact files from the pinned package. Keeping the
  // package's classic worker intact avoids Vite optimizing it as an ESM module.
  const wasmUrl = new URL('duckdb/duckdb-eh.wasm', document.baseURI).toString();
  const workerUrl = new URL('duckdb/duckdb-browser-eh.worker.js', document.baseURI).toString();
  const worker = new Worker(workerUrl);
  const database = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await database.instantiate(wasmUrl);
  return database;
}

function projection(column: string): string {
  const identifier = quoteIdent(column);
  if (metricIds.has(column)) return `try_cast(${identifier} AS DOUBLE) AS ${identifier}`;
  const field = fieldById.get(column);
  if (field?.kind === 'numeric') return `try_cast(${identifier} AS DOUBLE) AS ${identifier}`;
  if (field?.kind === 'date') return `try_cast(${identifier} AS TIMESTAMP) AS ${identifier}`;
  return `CAST(${identifier} AS VARCHAR) AS ${identifier}`;
}

function arrowRows(table: Awaited<ReturnType<AsyncDuckDBConnection['query']>>): StudyRow[] {
  const names = table.schema.fields.map((field) => field.name);
  return table.toArray().map((source) => {
    const values = source as unknown as Readonly<Record<string, unknown>>;
    return Object.fromEntries(names.map((name) => [name, values[name]]));
  });
}

async function execute(
  connection: AsyncDuckDBConnection,
  bound: BoundStatement,
): Promise<StudyRow[]> {
  const statement = await connection.prepare(bound.sql);
  try {
    return arrowRows(await statement.query(...bound.params));
  } finally {
    await statement.close();
  }
}

/** Browser-local implementation of the study half of the API seam. */
@Injectable({ providedIn: 'root' })
export class StudyRunner implements StudyApi {
  timeSummary(query: TimeSummaryQuery): Observable<TimeSummaryResult> {
    return defer(() => from(this.runTimeSummary(query)));
  }

  private async runTimeSummary(query: TimeSummaryQuery): Promise<TimeSummaryResult> {
    const { database, schema } = this.loaded();
    const { compileStudyTimeSummary, shapeTimeSummary } = await import('./study-time-summary');
    const plan = compileStudyTimeSummary(query, schema.columns);
    const connection = await database.connect();
    try { return shapeTimeSummary(await execute(connection, plan)); }
    finally { await connection.close(); }
  }

  density2d(query: StudyDensity2dQuery): Observable<Density2dResult> {
    return defer(() => from(this.runDensity2d(query)));
  }

  correlation(query: StudyCorrelationQuery): Observable<CorrelationResult> {
    return defer(() => from(this.runCorrelation(query)));
  }

  private async runDensity2d(query: StudyDensity2dQuery): Promise<Density2dResult> {
    const { database, schema } = this.loaded();
    const { compileStudyDensity2d, shapeDensity2d } = await import('./study-analysis');
    const plan = compileStudyDensity2d(query, schema.columns);
    const connection = await database.connect();
    try {
      const stats = (await execute(connection, plan.stats))[0];
      const range = plan.range(stats);
      const rows = await execute(connection, plan.histogram(range));
      const points = query.sampleSize === 0 ? [] : await execute(connection, plan.sample(range));
      return shapeDensity2d(query, stats, rows, points, range);
    } finally { await connection.close(); }
  }

  private async runCorrelation(query: StudyCorrelationQuery): Promise<CorrelationResult> {
    const { database, schema } = this.loaded();
    const { compileStudyCorrelation, shapeCorrelation } = await import('./study-analysis');
    const plan = compileStudyCorrelation(query, schema.columns);
    const connection = await database.connect();
    try { return shapeCorrelation(query, (await execute(connection, plan))[0]); }
    finally { await connection.close(); }
  }

  // Raw bytes and parsed rows are deliberately local to loadFile. Once it
  // resolves, this service retains only DuckDB and its uploaded-column schema.
  private database: AsyncDuckDB | null = null;
  private schema: StudySchema | null = null;
  private generation = 0;

  load(file: File): Observable<StudyLoadResult> {
    return defer(() => from(this.loadFile(file)));
  }

  clear(): void {
    this.generation += 1;
    this.schema = null;
    const database = this.database;
    this.database = null;
    if (database !== null) void database.terminate().catch(() => undefined);
  }

  distribution(query: StudyDistributionQuery): Observable<DistributionResult> {
    return defer(() => from(this.runDistribution(query)));
  }

  groupedSummary(query: StudyGroupedSummaryQuery): Observable<GroupedSummaryResult> {
    return defer(() => from(this.runGroupedSummary(query)));
  }

  private async loadFile(file: File): Promise<StudyLoadResult> {
    const generation = ++this.generation;
    const previous = this.database;
    this.database = null;
    this.schema = null;
    if (previous !== null) await previous.terminate();

    const { parseStudyFile } = await import('./study-parser');
    const parsed = await parseStudyFile(file);
    const database = await createDatabase();
    const path = `study-${generation}.json`;
    const connection = await database.connect();
    try {
      await database.registerFileText(path, JSON.stringify(parsed.rows));
      await connection.insertJSONFromPath(path, { schema: 'main', name: 'study_ingest' });
      const select = parsed.columns.map(projection).join(', ');
      await connection.query(
        `CREATE TABLE ${quoteIdent('study')} AS SELECT ${select} FROM ${quoteIdent('study_ingest')}`,
      );
      await connection.query(`DROP TABLE ${quoteIdent('study_ingest')}`);
    } catch (error) {
      await database.terminate();
      throw error;
    } finally {
      await database.dropFile(path).catch(() => null);
      await connection.close().catch(() => undefined);
    }

    if (generation !== this.generation) {
      await database.terminate();
      throw new Error('Study load was replaced by a newer file');
    }
    this.database = database;
    this.schema = { columns: new Set(parsed.columns) };
    return this.metadata(file.name, parsed);
  }

  private metadata(name: string, parsed: ParsedStudy): StudyLoadResult {
    return {
      name,
      rows: parsed.rows.length,
      metrics: parsed.metrics,
      totalMetrics: parsed.totalMetrics,
      ignoredColumns: parsed.ignoredColumns,
      missingMetrics: parsed.missingMetrics,
    };
  }

  private loaded(): { database: AsyncDuckDB; schema: StudySchema } {
    if (this.database === null || this.schema === null) throw new Error('No study is loaded');
    return { database: this.database, schema: this.schema };
  }

  private async runDistribution(query: StudyDistributionQuery): Promise<DistributionResult> {
    if (!Number.isInteger(query.bins) || query.bins < 1 || query.bins > 200) {
      throw new Error('Histogram bins must be an integer from 1 to 200');
    }
    if (
      query.range !== undefined &&
      (!Number.isFinite(query.range[0]) ||
        !Number.isFinite(query.range[1]) ||
        !(query.range[1] > query.range[0]))
    ) {
      throw new Error('Histogram range needs two finite increasing bounds');
    }
    const { database, schema } = this.loaded();
    const {
      compileStudyDistribution,
      shapeDistributionResult,
      shapeMetricSummary,
      studyHistogramRange,
    } = await import('./study-sql');
    const plan = compileStudyDistribution(query, schema.columns);
    const connection = await database.connect();
    try {
      const summary = shapeMetricSummary((await execute(connection, plan.stats))[0]);
      const ranged = query.range !== undefined;
      const [lo, hi] = query.range ?? studyHistogramRange(summary, query.clip);
      const binRows =
        summary.n === 0 || (!ranged && !(hi > lo))
          ? []
          : await execute(connection, plan.histogram(lo, hi, query.bins, ranged));
      return shapeDistributionResult(summary, binRows, query.bins, lo, hi, ranged);
    } finally {
      await connection.close();
    }
  }

  private async runGroupedSummary(query: StudyGroupedSummaryQuery): Promise<GroupedSummaryResult> {
    const { database, schema } = this.loaded();
    const {
      STUDY_GROUPED_HISTOGRAM_BINS,
      STUDY_NUMERIC_GROUP_BINS,
      compileStudyGroupedSummary,
      shapeGroupedSummaryResult,
    } = await import('./study-sql');
    const plan = compileStudyGroupedSummary(query, schema.columns);
    const connection = await database.connect();
    try {
      let bounds: { lo: number; width: number } | null = null;
      if (plan.groupRange !== null) {
        const row = (await execute(connection, plan.groupRange))[0];
        const lo = row?.['lo'] === null || row?.['lo'] === undefined ? null : Number(row['lo']);
        const hi = row?.['hi'] === null || row?.['hi'] === undefined ? null : Number(row['hi']);
        if (lo !== null && hi !== null && Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) {
          bounds = { lo, width: (hi - lo) / STUDY_NUMERIC_GROUP_BINS };
        }
      }
      const statements = plan.statements(bounds);
      const statRows = await execute(connection, statements.stats);
      if (statRows.length === 0) return { groups: [] };
      const lo = Math.min(...statRows.map((row) => Number(row['min'])));
      const hi = Math.max(...statRows.map((row) => Number(row['max'])));
      const histogramRows =
        hi > lo
          ? await execute(connection, statements.histogram(lo, hi, STUDY_GROUPED_HISTOGRAM_BINS))
          : [];
      return shapeGroupedSummaryResult(
        statRows,
        histogramRows,
        statements.group,
        lo,
        hi,
        STUDY_GROUPED_HISTOGRAM_BINS,
      );
    } finally {
      await connection.close();
    }
  }
}
