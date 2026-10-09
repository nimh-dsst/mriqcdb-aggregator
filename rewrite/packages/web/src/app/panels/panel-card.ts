import { DecimalPipe } from '@angular/common';
import { A11yModule } from '@angular/cdk/a11y';
import { MatMenuModule } from '@angular/material/menu';
import { DIFFERENCE_HEADERS } from '../view/stats';
import { cohortDialogSize } from '../chrome/cohort-editor';
import {
  ChangeDetectionStrategy,
  afterNextRender,
  Component,
  ElementRef,
  computed,
  inject,
  Injector,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { CdkConnectedOverlay, CdkOverlayOrigin } from '@angular/cdk/overlay';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { MatDialog } from '@angular/material/dialog';
import { MatSelect, MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { asColumnId, fieldsFor, metricsFor } from '@mriqc/shared';
import { LucideAngularModule } from 'lucide-angular';
import { switchMap } from 'rxjs';

import { Theme } from '../chrome/theme';
import { type PanelPatch } from '../graph/commands';
import { Graph } from '../graph/graph';
import { canStack } from '../graph/panels';
import { axisType, FORM_INFO, panelFormAvailability } from '../graph/panel-shapes';
import { type Form, type Panel } from '../graph/state';

import { AxesControls } from './axes-controls';
import { DARK_THEME, LIGHT_THEME } from './specs/palette';
import { SampleTable } from './sample-table';
import {
  type Brush2dRange,
  type BrushRange,
  type VegaInput,
  VegaViewDirective,
} from './vega-view.directive';

import { ColumnPicker } from './column-picker';
import { FormGlyph } from './form-glyphs';
import { studyFormReason } from '../graph/queries';
import { CompareInput } from './compare-input';

type ChartDatum = {
  readonly x: string;
  readonly y: string;
  readonly id?: string;
  readonly cohort?: string;
  readonly series?: string;
};

type LegendItem = {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly n: number | null;
  readonly descriptorKey?: string;
};

type DateFilter =
  | readonly [string, string]
  | { readonly from?: string; readonly to?: string }
  | null
  | undefined;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;

const dimmedSpec = (spec: unknown, isolatedId: string | null): unknown => {
  if (!isolatedId) {
    return spec;
  }

  const copy = structuredClone(spec);
  const test = [
    `datum.id === ${JSON.stringify(isolatedId)}`,
    `datum.cohort === ${JSON.stringify(isolatedId)}`,
    `datum.series === ${JSON.stringify(isolatedId)}`,
    `datum.seriesId === ${JSON.stringify(isolatedId)}`,
  ].join(' || ');
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const record = asRecord(node);
    if (!record) {
      return;
    }

    const encoding = asRecord(record['encoding']);
    if (encoding) {
      encoding['opacity'] = {
        condition: { test, value: 1 },
        value: 0.18,
      };
    }
    Object.values(record).forEach(visit);
  };

  visit(copy);
  return copy;
};

@Component({
  selector: 'app-panel-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AxesControls, DecimalPipe, A11yModule, MatMenuModule,
    CdkConnectedOverlay,
    CdkOverlayOrigin,
    ColumnPicker,
    FormGlyph,
    CompareInput,
    LucideAngularModule,
    MatSelectModule,
    MatTooltipModule,
    SampleTable,
    VegaViewDirective,
  ],
  templateUrl: './panel-card.html',
  styles: `
    :host { container-type: inline-size; display: block; min-width: 0; }
    .form-select { min-width: 130px; min-height: 36px; display: inline-flex; align-items: center; }
    .panel-controls { display: grid; grid-template-columns: minmax(0, 1fr) auto; }
    @container (max-width: 480px) {
      .panel-controls { grid-template-columns: 1fr; }
      .panel-form { justify-self: start; }
    }
  `,
})
export class PanelCard {
  readonly differenceHeaders = DIFFERENCE_HEADERS;
  private readonly graph = inject(Graph);
  private readonly theme = inject(Theme);
  private readonly dialog = inject(MatDialog);
  private readonly injector = inject(Injector);

