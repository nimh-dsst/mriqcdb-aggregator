import { provideZonelessChangeDetection } from '@angular/core';
import { OverlayContainer } from '@angular/cdk/overlay';
import { TestBed } from '@angular/core/testing';
import { fieldsFor } from '@mriqc/shared';
import { describe, expect, it } from 'vitest';

import { type Series, seriesKey } from '../graph/series';
import { CompareInput } from './compare-input';

const fields = fieldsFor('bold', 'raw', 'group').filter(
  (field) => field.kind === 'categorical' && field.groupable,
);
const firstField = fields[0]!;
const secondField = fields[1]!;

const fieldValues = {
  [firstField.id]: [
    { value: 'Vendor A', n: 12 },
    { value: 'Vendor B', n: 8 },
  ],
  [secondField.id]: [{ value: 'Value', n: 20 }],
};

const create = (series: readonly Series[] = []) => {
  TestBed.configureTestingModule({
    imports: [CompareInput], providers: [provideZonelessChangeDetection()],
  });
  const fixture = TestBed.createComponent(CompareInput);
  fixture.componentRef.setInput('series', series);
  fixture.componentRef.setInput('fields', fields);
  fixture.componentRef.setInput('groups', []);
  fixture.componentRef.setInput('fieldValues', fieldValues);
  fixture.componentRef.setInput('studyReady', true);
  fixture.detectChanges();
  return fixture;
};

