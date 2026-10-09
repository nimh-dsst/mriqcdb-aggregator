import { TestBed } from '@angular/core/testing';
import { fieldsFor, metricsFor } from '@mriqc/shared';
import { describe, expect, it, vi } from 'vitest';

import { Graph } from '../loop/graph';
import { defaultDashboard } from '../slices/panels/defaults';
import { reduce } from '../loop/reducer';
import { INITIAL_STATE } from '../graph/state';
import { QuestionPicker } from './question-picker';

function create() {
  const dispatch = vi.fn();
  TestBed.configureTestingModule({ imports: [QuestionPicker], providers: [{ provide: Graph, useValue: { dispatch } }] });
  const fixture = TestBed.createComponent(QuestionPicker);
  fixture.componentRef.setInput('metrics', metricsFor('bold'));
  fixture.componentRef.setInput('fields', fieldsFor('bold', 'raw', 'group'));
  fixture.detectChanges();
  return { fixture, dispatch, picker: fixture.componentInstance };
}

describe('question picker', () => {
  it('defaults to FD mean, with tSNR as the second metric', () => {
    const { picker } = create();
    expect(picker.metric()).toBe('fd_mean');
    expect(picker.second()).toBe('tsnr');
  });

  it.each([
    ['distribution', { x: 'fd_mean', y: null, form: 'histogram' }],
    ['by', { x: 'fd_mean', y: null, form: 'box' }],
    ['time', { x: 'created_at', y: 'fd_mean', form: 'band' }],
    ['relate', { x: 'fd_mean', y: 'tsnr', form: 'heatmap' }],
    ['uploads', { x: 'created_at', y: null, form: 'histogram' }],
  ] as const)('turns "%s" into a panel the reducer keeps as asked', (question, expected) => {
    const { picker, dispatch } = create();
    picker.chosen.set(question);
    picker.create();

    const state = reduce(reduce(INITIAL_STATE, { t: 'hydrate', url: defaultDashboard() }), dispatch.mock.calls[0][0]);
    expect(state.panels.at(-1)).toMatchObject(expected);
  });

  it('splits "differ by" on the chosen field', () => {
    const { picker, dispatch } = create();
    picker.chosen.set('by');
    picker.create();
    expect(dispatch.mock.calls[0][0].series).toEqual([{ kind: 'field', field: picker.field() }]);
  });
});