  readonly panelId = input.required<string>();
  readonly index = input(0);
  readonly count = input(1);
  readonly columns = input(3);
  readonly maximized = input(false);
  readonly removed = output<{ panel: Panel; at: number; title: string }>();

  readonly state = toSignal(this.graph.state$, { requireSync: true });
  private readonly panelTheme = computed(() => ({
    panelId: this.panelId(),
    theme: this.theme.mode() === 'dark' ? DARK_THEME : LIGHT_THEME,
  }));
  readonly view = toSignal(
    toObservable(this.panelTheme).pipe(
      switchMap(({ panelId, theme }) => this.graph.panelView$(panelId, theme)),
    ),
    { initialValue: null },
  );

  readonly columnPickerOpen = signal(false);
  readonly focusSecondMetric = signal(false);
  readonly pendingForm = signal<Form | null>(null);
  private readonly formPickerElement = viewChild<unknown, ElementRef<HTMLElement>>('formPicker', { read: ElementRef });
  private clearFormLinkListeners = () => {};
  readonly optionsOpen = signal(false);
  readonly metricSetOpen = signal(false);
  readonly isolatedId = signal<string | null>(null);
  readonly correlationMetrics = signal<readonly string[]>([]);

  readonly panel = computed(
    () => this.state().panels.find((panel) => panel.id === this.panelId()) ?? null,
  );
  readonly forms = computed(() => {
    const panel = this.panel();
    return panel ? panelFormAvailability(panel).filter(entry => entry.state !== 'hidden') : [];
  });
  readonly formInfo = computed(() => {
    const panel = this.panel();
    return panel ? FORM_INFO[panel.form] : null;
  });
  readonly numericX = computed(() => {
    const panel = this.panel();
    return panel ? axisType(panel.x) === 'numeric' : false;
  });
  readonly timeX = computed(() => {
    const panel = this.panel();
    return panel ? axisType(panel.x) === 'time' : false;
  });
  readonly modality = computed(() => this.state().global.modality);
  readonly selectedView = computed(() => this.state().global.view);
  readonly metrics = computed(() => metricsFor(this.modality()));
  readonly yUnit = computed(() => this.metrics().find(metric => metric.id === this.panel()?.y)?.unit);
  readonly fields = computed(() =>
    fieldsFor(this.modality(), this.selectedView(), 'group'),
  );
  readonly groups = computed(() => this.state().cohorts);
  readonly fieldValues = computed(() => {
    const state = this.state();
    const modality = this.modality();
    const view = this.selectedView();
    return Object.fromEntries(
      this.fields().map((field) => [
        field.id,
        state.catalog?.fieldValues[field.id]?.[modality]?.[view] ?? [],
      ]),
    );
  });
  readonly studyReady = computed(() => {
    const study = this.state().study;
    return typeof study === 'object' && study !== null && study.status === 'ready';
  });
  readonly formWidth = computed(() => Math.max(130, 66 + Math.max(0, ...this.forms().map(entry => FORM_INFO[entry.form].label.length)) * 8));
  readonly studyCapabilityReason = computed(() => this.panel() ? studyFormReason(this.panel()!, this.state()) : null);
  readonly dateRange = computed<readonly [string, string] | null>(() => {
    const date = this.state().global.filters.find(filter => filter.field === 'created_at' && filter.op === 'between');
    return date?.op === 'between' && typeof date.lo === 'string' && typeof date.hi === 'string' ? [date.lo, date.hi] : null;
  });
  readonly legend = computed<readonly LegendItem[]>(
    () => this.view()?.cohorts ?? [],
  );
  readonly vegaInput = computed<VegaInput | null>(() => {
    const view = this.view();
    if (!view) {
      return null;
    }
    const isolatedId = this.isolatedId();
    return {
      specKey: `${view.specKey}:${isolatedId ?? 'all'}`,
      spec: dimmedSpec(view.spec, isolatedId) as VegaInput['spec'],
      live: view.live,
      datasets: view.datasets,
    };
  });

