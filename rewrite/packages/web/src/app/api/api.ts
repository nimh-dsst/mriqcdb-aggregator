import type { Query as SharedQuery, TimeSummaryQuery, TimeSummaryResult } from '@mriqc/shared';
export type Query = SharedQuery | TimeSummaryQuery;
export type StudyTimeSummaryQuery = TimeSummaryQuery & { source: 'study' };
/**
 * The one seam between the command loop and the outside world.
 *
 * The effects runner talks to this interface and nothing else, so the same
 * graph runs against the mock, against tRPC, and against a fake in tests. Every
 * parameter and result type comes from `@mriqc/shared`; nothing is redeclared.
 */

import { InjectionToken } from '@angular/core';
import { Observable } from 'rxjs';
import type {
  ColumnId,
  CompletedCatalog,
  CoverageResult,
  Density2dResult,
  CorrelationResult,
  DistributionResult,
  GroupedSummaryResult,
  SampleResult,
} from '@mriqc/shared';

/** The parameters of each procedure, taken straight off the shared query union. */
export type DistributionQuery = Extract<Query, { proc: 'distribution' }>;
export type GroupedSummaryQuery = Extract<Query, { proc: 'groupedSummary' }>;
export type CoverageQuery = Extract<Query, { proc: 'coverage' }>;
export type SampleQuery = Extract<Query, { proc: 'sample' }>;
export type Density2dQuery = Extract<Query, { proc: 'density2d' }>;
export type CorrelationQuery = Extract<Query, { proc: 'correlation' }>;
export type StudyDensity2dQuery = Density2dQuery & { source: 'study' };
export type StudyCorrelationQuery = CorrelationQuery & { source: 'study' };
export type StudyDistributionQuery = DistributionQuery & { source: 'study' };
export type StudyGroupedSummaryQuery = GroupedSummaryQuery & { source: 'study' };

/** Metadata retained in graph state after rows have been loaded into DuckDB-WASM. */
export interface StudyLoadResult {
  name: string;
  rows: number;
  metrics: readonly ColumnId[];
  totalMetrics: number;
  ignoredColumns: readonly string[];
  missingMetrics: readonly ColumnId[];
}

/** The local half of the query seam; implemented by the browser study runner. */
export interface StudyApi {
  load(file: File): Observable<StudyLoadResult>;
  clear(): void;
  distribution(query: StudyDistributionQuery): Observable<DistributionResult>;
  groupedSummary(query: StudyGroupedSummaryQuery): Observable<GroupedSummaryResult>;
  density2d(query: StudyDensity2dQuery): Observable<Density2dResult>;
  correlation(query: StudyCorrelationQuery): Observable<CorrelationResult>;
  timeSummary(query: StudyTimeSummaryQuery): Observable<TimeSummaryResult>;
}

/** Everything the dashboard can ask for. One method per tRPC procedure. */
export interface Api {
  catalog(): Observable<CompletedCatalog>;
  distribution(query: DistributionQuery): Observable<DistributionResult>;
  groupedSummary(query: GroupedSummaryQuery): Observable<GroupedSummaryResult>;
  coverage(query: CoverageQuery): Observable<CoverageResult>;
  sample(query: SampleQuery): Observable<SampleResult>;
  density2d(query: Density2dQuery): Observable<Density2dResult>;
  correlation(query: CorrelationQuery): Observable<CorrelationResult>;
  timeSummary(query: TimeSummaryQuery): Observable<TimeSummaryResult>;
  /** Emits the ingest version on connect and on every change. Never completes. */
  dataVersion(): Observable<string>;
}

/** The token the runner injects. `app.config.ts` picks the implementation. */
export const API = new InjectionToken<Api>('mriqc.Api');

/** Dispatch one query to the method that serves it. */
export function runQuery(api: Api, query: Query, studyApi?: StudyApi): Observable<unknown> {
  if (query.source === 'study') {
    if (studyApi === undefined) {
      return new Observable((subscriber) => subscriber.error(new Error('No study is loaded')));
    }
    switch (query.proc) {
      case 'timeSummary': return studyApi.timeSummary(query as StudyTimeSummaryQuery);
      case 'distribution': return studyApi.distribution(query as StudyDistributionQuery);
      case 'groupedSummary': return studyApi.groupedSummary(query as StudyGroupedSummaryQuery);
      case 'density2d': return studyApi.density2d(query as StudyDensity2dQuery);
      case 'correlation': return studyApi.correlation(query as StudyCorrelationQuery);
    }
  }
  switch (query.proc) {
    case 'timeSummary': return api.timeSummary(query);
    case 'catalog':
      return api.catalog();
    case 'distribution':
      return api.distribution(query);
    case 'groupedSummary':
      return api.groupedSummary(query);
    case 'coverage':
      return api.coverage(query);
    case 'sample':
      return api.sample(query);
    case 'density2d':
      return api.density2d(query);
    case 'correlation':
      return api.correlation(query);
  }
}
