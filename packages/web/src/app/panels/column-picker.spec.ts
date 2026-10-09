import { TestBed } from '@angular/core/testing';
import { asColumnId, fieldsFor, metricsFor } from '@mriqc/shared';
import { describe, expect, it, vi } from 'vitest';
import { Graph } from '../loop/graph';
import { defaultDashboard } from '../slices/panels/defaults';
import { reduce } from '../slices/reducer';
import { INITIAL_STATE } from '../graph/state';
import { decodeUrlState, encodeUrlState, urlState } from '../url/url';
import { panelView } from '../slices/panels/view';
import { panelQueries } from '../slices/panels/queries';

import { ColumnPicker, columnGroups } from './column-picker';

const metrics = metricsFor('bold');
const fields = fieldsFor('bold', 'raw', 'group');

const columnsIn = (groups: ReturnType<typeof columnGroups>) =>
  groups.flatMap((group) => group.sections.flatMap((section) => section.columns));

describe('column drawer actions', () => {
  it('finds Upload time in Y and applies Band to an FD-mean card, with a URL round trip', () => {
    const { fixture, dispatch } = createDrawer('p1', 'fd_mean');
    fixture.componentRef.setInput('focusY', true);
    fixture.componentRef.setInput('pendingForm', 'band');
    fixture.detectChanges();
    search(fixture, 'Upload time', 'Y slot (optional)');
    const choices = fixture.nativeElement.querySelectorAll('.column-picker-columns [data-column-id]');
    expect(choices[0].getAttribute('data-column-id')).toBe('created_at');
    expect(choices[0].disabled).toBe(false);
    expect(fixture.nativeElement.querySelector('[data-column-id="manufacturer"]')).toBeNull();
    choices[0].click();
    const state = reduce(reduce(INITIAL_STATE, { t: 'hydrate', url: defaultDashboard() }), dispatch.mock.calls[0][0]);
    expect(state.panels[0]).toMatchObject({ x: 'created_at', y: 'fd_mean', form: 'band' });
    expect(panelView(state, 'p1')?.title).toBe('FD mean over time');
    const decoded = decodeUrlState(encodeUrlState(urlState(state)))!;
    expect(decoded.panels[0]).toMatchObject({ x: 'created_at', y: 'fd_mean', form: 'band' });
  });

  it('allows an explicit swap with time on Y and keeps it through hydration', () => {
    const { fixture, dispatch } = createDrawer('p1', 'created_at');
    fixture.componentRef.setInput('y', 'fd_mean');
    fixture.detectChanges();
    const swap = fixture.nativeElement.querySelector('[aria-label="Swap X and Y"]');
    expect(swap.disabled).toBe(false);
    swap.click();
    fixture.componentInstance.commit();
    const state = reduce(reduce(INITIAL_STATE, { t: 'hydrate', url: defaultDashboard() }), dispatch.mock.calls[0][0]);
    const restored = reduce(INITIAL_STATE, { t: 'hydrate', url: decodeUrlState(encodeUrlState(urlState(state)))! });
    expect(restored.panels[0]).toMatchObject({ x: 'fd_mean', y: 'created_at' });
    for (const form of ['band', 'heatmap'] as const) {
      const paired = { ...restored.panels[0], form };
      expect(panelQueries(restored, paired)[0]).toMatchObject({
        proc: form === 'band' ? 'binnedSummary' : 'density2d', x: 'fd_mean', y: 'created_at',
      });
    }
  });

  const createDrawer = (panelId: string | null = null, selected = 'created_at') => {
    const dispatch = vi.fn();
    TestBed.configureTestingModule({ imports: [ColumnPicker], providers: [{ provide: Graph, useValue: { dispatch } }] });
    const fixture = TestBed.createComponent(ColumnPicker);
    fixture.componentRef.setInput('metrics', metrics);
    fixture.componentRef.setInput('fields', fields);
    fixture.componentRef.setInput('drawer', true);
    fixture.componentRef.setInput('panelId', panelId);
    fixture.componentRef.setInput('selected', selected);
    fixture.detectChanges();
    return { fixture, dispatch };
  };

  const family = (fixture: ReturnType<typeof createDrawer>['fixture'], name: string) => {
    const button = Array.from(fixture.nativeElement.querySelectorAll('[data-family]') as NodeListOf<HTMLButtonElement>)
      .find(button => button.dataset['family'] === name)!;
    button.click();
    fixture.detectChanges();
  };
  const metricFamily = (id: string) => metrics.find(metric => metric.id === id)!.family;
  const search = (fixture: ReturnType<typeof createDrawer>['fixture'], value: string, slot = 'X slot') => {
    const input = fixture.nativeElement.querySelector(`[aria-label="${slot}"]`) as HTMLInputElement;
    input.dispatchEvent(new FocusEvent('focus'));
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    return input;
  };

  it('shows every family, full names, short labels, units and categorical fields', () => {
    const { fixture } = createDrawer();
    for (const heading of ['Time', ...new Set(metrics.map(metric => metric.family)), 'Fields']) expect(fixture.nativeElement.textContent).toContain(heading);
    family(fixture, 'Fields');
    expect(fixture.nativeElement.querySelector('[data-column-id="manufacturer"]')).not.toBeNull();
    family(fixture, metricFamily('fd_mean'));
    const fd = fixture.nativeElement.querySelector('[data-column-id="fd_mean"]');
    expect(fd.textContent).toContain('Mean framewise displacement');
    expect(fd.textContent).toContain('FD mean');
    expect(fd.textContent).toContain('mm');
  });

  it('places families, selected-family columns and details in three panes with filter slots in the header', () => {
    const { fixture } = createDrawer();
    const root: HTMLElement = fixture.nativeElement;
    const picker = root.querySelector('.column-picker')!;
    const toolbar = picker.querySelector('.column-picker-toolbar')!;
    const body = picker.querySelector('.column-picker-body')!;
    const strip = body.querySelector('.column-picker-columns')!;
    const details = body.querySelector('.column-picker-details')!;
    const families = body.querySelector('.column-picker-families')!;
    expect(toolbar.nextElementSibling).toBe(body);
    expect(Array.from(toolbar.querySelectorAll('button, input'), control => control.getAttribute('aria-label') ?? control.textContent?.trim()))
      .toEqual(['X slot', 'Y slot (optional)', 'Swap X and Y', 'Create panel', 'Close column drawer']);
    expect(toolbar.querySelectorAll('input[type="text"]')).toHaveLength(2);
    expect(toolbar.querySelector('[role="combobox"], [role="listbox"]')).toBeNull();
    expect(toolbar.querySelector('[aria-label="Search columns"]')).toBeNull();
    expect(Array.from(body.children)).toEqual([families, strip, details]);
    expect(root.querySelectorAll('.column-picker-columns')).toHaveLength(1);
    expect(Array.from(families.querySelectorAll('[data-family]'), row => row.getAttribute('data-family')))
      .toEqual(['Time', ...new Set(metrics.map(metric => metric.family)), 'Fields']);
    expect(strip.querySelectorAll('[data-column-id]')).toHaveLength(1);
    expect(families.querySelector('[aria-pressed="true"]')?.getAttribute('data-family')).toBe('Time');
    for (const name of new Set(metrics.map(metric => metric.family))) {
      family(fixture, name);
      const expected = metrics.filter(metric => metric.family === name).map(metric => metric.id).sort();
      const rendered = Array.from(strip.querySelectorAll('[data-column-id]'), row => row.getAttribute('data-column-id')).sort();
      expect(rendered).toEqual(expected);
      const choice = Array.from(families.querySelectorAll('[data-family]')).find(row => row.getAttribute('data-family') === name)!;
      expect(choice.querySelector('.column-picker-count')?.textContent?.trim()).toBe(String(expected.length));
    }
  });

  it('adds a column and closes, while Shift adds another without closing', () => {
    const { fixture, dispatch } = createDrawer();
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    const button = fixture.nativeElement.querySelector('[data-column-id="created_at"]');
    button.click();
    expect(dispatch).not.toHaveBeenCalled();
    fixture.detectChanges();
    fixture.componentInstance.commit(new MouseEvent('click', { shiftKey: true }));
    expect(dispatch).toHaveBeenLastCalledWith({ t: 'addPanel', x: 'created_at', y: null });
    expect(closed).not.toHaveBeenCalled();
    button.click();
    fixture.componentInstance.commit();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(closed).toHaveBeenCalledOnce();
  });

  it('preserves both picks when catalog inputs refresh before Create panel', () => {
    const { fixture, dispatch } = createDrawer();
    search(fixture, 'fd_mean');
    fixture.nativeElement.querySelector('[data-column-id="fd_mean"]').click();
    search(fixture, 'tsnr', 'Y slot (optional)');
    fixture.nativeElement.querySelector('[data-column-id="tsnr"]').click();
    fixture.detectChanges();
    fixture.componentRef.setInput('metrics', [...metrics]);
    fixture.componentRef.setInput('fields', [...fields]);
    fixture.detectChanges();
    const create = Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>)
      .find(button => button.textContent?.trim() === 'Create panel')!;
    expect(create.disabled).toBe(false);
    create.click();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ t: 'addPanel', x: 'fd_mean', y: 'tsnr' });
  });

  it('retargets a card rather than adding one', () => {
    const { fixture, dispatch } = createDrawer('p1', 'snr');
    expect(fixture.componentInstance.selectedFamily()).toBe(metricFamily('snr'));
    family(fixture, 'Fields');
    fixture.nativeElement.querySelector('[data-column-id="manufacturer"]').click();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ t: 'patchPanel', id: 'p1', patch: { x: 'manufacturer', y: null } });
    expect(fixture.nativeElement.textContent).not.toContain('Apply');
    expect(fixture.nativeElement.textContent).not.toContain('Create panel');
  });

  it('selects a time metric through the Y slot and applies both axes', () => {
    const { fixture, dispatch } = createDrawer('p1');
    fixture.nativeElement.querySelector('[aria-label="Y slot (optional)"]').click();
    family(fixture, metricFamily('fd_mean'));
    fixture.nativeElement.querySelector('[data-column-id="fd_mean"]').click();
    fixture.detectChanges();
    fixture.componentInstance.commit();
    expect(dispatch).toHaveBeenCalledWith({ t: 'patchPanel', id: 'p1', patch: { x: 'created_at', y: 'fd_mean' } });
  });

  it('removes Y immediately and leaves the title drawer open', () => {
    const { fixture, dispatch } = createDrawer('p1', 'fd_mean');
    fixture.componentRef.setInput('y', 'tsnr');
    fixture.detectChanges();
    const closed = vi.fn(); fixture.componentInstance.closed.subscribe(closed);
    fixture.nativeElement.querySelector('[aria-label="Clear Y slot"]').click();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ t: 'patchPanel', id: 'p1', patch: { x: 'fd_mean', y: null } });
    expect(closed).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).not.toContain('Apply');
  });

  it('shows metric descriptions and documented direction on keyboard focus', () => {
    const { fixture } = createDrawer();
    family(fixture, metricFamily('fd_mean'));
    fixture.nativeElement.querySelector('[data-column-id="fd_mean"]').dispatchEvent(new FocusEvent('focus'));
    fixture.detectChanges();
    const details = fixture.nativeElement.querySelector('.column-picker-details');
    expect(details.textContent).toContain('Lower is better');
    expect(details.querySelector('a')?.href).toContain('mriqc.readthedocs.io');
    expect(fixture.nativeElement.querySelector('[aria-label="Y slot (optional)"]')).not.toBeNull();
  });

  it('creates two metrics in one command, swaps them, and clears a slot', () => {
    const { fixture, dispatch } = createDrawer();
    family(fixture, metricFamily('fd_mean'));
    fixture.nativeElement.querySelector('[data-column-id="fd_mean"]').click();
    family(fixture, metricFamily('tsnr'));
    fixture.nativeElement.querySelector('[data-column-id="tsnr"]').click();
    fixture.detectChanges();
    expect(dispatch).not.toHaveBeenCalled();
    fixture.nativeElement.querySelector('[aria-label="Swap X and Y"]').click();
    fixture.componentInstance.commit();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ t: 'addPanel', x: 'tsnr', y: 'fd_mean' });
    fixture.nativeElement.querySelector('[aria-label="Clear Y slot"]').click();
    expect(fixture.componentInstance.slots().y).toBeNull();
  });

  it('pre-fills both title slots and applies a requested form as soon as Y is picked', () => {
    const { fixture, dispatch } = createDrawer('p1', 'fd_mean');
    fixture.componentRef.setInput('y', 'tsnr');
    fixture.detectChanges();
    expect(fixture.componentInstance.slots().y?.id).toBe('tsnr');
    fixture.componentRef.setInput('y', null);
    fixture.componentRef.setInput('focusY', true);
    fixture.componentRef.setInput('pendingForm', 'scatter');
    fixture.detectChanges();
    search(fixture, 'tsnr', 'Y slot (optional)');
    fixture.nativeElement.querySelector('[data-column-id="tsnr"]').click();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ t: 'patchPanel', id: 'p1', patch: { x: 'fd_mean', y: 'tsnr', form: 'scatter' } });
  });

  it('filters across families by full name, short label and id, and picks either slot with Enter', () => {
    const { fixture } = createDrawer();
    for (const query of ['Mean framewise displacement', 'FD mean', 'fd_mean']) {
      const input = search(fixture, query);
      expect(fixture.nativeElement.querySelector('[role="listbox"], .column-picker-options')).toBeNull();
      expect(fixture.nativeElement.querySelector('[data-column-id="fd_mean"]')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('[data-family="Time"]').classList.contains('no-hits')).toBe(true);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      fixture.detectChanges();
      expect(fixture.componentInstance.query()).toBe('');
      expect(fixture.nativeElement.querySelector('[role="listbox"]')).toBeNull();
    }
    const x = search(fixture, 'fd_mean');
    x.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.slots().x?.id).toBe('fd_mean');
    expect(x.value).toBe('Mean framewise displacement');
    const y = search(fixture, 'tsnr', 'Y slot (optional)');
    y.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.slots().y?.id).toBe('tsnr');
  });

  it('captions cross-family results and moves focus through the columns pane with arrows', () => {
    const { fixture } = createDrawer();
    const input = search(fixture, 'mean');
    const expected = columnGroups(metrics, fields, 'mean');
    expect(expected.length).toBeGreaterThan(1);
    const root: HTMLElement = fixture.nativeElement;
    expect(Array.from(root.querySelectorAll('.column-picker-columns h3'), heading => heading.textContent?.trim()))
      .toEqual(expected.map(group => group.label));
    expect(root.querySelector('[role="listbox"]')).toBeNull();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    fixture.detectChanges();
    expect(document.activeElement?.getAttribute('data-column-id')).toBe(columnsIn(expected)[0].id);
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    fixture.detectChanges();
    const second = columnsIn(expected)[1];
    expect(document.activeElement?.getAttribute('data-column-id')).toBe(second.id);
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement?.getAttribute('data-column-id')).toBe(columnsIn(expected)[0].id);
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(fixture.componentInstance.slots().x?.id).toBe(second.id);
  });

  it('picks the first visible hit with Enter, including an unfiltered selected family', () => {
    const { fixture } = createDrawer();
    const input = search(fixture, 'mean');
    const first = fixture.nativeElement.querySelector('.column-picker-columns [data-column-id]').getAttribute('data-column-id');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.slots().x?.id).toBe(first);
    family(fixture, 'Time');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(fixture.componentInstance.slots().x?.id).toBe('created_at');
  });

  it('switches panes with Left/Right and moves family and column focus with arrows', () => {
    const { fixture } = createDrawer();
    const root: HTMLElement = fixture.nativeElement;
    const key = (element: Element, key: string) => {
      element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      fixture.detectChanges();
    };
    const first = root.querySelector<HTMLElement>('[data-family="Time"]')!;
    first.focus();
    key(first, 'ArrowDown');
    expect(document.activeElement?.getAttribute('data-family')).toBe(metrics[0].family);
    key(document.activeElement!, 'ArrowRight');
    const column = document.activeElement!;
    expect(column.hasAttribute('data-column-id')).toBe(true);
    key(column, 'ArrowDown');
    expect(document.activeElement).not.toBe(column);
    key(document.activeElement!, 'ArrowRight');
    expect(document.activeElement?.classList.contains('column-picker-details')).toBe(true);
    key(document.activeElement!, 'ArrowLeft');
    expect(document.activeElement?.hasAttribute('data-column-id')).toBe(true);
    const pickedId = document.activeElement!.getAttribute('data-column-id');
    key(document.activeElement!, 'Enter');
    expect(fixture.componentInstance.slots().x?.id).toBe(pickedId);
    key(document.activeElement!, 'ArrowLeft');
    expect(document.activeElement?.getAttribute('data-family')).toBe(metrics[0].family);
  });

  it('keeps empty searches safe and Escape restores the selected value without closing the drawer', () => {
    const { fixture, dispatch } = createDrawer('p1', 'fd_mean');
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    const input = search(fixture, 'no such column');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.column-picker-columns').textContent).toContain('No columns match');
    expect(dispatch).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(input.value).toBe('Mean framewise displacement');
    expect(fixture.componentInstance.slots().x?.id).toBe('fd_mean');
    expect(closed).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelectorAll('.column-picker-columns h3')).toHaveLength(1);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(closed).toHaveBeenCalledOnce();
  });
});

