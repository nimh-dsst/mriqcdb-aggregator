/**
 * The global controls and the status line.
 *
 * It owns no state: the form belongs to the graph, and everything it shows is
 * the `chrome` projection. Binding `[formGroup]="graph.form"` is what makes
 * Angular's reactive forms a command source rather than a second store.
 */

import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { ReactiveFormsModule } from '@angular/forms';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { LucideAngularModule } from 'lucide-angular';
import { MODALITIES, viewsFor, type Filter, type ViewDef } from '@mriqc/shared';
import { Graph } from '../graph/graph';
import { emptyFilterControls, emptyNumericControls } from './controls-form';
import { MAX_COHORTS } from '../graph/state';
import { CATALOG_KEY } from '../graph/queries';
import { significant } from '../view/text';
import type { FilterFieldView, NumericFieldView } from '../view/chrome-view';
import { environment, useMockApi } from '../../environments/environment';
import { FilterSelect } from './filter-select';
import { RouterLink } from '@angular/router';
import { ThemeToggle } from './theme-toggle';
import { PHONE_QUERY, matchesMedia } from './media';
import { ExportDialog } from './export-dialog';

const MODALITY_LABELS: Record<string, string> = {
  bold: 'BOLD (functional)',
  T1w: 'T1-weighted',
  T2w: 'T2-weighted',
};

/**
 * What a filter field's name does not say on its own, for a researcher who has
 * never read the code (`docs/ui-style.md`, "Text is for people"). Keyed by
 * field id and held here rather than in the catalog, because it is UI copy and
 * nothing else reads it.
 */
const FIELD_TOOLTIPS: Record<string, string> = {
  canonical_diameter:
    'The largest within-group metric range divided by its frozen reference IQR. ' +
    'Near zero means repeat runs agree; larger values mean more run-to-run disagreement.',
  canonical_group_rows:
    'How many raw uploads were collapsed into this one record. 1 means the scan was ' +
    'uploaded once.',
  canonical_hmc_mode: 'Which head-motion correction MRIQC ran for this scan.',
};

/**
 * How long the "Data updated" chip stays up after the ingest version changes.
 *
 * The dashboard already refetches by itself -- the effects runner diffs
 * `(key, version)` pairs and restarts everything on a version change -- so
 * there is nothing for the user to click. The chip reports that it happened and
 * then gets out of the way; it is not an offer to refresh.
 */
export const DATA_UPDATED_MS = 8000;

/** The date field the range picker owns, which lives in "More filters" with the ranges. */
export const DATE_FILTER_FIELD = 'created_at';

/**
 * How many of "More filters"'s own controls are in force: the two-ended numeric
 * ranges of the current view, the upload-date range, and the long-tail
 * categorical selects that live down there with them.
 *
 * Counted off the filters the graph holds rather than off the form, so it counts
 * what the dashboard is actually filtered by -- including what arrived in a
 * shared link -- and so the badge and the auto-expand cannot disagree. The
 * secondary selects are in the count for the same reason the ranges are: a
 * dashboard filtered by one of them must not hide the control that says so.
 */
export function moreFilterCount(
  filters: readonly Filter[],
  numericFields: readonly NumericFieldView[],
  secondaryFields: readonly FilterFieldView[] = [],
): number {
  const owned = new Set<string>([
    DATE_FILTER_FIELD,
    ...numericFields.map((entry) => entry.field.id as string),
    ...secondaryFields.map((entry) => entry.field.id as string),
  ]);
  return filters.filter((filter) => owned.has(filter.field as string)).length;
}

/**
 * What the collapsed `Filters (N active)` button counts: everything in force.
 *
 * The brush is one of them. It drops four panels from 778,075 rows to 102,020
 * and "Clear filters" already clears it, so a button that claimed `0 active`
 * while a brush was narrowing the page was simply wrong -- and on a phone that
 * button is the only thing on screen while the group is shut.
 */
export function activeFilterCount(filters: readonly Filter[], brushed: boolean | number): number {
  return filters.length + (typeof brushed === 'number' ? brushed : brushed ? 1 : 0);
}

/**
 * Whether the section is open: the user's own last click if they made one,
 * otherwise open exactly when something inside it is filtering.
 *
 * Eleven range pairs took three rows of the top bar and pushed the panels off
 * the first screen, so they are collapsed by default -- but a dashboard that
 * *is* range-filtered must not hide the control that says so, which is what the
 * fallback does. An explicit click wins either way, so a user who closes the
 * section keeps it closed.
 */
export function moreFiltersExpanded(toggled: boolean | null, activeCount: number): boolean {
  return toggled ?? activeCount > 0;
}

