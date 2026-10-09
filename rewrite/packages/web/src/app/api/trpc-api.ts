import { normalizeSelections, type TimeSummaryQuery, type TimeSummaryResult } from '@mriqc/shared';
/**
 * The real `Api`, against `@mriqc/server`'s tRPC router.
 *
 * `AppRouter` is a type-only import, so nothing of the server's runtime (DuckDB,
 * `node:http`) is bundled: the whole server package contributes exactly one
 * `.d.ts` to the browser build. It does have to be *built* first, which
 * `pnpm -r build` already orders (shared -> server -> web).
 *
 * Two links, split by operation type (`docs/backend-graph.md`, "Procedures"):
 * `dataVersion` is a subscription and rides `httpSubscriptionLink` over SSE;
 * every query goes through `httpBatchLink`, so the five panels of a fresh
 * dashboard cost one request. Both point at `/trpc`, which `ng serve` proxies to
 * the API and which the server itself serves in production -- the browser only
 * ever talks to its own origin.
 *
 * Each method translates one variant of the shared `Query` union into the exact
 * object the matching zod schema parses. Nothing else here knows about tRPC.
 */

import { Injectable } from '@angular/core';
import {
  createTRPCClient,
  httpBatchLink,
  httpSubscriptionLink,
  splitLink,
  type TRPCClient,
} from '@trpc/client';
import { Observable } from 'rxjs';
import { distinctUntilChanged, shareReplay } from 'rxjs/operators';
import type { AppRouter } from '@mriqc/server';
import type {
  CompletedCatalog,
  CoverageResult,
  Density2dResult,
  CorrelationResult,
  DistributionResult,
  Filter,
  FilterValue,
  GroupedSummaryResult,
  Modality,
  SampleResult,
  Selection,
  View,
} from '@mriqc/shared';
import type { Api, CoverageQuery, DistributionQuery, GroupedSummaryQuery, SampleQuery, Density2dQuery, CorrelationQuery } from './api';

/** Where the procedures live. Same origin, so `ng serve`'s proxy is the only hop. */
export const TRPC_URL = '/trpc';

/* ------------------------------------------------------------ wire shaping */

/**
 * The filter shape `filterSchema` parses. Identical to the shared `Filter`
 * except that zod produces mutable arrays, so the readonly value list has to be
 * copied rather than passed through.
 */
type WireFilter =
  | { field: string; op: 'in'; values: FilterValue[] }
  | { field: string; op: 'between'; lo: number | string; hi: number | string }
  | { field: string; op: 'isNull' }
  | { field: string; op: 'notNull' };

function wireFilter(filter: Filter): WireFilter {
  switch (filter.op) {
    case 'in':
      return { field: filter.field, op: 'in', values: [...filter.values] };
    case 'between':
      return { field: filter.field, op: 'between', lo: filter.lo, hi: filter.hi };
    case 'isNull':
      return { field: filter.field, op: 'isNull' };
    default:
      return { field: filter.field, op: 'notNull' };
  }
}

/** The four parameters `scopedShape` declares, in the shape it parses. */
interface WireScope {
  modality: Modality;
  view: View;
  filters: WireFilter[];
  selections: { metric: string; range: [number, number] }[];
}

function scope(query: {
  modality: Modality;
  view: View;
  filters: readonly Filter[];
  selection?: Selection | null;
  selections?: readonly Selection[];
}): WireScope {
  return {
    modality: query.modality,
    view: query.view,
    filters: query.filters.map(wireFilter),
    selections: normalizeSelections(query).map(selection => ({ metric: selection.metric, range: [selection.range[0], selection.range[1]] })),
  };
}

/* --------------------------------------------------------------- lifecycle */

/**
 * One tRPC query as an observable whose unsubscription actually cancels it.
 *
 * `from(promise)` would only stop the subscriber from seeing the result: the
 * request stays in the batch and the server keeps the DuckDB connection busy
 * answering a question nobody is waiting for. The runner cancels a key the
 * moment it leaves the needed set -- every modality switch and every brush step
 * does that -- so the signal is what makes cancellation mean anything.
 */
