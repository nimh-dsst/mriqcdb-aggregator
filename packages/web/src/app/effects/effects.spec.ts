import { queryKey } from '../api/api';
import { EMPTY, Observable, Subject, of, throwError } from 'rxjs';
import {
  asColumnId,
  type DistributionResult,
  type GroupedSummaryResult,
  type Query,
  type QueryKey,
} from '@mriqc/shared';
import type {
  Api,
  CoverageQuery,
  DistributionQuery,
  GroupedSummaryQuery,
  SampleQuery,
  StudyApi,
  StudyDistributionQuery,
  StudyGroupedSummaryQuery,
} from '../api/api';
import type { Command } from '../slices/commands';
import { runEffects, type NeededEmission } from './queries';

/** Records what was subscribed, lets a test resolve or fail each call by hand. */
class FakeApi implements Api {
  binnedSummary(query: import('@mriqc/shared').BinnedSummaryQuery): Observable<never> {
    return this.track(queryKey(query)) as Observable<never>;
  }
  readonly started: QueryKey[] = [];
  readonly cancelled: QueryKey[] = [];
  readonly versions = new Subject<string>();
  private readonly pending = new Map<QueryKey, (value: unknown) => void>();
  failures = new Set<QueryKey>();

  catalog(): Observable<never> {
    return this.track('population/catalog') as Observable<never>;
  }
  distribution(query: DistributionQuery): Observable<never> {
    return this.track(queryKey(query)) as Observable<never>;
  }
  groupedSummary(query: GroupedSummaryQuery): Observable<never> {
    return this.track(queryKey(query)) as Observable<never>;
  }
  coverage(query: CoverageQuery): Observable<never> {
    return this.track(queryKey(query)) as Observable<never>;
  }
  sample(query: SampleQuery): Observable<never> {
    return this.track(queryKey(query)) as Observable<never>;
  }
  density2d(query: Extract<Query, { proc: 'density2d' }>): Observable<never> {
    return this.track(queryKey(query)) as Observable<never>;
  }
  correlation(query: Extract<Query, { proc: 'correlation' }>): Observable<never> {
    return this.track(queryKey(query)) as Observable<never>;
  }
  dataVersion(): Observable<string> {
    return this.versions.asObservable();
  }

  /** Deliver the result of an in-flight call. */
  resolve(key: QueryKey, value: unknown): void {
    this.pending.get(key)?.(value);
  }

  private track(key: QueryKey): Observable<unknown> {
    if (this.failures.has(key)) return throwError(() => new Error(`failed: ${key}`));
    return new Observable<unknown>((subscriber) => {
      this.started.push(key);
      let settled = false;
      this.pending.set(key, (value) => {
        settled = true;
        subscriber.next(value);
        subscriber.complete();
      });
      return () => {
        if (!settled) this.cancelled.push(key);
        this.pending.delete(key);
      };
    });
  }
}

class FakeStudyApi implements StudyApi {
  coverage(query: import('../api/api').StudyCoverageQuery) { this.started.push(queryKey(query)); return EMPTY; }
  sample(query: import('../api/api').StudySampleQuery) { this.started.push(queryKey(query)); return EMPTY; }
  binnedSummary(query: import('@mriqc/shared').BinnedSummaryQuery): Observable<never> {
    this.started.push(queryKey(query)); return EMPTY;
  }
  readonly started: QueryKey[] = [];
  density2d(query: Extract<Query, { proc: 'density2d' }>): Observable<never> {
    this.started.push(queryKey(query)); return EMPTY;
  }
  correlation(query: Extract<Query, { proc: 'correlation' }>): Observable<never> {
    this.started.push(queryKey(query)); return EMPTY;
  }
  load(): Observable<never> {
    return EMPTY;
  }
  clear(): void {}
  distribution(query: StudyDistributionQuery): Observable<DistributionResult> {
    this.started.push(queryKey(query));
    return of({
      n: 1,
      min: 1,
      max: 1,
      mean: 1,
      stddev: 0,
      quantiles: { p01: 1, p05: 1, p25: 1, p50: 1, p75: 1, p95: 1, p99: 1 },
      histogram: { lo: 1, hi: 1, width: 0, counts: [1] },
    });
  }
  groupedSummary(query: StudyGroupedSummaryQuery): Observable<GroupedSummaryResult> {
    this.started.push(queryKey(query));
    return of({ groups: [] });
  }
}

function distributionQuery(metric: string): DistributionQuery {
  return {
    source: 'population',
    proc: 'distribution',
    modality: 'bold',
    view: 'raw',
    filters: [],
    selections: [],
    metric: asColumnId(metric),
    bins: 40,
    clip: 'p01p99',
  };
}

function emission(version: string | null, ...queries: Query[]): NeededEmission {
  return { version, queries: new Map(queries.map((query) => [queryKey(query), query])) };
}