/** Day, short month, year -- `6 Aug 2026` -- read in UTC, like the bounds. */
const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * The status line's headline: how current the data is, in words.
 *
 * "Uploads through 6 Aug 2026" and not "Data from 6 Aug 2026": the date is the
 * newest upload in the database, so "from" read as the start of a range to
 * everyone who met it beside a date-range filter. The ingest hash it replaces
 * is not gone, only moved -- it is the tooltip on this text
 * (`docs/ui-style.md`, "Copy"). `created_at` bounds are UTC instants, so the
 * day is read in UTC and not in the reader's zone, where an upload logged at
 * 23:30Z would show as the day before.
 */
export function uploadDateLabel(iso: string | null): string {
  if (iso === null) return 'Upload date unknown';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Upload date unknown';
  return `Uploads through ${DATE_FORMAT.format(date)}`;
}

/**
 * What the "N unstable groups left out" chip says on hover: the uploads inside
 * those groups, and the one-line definition of what an unstable group is.
 *
 * The chip itself is one short fact about this view. Everything that explains
 * the fact is here, because standing prose under a control is the thing this
 * pass removed.
 */
export function quarantineTip(counts: { groups: number; rows: number } | null): string {
  if (counts === null) return '';
  const rows = counts.rows.toLocaleString('en-US');
  return (
    `${rows} uploads. An unstable group is a set of repeat uploads of one scan ` +
    'that the deduplication could not reduce to a single record with confidence, ' +
    'so none of them are in the figures on this page.'
  );
}

/**
 * What the status line says *instead* of the data date, or null when there is
 * nothing to report and the date can have the line.
 *
 * Only the states a reader can act on: still arriving, or something failed.
 * "up to date" was neither -- it told the reader what the absence of the other
 * two already told them -- so it is gone and the date took its place.
 */
export function busyLine(
  chrome:
    | {
        catalogReady: boolean;
        catalogError: string | null;
        errorCount: number;
        pendingCount: number;
      }
    | undefined,
): string | null {
  if (!chrome) return 'Starting';
  // A failed catalogue is not a slow one. The line used to say "Loading the
  // metric catalogue" for the rest of the session, which was the single most
  // misleading string on the page: nothing was loading and nothing ever would.
  if (chrome.catalogError !== null) return "Couldn't load the metric catalogue";
  if (!chrome.catalogReady) return 'Loading the metric catalogue';
  if (chrome.errorCount > 0) {
    return `${chrome.errorCount} panel${chrome.errorCount === 1 ? '' : 's'} could not load`;
  }
  if (chrome.pendingCount > 0) {
    return `Loading ${chrome.pendingCount} panel${chrome.pendingCount === 1 ? '' : 's'}`;
  }
  return null;
}

/**
 * What "Records shown" is actually choosing between, in one line.
 *
 * "Deduplicated (K4+)" named a policy nobody outside this repository has heard
 * of and said nothing about what it does to the numbers. The three answers are
 * authored off the `ViewDef` rather than keyed by view id, so a fourth view
 * gets a sentence without a fourth branch here.
 */
export function viewHelp(view: ViewDef | undefined): string {
  if (!view) return '';
  if (view.policy === undefined) return 'Every upload as received';
  const merged = `One record per scan; repeated uploads of the same file merged (${view.policy})`;
  return view.includesQuarantined === true
    ? `${merged}, plus the raw uploads of groups the policy refused`
    : merged;
}

/** The compact coverage phrase used by the uploaded-study dialog. */
export function studyMetricSummary(study: {
  metrics: readonly unknown[];
  totalMetrics: number;
}): string {
  return `${study.metrics.length.toLocaleString('en-US')} of ${study.totalMetrics.toLocaleString(
    'en-US',
  )} metrics`;
}

@Component({
  selector: 'app-top-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DecimalPipe,
    NgTemplateOutlet,
    ReactiveFormsModule,
    MatDatepickerModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatTooltipModule,
    LucideAngularModule,
    FilterSelect,
    RouterLink,
    ThemeToggle,
    ExportDialog,
  ],
  templateUrl: './top-bar.html',
})
export class TopBar {
  private readonly dialog = inject(MatDialog);
  protected readonly exportOpen = signal(false);
  protected readonly graph = inject(Graph);
  protected readonly chrome = toSignal(this.graph.chrome$);
  protected readonly modalities = MODALITIES;
  protected readonly modalityLabels = MODALITY_LABELS;

  /**
   * Whether the numbers on screen are fabricated. Fixed for the life of the
   * page -- the `Api` was chosen once, at the composition root -- so it is a
   * constant here and not a projection.
   */
  protected readonly mock = useMockApi();