  toggleColumnPicker(): void {
    this.focusSecondMetric.set(false);
    this.pendingForm.set(null);
    this.columnPickerOpen.update((open) => !open);
  }

  addSecondMetric(event: Event, picker: MatSelect, form?: Form): void {
    event.preventDefault();
    event.stopPropagation();
    picker.close();
    this.focusSecondMetric.set(true);
    const linkedForm = event.target instanceof Element
      ? event.target.closest<HTMLElement>('.form-reason')?.dataset['form']
      : undefined;
    this.pendingForm.set(form ?? (linkedForm as Form | undefined) ?? null);
    this.columnPickerOpen.set(true);
  }

  closeColumnPicker(): void {
    this.columnPickerOpen.set(false);
    this.pendingForm.set(null);
  }

  setAxisRange(event: { axis: 'x' | 'y'; range: [number, number] | 'auto' }): void {
    this.graph.dispatch({ t: 'setPanelRange', id: this.panelId(), ...event });
  }

  resetPanelRanges(): void {
    this.graph.dispatch({ t: 'resetPanelRanges', id: this.panelId() });
  }

  prepareFormLinks(open: boolean, picker: MatSelect): void {
    this.clearFormLinkListeners();
    if (open) afterNextRender(() => this.attachFormLinks(picker), { injector: this.injector });
  }

  private attachFormLinks(picker: MatSelect): void {
    if (!picker.panelOpen || !picker.panel) return;
    const panel: HTMLElement = picker.panel.nativeElement;
    const trigger = this.formPickerElement()?.nativeElement;
    // MatSelect normally closes on Tab. Let keyboard users reach the reasons.
    const onKeydown = (event: KeyboardEvent) => {
      const links = Array.from(panel.querySelectorAll<HTMLAnchorElement>('.form-reason'));
      if (!links.length) return;
      const index = links.indexOf(event.target as HTMLAnchorElement);
      if (event.key === 'Tab') {
        const next = index + (event.shiftKey ? -1 : 1);
        if (next >= 0 && next < links.length) {
          event.preventDefault();
          event.stopImmediatePropagation();
          links[next].focus();
        }
      } else if (index >= 0 && event.key !== 'Escape') {
        event.stopImmediatePropagation();
        if (event.key === 'Enter' || event.key === ' ') this.addSecondMetric(event, picker);
      }
    };
    panel.addEventListener('keydown', onKeydown, true);
    trigger?.addEventListener('keydown', onKeydown, true);
    this.clearFormLinkListeners = () => {
      panel.removeEventListener('keydown', onKeydown, true);
      trigger?.removeEventListener('keydown', onKeydown, true);
    };
  }

  changeX(value: string): void {
    this.graph.dispatch({
      t: 'setPanelAxis',
      id: this.panelId(),
      axis: 'x',
      value: value ? (value === 'created_at' ? value : asColumnId(value)) : null,
    });
    this.columnPickerOpen.set(false);
  }

  changeY(value: string): void {
    this.graph.dispatch({
      t: 'setPanelAxis',
      id: this.panelId(),
      axis: 'y',
      value: value ? asColumnId(value) : null,
    });
    this.columnPickerOpen.set(false);
  }

  changeForm(form: Form): void {
    if (!this.forms().some(entry => entry.form === form && entry.state === 'enabled')) return;
    this.graph.dispatch({ t: 'setPanelForm', id: this.panelId(), form });
  }

  patch(patch: PanelPatch): void {
    this.graph.dispatch({ t: 'patchPanel', id: this.panelId(), patch });
  }

  changeOption(event: Event, key: string): void {
    const panel = this.panel();
    if (!panel) {
      return;
    }
    const value = (event.target as HTMLSelectElement).value;
    this.patch({ options: { ...panel.options, [key]: value } });
  }

  changeBooleanOption(event: Event, key: string): void {
    const panel = this.panel();
    if (!panel) {
      return;
    }
    this.patch({
      options: {
        ...panel.options,
        [key]: (event.target as HTMLInputElement).checked,
      },
    });
  }

