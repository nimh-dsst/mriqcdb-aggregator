import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { BinControl } from './bin-control';
import { makePanel } from './card-test-harness';
import type { Panel } from '../../graph/state';

function create(panel: Panel, n: number | null = null) {
  const fixture = TestBed.createComponent(BinControl);
  fixture.componentRef.setInput('panel', panel);
  fixture.componentRef.setInput('n', n);
  fixture.detectChanges();
  return fixture;
}

describe('BinControl', () => {
  it('steps through round numbers and caps increases at the data-dependent limit', () => {
    const panel = makePanel();
    const fixture = create({ ...panel, options: { ...panel.options, bins: 20 } }, 400);
    const patch = vi.spyOn(fixture.componentInstance.patch, 'emit');
    fixture.nativeElement.querySelector('[aria-label="More bins"]').click();
    expect(patch).toHaveBeenLastCalledWith({ bins: 30 });
    fixture.nativeElement.querySelector('[aria-label="Fewer bins"]').click();
    expect(patch).toHaveBeenLastCalledWith({ bins: 10 });
    fixture.componentRef.setInput('panel', { ...panel, options: { ...panel.options, bins: 40 } });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[aria-label="More bins"]').disabled).toBe(true);
  });

  it('allows typed bins above the soft stepper cap', () => {
    const fixture = create(makePanel(), 12);
    const patch = vi.spyOn(fixture.componentInstance.patch, 'emit');
    const input = fixture.nativeElement.querySelector('input');
    input.value = '150';
    input.dispatchEvent(new Event('change'));
    expect(patch).toHaveBeenCalledExactlyOnceWith({ bins: 150 });
  });

  it('emits time granularity from the rendered buttons', () => {
    const fixture = create(makePanel({ x: 'created_at', form: 'line' }));
    const patch = vi.spyOn(fixture.componentInstance.patch, 'emit');
    const buttons = Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
    expect(buttons.map(button => button.textContent?.trim())).toEqual(['Day', 'Week', 'Month', 'Year']);
    buttons[2].click();
    expect(patch).toHaveBeenCalledExactlyOnceWith({ granularity: 'month' });
  });

  it('keeps a selected cell size available even when the data is sparse', () => {
    const fixture = create(makePanel({ form: 'heatmap' }), 100);
    const patch = vi.spyOn(fixture.componentInstance.patch, 'emit');
    const buttons = Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];
    expect(buttons.map(button => button.disabled)).toEqual([false, false, true]);
    buttons[0].click();
    expect(patch).toHaveBeenCalledExactlyOnceWith({ cells: 30 });
  });

  it('limits cluster controls to two through six', () => {
    const panel = makePanel({ form: 'clusters' });
    const fixture = create({ ...panel, options: { ...panel.options, k: 2 } });
    expect(fixture.nativeElement.querySelector('[aria-label="Fewer clusters"]').disabled).toBe(true);
    fixture.componentRef.setInput('panel', { ...panel, options: { ...panel.options, k: 6 } });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[aria-label="More clusters"]').disabled).toBe(true);
  });
});