  /** The upload path is build-time gated, while the loaded study itself belongs to the graph. */
  protected readonly studyUpload = environment.features.studyUpload;
  protected readonly study = computed(() => this.chrome()?.study ?? 'none');
  protected readonly studyDialogOpen = signal(false);
  protected readonly selectedStudyName = signal<string | null>(null);
  protected readonly notice = computed(() => this.chrome()?.notice ?? null);

  protected readonly studyMetricSummary = studyMetricSummary;

  protected openStudyDialog(): void {
    this.studyDialogOpen.set(true);
  }

  protected closeStudyDialog(): void {
    this.studyDialogOpen.set(false);
  }

  protected chooseStudy(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.selectedStudyName.set(file.name);
    this.graph.dispatch({ t: 'studyChosen', file });
    // Choosing the same file again after an error must still emit `change`.
    input.value = '';
  }

  protected clearStudy(): void {
    this.graph.dispatch({ t: 'clearStudy' });
    this.selectedStudyName.set(null);
  }

  /** The primary filter row: the everyday categorical fields of this view. */
  protected readonly filterFields = computed(() => this.chrome()?.filterFields ?? []);

  /** The long-tail categorical fields, which render inside "More filters". */
  protected readonly secondaryFields = computed(() => this.chrome()?.secondaryFields ?? []);

  /** The numeric filterable fields of the current modality and view, with their bounds. */
  protected readonly numericFields = computed(() => this.chrome()?.numericFields ?? []);

  /**
   * The user's own open/closed choice for "More filters", or null while they
   * have not made one. Ephemeral: it decides nothing about what the dashboard
   * shows, so it is a local signal and never reaches the graph or the URL.
   */
  private readonly moreToggled = signal<boolean | null>(null);

  /** How many filters the collapsed section is holding, for its badge. */
  protected readonly moreCount = computed(() =>
    moreFilterCount(this.chrome()?.filters ?? [], this.numericFields(), this.secondaryFields()),
  );

  /** Whether the section is showing. */
  protected readonly moreOpen = computed(() =>
    moreFiltersExpanded(this.moreToggled(), this.moreCount()),
  );

  protected toggleMore(): void {
    this.moreToggled.set(!this.moreOpen());
  }

  /* --------------------------------------------------------------- cohorts */

  private readonly cohortChips = toSignal(this.graph.cohorts$, { initialValue: [] });

  /** True at the cohort cap, where the save action is disabled rather than silent. */
  protected readonly cohortsFull = computed(
    () => this.cohortChips().filter((entry) => entry.editable).length >= MAX_COHORTS,
  );

  /**
   * The one-click path: the dashboard, as a cohort, named after itself.
   *
   * No dialog, because there is nothing to ask -- the view, the filters and the
   * brush are already chosen, and the name composes from exactly those
   * (`cohortAutoName`). It sits in this row because this row is where those
   * three were chosen.
   */
  protected saveAsCohort(): void {
    void import('./cohort-editor').then(({ CohortEditor, cohortDialogSize }) => {
      this.dialog.open(CohortEditor, { ...cohortDialogSize(this.phone()), ariaLabel: 'Save as group',
        data: { mode: 'create', seed: null, convertPanel: null } });
    });
  }

  /** What the active policy refused, shown under the view select. Null off a canonical view. */
  protected readonly quarantine = computed(() => this.chrome()?.quarantine ?? null);

  /* ----------------------------------------------------- the phone layout */

  /**
   * True under 700px, where the whole filter group -- the categorical selects,
   * "More filters" and "Clear filters" -- hides behind one button.
   *
   * At 390px the bar was 835px tall: a full screen of controls before a single
   * number. Modality and "Records shown" stay out, because they are the two
   * that change what every figure means.
   */
  protected readonly phone = matchesMedia(PHONE_QUERY);

  /** Whether the collapsed filter group is showing. Ephemeral, phone only. */
  protected readonly filtersOpen = signal(false);

  /** Everything in force, for the collapsed button's count -- the brush included. */
  protected readonly filterCount = computed(() =>
    activeFilterCount(this.chrome()?.filters ?? [], this.brushes().length),
  );

  protected toggleFilters(): void {
    this.filtersOpen.update((open) => !open);
  }

  /** True when the filter group is on screen: always on desktop, on request on a phone. */
  protected readonly filtersShown = computed(() => !this.phone() || this.filtersOpen());

  /* ------------------------------------------------- what the view means */

