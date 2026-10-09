import { shapeOf } from '../graph/panel-shapes';
import { AxesControls } from './axes-controls';
import { MetricPicker } from './metric-picker';
import { OverlayModule } from '@angular/cdk/overlay';
import { A11yModule } from '@angular/cdk/a11y';
import { correlationMetrics } from '../graph/correlation-options';
/**
 * One dashboard card: a toolbar that emits commands and a chart that renders a
 * projection. The component holds nothing but the open/closed state of its own
 * menu, which no one else can read.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { MatDialog } from '@angular/material/dialog';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { LucideAngularModule } from 'lucide-angular';
import { switchMap } from 'rxjs/operators';
import {
  asColumnId,
  fieldsFor,
  metricsFor,
  type ClipMode,
  type FieldDef,
  type Granularity,
  type MetricDef,
  type PanelKind,
  type QueryKey,
} from '@mriqc/shared';
import type { CohortEditorData } from '../chrome/cohort-editor';
import { Theme } from '../chrome/theme';
import { DARK_THEME, LIGHT_THEME } from './specs/palette';
import { PHONE_QUERY, matchesMedia } from '../chrome/media';
import { Graph } from '../graph/graph';
import type { CohortChip } from '../graph/cohorts';
import { DIFFERENCE_HEADERS } from '../view/stats';
import { CLIP_CHIP } from '../view/text';
import { chartsFor, PANEL_KINDS, type PanelShape } from '../graph/panel-shapes';
import {
  type CohortId,
  type BoxSort,
  type CoverageWindow,
  type Panel,
  type PanelChart,
  type PanelOptions,
  type PanelId,
  type SplitPresentation,
  type StudyState,
  STUDY_COHORT,
} from '../graph/state';
import { SampleTable } from './sample-table';
import { VegaViewDirective, type BrushRange } from './vega-view.directive';

/** Metrics, grouped the way the catalog families group them. */
export interface MetricGroup {
  label: string;
  metrics: readonly MetricDef[];
}

/** Family, then subfamily, in catalog order. */
export function metricGroups(metrics: readonly MetricDef[]): MetricGroup[] {
  const groups = new Map<string, MetricDef[]>();
  for (const metric of metrics) {
    const label = metric.subfamily ? `${metric.family} · ${metric.subfamily}` : metric.family;
    const bucket = groups.get(label);
    if (bucket) bucket.push(metric);
    else groups.set(label, [metric]);
  }
  return [...groups].map(([label, entries]) => ({ label, metrics: entries }));
}

/** True when the loaded study can answer a panel query for this metric. */
export function studyHasMetric(study: StudyState, metric: string | null): boolean {
  return (
    metric !== null &&
    typeof study === 'object' &&
    study.status === 'ready' &&
    study.metrics.some((candidate) => candidate === metric)
  );
}

/** Only a comparison that actually includes the study restricts its metric picker. */
export function metricMissingFromStudy(
  study: StudyState,
  cohorts: readonly CohortId[] | null | undefined,
  metric: string,
): boolean {
  return (
    cohorts?.includes(STUDY_COHORT) === true &&
    typeof study === 'object' &&
    study.status === 'ready' &&
    !study.metrics.some((candidate) => candidate === metric)
  );
}

/**
 * What each chart does, beside its name.
 *
 * "ECDF" and "Density" are terms of art; the clause after the middle dot is what
 * a reader who does not have them can choose by. The names stay first so a
 * reader who does have them still scans the list by name.
 *
 * Keyed by panel kind as well as chart, because one `box` is "the spread of each
 * manufacturer" on a grouped panel and "the spread of each cohort" on a
 * comparison -- the same mark answering two different questions, and the list is
 * where the reader decides which one they are asking.
 */
