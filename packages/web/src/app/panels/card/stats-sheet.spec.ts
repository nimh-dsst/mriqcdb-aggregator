import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { StatsSheet } from './stats-sheet';
import { panelView } from './card-test-harness';

describe('StatsSheet', () => {
  it('folds summary and detailed statistics without hiding an ungrouped analysis note', () => {
    const fixture = TestBed.createComponent(StatsSheet);
    fixture.componentRef.setInput('view', { ...panelView, stats: [{ label: 'Median', title: 'Middle value', value: '3.5' }], analysisNote: 'Approximate' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="panel-stats"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="analysis-note"]').textContent).toBe('Approximate');
    fixture.componentRef.setInput('statsOpen', true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-stat="Median"] .stat-value').textContent).toBe('3.5');
    expect(fixture.nativeElement.querySelector('.stat-label').title).toBe('Middle value');
  });

  it('keeps comparison statistics before metric-pair inspection and emits the selected pair', () => {
    const fixture = TestBed.createComponent(StatsSheet);
    const pair = { x: 'snr', y: 'efc', label: 'SNR / EFC' };
    fixture.componentRef.setInput('view', { ...panelView, title: 'Metrics', comparison: { headers: ['Series', 'IQR'], rows: [{ id: 'one', name: 'One', color: '#123456', cells: ['1–2'] }] }, correlationPairs: [pair] });
    fixture.componentRef.setInput('statsOpen', true);
    fixture.detectChanges();
    const selected = vi.spyOn(fixture.componentInstance.pair, 'emit');
    expect(fixture.nativeElement.querySelector('table').textContent).toContain('1–2');
    expect(fixture.nativeElement.querySelector('table').compareDocumentPosition(fixture.nativeElement.querySelector('details')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fixture.nativeElement.querySelector('details button').click();
    expect(selected).toHaveBeenCalledExactlyOnceWith(pair);
  });
});