describe('CompareInput', () => {
  it('removes one expanded group chip and offers the missing group to add back', async () => {
    const descriptor: Series = { kind: 'field', field: firstField.id };
    const fixture = create([descriptor]);
    const id = `g\u0000${firstField.id}\u0000Vendor A`;
    fixture.componentRef.setInput('legend', [{ id, name: 'Vendor A', color: '#123456', n: 12, descriptorKey: seriesKey(descriptor) }]);
    const removed: string[] = [], replaced: Series[] = [];
    fixture.componentInstance.removed.subscribe(value => removed.push(value));
    fixture.componentInstance.replaced.subscribe(value => replaced.push(value));
    fixture.detectChanges();
    fixture.nativeElement.querySelector('button[aria-label="Remove comparison Vendor A"]').click();
    expect(removed).toEqual([id]);
    fixture.componentRef.setInput('series', [{ kind: 'values', field: firstField.id, values: ['Vendor B'] }]);
    fixture.detectChanges();
    fixture.nativeElement.querySelector('button[aria-label="Add comparison"]').click();
    await fixture.whenStable();
    const items = [...TestBed.inject(OverlayContainer).getContainerElement().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    const addBack = items.find(item => item.textContent?.includes('Vendor A'))!;
    expect(addBack.disabled).toBe(false);
    addBack.click();
    expect(replaced).toEqual([{ kind: 'values', field: firstField.id, values: ['Vendor B', 'Vendor A'] }]);
  });

  it('opens Split at and emits numeric bins from entered cut points', async () => {
    const fixture = create();
    const numeric = fieldsFor('bold', 'raw', 'filter').filter(field => field.kind === 'numeric');
    fixture.componentRef.setInput('fields', [...fields, ...numeric]);
    const replaced: Series[] = [];
    fixture.componentInstance.replaced.subscribe(value => replaced.push(value));
    fixture.detectChanges();
    fixture.nativeElement.querySelector('button[aria-label="Add comparison"]').click();
    await fixture.whenStable();
    [...TestBed.inject(OverlayContainer).getContainerElement().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find(item => item.textContent?.includes('Split at'))!.click();
    await fixture.whenStable();
    const cuts = fixture.nativeElement.querySelector('[aria-label="Cut points"]') as HTMLInputElement;
    cuts.value = '1, 2';
    cuts.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    [...fixture.nativeElement.querySelectorAll('button')].find((button: any) => button.textContent.trim() === 'Split').click();
    expect(replaced).toEqual([{ kind: 'values', field: numeric[0].id, values: ['bin:[null,1]', 'bin:[1,2]', 'bin:[2,null]'] }]);
  });

  it.each(['contextmenu', 'F10', 'ContextMenu', 'click'])('opens field-chip actions with %s and emits group actions', async gesture => {
    const descriptor: Series = { kind: 'field', field: firstField.id };
    const fixture = create([descriptor]);
    fixture.componentRef.setInput('legend', [{ id: 'vendor-a', name: 'Vendor A', color: '#123456', n: 12, descriptorKey: seriesKey(descriptor) }]);
    const actions: unknown[] = [];
    fixture.componentInstance.groupAction.subscribe(value => actions.push(value));
    fixture.detectChanges();
    const chip = fixture.nativeElement.querySelector('[data-testid="compare-series-chip"]') as HTMLElement;
    if (gesture === 'click') chip.querySelector<HTMLButtonElement>('[aria-label="Actions for Vendor A"]')!.click();
    else if (gesture === 'contextmenu') chip.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    else chip.querySelector('button[aria-pressed]')!.dispatchEvent(new KeyboardEvent('keydown', { key: gesture, shiftKey: gesture === 'F10', bubbles: true }));
    fixture.detectChanges(); await fixture.whenStable();
    const items = Array.from(TestBed.inject(OverlayContainer).getContainerElement().querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    expect(items.map(item => item.textContent?.trim())).toEqual(['Isolate', 'Reset', 'Remove', 'Save as group…', 'Only this group']);
    items[3].click(); expect(actions).toEqual([{ id: 'vendor-a', action: 'save' }]);
    await fixture.whenStable();
    chip.querySelector<HTMLButtonElement>('[aria-label="Actions for Vendor A"]')!.click();
    fixture.detectChanges(); await fixture.whenStable();
    Array.from(TestBed.inject(OverlayContainer).getContainerElement().querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
      .find(item => item.textContent?.trim() === 'Only this group')!.click();
    expect(actions[1]).toEqual({ id: 'vendor-a', action: 'only' });
  });
  it('renders legend chips with pending counts and emits isolation changes', () => {
    const fixture = create();
    const isolated: (string | null)[] = [];
    fixture.componentRef.setInput('legend', [
      { id: 'group-a', name: 'Group A', color: '#123456', n: null },
    ]);
    fixture.componentInstance.isolatedChange.subscribe((value) => isolated.push(value));
    fixture.detectChanges();

    const chip = fixture.nativeElement.querySelector('button[aria-pressed]') as HTMLButtonElement;
    expect(chip.textContent).toContain('Group A');
    expect(chip.textContent).toContain('—');
    chip.click();
    expect(isolated).toEqual(['group-a']);
    chip.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(isolated).toEqual(['group-a', null]);
  });

  it('only renders a remove control for legend entries with descriptor keys', () => {
    const fixture = create();
    const removed: string[] = [];
    fixture.componentRef.setInput('legend', [
      { id: 'pending', name: 'Pending', color: '#123456', n: null },
      { id: 'descriptor', name: 'Descriptor', color: '#654321', n: 4, descriptorKey: 'descriptor-key' },
    ]);
    fixture.componentInstance.removed.subscribe((value) => removed.push(value));
    fixture.detectChanges();

    const buttons = fixture.nativeElement.querySelectorAll('button[aria-label^="Remove comparison "]');
    expect(buttons).toHaveLength(1);
    (buttons[0] as HTMLButtonElement).click();
    expect(removed).toEqual(['descriptor-key']);
  });
  it('explains a local-study query capability limit', () => {
    const fixture = create();
    fixture.componentRef.setInput('studyFormReason', 'Local studies do not provide raw-record queries for Table.');
    fixture.detectChanges();
    expect(fixture.componentInstance.disabledReason({ kind: 'study' })).toContain('raw-record queries');
    expect(fixture.componentInstance.disabledReason({ kind: 'population' })).toBeNull();
  });
  it('shows helper reasons for a second field and an already-added population', () => {
    const existing: readonly Series[] = [
      { kind: 'field', field: firstField.id },
      { kind: 'population' },
    ];
    const fixture = create(existing);
    const secondFieldReason = fixture.componentInstance.disabledReason({
      kind: 'field',
      field: secondField.id,
    });
    const populationReason = fixture.componentInstance.disabledReason({
      kind: 'population',
    });

    expect(secondFieldReason).toBeTruthy();
    expect(populationReason).toBeTruthy();

    (fixture.nativeElement.querySelector(
      'button[aria-label="Add comparison"]',
    ) as HTMLButtonElement).click();
    fixture.detectChanges();
    const overlay = TestBed.inject(OverlayContainer).getContainerElement();

    expect(overlay.textContent).toContain(secondFieldReason);
    expect(overlay.textContent).toContain(populationReason);
  });

  it.each(['Vendor A', ''])('adds a chosen categorical value %j, including missing', (value) => {
    const fixture = create();
    const added: Series[] = [];
    fixture.componentInstance.added.subscribe((series) => added.push(series));

    fixture.componentInstance.openValuesEditor();
    fixture.componentInstance.setChosenField(firstField.id);
    fixture.componentInstance.setChosenValues([value]);
    fixture.componentInstance.addChosenValues();

    expect(added).toEqual([
      { kind: 'values', field: firstField.id, values: [value] },
    ]);
  });

  it('emits the series key when a comparison is removed', () => {
    const series: Series = { kind: 'population' };
    const fixture = create([series]);
    const removed: string[] = [];
    fixture.componentInstance.removed.subscribe((key) => removed.push(key));

    fixture.componentInstance.removeSeries(series);

    expect(removed).toEqual([seriesKey(series)]);
  });

  it('uses the calendar year before the latest range bound for Previous year', () => {
    const fixture = create();
    const added: Series[] = [];
    fixture.componentInstance.added.subscribe((series) => added.push(series));
    fixture.componentRef.setInput('dateRange', ['2024-02-01', '2025-10-08']);
    fixture.detectChanges();

    fixture.componentInstance.addCandidate(
      fixture.componentInstance.previousYearSeries(),
    );

    expect(added).toEqual([
      { kind: 'span', from: '2024-01-01', to: '2024-12-31' },
    ]);
  });
});