describe('columnGroups', () => {
  it('orders Time, metric families, and categorical groupable Fields', () => {
    const groups = columnGroups(metrics, fields, '');
    const expectedFamilies = [...new Set(metrics.map((metric) => metric.family))];
    const expectedFields = fields.filter(
      (field) => field.kind === 'categorical' && field.groupable,
    );

    expect(groups.map((group) => group.label)).toEqual([
      'Time',
      ...expectedFamilies,
      ...(expectedFields.length > 0 ? ['Fields'] : []),
    ]);
    expect(columnsIn(groups).find((column) => column.id === 'created_at')).toMatchObject({
      label: 'Upload time',
      source: 'time',
    });
    expect(
      columnsIn(groups)
        .filter((column) => column.source === 'field')
        .map((column) => column.id),
    ).toEqual(expectedFields.map((field) => field.id));
  });

  it('filters by labels, identifiers, short labels, and families', () => {
    const manufacturer = columnGroups(metrics, fields, 'Manufacturer');
    expect(columnsIn(manufacturer).map(column=>column.id)).toContain('manufacturer');
    expect(columnsIn(manufacturer).every(column=>column.source==='field')).toBe(true);

    const metric = metrics[0];
    const metricResult = columnGroups(
      metrics,
      fields,
      metric.shortLabel ?? metric.id,
    );
    expect(columnsIn(metricResult).map((column) => column.id)).toContain(metric.id);
  });
});