export function abortable<T>(run: (signal: AbortSignal) => Promise<T>): Observable<T> {
  return new Observable<T>((subscriber) => {
    const controller = new AbortController();
    run(controller.signal).then(
      (value) => {
        subscriber.next(value);
        subscriber.complete();
      },
      (error: unknown) => {
        // An abort is the caller's own doing, not a failure to report.
        if (!controller.signal.aborted) subscriber.error(error);
      },
    );
    return () => controller.abort();
  });
}

/* ------------------------------------------------------------------ client */

function createClient(): TRPCClient<AppRouter> {
  return createTRPCClient<AppRouter>({
    links: [
      splitLink({
        condition: (op) => op.type === 'subscription',
        true: httpSubscriptionLink({ url: TRPC_URL }),
        false: httpBatchLink({ url: TRPC_URL }),
      }),
    ],
  });
}

/** An `Api` that answers from the DuckDB server. */
@Injectable()
export class TrpcApi implements Api {
  private readonly client = createClient();

  /**
   * One SSE connection for the whole application. The server yields the current
   * version before it starts waiting for changes, so this emits immediately on
   * connect; `distinctUntilChanged` absorbs the repeat a reconnect would bring.
   */
  private readonly version$ = new Observable<string>((subscriber) => {
    const subscription = this.client.dataVersion.subscribe(undefined, {
      onData: (version: string) => subscriber.next(version),
      onError: (error: unknown) => subscriber.error(error),
      onComplete: () => subscriber.complete(),
    });
    return () => subscription.unsubscribe();
  }).pipe(distinctUntilChanged(), shareReplay({ bufferSize: 1, refCount: true }));

  catalog(): Observable<CompletedCatalog> {
    return abortable((signal) => this.client.catalog.query(undefined, { signal }));
  }

  /**
   * `range` is forwarded only when the query carries one, so a plain
   * distribution panel sends exactly the input it always sent.
   *
   * It is not optional to get right: a comparison panel's whole claim is that
   * every cohort was binned over the same interval, and dropping the parameter
   * here left the server clipping each cohort to its own quantiles instead. The
   * two histograms then had different bin edges -- which is the one thing
   * overlaying them is supposed to rule out -- and the only visible sign was a
   * blank KS cell, because `sameGrid` refused to compare curves over different
   * grids.
   */
  distribution(query: DistributionQuery): Observable<DistributionResult> {
    const input = {
      ...scope(query),
      metric: query.metric,
      bins: query.bins,
      clip: query.clip,
      ...(query.range === undefined ? {} : { range: [query.range[0], query.range[1]] as [number, number] }),
    };
    return abortable((signal) => this.client.distribution.query(input, { signal }));
  }

  groupedSummary(query: GroupedSummaryQuery): Observable<GroupedSummaryResult> {
    return abortable((signal) =>
      this.client.groupedSummary.query(
        { ...scope(query), metric: query.metric, group: query.group },
        { signal },
      ),
    );
  }

  timeSummary(query: TimeSummaryQuery): Observable<TimeSummaryResult> {
    return abortable(signal => this.client.timeSummary.query({ ...scope(query), metric: query.metric,
      granularity: query.granularity, group: query.group, window: query.window }, { signal }));
  }

  coverage(query: CoverageQuery): Observable<CoverageResult> {
    return abortable((signal) =>
      this.client.coverage.query(
        { ...scope(query), group: query.group, granularity: query.granularity },
        { signal },
      ),
    );
  }

  sample(query: SampleQuery): Observable<SampleResult> {
    return abortable((signal) =>
      this.client.sample.query(
        { ...scope(query), columns: [...query.columns], cursor: query.cursor },
        { signal },
      ),
    );
  }

  dataVersion(): Observable<string> {
    return this.version$;
  }

  density2d(query: Density2dQuery): Observable<Density2dResult> {
    return abortable((signal) => this.client.density2d.query({
      ...scope(query), x: query.x, y: query.y, bins: query.bins,
      clip: query.clip, range: query.range, sampleSize: query.sampleSize, seed: query.seed,
    }, { signal }));
  }

  correlation(query: CorrelationQuery): Observable<CorrelationResult> {
    return abortable((signal) => this.client.correlation.query({
      ...scope(query), metrics: [...query.metrics], method: query.method,
    }, { signal }));
  }
}
