import { queryKey as sharedQueryKey, type Query as SharedQuery, type BinnedSummaryQuery, type BinnedSummaryResult } from '@mriqc/shared';
export type StudyCoverageQuery = Omit<Extract<SharedQuery, { proc: 'coverage' }>, 'source'> & { source: 'study'; countsOnly?: boolean };
export type StudySampleQuery = Omit<Extract<SharedQuery, { proc: 'sample' }>, 'source'> & { source: 'study' };
export type Query = SharedQuery | StudyCoverageQuery | StudySampleQuery;
/** Local procedures use the shared key grammar without extending the server API. */
export function queryKey(query: Query): string {
  if (query.source === 'study' && (query.proc === 'coverage' || query.proc === 'sample')) {
    const key = sharedQueryKey({ ...query, source: 'population' }).replace(/^population\//, 'study/');
    return query.proc === 'coverage' && query.countsOnly ? `${key}&countsOnly=true` : key;
  }
  return sharedQueryKey(query);
}
export type StudyBinnedSummaryQuery = BinnedSummaryQuery & { source: 'study' };
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
export type CoverageQuery = Extract<SharedQuery, { proc: 'coverage' }>;
export type SampleQuery = Extract<SharedQuery, { proc: 'sample' }>;
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
  columns?: readonly string[];
  columnMapping?: readonly { source: string; target: string }[];
}

/** The local half of the query seam; implemented by the browser study runner. */
export interface StudyApi {
  load(file: File): Observable<StudyLoadResult>;
  clear(): void;
  coverage(query: StudyCoverageQuery): Observable<CoverageResult>;
  sample(query: StudySampleQuery): Observable<SampleResult>;
  distribution(query: StudyDistributionQuery): Observable<DistributionResult>;
  groupedSummary(query: StudyGroupedSummaryQuery): Observable<GroupedSummaryResult>;
  density2d(query: StudyDensity2dQuery): Observable<Density2dResult>;
  correlation(query: StudyCorrelationQuery): Observable<CorrelationResult>;
  binnedSummary(query: StudyBinnedSummaryQuery): Observable<BinnedSummaryResult>;
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
  binnedSummary(query: BinnedSummaryQuery): Observable<BinnedSummaryResult>;
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
      case 'coverage': return studyApi.coverage(query);
      case 'sample': return studyApi.sample(query);
      case 'binnedSummary': return studyApi.binnedSummary(query as StudyBinnedSummaryQuery);
      case 'distribution': return studyApi.distribution(query as StudyDistributionQuery);
      case 'groupedSummary': return studyApi.groupedSummary(query as StudyGroupedSummaryQuery);
      case 'density2d': return studyApi.density2d(query as StudyDensity2dQuery);
      case 'correlation': return studyApi.correlation(query as StudyCorrelationQuery);
    }
  }
  switch (query.proc) {
    case 'binnedSummary': return api.binnedSummary(query);
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
