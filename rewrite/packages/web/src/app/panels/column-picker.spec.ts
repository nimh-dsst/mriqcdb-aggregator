import { TestBed } from '@angular/core/testing';
import { asColumnId, fieldsFor, metricsFor } from '@mriqc/shared';
import { describe, expect, it, vi } from 'vitest';
import { Graph } from '../graph/graph';

import { ColumnPicker, columnGroups } from './column-picker';

const metrics = metricsFor('bold');
const fields = fieldsFor('bold', 'raw', 'group');

const columnsIn = (groups: ReturnType<typeof columnGroups>) =>
  groups.flatMap((group) => group.sections.flatMap((section) => section.columns));

describe('column drawer actions', () => {
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

  it('shows every family, full names, short labels, units and categorical fields', () => {
    const { fixture } = createDrawer();
    for (const heading of ['Time', ...new Set(metrics.map(metric => metric.family)), 'Fields']) expect(fixture.nativeElement.textContent).toContain(heading);
    expect(fixture.nativeElement.querySelector('[data-column-id="manufacturer"]')).not.toBeNull();
    const fd = fixture.nativeElement.querySelector('[data-column-id="fd_mean"]');
    expect(fd.textContent).toContain('Mean framewise displacement');
    expect(fd.textContent).toContain('FD mean');
    expect(fd.textContent).toContain('mm');
  });

  it('adds a column and closes, while Shift adds another without closing', () => {
    const { fixture, dispatch } = createDrawer();
    const closed = vi.fn();
    fixture.componentInstance.closed.subscribe(closed);
    const button = fixture.nativeElement.querySelector('[data-column-id="created_at"]');
    button.dispatchEvent(new MouseEvent('click', { shiftKey: true }));
    expect(dispatch).toHaveBeenLastCalledWith({ t: 'addPanel', x: 'created_at', y: null });
    expect(closed).not.toHaveBeenCalled();
    button.click();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(closed).toHaveBeenCalledOnce();
  });

  it('retargets a card rather than adding one', () => {
    const { fixture, dispatch } = createDrawer('p1', 'snr');
    fixture.nativeElement.querySelector('[data-column-id="manufacturer"]').click();
    expect(dispatch).toHaveBeenCalledWith({ t: 'patchPanel', id: 'p1', patch: { x: 'manufacturer', y: null } });
  });

  it('selects a time metric from the right pane without closing the drawer', () => {
    const { fixture, dispatch } = createDrawer('p1');
    fixture.nativeElement.querySelector('[data-column-id="fd_mean"]').dispatchEvent(new MouseEvent('mouseenter'));
    fixture.detectChanges();
    const select = fixture.nativeElement.querySelector('[aria-label="Metric over time (y)"]') as HTMLSelectElement;
    select.value = 'fd_mean';
    select.dispatchEvent(new Event('change'));
    expect(dispatch).toHaveBeenCalledWith({ t: 'patchPanel', id: 'p1', patch: { x: 'created_at', y: 'fd_mean' } });
  });

  it('shows metric descriptions and documented direction on keyboard focus', () => {
    const { fixture } = createDrawer();
    fixture.nativeElement.querySelector('[data-column-id="fd_mean"]').dispatchEvent(new FocusEvent('focus'));
    fixture.detectChanges();
    const details = fixture.nativeElement.querySelector('.column-picker-details');
    expect(details.textContent).toContain('Lower is better');
    expect(details.querySelector('a')?.href).toContain('mriqc.readthedocs.io');
    expect(details.querySelector('[aria-label="Second metric (y)"]')).not.toBeNull();
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