  /** The `ViewDef` the user is on, for its one-line explanation. */
  private readonly activeView = computed<ViewDef | undefined>(() => {
    const chrome = this.chrome();
    if (!chrome) return undefined;
    return viewsFor(chrome.modality).find((view) => view.id === chrome.view);
  });

  /**
   * What "Scans shown" is choosing between. The select's own tooltip now, not a
   * line of prose under it: it explains the control rather than stating a fact
   * about the data, and explanations live on demand.
   */
  protected readonly viewHelpText = computed(() => viewHelp(this.activeView()));

  /** The hover text of the quarantine chip. */
  protected readonly quarantineTip = computed(() => quarantineTip(this.quarantine()));

  /* -------------------------------------------------------- the brushed range */

  /** The brushed interval, or null. Rendered as an amber chip that clears it. */
  protected readonly brushes = computed(() => this.chrome()?.brushes ?? []);

  /** Drop the linked selection. The reducer ignores `from` and `metric` on a null range. */
  protected clearBrush(brush: { from: string; metric: import('../graph/state').MetricId }): void {
    this.graph.dispatch({ t: 'brush', from: brush.from, metric: brush.metric, range: null });
  }

  /* ------------------------------------------------------- a failed catalogue */

  /** Why the catalogue is missing, or null. */
  protected readonly catalogError = computed(() => this.chrome()?.catalogError ?? null);

  /** Forget the failed entry so `needed` asks for the catalogue again. */
  protected retryCatalog(): void {
    this.graph.dispatch({ t: 'retryKey', key: CATALOG_KEY });
  }

  /* ----------------------------------------------------------- "About this data" */

  /**
   * What a range box shows while it is empty: the bound the column actually
   * reaches, so an empty box reads as "everything from here" rather than as a
   * blank the user has to guess at. Three significant digits, like the stat row;
   * `--` while the catalog has nothing to say.
   */
  protected bound(entry: NumericFieldView, end: 'min' | 'max'): string {
    return significant(entry.range?.[end]);
  }

  /** What the line says while something is arriving or has failed; else null. */
  protected readonly busyText = computed(() => busyLine(this.chrome()));

  /** The dot beside it: amber while working, the error colour when something broke. */
  protected readonly statusClass = computed(() =>
    (this.chrome()?.errorCount ?? 0) > 0 ? 'bg-danger' : 'bg-highlight',
  );

  /** "Data from 6 Aug 2026", the line's resting state. */
  protected readonly dataDateText = computed(() =>
    uploadDateLabel(this.chrome()?.dataDate ?? null),
  );

  /** The ingest hash, which is a tooltip and never on screen. */
  protected readonly versionTooltip = computed(() => {
    const version = this.chrome()?.dataVersion;
    return version ? `Newest upload in the database. Ingest version ${version}.` : '';
  });

  /** The tooltip a filter's name carries, or '' for a name that explains itself. */
  protected fieldTip(fieldId: string): string {
    return FIELD_TOOLTIPS[fieldId] ?? '';
  }

  /**
   * True for a few seconds after the ingest version changed under the page.
   *
   * The runner has already cancelled and restarted every fetch by the time this
   * flips, so the chip is a notice and not a button. The version it has seen is
   * instance state rather than a signal read inside the effect, so the effect
   * depends on `chrome()` alone and cannot re-run itself.
   */
  protected readonly refreshed = signal(false);

  private seenVersion: string | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    });
    effect(() => {
      const version = this.chrome()?.dataVersion ?? null;
      if (version === null) return;
      untracked(() => {
        // The first version this page ever saw is not an update.
        if (this.seenVersion === null || this.seenVersion === version) {
          this.seenVersion = version;
          return;
        }
        this.seenVersion = version;
        this.refreshed.set(true);
        if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => this.refreshed.set(false), DATA_UPDATED_MS);
      });
    });
  }

  /**
   * Clears every filter control at once -- including the ones the current view
   * does not render, which a link or an earlier view could have set -- the
   * numeric ranges, and the date range. The reducer does the rest.
   */
  protected clearFilters(): void {
    // The brush is a filter in every way that matters -- it drops four panels
    // from 778,075 rows to 102,020 -- so the control named "Clear filters"
    // clears it too. Leaving it in force was the single thing on the page with
    // no visible way back.
    this.graph.dispatch({ t: 'clearSelections' });
    // Back to the automatic open/closed rule: with nothing left in force, that
    // collapses the section again.
    this.moreToggled.set(null);
    this.graph.form.patchValue({
      filters: emptyFilterControls(),
      numeric: emptyNumericControls(),
      createdFrom: null,
      createdTo: null,
    });
  }
}
