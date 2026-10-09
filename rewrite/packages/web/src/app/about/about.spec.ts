import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { firstValueFrom } from 'rxjs';
import { API } from '../api/api';
import { MockApi, MOCK_LATENCY_MS } from '../api/mock-api';
import { APP_ROUTES, WEB_ICONS } from '../app.config';
import { About } from './about';
import { catalogCount } from './about-view';

describe('About route', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/about');
    TestBed.configureTestingModule({
      imports: [WEB_ICONS],
      providers: [provideRouter(APP_ROUTES), MockApi, { provide: API, useExisting: MockApi }],
    });
  });
  it('renders the real route, all anchors, runtime catalog totals and provenance', async () => {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/about#dedup', About);
    await new Promise((resolve) => setTimeout(resolve, MOCK_LATENCY_MS * 4));
    harness.detectChanges();
    const host = harness.routeNativeElement!;
    for (const id of ['dedup', 'stability', 'views'])
      expect(host.querySelector(`#${id}`)).not.toBeNull();
    const catalog = await firstValueFrom(TestBed.inject(MockApi).catalog());
    const table = host.querySelector('[data-testid="about-population"]')!;
    for (const modality of ['bold', 'T1w', 'T2w'] as const) {
      expect(table.textContent).toContain(
        catalogCount(catalog, modality, 'raw')!.toLocaleString('en-US'),
      );
    }
    expect(host.textContent).toContain('Uploads through 30 Jun 2025');
    expect(host.querySelector('[data-testid="about-version"]')?.textContent).toContain(
      catalog.dataVersion,
    );
    expect(
      host.querySelector<HTMLAnchorElement>('[data-testid="about-back"]')?.getAttribute('href'),
    ).toContain('/?s=');
  });
  it('does not call a capped catalog list a population total', async () => {
    const catalog = await firstValueFrom(TestBed.inject(MockApi).catalog());
    catalog.fieldValues['magnetic_field_strength'] = {
      bold: { raw: Array.from({ length: 200 }, (_, value) => ({ value, n: 1 })) },
    };
    expect(catalogCount(catalog, 'bold', 'raw')).toBeNull();
    expect(catalogCount(catalog, 'T1w', 'raw')).toBeNull();
  });
});
