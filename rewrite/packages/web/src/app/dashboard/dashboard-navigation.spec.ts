import { TestBed } from '@angular/core/testing';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { APP_ROUTES } from '../app.config';
import { Graph } from '../graph/graph';
import { defaultDashboard, initialState } from '../graph/reducer';
import { encodeUrlState } from '../graph/url';
import { Dashboard } from './dashboard';

describe('Dashboard query-only navigation', () => {
  afterEach(() => window.history.replaceState({}, '', '/'));

  it('reuses the Dashboard instance and host for a changed s parameter', async () => {
    const initial = defaultDashboard();
    const firstUrl = `/?s=${encodeURIComponent(encodeUrlState(initial))}`;
    const changedUrl = `/?s=${encodeURIComponent(encodeUrlState({
      ...initial,
      panels: initial.panels.map((panel, index) => index === 0 ? { ...panel, form: 'ecdf' } : panel),
    }))}`;
    window.history.replaceState({}, '', firstUrl);
    TestBed.configureTestingModule({
      providers: [
        provideRouter(APP_ROUTES),
        { provide: Graph, useValue: {
          panels$: of([]), chrome$: of(undefined), state$: of(initialState),
        } },
      ],
    });
    // Exercise the real component and production routes without rendering Vega.
    TestBed.overrideComponent(Dashboard, { set: { template: '', imports: [] } });
    const harness = await RouterTestingHarness.create();
    const dashboard = await harness.navigateByUrl(firstUrl, Dashboard);
    const host = harness.routeNativeElement;

    expect(changedUrl).not.toBe(firstUrl);
    expect(await harness.navigateByUrl(changedUrl, Dashboard)).toBe(dashboard);
    expect(harness.routeNativeElement).toBe(host);
    expect(await harness.navigateByUrl(firstUrl, Dashboard)).toBe(dashboard);
    expect(harness.routeNativeElement).toBe(host);
  });
});