const CHART_LABELS: Record<string, string> = {
  'distribution/density': 'Density · smoothed share',
  'distribution/histogram': 'Histogram · scans per value range',
  'distribution/ecdf': 'ECDF · share at or below a value',
  'distribution/box': 'Box · spread per group',
  'grouped/box': 'Box · spread per group',
  'grouped/facetedHistogram': 'Faceted histogram',
  'grouped/facetedEcdf': 'Faceted ECDF',
  'coverage/stackedBar': 'Stacked bars',
  'coverage/area': 'Stacked area',
  'sample/table': 'Table',
  'comparison/density': 'Density · smoothed share',
  'comparison/histogram': 'Histogram · share per value range',
  'comparison/ecdf': 'ECDF · share at or below a value',
  'comparison/box': 'Box · spread per cohort',
};

/**
 * The name alone, for the closed control.
 *
 * The clause above belongs in the open list, where there is room for it and
 * where the reader is choosing. In a 150px trigger it truncates to "Histogram ·
 * scans per…", which is the explanation half-said -- worse than not saying it.
 */
const CHART_NAMES: Record<string, string> = {
  'distribution/density': 'Density',
  'distribution/histogram': 'Histogram',
  'distribution/ecdf': 'ECDF',
  'distribution/box': 'Box',
  'grouped/box': 'Box',
  'grouped/facetedHistogram': 'Faceted histogram',
  'grouped/facetedEcdf': 'Faceted ECDF',
  'coverage/stackedBar': 'Stacked bars',
  'coverage/area': 'Stacked area',
  'sample/table': 'Table',
  'comparison/density': 'Density',
  'comparison/histogram': 'Histogram',
  'grouped/histogram': 'Histogram',
  'comparison/ecdf': 'ECDF',
  'comparison/box': 'Box',
};

/** What a chart is called in the open list, for one panel kind. */
export function chartLabel(kind: PanelShape, chart: PanelChart): string {
  return CHART_LABELS[`${kind}/${chart}`] ?? chartName(kind, chart);
}

/** The same chart's name alone, for the closed control. */
export function chartName(kind: PanelShape, chart: PanelChart): string {
  return CHART_NAMES[`${kind}/${chart}`] ?? ({ density2d: '2D density', scatter: 'Scatter sample', hexbin: 'Hexbin sample', correlation: 'Correlation', clusters: 'Clusters', line: 'Line', medianBand: 'Median band', table: 'Table', density: 'Density per group' } as Partial<Record<PanelChart, string>>)[chart] ?? String(chart);
}

/**
 * The value range the chart is drawn over. Shared with the card's chip
 * (`CLIP_CHIP`), so the chip and the control that produced it read identically.
 */
const CLIP_LABELS: Record<ClipMode, string> = CLIP_CHIP;

@Component({
  selector: 'app-panel-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DecimalPipe,
    MatMenuModule,
    MatProgressSpinnerModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatTooltipModule,
    LucideAngularModule,
    SampleTable,
    VegaViewDirective,
    AxesControls,
    MetricPicker,
    OverlayModule,
    A11yModule,
  ],
  templateUrl: './panel-card.html',
  host: { class: 'block min-w-0 min-h-0' },
})
export class PanelCard {
  protected readonly shapeOf = shapeOf;
  protected readonly metricOpen = signal(false);
  protected readonly families = computed(() => [...new Set(metricsFor(this.chrome()?.modality ?? 'bold').map(m => m.family))]);
  protected readonly allMetrics = computed(() => metricsFor(this.chrome()?.modality ?? 'bold'));
  protected readonly correlationIds = computed(() => this.view() ? correlationMetrics(this.view()!.panel, this.chrome()?.modality ?? 'bold') : []);
  protected readonly correlationChips = computed(() => this.correlationIds().map(id => this.allMetrics().find(metric => metric.id === id)).filter(metric => metric !== undefined));
  protected removeCorrelationMetric(id: string): void { this.analysisOptions({ metrics: this.correlationIds().filter(metric => metric !== id), family: 'custom' }); }
  protected addCorrelationMetric(id: string): void {
    if (this.correlationIds().length < 24 && !this.correlationIds().includes(asColumnId(id))) this.analysisOptions({ metrics: [...this.correlationIds(), asColumnId(id)], family: 'custom' });
  }
  protected readonly activeFamily = computed(() => this.view()?.panel.options.family ?? 'custom');

