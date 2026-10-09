import { TestBed } from '@angular/core/testing';
import { asColumnId, metricsFor } from '@mriqc/shared';
import { describe, expect, it, vi } from 'vitest';
import { MatrixControl } from './matrix-control';
import { makePanel } from './card-test-harness';

describe('MatrixControl', () => {
  it('emits coefficient options and requires two metrics for a custom matrix', () => {
    const fixture = TestBed.createComponent(MatrixControl);
    fixture.componentRef.setInput('panel', makePanel({ form: 'matrix' }));
    fixture.componentRef.setInput('metrics', metricsFor('bold'));
    fixture.detectChanges();
    const patch = vi.spyOn(fixture.componentInstance.patch, 'emit');
    const applied = vi.spyOn(fixture.componentInstance.applied, 'emit');
    const select = fixture.nativeElement.querySelector('select');
    select.value = 'pearson'; select.dispatchEvent(new Event('change'));
    expect(patch).toHaveBeenCalledExactlyOnceWith({ coefficient: 'pearson' });
    fixture.componentInstance.openMetricSet();
    fixture.componentInstance.setCorrelationMetrics(['snr']);
    fixture.componentInstance.applyMetricSet();
    expect(applied).not.toHaveBeenCalled();
    fixture.componentInstance.setCorrelationMetrics(['snr', 'efc']);
    fixture.componentInstance.applyMetricSet();
    expect(applied).toHaveBeenCalledExactlyOnceWith({ family: 'custom', metrics: [asColumnId('snr'), asColumnId('efc')] });
    expect(fixture.componentInstance.metricSetOpen()).toBe(false);
  });
});