  changeNumberOption(event: Event, key: string): void {
    const panel = this.panel();
    if (!panel) {
      return;
    }
    this.patch({
      options: {
        ...panel.options,
        [key]: Number((event.target as HTMLInputElement).value),
      },
    });
  }

  formDetails(form: Form) {
    if (form === 'bars' && this.panel() && axisType(this.panel()!.x) === 'categorical') {
      return { ...FORM_INFO.bars, hint: 'Counts in each category' };
    }
    return FORM_INFO[form];
  }

  openMetricSet(): void {
    const panel = this.panel();
    const metrics = (panel?.options as { readonly metrics?: readonly string[] } | undefined)
      ?.metrics;
    this.correlationMetrics.set(metrics ?? []);
    this.metricSetOpen.set(true);
  }

  setCorrelationMetrics(metrics: readonly string[]): void {
    this.correlationMetrics.set(metrics);
  }

  applyMetricSet(): void {
    const panel = this.panel();
    const metrics = this.correlationMetrics();
    if (!panel || metrics.length < 2) {
      return;
    }
    this.patch({
      form: 'matrix',
      options: { ...panel.options, family: 'custom', metrics: metrics.map(asColumnId) },
    });
    this.metricSetOpen.set(false);
    this.columnPickerOpen.set(false);
  }

  addSeries(series: Parameters<CompareInput['added']['emit']>[0]): void {
    this.graph.dispatch({ t: 'addPanelSeries', id: this.panelId(), series });
  }

  removeSeries(key: string): void {
    this.graph.dispatch({ t: 'removePanelSeries', id: this.panelId(), key });
  }

  async createGroup(): Promise<void> {
    const { CohortEditor } = await import('../chrome/cohort-editor');
    this.dialog.open(CohortEditor, {
      ...cohortDialogSize(false),
      data: { mode: 'create', seed: null, convertPanel: this.panelId() },
    });
  }

  toggleIsolated(item: LegendItem): void {
    this.isolatedId.update((current) => (current === item.id ? null : item.id));
  }

  resetIsolation(): void {
    this.isolatedId.set(null);
  }

  removeLegendSeries(item: LegendItem): void {
    if (item.descriptorKey) {
      this.removeSeries(item.descriptorKey);
    }
  }

  onBrush(range: BrushRange): void {
    const panel = this.panel();
    if (panel) {
      this.graph.dispatch({
        t: 'brush',
        from: panel.id,
        metric: asColumnId(String(panel.x)),
        range,
      });
    }
  }

  onBrush2d(ranges: Brush2dRange): void {
    const panel = this.panel();
    if (panel?.y) {
      this.graph.dispatch({
        t: 'brush2d',
        from: panel.id,
        x: asColumnId(String(panel.x)),
        y: panel.y,
        ranges,
      });
    }
  }

  onCell(cell: ChartDatum): void {
    this.patch({
      x: asColumnId(cell.x),
      y: asColumnId(cell.y),
      form: 'heatmap',
    });
  }

  requestPage(cursor: string | null): void {
    this.graph.dispatch({ t: 'requestPage', id: this.panelId(), cursor });
  }

  toggleMaximized(): void {
    this.graph.dispatch({
      t: 'maximizePanel',
      id: this.maximized() ? null : this.panelId(),
    });
  }

  onEscape(): void {
    if (this.maximized()) {
      this.graph.dispatch({ t: 'maximizePanel', id: null });
    }
  }

  removePanel(): void {
    const panel = this.panel();
    if (!panel) {
      return;
    }
    this.graph.dispatch({ t: 'removePanel', id: panel.id });
    this.removed.emit({ panel, at: this.index(), title: this.view()?.title ?? 'Panel' });
  }

  retry(retryKey: string): void {
    this.graph.dispatch({ t: 'retryKey', key: retryKey });
  }

  readonly canStack = computed(() => {
    const panel = this.panel();
    return panel ? canStack(panel) : false;
  });
}
