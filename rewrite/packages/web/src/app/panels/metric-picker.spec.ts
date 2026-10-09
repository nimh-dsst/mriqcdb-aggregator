import { TestBed } from '@angular/core/testing';
import { asColumnId, type MetricDef } from '@mriqc/shared';

import { MetricPicker } from './metric-picker';

const METRICS: MetricDef[] = [
  {
    id: asColumnId('fd_mean'),
    label: 'Mean fractional anisotropy',
    shortLabel: 'FA mean',
    family: 'Diffusion',
    subfamily: 'Tensor',
    modalities: ['bold'],
    clipDefault: 'p01p99',
    unit: 'ratio',
  },
  {
    id: asColumnId('fd_md'),
    label: 'Mean diffusivity',
    shortLabel: 'MD',
    family: 'Diffusion',
    subfamily: 'Tensor',
    modalities: ['bold'],
    clipDefault: 'p01p99',
    unit: 'mm²/s',
  },
  {
    id: asColumnId('bold_mean'),
    label: 'Mean BOLD signal',
    shortLabel: 'BOLD mean',
    family: 'Functional',
    subfamily: 'Signal',
    modalities: ['bold'],
    clipDefault: 'p01p99',
  },
  {
    id: asColumnId('t1_snr'),
    label: 'Structural signal to noise ratio',
    family: 'Structural',
    modalities: ['T1w'],
    clipDefault: 'p01p99',
  },
];

describe('MetricPicker', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [MetricPicker] });
  });

  function createPicker(
    metrics: readonly MetricDef[] = METRICS,
    disabledMetrics: readonly string[] = [],
    selected: string | null = null,
  ) {
    const fixture = TestBed.createComponent(MetricPicker);
    fixture.componentRef.setInput('metrics', metrics);
    fixture.componentRef.setInput('disabledMetrics', disabledMetrics);
    fixture.componentRef.setInput('selected', selected);
    fixture.detectChanges();
    return fixture;
  }

  it('searches metric labels, short labels, ids, and families while preserving catalog grouping', () => {
    const fixture = createPicker();
    const headings = () =>
      [...fixture.nativeElement.querySelectorAll('h3, h4')].map((heading: HTMLElement) =>
        heading.textContent.trim(),
      );

    expect(headings()).toEqual(['Diffusion', 'Tensor', 'Functional', 'Signal', 'Structural']);

    const input = fixture.nativeElement.querySelector('input[aria-label="Search metrics"]') as HTMLInputElement;
    input.value = 'FA MEAN';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Mean fractional anisotropy');
    expect(fixture.nativeElement.textContent).not.toContain('Mean diffusivity');

    input.value = 't1_snr';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Structural signal to noise ratio');
  });

  it('emits the selected metric id and marks the selected result', () => {
    const fixture = createPicker(METRICS, [], 'fd_md');
    let picked: string | undefined;
    fixture.componentInstance.picked.subscribe((metricId) => (picked = metricId));

    const selected = fixture.nativeElement.querySelector('button[aria-pressed="true"]') as HTMLButtonElement;
    expect(selected.textContent).toContain('Mean diffusivity');
    selected.click();

    expect(picked).toBe('fd_md');
  });

  it('disables study-missing metrics and does not emit them', () => {
    const fixture = createPicker(METRICS, ['bold_mean']);
    let picked: string | undefined;
    fixture.componentInstance.picked.subscribe((metricId) => (picked = metricId));

    const missing = [...fixture.nativeElement.querySelectorAll('button')].find((button: HTMLButtonElement) =>
      button.textContent.includes('Mean BOLD signal'),
    ) as HTMLButtonElement;
    expect(missing.disabled).toBe(true);
    missing.click();

    expect(picked).toBeUndefined();
  });

  it('shows an empty result message when no metric matches', () => {
    const fixture = createPicker();
    const input = fixture.nativeElement.querySelector('input[aria-label="Search metrics"]') as HTMLInputElement;
    input.value = 'does-not-exist';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('No metrics match your search.');
    expect(fixture.nativeElement.querySelectorAll('button').length).toBe(0);
  });
});
