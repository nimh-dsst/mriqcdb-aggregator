import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { CardFooter } from './card-footer';
import { panelView } from './card-test-harness';

describe('CardFooter', () => {
  it('preserves count meaning, subtitle, notes and clip label', () => {
    const fixture = TestBed.createComponent(CardFooter);
    fixture.componentRef.setInput('view', { ...panelView, n: 1234, countLabel: 'scans', subtitle: 'Showing 100 of 1234 scans', notes: ['filtered by brush'], clipChip: 'Full range' });
    fixture.detectChanges();
    const count = fixture.nativeElement.querySelector('[data-testid="panel-count"]');
    expect(count.textContent).toBe('1,234');
    expect(count.getAttribute('aria-label')).toBe('1,234 scans');
    expect(count.title).toBe('1,234 scans');
    expect(fixture.nativeElement.querySelector('[data-testid="panel-shown"]').textContent).toBe('Showing 100 of 1234 scans');
    expect(fixture.nativeElement.querySelector('[data-testid="panel-note"]').textContent).toContain('filtered by brush');
    expect(fixture.nativeElement.querySelector('[data-testid="panel-clip"]').textContent).toBe('Full range');
  });

  it('omits unknown counts', () => {
    const fixture = TestBed.createComponent(CardFooter);
    fixture.componentRef.setInput('view', { ...panelView, n: null });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="panel-count"]')).toBeNull();
  });
});
