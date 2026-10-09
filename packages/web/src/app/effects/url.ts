import { ActivatedRoute, Router } from '@angular/router';
import { concat, Observable, of } from 'rxjs';
import { distinctUntilChanged, filter, map, tap } from 'rxjs/operators';

import { type Command } from '../slices/commands';
import { urlSyncMode } from '../slices/history/history';
import { defaultDashboard } from '../slices/panels/defaults';
import { decodeUrlState } from '../url/url';

export const URL_PARAM = 's';

export function paramFromLocation(): string | null {
  try {
    return typeof window === 'undefined'
      ? null
      : new URLSearchParams(window.location.search).get(URL_PARAM);
  } catch {
    return null;
  }
}

export class UrlSync {
  private lastUrlParam: string | null | undefined = undefined;
  private hydrated = false;
  private firstSyncAfterHydrate = true;

  readonly hydrate$: Observable<Command>;

  constructor(private readonly router: Router, private readonly route: ActivatedRoute) {
    this.hydrate$ = concat(
    of(paramFromLocation()),
    this.route.queryParamMap.pipe(
      filter(() => this.router.navigated),
      map((params) => params.get(URL_PARAM)),
    ),
  ).pipe(
    distinctUntilChanged(),
    filter((param) => (param ?? '') !== this.lastUrlParam),
    tap(() => {
      this.hydrated = true;
      this.firstSyncAfterHydrate = true;
    }),
    map((param) => {
      const decoded = decodeUrlState(param);
      return {
        t: 'hydrate',
        url: decoded ?? defaultDashboard(),
        ...(param && !decoded
          ? {
              notice:
                'This dashboard URL could not be read. Showing the default dashboard.',
            }
          : {}),
      } as Command;
    }),
  );

  }

  sync(param: string): void {
    if (!this.hydrated || this.lastUrlParam === param) {
      return;
    }

    const mode = urlSyncMode(
      this.firstSyncAfterHydrate,
      param,
      paramFromLocation(),
    );
    this.firstSyncAfterHydrate = false;
    this.lastUrlParam = param;

    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { [URL_PARAM]: param || null },
      queryParamsHandling: 'merge',
      replaceUrl: mode === 'replace',
    });
  }
}