describe('ColumnPicker', () => {
  const create = (disabledMetrics: readonly string[] = []) => {
    TestBed.configureTestingModule({ imports: [ColumnPicker] });
    const fixture = TestBed.createComponent(ColumnPicker);
    fixture.componentRef.setInput('metrics', metrics);
    fixture.componentRef.setInput('fields', fields);
    fixture.componentRef.setInput('disabledMetrics', disabledMetrics);
    fixture.detectChanges();
    return fixture;
  };

  it('renders Upload time and gives each instance unique group heading ids', () => {
    const first = create();
    const second = TestBed.createComponent(ColumnPicker);
    second.componentRef.setInput('metrics',metrics);second.componentRef.setInput('fields',fields);second.detectChanges();
    const firstHeadings = Array.from(
      first.nativeElement.querySelectorAll('h3'),
      (heading: HTMLHeadingElement) => heading.id,
    );
    const secondHeadings = Array.from(
      second.nativeElement.querySelectorAll('h3'),
      (heading: HTMLHeadingElement) => heading.id,
    );

    expect(first.nativeElement.textContent).toContain('Upload time');
    expect(firstHeadings[0]).not.toBe(secondHeadings[0]);
  });

  it('shows a clear message when the search has no matches', () => {
    const fixture = create();
    const search = fixture.nativeElement.querySelector(
      'input[aria-label="Search columns"]',
    ) as HTMLInputElement;
    search.value = 'no such column';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain(
      'No columns match your search.',
    );
  });

  it('disables configured metrics and emits the selected column', () => {
    const disabled = metrics[0];
    const fixture = create([disabled.id]);
    const picked: string[] = [];
    fixture.componentInstance.picked.subscribe((column) => picked.push(column));
    const buttons = Array.from(
      fixture.nativeElement.querySelectorAll('button'),
    ) as HTMLButtonElement[];
    const disabledButton = buttons.find(
      (button) => button.dataset['columnId'] === disabled.id,
    );
    const uploadButton = buttons.find(
      (button) => button.dataset['columnId'] === 'created_at',
    );

    expect(disabledButton?.disabled).toBe(true);
    disabledButton?.click();
    uploadButton?.click();

    expect(picked).toEqual([asColumnId('created_at')]);
  });
});