describe('runEffects', () => {
  let api: FakeApi;
  let needed$: Subject<NeededEmission>;
  let studyApi: FakeStudyApi;
  let commands: Command[];
  let subscription: { unsubscribe(): void };

  beforeEach(() => {
    api = new FakeApi();
    needed$ = new Subject<NeededEmission>();
    studyApi = new FakeStudyApi();
    commands = [];
    subscription = runEffects(needed$, api, studyApi).subscribe((command) =>
      commands.push(command),
    );
  });

  afterEach(() => subscription.unsubscribe());

  it('turns the data-version subscription into commands', () => {
    api.versions.next('v1');
    expect(commands).toEqual([{ t: 'dataVersionChanged', version: 'v1' }]);
  });

  it('fetches nothing until the data version is known', () => {
    needed$.next(emission(null, distributionQuery('fd_mean')));
    expect(api.started).toEqual([]);
  });

  it('starts one fetch per key that appears', () => {
    const fd = distributionQuery('fd_mean');
    const tsnr = distributionQuery('tsnr');
    needed$.next(emission('v1', fd));
    expect(api.started).toEqual([queryKey(fd)]);
    needed$.next(emission('v1', fd, tsnr));
    expect(api.started).toEqual([queryKey(fd), queryKey(tsnr)]);
  });

  it('does not restart a key that stays in the set', () => {
    const fd = distributionQuery('fd_mean');
    needed$.next(emission('v1', fd));
    needed$.next(emission('v1', fd));
    needed$.next(emission('v1', fd));
    expect(api.started).toHaveLength(1);
  });

  it('feeds a result back as dataArrived, tagged with the version it was fetched at', () => {
    const fd = distributionQuery('fd_mean');
    needed$.next(emission('v1', fd));
    api.resolve(queryKey(fd), { n: 7 });
    expect(commands).toEqual([
      { t: 'dataArrived', key: queryKey(fd), result: { n: 7 }, version: 'v1' },
    ]);
  });

  it('cancels a fetch whose key left the set', () => {
    const fd = distributionQuery('fd_mean');
    needed$.next(emission('v1', fd));
    needed$.next(emission('v1'));
    expect(api.cancelled).toEqual([queryKey(fd)]);
    expect(commands).toEqual([]);
  });

  it('restarts a key that comes back after being cancelled', () => {
    const fd = distributionQuery('fd_mean');
    needed$.next(emission('v1', fd));
    needed$.next(emission('v1'));
    needed$.next(emission('v1', fd));
    expect(api.started).toHaveLength(2);
  });

  it('turns a rejection into dataFailed and keeps running', () => {
    const fd = distributionQuery('fd_mean');
    const tsnr = distributionQuery('tsnr');
    api.failures.add(queryKey(fd));
    needed$.next(emission('v1', fd));
    expect(commands).toEqual([
      { t: 'dataFailed', key: queryKey(fd), error: `failed: ${queryKey(fd)}` },
    ]);
    needed$.next(emission('v1', fd, tsnr));
    api.resolve(queryKey(tsnr), 1);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toMatchObject({ t: 'dataArrived', key: queryKey(tsnr) });
  });

  it('refetches the on-screen keys after a version change', () => {
    const fd = distributionQuery('fd_mean');
    needed$.next(emission('v1', fd));
    api.resolve(queryKey(fd), 1);
    // The reducer's entry is now stale, so the key reappears at the new version.
    needed$.next(emission('v2'));
    needed$.next(emission('v2', fd));
    expect(api.started).toEqual([queryKey(fd), queryKey(fd)]);
    api.resolve(queryKey(fd), 2);
    expect(commands.at(-1)).toEqual({
      t: 'dataArrived',
      key: queryKey(fd),
      result: 2,
      version: 'v2',
    });
  });

  it('refetches a key that was still in flight when the version changed', () => {
    const fd = distributionQuery('fd_mean');
    needed$.next(emission('v1', fd));
    expect(api.started).toHaveLength(1);
    // The ingest version moves while the v1 call is outstanding. The key never
    // leaves the needed set, so only a (key, version) diff can notice.
    needed$.next(emission('v2', fd));
    expect(api.started).toEqual([queryKey(fd), queryKey(fd)]);
    expect(api.cancelled).toEqual([queryKey(fd)]);
    api.resolve(queryKey(fd), 'late');
    expect(commands.some((c) => c.t === 'dataArrived' && c.version === 'v1')).toBe(false);
  });

  it('keeps fetching after the version subscription errors', () => {
    api.versions.next('v1');
    api.versions.error(new Error('sse connection dropped'));
    const fd = distributionQuery('fd_mean');
    needed$.next(emission('v1', fd));
    expect(api.started).toEqual([queryKey(fd)]);
    api.resolve(queryKey(fd), 1);
    expect(commands.at(-1)).toMatchObject({ t: 'dataArrived', key: queryKey(fd) });
  });

  it('dispatches every procedure to its own method', () => {
    const queries: Query[] = [
      { source: 'population', proc: 'catalog' },
      distributionQuery('fd_mean'),
      {
        source: 'population',
        proc: 'groupedSummary',
        modality: 'bold',
        view: 'raw',
        filters: [],
        selections: [],
        metric: asColumnId('fd_mean'),
        group: asColumnId('manufacturer'),
      },
      {
        source: 'population',
        proc: 'coverage',
        modality: 'bold',
        view: 'raw',
        filters: [],
        selections: [],
        group: asColumnId('manufacturer'),
        granularity: 'month',
      },
      {
        source: 'population',
        proc: 'sample',
        modality: 'bold',
        view: 'raw',
        filters: [],
        selections: [],
        columns: [asColumnId('id')],
        cursor: null,
      },
    ];
    needed$.next(emission('v1', ...queries));
    expect(api.started).toEqual(queries.map(queryKey));
  });

  it('routes study queries only to the local runner', () => {
    const query: Query = { ...distributionQuery('fd_mean'), source: 'study' };
    needed$.next(emission('v1', query));
    expect(api.started).toEqual([]);
    expect(studyApi.started).toEqual([queryKey(query)]);
    expect(commands.at(-1)).toMatchObject({ t: 'dataArrived', key: queryKey(query) });
  });
});
