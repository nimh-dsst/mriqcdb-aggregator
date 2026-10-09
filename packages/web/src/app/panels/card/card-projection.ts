import { Directive, computed, inject, input } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { fieldsFor, metricsFor } from '@mriqc/shared';
import { distinctUntilChanged, map, switchMap } from 'rxjs';
import { Theme } from '../../chrome/theme';
import { Graph } from '../../loop/graph';
import { panelCohort } from '../../slices/cohorts/queries';
import { panelCohorts } from '../../slices/series/queries';
import { studyFormReason } from '../../slices/study/queries';
import { seriesKey } from '../../slices/series/model';
import type { Panel, State } from '../../graph/state';
import { urlState } from '../../url/url';
import { panelView, type PanelView } from '../../slices/panels/view';
import { DARK_THEME, LIGHT_THEME } from '../specs/palette';

/** Control and action data from the same snapshot as the chart projection. */
export function cardControls(state: State, panel: Panel) {
  const { modality, view } = state.global;
  const fields = fieldsFor(modality, view, 'group');
  const date = state.global.filters.find(filter => filter.field === 'created_at' && filter.op === 'between');
  const cohorts = panelCohorts(state, panel);
  const groupActions = [...cohorts];
  for (const descriptor of panel.series) {
    if (descriptor.kind !== 'values' || groupActions.some(cohort => cohort.id === seriesKey(descriptor))) continue;
    groupActions.push({
      ...panelCohort(state, panel), id: seriesKey(descriptor), name: descriptor.values.join(', '),
      filters: [...state.global.filters.filter(filter => filter.field !== descriptor.field),
        { field: descriptor.field, op: 'in', values: descriptor.values }],
    });
  }
  return {
    metrics: metricsFor(modality), fields, groups: state.cohorts,
    fieldValues: Object.fromEntries(fields.map(field => [field.id, state.catalog?.fieldValues[field.id]?.[modality]?.[view] ?? []])),
    studyReady: typeof state.study === 'object' && state.study.status === 'ready',
    studyCapabilityReason: studyFormReason(panel, state),
    dateRange: date?.op === 'between' && typeof date.lo === 'string' && typeof date.hi === 'string'
      ? [date.lo, date.hi] as const : null,
    hasBrush: state.selections.some(selection => selection.from === panel.id),
    groupActions, layout: state.layout ?? undefined, url: urlState(state),
  };
}

export type CardControls = ReturnType<typeof cardControls>;
export type CardView = PanelView & { readonly controls: CardControls };

/** UI subscription edge; components receive a single coherent per-panel input. */
@Directive({ selector: 'app-panel-card', exportAs: 'cardProjection' })
export class CardProjection {
  private readonly graph = inject(Graph);
  private readonly theme = inject(Theme);
  readonly panelId = input.required<string>();
  private readonly parameters = computed(() => ({
    id: this.panelId(), theme: this.theme.mode() === 'dark' ? DARK_THEME : LIGHT_THEME,
  }));
  readonly view = toSignal(toObservable(this.parameters).pipe(
    switchMap(({ id, theme }) => this.graph.state$.pipe(
      map(state => {
        const view = panelView(state, id, theme);
        return view ? { projection: view, controls: cardControls(state, view.panel) } : null;
      }),
      distinctUntilChanged((a, b) => a?.projection === b?.projection && JSON.stringify(a?.controls) === JSON.stringify(b?.controls)),
      map(value => value ? { ...value.projection, controls: value.controls } : null),
    )),
  ), { initialValue: null });
}