  protected setSecondMetric(metric: string | null): void {
    this.graph.dispatch({ t: 'setPanelAxis', id: this.panelId(), axis: 'y', value: metric ? asColumnId(metric) : null });
  }
  protected analysisOptions(options: Partial<PanelOptions>): void {
    this.graph.dispatch({ t: 'setPanelOptions', id: this.panelId(), options });
  }
  protected choosePair(pair: { x: string; y: string }): void {
    if (pair.x === pair.y) return;
    this.graph.dispatch({ t: 'patchPanel', id: this.panelId(), patch: {
      x: asColumnId(pair.x), y: asColumnId(pair.y), split: null, chart: 'density2d',
    } });
  }
  private readonly graph = inject(Graph);
  private readonly dialog = inject(MatDialog);

  /**
   * The breakpoint, read here rather than in the click handler: `matchesMedia`
   * registers a teardown with `inject(DestroyRef)`, so it only works where an
   * injection context exists -- a field initializer.
   */
  private readonly phone = matchesMedia(PHONE_QUERY);

  readonly panelId = input.required<PanelId>();
  /** This card's place in the grid, so the toolbar can disable the end moves. */
  readonly index = input.required<number>();
  readonly count = input.required<number>();
  readonly columns = input(3);
  readonly maximized = input(false);
  protected maximize(): void {
    this.graph.dispatch({ t: 'maximizePanel', id: this.maximized() ? null : this.panelId() });
  }
  protected readonly yUnit = computed(() => this.metricGroups().flatMap(group => group.metrics).find(metric => metric.id === this.view()?.panel.y)?.unit);
  protected readonly metricLabel = computed(() => {
    if (this.view()?.panel.x === 'created_at') return 'Upload time';
    const metric = this.metricGroups().flatMap(group => group.metrics).find(metric => metric.id === this.view()?.panel.x);
    return metric?.label ?? 'Metric';
  });
  protected readonly cardTitle = computed(() => {
    const panel = this.view()?.panel;
    if (panel?.chart === 'correlation') return 'Metric correlations';
    const y = this.allMetrics().find(metric => metric.id === panel?.y);
    return y ? `${this.metricLabel()} vs ${y.label}` : this.metricLabel();
  });
  protected readonly disabledMetrics = computed(() => this.allMetrics().filter(metric => this.studyMetricMissing(metric.id)).map(metric => String(metric.id)));
  protected readonly allMetricIds = computed(() => this.allMetrics().map(metric => String(metric.id)));
  protected readonly correlationDisabledMetrics = computed(() => [...this.disabledMetrics(), ...this.correlationIds()]);
  protected readonly metricDocs = computed(() => this.allMetrics().find(metric => metric.id === this.view()?.panel.x)?.docsUrl
    ?? `https://mriqc.readthedocs.io/en/latest/iqms/${this.chrome()?.modality === 'bold' ? 'bold' : 't1w'}.html`);

  /**
   * What was removed and from where, for the page's undo snackbar. The card
   * still dispatches the removal itself -- this is the notice, not the
   * command -- because only the page can own a toast that outlives the card.
   */
  readonly removed = output<{ panel: Panel; at: number; title: string }>();

  private readonly theme = inject(Theme);
  private readonly renderInput = computed(() => ({ id: this.panelId(), theme: this.theme.mode() === 'dark' ? DARK_THEME : LIGHT_THEME }));
  protected readonly view = toSignal(
    toObservable(this.renderInput).pipe(switchMap(({ id, theme }) => this.graph.panelView$(id, theme))),
  );
  protected readonly chrome = toSignal(this.graph.chrome$);

  protected readonly chartLabel = chartLabel;
  protected readonly chartName = chartName;
  protected readonly differenceHeaders = DIFFERENCE_HEADERS;
  protected readonly clipModes: readonly ClipMode[] = ['p01p99', 'p05p95', 'none'];
  protected readonly clipLabels = CLIP_LABELS;
  protected readonly binChoices: readonly number[] = [10, 20, 30, 40, 60, 80, 120, 200];
  protected readonly granularities: readonly Granularity[] = ['day', 'week', 'month', 'year'];
  protected readonly coverageWindows: readonly CoverageWindow[] = ['12m', '5y', 'all', 'custom'];
  protected readonly boxSorts: readonly BoxSort[] = ['median', 'n'];

