import {provideZonelessChangeDetection} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import {defaultPanelOptions} from '../graph/state';
import {ElementAxis, ElementControls} from './element-controls';

describe('ElementControls', () => {
  let fixture: ComponentFixture<ElementControls>;
  let component: ElementControls;
  let changes: unknown[];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ElementControls],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();

    fixture = TestBed.createComponent(ElementControls);
    component = fixture.componentInstance;
    changes = [];
    component.changed.subscribe((change) => changes.push(change));
  });

  async function render(axis: ElementAxis, countAxis = false): Promise<void> {
    fixture.componentRef.setInput('options', defaultPanelOptions());
    fixture.componentRef.setInput('axis', axis);
    fixture.componentRef.setInput('countAxis', countAxis);
    fixture.componentRef.setInput('colorDefault', 'log');
    fixture.detectChanges();
    await fixture.whenStable();
  }

  function selects(): HTMLSelectElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('select'));
  }

  function optionLabels(select: HTMLSelectElement): string[] {
    return Array.from(select.options, (option) => option.text);
  }

  async function selectValue(select: HTMLSelectElement, value: string): Promise<void> {
    select.value = value;
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    await fixture.whenStable();
  }

  async function enterBound(index: number, value: string): Promise<void> {
    const input = (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLInputElement>('input.bound')[index];
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    await fixture.whenStable();
  }

  it('offers coordinate scales and dispatches the x scale', async () => {
    await render('x');

    const scale = selects()[0];
    expect(optionLabels(scale)).toEqual(['Linear', 'Log', 'Symlog']);

    await selectValue(scale, 'symlog');

    expect(changes).toEqual([{xScale: 'symlog'}]);
  });

  it('offers coordinate scales and dispatches the y scale', async () => {
    await render('y');

    const scale = selects()[0];
    expect(optionLabels(scale)).toEqual(['Linear', 'Log', 'Symlog']);

    await selectValue(scale, 'log');

    expect(changes).toEqual([{yScale: 'log'}]);
  });

  it('offers count modes and dispatches the selected y mode', async () => {
    await render('y', true);

    const countMode = selects()[0];
    expect(optionLabels(countMode)).toEqual(['Count', 'Share', 'Log count']);

    await selectValue(countMode, 'share');

    expect(changes).toEqual([{ yMode: 'share', yScale: 'linear' }]);
    expect(optionLabels(selects()[1])).toEqual(['Linear', 'Log', 'Symlog']);
  });

  it('offers color scales and dispatches the selected color scale', async () => {
    await render('color');

    const scale = selects()[0];
    expect(optionLabels(scale)).toEqual(['Linear', 'Log', 'Sqrt']);
    expect(scale.value).toBe('log');

    await selectValue(scale, 'sqrt');

    expect(changes).toEqual([{colorScale: 'sqrt'}]);
  });

  it('keeps an incomplete custom x range local, then emits it and an auto reset', async () => {
    await render('x');

    await selectValue(selects()[1], 'custom');
    expect(changes).toEqual([]);

    await enterBound(0, '5');
    expect(changes).toEqual([]);

    await enterBound(1, '1');
    expect(changes).toEqual([]);

    await enterBound(1, '8');
    expect(changes).toEqual([{xRange: [5, 8]}]);

    await selectValue(selects()[1], 'auto');
    expect(changes).toEqual([{xRange: [5, 8]}, {xRange: 'auto'}]);
  });

  it('emits a valid custom y range', async () => {
    await render('y');

    await selectValue(selects()[1], 'custom');
    await enterBound(0, '-3');
    await enterBound(1, '9');

    expect(changes).toEqual([{yRange: [-3, 9]}]);

    await selectValue(selects()[1], 'auto');
    expect(changes).toEqual([{yRange: [-3, 9]}, {yRange: 'auto'}]);
  });

  it('rejects non-positive log color bounds before emitting a domain or auto reset', async () => {
    await render('color');

    await selectValue(selects()[1], 'custom');
    await enterBound(0, '-1');
    await enterBound(1, '5');
    expect(changes).toEqual([]);

    await enterBound(0, '1');
    expect(changes).toEqual([{colorDomain: [1, 5]}]);

    await selectValue(selects()[1], 'auto');
    expect(changes).toEqual([{colorDomain: [1, 5]}, {colorDomain: 'auto'}]);
  });

  it('uses the compact, non-truncating control structure', async () => {
    await render('x');

    const root = fixture.nativeElement.querySelector('.element-controls');
    expect(root).not.toBeNull();
    expect(fixture.nativeElement.querySelectorAll('.control-row').length).toBe(2);

    await selectValue(selects()[1], 'custom');
    expect(fixture.nativeElement.querySelector('.bounds')).not.toBeNull();
    expect(fixture.nativeElement.querySelectorAll('.bounds .bound').length).toBe(2);
    expect(fixture.nativeElement.querySelectorAll('.truncate, .text-truncate').length).toBe(0);
  });
});