  protected readonly metricGroups = computed<MetricGroup[]>(() => {
    const chrome = this.chrome();
    return chrome ? metricGroups(metricsFor(chrome.modality)) : [];
  });

  protected readonly groupFields = computed<readonly FieldDef[]>(() => {
    const chrome = this.chrome();
    return chrome ? fieldsFor(chrome.modality, chrome.view, 'group') : [];
  });

  /**
   * The split field's own name, for the control's `title`.
   *
   * The three controls share one row in fixed proportions, so "Motion
   * correction" in a quarter of a 507px card ellipsizes; the whole string has
   * to be reachable, and a native `title` is the one place it fits.
   */
  protected readonly groupLabel = computed(() => {
    const group = this.view()?.panel.split ?? null;
    if (group === null) return 'No split';
    return this.groupFields().find((field) => field.id === group)?.label ?? String(group);
  });

  protected readonly charts = computed<readonly PanelChart[]>(() => {
    const panel = this.view()?.panel;
    if (!panel) return [];
    const available = chartsFor(shapeOf({ ...panel, chart: 'histogram' }));
    const forms: PanelChart[] = panel.x === 'created_at' ? ['stackedBar', 'line', 'medianBand'] : panel.split !== null
      ? ['histogram', 'density', 'facetedEcdf', 'box', 'table'] : available.filter(chart => chart !== 'correlation' &&
      !(panel.y !== null && chart === 'table') &&
      !(panel.x === 'created_at' && (chart === 'area' || chart === 'table')));
    return forms.includes(panel.chart) ? forms : [...forms, panel.chart];
  });
  protected chartFormName(chart: PanelChart): string {
    return ({ density2d: 'Density', scatter: 'Scatter', hexbin: 'Hexbin', stackedBar: 'Bars', density: 'Density', facetedEcdf: 'ECDF' } as Partial<Record<PanelChart, string>>)[chart] ?? chartName(shapeOf(this.view()!.panel), chart);
  }
  protected chartAvailable(chart: PanelChart): boolean {
    const panel = this.view()?.panel;
    return !!panel && chartsFor(shapeOf({ ...panel, chart: 'histogram' })).includes(chart);
  }
  protected chartTip(chart: PanelChart): string {
    if (this.chartAvailable(chart)) return this.chartFormName(chart);
    return chart === 'medianBand' ? 'Median band · choose a second metric (y)' : `${this.chartFormName(chart)} · remove the second metric (y)`;
  }
  protected chartIcon(chart: PanelChart): string {
    return ({ histogram: 'chart-column', density: 'chart-spline', ecdf: 'chart-no-axes-combined', box: 'chart-candlestick', table: 'table-2',
      density2d: 'grid-2x2', scatter: 'chart-scatter', hexbin: 'hexagon', clusters: 'shapes',
      stackedBar: 'chart-column-stacked', line: 'chart-line', medianBand: 'chart-area', area: 'chart-area',
      facetedHistogram: 'panels-top-left', facetedEcdf: 'panels-top-left' } as Partial<Record<PanelChart, string>>)[chart] ?? 'chart-column';
  }

  /* ------------------------------------------------------------- cohorts */

  protected readonly cohortChips = toSignal(this.graph.cohorts$, { initialValue: [] });

  /** Every non-comparison card can follow the dashboard, all data, or one saved scope. */
  protected readonly showOptions = computed<readonly CohortChip[]>(() => {
    const entries = this.cohortChips();
    return [entries.find(entry => entry.cohort.id === 'current'),
      ...entries.filter(entry => !['current', 'all', STUDY_COHORT].includes(entry.cohort.id)),
      entries.find(entry => entry.cohort.id === STUDY_COHORT), entries.find(entry => entry.cohort.id === 'all')]
      .filter((entry): entry is CohortChip => entry !== undefined);
  });
  protected readonly compareValue = computed(() => this.view()?.panel.cohorts.length === 1 ? this.view()!.panel.cohorts[0] : 'multiple');
  protected readonly compareLabel = computed(() => this.compareValue() === 'multiple'
    ? `${this.view()?.panel.cohorts.length} cohorts`
    : this.showOptions().find(entry => entry.cohort.id === this.compareValue())?.cohort.name ?? 'This dashboard');
  protected cohortUnavailable(id: string): boolean {
    const panel = this.view()?.panel;
    const study = this.chrome()?.study ?? 'none';
    return id === STUDY_COHORT && (!panel || (panel.x !== 'created_at' && !studyHasMetric(study, panel.x)) || (panel.y !== null && !studyHasMetric(study, panel.y)));
  }
  protected selectCompare(value: string): void {
    if (value === 'new') this.compareWithNew();
    else this.setCohort(value);
  }

  /**
   * What "Compare with… / Add cohort…" offers: Whole population, This dashboard,
   * every saved cohort, and -- on a panel that is split -- every group of the
   * split field, minus whatever the panel already draws.
   *
   * "This dashboard" is left out of a *distribution* panel's list because it is
   * the panel itself: converting always opens on `current` plus the chosen
   * cohort, so offering it would mean comparing the dashboard with itself.
   */
  protected readonly compareOptions = computed<readonly CohortChip[]>(() => {
    const panel = this.view()?.panel;
    if (!panel) return [];
    const already = new Set<CohortId>(panel.cohorts ?? []);
    const saved = this.cohortChips().filter((entry) => {
      if (already.has(entry.cohort.id)) return false;
      if (entry.cohort.id === STUDY_COHORT) {
        return studyHasMetric(this.chrome()?.study ?? 'none', panel.x);
      }
      return PANEL_KINDS[shapeOf(panel)].supportsCohorts || entry.cohort.id !== 'current';
    });
    const groups = (this.view()?.splitCohorts ?? []).filter(
      (entry) => !already.has(entry.cohort.id),
    );
    return [...saved, ...groups];
  });

  /** The direct path from a single distribution to a comparison with the uploaded study. */
  protected readonly canAddStudy = computed(() => {
    const panel = this.view()?.panel;
    return (
      panel && shapeOf(panel) === 'distribution' && studyHasMetric(this.chrome()?.study ?? 'none', panel.x)
    );
  });

  protected addStudy(): void {
    if (!this.canAddStudy()) return;
    this.graph.dispatch({
      t: 'convertToComparison',
      panelId: this.panelId(),
      with: STUDY_COHORT,
    });
  }

  /** Missing study columns stay visible in a comparison picker, but cannot be selected. */
  protected studyMetricMissing(metric: string): boolean {
    const panel = this.view()?.panel;
    if (!panel) return false;
    return metricMissingFromStudy(this.chrome()?.study ?? 'none', panel.cohorts, metric);
  }

  /** The groups of this panel's split field, for the tick-and-compare row. */
  protected readonly splitGroups = computed<readonly CohortChip[]>(
    () => this.view()?.splitCohorts ?? [],
  );

  /**
   * Which split groups the reader has ticked.
   *
   * Ephemeral UI: it decides nothing until "Compare selected" is pressed, it is
   * not in the URL, and it must not survive a reload. The command it produces
   * carries the whole list at once, so the panel never passes through a state
   * comparing something nobody asked for.
   */
  protected readonly picked = signal<ReadonlySet<CohortId>>(new Set());

  protected togglePicked(id: CohortId): void {
    this.picked.update((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  protected isPicked(id: CohortId): boolean {
    return this.picked().has(id);
  }

  protected readonly pickedCount = computed(() => this.picked().size);

  /** Turn the ticked groups into a comparison of exactly those groups. */
  protected compareSelected(): void {
    const chosen = [...this.picked()].filter((id) =>
      this.splitGroups().some((entry) => entry.cohort.id === id),
    );
    if (chosen.length < 2) return;
    this.graph.dispatch({ t: 'convertToComparison', panelId: this.panelId(), with: chosen });
    this.picked.set(new Set());
  }

  /**
   * Whether the all-pairs KS table is showing.
   *
   * Ephemeral UI, like "More filters": it reveals a table of figures the card
   * already holds and changes nothing about what is being compared.
   */
  protected readonly allPairs = signal(false);

  protected toggleAllPairs(): void {
    this.allPairs.update((open) => !open);
  }

  /** True for a panel "Compare with…" can act on: one metric, not a table or a timeline. */
  protected readonly comparable = computed(() => {
    const panel = this.view()?.panel;
    if (!panel) return false;
    const def = PANEL_KINDS[shapeOf(panel)];
    // Already a comparison, or the one kind a single "Compare with…" can
    // convert: one metric, one series, no split. A *split* panel offers
    // "Compare selected (n)" over its groups instead, and a kind that needs a
    // split has no single series to compare at all.
    return def.supportsCohorts || (def.supportsSplit && !def.needsGroup && panel.split === null);
  });

  protected compareWith(id: CohortId): void {
    this.graph.dispatch({ t: 'convertToComparison', panelId: this.panelId(), with: id });
  }

  /**
   * "New cohort…": the editor, told which panel to convert once the cohort
   * exists. It is the dialog that dispatches both commands, because only it
   * knows the id it minted.
   */
  /**
   * Save the dashboard as a cohort and compare this panel against it, in one
   * click and with no dialog.
   *
   * Two commands, and the id is not predicted: the reducer mints it, and the
   * panel is pointed at whatever the cohort list gained. Reading it back out of
   * the next `cohorts$` emission is what keeps the component from having to
   * guess what `mintCohortId` would have produced.
   */
  protected compareWithSavedCurrent(): void {
    const before = new Set(this.cohortChips().map((entry) => entry.cohort.id));
    this.graph.dispatch({ t: 'saveCurrentAsCohort' });
    const added = this.cohortChips().find((entry) => !before.has(entry.cohort.id));
    if (!added) return;
    this.graph.dispatch({
      t: 'convertToComparison',
      panelId: this.panelId(),
      with: added.cohort.id,
    });
  }

  protected compareWithNew(): void {
    const data: CohortEditorData = {
      mode: 'create',
      seed: null,
      convertPanel: this.panelId(),
    };
    // Loaded on demand, for the reason `cohort-bar.ts` gives: it is a dialog
    // most sessions never open and it is the size of the top bar.
    const phone = this.phone();
    void import('../chrome/cohort-editor').then(({ CohortEditor, cohortDialogSize }) => {
      this.dialog.open(CohortEditor, {
        data,
        ariaLabel: 'Compare with a cohort',
        ...cohortDialogSize(phone),
        autoFocus: 'dialog',
        restoreFocus: true,
      });
    });
  }

  /** Which cohort the differences block subtracts from. */
  protected setReference(cohort: CohortId): void {
    this.graph.dispatch({ t: 'setPanelReference', id: this.panelId(), cohort });
  }

  /** Take one cohort off this panel. The cohort itself is untouched. */
  protected removeCohort(cohort: CohortId): void {
    this.graph.dispatch({ t: 'removePanelCohort', panelId: this.panelId(), cohort });
  }

  /** "Back to single distribution": this dashboard, one metric, no cohorts. */
  protected backToSingle(): void {
    this.graph.dispatch({ t: 'revertPanelToSingle', id: this.panelId() });
  }

  /**
   * Whether the chart area grows with its content instead of filling 260px.
   *
   * Everything else fills the box, axis bands included. These three size
   * themselves by how many groups the data has -- one 22px row per box, a 110px
   * cell per facet -- so fourteen manufacturers are already 308px. Clipping
   * that to 260px puts the chart's own value axis below the fold, which is
   * worse than a taller card, so for these the 260px is a floor.
   */
  protected readonly grows = computed(() => {
    const panel = this.view()?.panel;
    if (!panel) return false;
    return (
      panel.chart === 'box' ||
      panel.chart === 'facetedHistogram' ||
      panel.chart === 'facetedEcdf' ||
      (panel.y !== null && panel.cohorts.length > 3 && panel.chart !== 'clusters' && panel.chart !== 'table') ||
      (shapeOf(panel) === 'grouped' &&
        panel.split !== null &&
        panel.options.splitPresentation === 'facets')
    );
  });

  protected setMetric(metric: string): void {
    this.graph.dispatch({ t: 'setPanelAxis', id: this.panelId(), axis: 'x', value: metric === 'created_at' ? 'created_at' : asColumnId(metric) });
  }

  protected setChart(chart: PanelChart): void {
    this.graph.dispatch({ t: 'setPanelChart', id: this.panelId(), chart });
  }

  protected setGroup(group: string | null): void {
    this.graph.dispatch({
      t: 'setPanelSplit',
      id: this.panelId(),
      split: group ? asColumnId(group) : null,
    });
  }

  protected setBins(bins: number): void {
    this.graph.dispatch({ t: 'setPanelOptions', id: this.panelId(), options: { bins } });
  }

  protected setClip(clip: ClipMode): void {
    this.graph.dispatch({ t: 'setPanelOptions', id: this.panelId(), options: { clip } });
  }

  protected setGranularity(granularity: Granularity): void {
    this.graph.dispatch({ t: 'setPanelOptions', id: this.panelId(), options: { granularity } });
  }

  protected setCohort(cohort: CohortId): void {
    this.graph.dispatch({ t: 'setPanelCohort', id: this.panelId(), cohort });
  }

  protected setSplitPresentation(splitPresentation: SplitPresentation): void {
    this.graph.dispatch({
      t: 'setPanelOptions',
      id: this.panelId(),
      options: { splitPresentation },
    });
  }

  protected setBoxSort(boxSort: BoxSort): void {
    this.graph.dispatch({ t: 'setPanelOptions', id: this.panelId(), options: { boxSort } });
  }

  protected toggleCumulative(cumulative: boolean): void {
    this.graph.dispatch({ t: 'setPanelOptions', id: this.panelId(), options: { cumulative } });
  }

  protected toggleShare(share: boolean): void {
    this.graph.dispatch({ t: 'setPanelOptions', id: this.panelId(), options: { share } });
  }

  protected setCoverageWindow(coverageWindow: CoverageWindow): void {
    this.graph.dispatch({ t: 'setPanelOptions', id: this.panelId(), options: { coverageWindow } });
  }

  protected setCoverageCustom(at: 0 | 1, value: string): void {
    const current = this.view()?.panel.options.coverageCustom ?? ['', ''];
    const coverageCustom: [string, string] = at === 0 ? [value, current[1]] : [current[0], value];
    this.graph.dispatch({ t: 'setPanelOptions', id: this.panelId(), options: { coverageCustom } });
  }

  protected toggleCoverageLogY(coverageLogY: boolean): void {
    this.graph.dispatch({ t: 'setPanelOptions', id: this.panelId(), options: { coverageLogY } });
  }


  protected toggleSelection(useSelection: boolean): void {
    this.graph.dispatch({ t: 'setPanelOptions', id: this.panelId(), options: { useSelection } });
  }

  protected remove(): void {
    const view = this.view();
    if (view) this.removed.emit({ panel: view.panel, at: this.index(), title: view.title });
    this.graph.dispatch({ t: 'removePanel', id: this.panelId() });
  }

  /**
   * Forget the failed entries behind this panel so `needed` asks for them
   * again. One command per key, because a comparison panel can fail on either
   * half and the reader asked for the panel, not for one of its queries.
   */
  protected retry(keys: readonly string[]): void {
    for (const key of keys) this.graph.dispatch({ t: 'retryKey', key: key as QueryKey });
  }

  protected requestPage(cursor: string | null): void {
    this.graph.dispatch({ t: 'requestPage', id: this.panelId(), cursor });
  }

  protected onBrush2d(ranges: import('./vega-view.directive').Brush2dRange): void {
    const panel = this.view()?.panel;
    if (!panel || panel.x === 'created_at' || !panel.y) return;
    this.graph.dispatch({ t: 'brush2d', from: panel.id, x: panel.x, y: panel.y, ranges });
  }

  protected onBrush(range: BrushRange): void {
    const panel = this.view()?.panel;
    if (!panel?.x || panel.x === 'created_at') return;
    this.graph.dispatch({ t: 'brush', from: panel.id, metric: panel.x, range });
  }
}
