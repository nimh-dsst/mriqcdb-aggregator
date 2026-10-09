/**
 * The cohort editor: a dialog that builds or edits one cohort, and the one place
 * "Compare time spans" is set up.
 *
 * It is the *secondary* way a cohort comes into being. The primary one is one
 * click -- "Save as cohort" snapshots the dashboard and names it -- so this
 * dialog opens on that same snapshot and exists to change it, which is why
 * "Start from" is the first control and overwrites everything under it.
 *
 * It holds a form of its own, which is not a second store: a dialog's unsaved
 * draft decides nothing about what the dashboard shows, it is not in the URL,
 * and it must not survive a cancel. Save is the only thing that reaches the
 * graph, as a command like any other.
 *
 * The form is the *same* form the top bar drives (`buildControlsForm`), so a
 * cohort's view and filters are edited with the same controls and read back with
 * the same `filtersFromForm` -- numeric ranges included, even though only the
 * categorical selects and the date range are rendered. That is what makes
 * "Start from: This dashboard" keep the filters it cannot show.
 *
 * `MatDialog` and not the hand-rolled overlay "About this data" uses: three
 * different places open this, the opener needs the result back, and a dialog is
 * exactly the behaviour `docs/ui-style.md` keeps Material for.
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
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { DecimalPipe } from '@angular/common';
import { ReactiveFormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { LucideAngularModule } from 'lucide-angular';
import { Subject, of } from 'rxjs';
import { catchError, debounceTime, map, startWith, switchMap } from 'rxjs/operators';
import {
  asColumnId,
  fieldsFor,
  metricsFor,
  viewsFor,
  type ColumnId,
  type CoverageResult,
  type Filter,
  type View,
} from '@mriqc/shared';
import { API } from '../api/api';
import { Graph } from '../graph/graph';
import {
  buildControlsForm,
  filtersFromForm,
  formFromGlobal,
  type ControlsValue,
} from './controls-form';
import { CATEGORY_PALETTE, cohortColor } from '../panels/specs';
import { cohortAutoName, uniqueCohortName } from '../graph/cohort-name';
import { mintCohortId, nextCohortColor } from '../graph/cohorts';
import { unitNoun } from '../view/text';
import {
  CURRENT_COHORT,
  MAX_COHORTS,
  type Cohort,
  type CohortId,
  type MetricId,
  type PanelId,
} from '../graph/state';
import { PHONE_QUERY, matchesMedia } from './media';
import { FilterSelect } from './filter-select';

/**
 * What the dialog was opened to do.
 *
 * `create` and `edit` are one cohort. `timespans` is two: it duplicates a base
 * cohort with two different upload-date ranges and opens a comparison panel over
 * them, which is the two-click time comparison `comparison-design.md` asks for.
 */
export type CohortEditorMode = 'create' | 'edit' | 'timespans';

/** Where a new cohort's fields come from before the reader touches them. */
export type StartFrom = 'current' | 'blank' | 'cohort';

/** What the opener hands the dialog. */
export interface CohortEditorData {
  mode: CohortEditorMode;
  /** The cohort to edit, or the one to seed a new one from. Null for a blank create. */
  seed: Cohort | null;
  /**
   * A panel to convert into a comparison with the saved cohort, for "Compare
   * with… / New cohort…". Null when the cohort is being made on its own.
   */
  convertPanel: PanelId | null;
}

/** Which metric a time-span comparison opens on, as the dialog's own select holds it. */
interface TimeSpanValue {
  metric: MetricId | null;
  fromA: Date | null;
  toA: Date | null;
  fromB: Date | null;
  toB: Date | null;
}

/** How long the match-count preview waits before asking. */
export const PREVIEW_DEBOUNCE_MS = 350;

/**
 * The dialog's own geometry, which has to be set on the **surface** and not
 * inside the component.
 *
 * `MatDialog` sizes its surface from the config; a width declared on the
 * component's root can only ever be clipped by it. That is what this dialog was
 * doing: a 672px grid inside a 560px surface, with the third filter column,
 * three swatches and the Create button off the right edge and reachable only by
 * a horizontal scrollbar nobody looks for.
 *
 * Written here as a plain CSS string rather than as a Tailwind arbitrary value,
 * because `w-[min(640px,calc(100vw-32px))]` is not valid CSS -- `calc` needs
 * spaces around its operator, and Tailwind's arbitrary-value syntax needs
 * underscores for those spaces -- so the declaration was silently dropped and
 * the surface fell back to sizing itself from its content.
 *
 * Full-bleed on a phone, where a 16px gutter each side costs a column.
 */
export function cohortDialogSize(phone: boolean): {
  width: string;
  maxWidth: string;
  height?: string;
} {
  return phone
    ? { width: '100vw', maxWidth: '100vw', height: '100dvh' }
    : { width: 'min(640px, calc(100vw - 32px))', maxWidth: 'calc(100vw - 32px)' };
}

/** Day, short month, year, in UTC -- the same reading the date filters get. */
const DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** How a date range reads in an auto-generated cohort name: `2019` or `Jan 2019 – Mar 2019`. */
export function spanLabel(from: Date | null, to: Date | null): string {
  if (!from || !to) return 'all dates';
  const fromYear = from.getUTCFullYear();
  const toYear = to.getUTCFullYear();
  // A whole calendar year is the commonest span by far, and "2019" is what a
  // reader wants on a legend rather than "1 Jan 2019 - 31 Dec 2019".
  const wholeYear =
    fromYear === toYear &&
    from.getUTCMonth() === 0 &&
    from.getUTCDate() === 1 &&
    to.getUTCMonth() === 11 &&
    to.getUTCDate() >= 28;
  if (wholeYear) return String(fromYear);
  return `${DATE_FORMAT.format(from)} – ${DATE_FORMAT.format(to)}`;
}

/** The `created_at between` filter a date range becomes, or none when either end is empty. */
export function dateFilter(from: Date | null, to: Date | null): Filter | null {
  if (!from || !to) return null;
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  return {
    field: asColumnId('created_at'),
    op: 'between',
    lo: lo.toISOString(),
    hi: hi.toISOString(),
  };
}

/** The same filter list with any `created_at` predicate replaced by this one. */
export function withDateRange(filters: readonly Filter[], span: Filter | null): readonly Filter[] {
  const rest = filters.filter((filter) => filter.field !== 'created_at');
  return span === null ? rest : [...rest, span];
}

/**
 * The name a duplicate opens with.
 *
 * "Siemens 3T copy" rather than "Siemens 3T", because two cohorts with one name
 * are indistinguishable in a legend and in the statistics table. A time-span
 * duplicate gets its span appended instead, so the suffix would be noise.
 */
export function suggestName(base: string, mode: CohortEditorMode): string {
  if (mode === 'timespans') return base;
  return `${base} copy`;
}

@Component({
  selector: 'app-cohort-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    DecimalPipe,
    ReactiveFormsModule,
    MatDatepickerModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatTooltipModule,
    LucideAngularModule,
    FilterSelect,
  ],
  templateUrl: './cohort-editor.html',
})
export class CohortEditor {
  private readonly graph = inject(Graph);
  private readonly api = inject(API);
  private readonly dialog = inject<MatDialogRef<CohortEditor, CohortId | null>>(MatDialogRef);
  protected readonly data = inject<CohortEditorData>(MAT_DIALOG_DATA);

  protected readonly chrome = toSignal(this.graph.chrome$);
  protected readonly cohorts = toSignal(this.graph.cohorts$, { initialValue: [] });

  /**
   * What the dialog is doing, which the reader can change without reopening it.
   *
   * "Compare time spans" used to be a third button on every cohort chip, which
   * made a 28px chip a toolbar. It is the same dialog with a second date range,
   * so it is a mode of this one -- reachable from the cohort being edited,
   * which is the cohort the two spans will be copies of.
   */
  protected readonly mode = signal<CohortEditorMode>(this.data.mode);

  /** Switch to the two-span comparison, keeping everything already filled in. */
  protected compareTimeSpans(): void {
    this.mode.set('timespans');
    if (this.span().metric === null) {
      this.span.update((value) => ({ ...value, metric: this.metrics()[0]?.id ?? null }));
    }
  }

  /** Single column and a full-screen sheet under 700px. */
  protected readonly phone = matchesMedia(PHONE_QUERY);

  /** The same controls the top bar has, for this cohort's view and filters. */
  protected readonly form = buildControlsForm();

  protected readonly name = signal('');
  protected readonly addToAll = signal(true);

  protected renameGroup(id: string, event: Event): void {
    const name = (event.target as HTMLInputElement).value.trim();
    if (name) this.graph.dispatch({ t: 'updateCohort', id, patch: { name } });
  }

  protected deleteGroup(id: string): void { this.graph.dispatch({ t: 'removeCohort', id }); }
  protected readonly color = signal(0);
  protected readonly palette = CATEGORY_PALETTE;
  protected readonly swatch = cohortColor;

  /** Where the fields came from. First control, because it overwrites the rest. */
  protected readonly startFrom = signal<StartFrom>('current');
  /** Which saved cohort, when `startFrom` is `cohort`. */
  protected readonly startCohort = signal<CohortId | null>(null);

  /**
   * True once the reader has typed in the name box.
   *
   * Until then the name tracks the fields, so a cohort assembled by changing
   * filters ends up named after the filters it ended on rather than after the
   * ones it started from. After it, the name is theirs and nothing overwrites
   * it -- a box that kept re-writing what you had typed would be unusable.
   */
  protected readonly nameTouched = signal(false);

  /** The second half of a time-span comparison. Unused in the other two modes. */
  protected readonly span = signal<TimeSpanValue>({
    metric: null,
    fromA: null,
    toA: null,
    fromB: null,
    toB: null,
  });

  /** An optional metric range: a cohort narrowed to part of one metric's axis. */
  protected readonly retainedSelections = signal<Cohort['selections']>([]);
  protected readonly rangeMetric = signal<MetricId | null>(null);
  protected readonly rangeLo = signal<number | null>(null);
  protected readonly rangeHi = signal<number | null>(null);

  /** Whether the long-tail filters are showing, exactly as in the top bar. */
  protected readonly moreOpen = signal(false);

  protected toggleMore(): void {
    this.moreOpen.update((open) => !open);
  }

  /** The form's current value, as a signal, so the name and the preview can track it. */
  private readonly formValue = signal<ControlsValue>(this.form.getRawValue() as ControlsValue);

  protected readonly title = computed(() => {
    switch (this.mode()) {
      case 'edit':
        return 'Edit group';
      case 'timespans':
        return 'Compare time spans';
      default:
        return 'Save as group';
    }
  });

  /** The views of the modality on screen; a cohort picks one of these, not the global one. */
  protected readonly views = computed(() => {
    const modality = this.chrome()?.modality;
    return modality ? viewsFor(modality) : [];
  });

  /** Every metric of this modality, for the metric-range and time-span selects. */
  protected readonly metrics = computed(() => {
    const modality = this.chrome()?.modality;
    return modality ? metricsFor(modality) : [];
  });

  /** The everyday categorical filters, which are always on screen. */
  protected readonly filterFields = computed(() => this.chrome()?.filterFields ?? []);

  /** The long-tail ones, behind "More filters" -- the same split the top bar makes. */
  protected readonly secondaryFields = computed(() => this.chrome()?.secondaryFields ?? []);

  /** The cohorts "Start from: Saved cohort" can copy. */
  protected readonly savedCohorts = computed(() =>
    this.cohorts().filter((entry) => entry.editable),
  );

  /* ------------------------------------------------- the match-count preview */

  /** Recomputed whenever the draft changes; the pipeline below debounces it. */
  private readonly previewTrigger = new Subject<void>();

  /**
   * How many scans the draft currently matches, or null while it is being
   * fetched.
   *
   * A request made by a component, which the architecture otherwise reserves
   * for the effects runner. It is allowed here because it never enters state:
   * nothing downstream reads it, no key is cached, it is debounced, every
   * earlier request is cancelled by `switchMap`, and it dies with the dialog.
   * The alternative -- routing a dialog's unsaved draft through the command
   * loop -- would put a draft nobody has saved into the thing that decides what
   * the whole page shows.
   *
   * `coverage` rather than `distribution`, because this is a count of *scans*
   * and `distribution.n` counts the scans that had a value for one metric.
   */
  protected readonly matchCount = toSignal(
    this.previewTrigger.pipe(
      startWith(undefined),
      debounceTime(PREVIEW_DEBOUNCE_MS),
      switchMap(() => {
        const chrome = this.chrome();
        const value = this.formValue();
        const group = chrome
          ? fieldsFor(chrome.modality, value.view as View, 'group')[0]?.id
          : undefined;
        if (!chrome || group === undefined) return of<number | null>(null);
        return this.api
          .coverage({
            source: 'population',
            proc: 'coverage',
            modality: chrome.modality,
            view: value.view as View,
            filters: filtersFromForm(value),
            selections: this.selections(),
            group,
            granularity: 'year',
          })
          .pipe(
            map((result: CoverageResult) =>
              result.buckets.reduce((sum, bucket) => sum + bucket.n, 0),
            ),
            // A failed preview is a missing figure, not a broken dialog.
            catchError(() => of<number | null>(null)),
            startWith(null as number | null),
          );
      }),
    ),
    { initialValue: null as number | null },
  );

  /** What a row of this view is called, for the preview line. */
  protected readonly unitNoun = computed(() => {
    const chrome = this.chrome();
    if (!chrome) return 'scans';
    return unitNoun(viewsFor(chrome.modality).find((v) => v.id === this.formValue().view));
  });

  constructor() {
    const seed = this.data.seed;
    if (seed !== null) {
      // Editing, or duplicating a named cohort: the fields are that cohort's.
      this.startFrom.set('cohort');
      this.startCohort.set(seed.id);
      this.loadFrom(seed);
      this.name.set(this.mode() === 'edit' ? seed.name : suggestName(seed.name, this.mode()));
      this.nameTouched.set(true);
      this.color.set(this.mode() === 'edit' ? seed.color : this.freeColor());
    } else {
      this.applyStart('current');
      this.color.set(this.freeColor());
    }
    if (this.mode() === 'timespans') {
      this.span.update((value) => ({ ...value, metric: this.metrics()[0]?.id ?? null }));
    }

    // One subscription, so the name and the preview both track the controls.
    this.form.valueChanges.pipe(takeUntilDestroyed(inject(DestroyRef))).subscribe(() => {
      this.formValue.set(this.form.getRawValue() as ControlsValue);
      this.previewTrigger.next();
    });

    // The name follows the fields until the reader takes it over.
    effect(() => {
      this.formValue();
      this.rangeMetric();
      this.rangeLo();
      this.rangeHi();
      this.retainedSelections();
      untracked(() => {
        if (this.nameTouched()) return;
        this.name.set(this.autoName());
      });
    });
  }

  /**
   * Which swatch is selected, compared modulo the palette.
   *
   * `cohortColor` is modular, because a `Cohort.color` can arrive from a link
   * as any integer; comparing the raw index would leave a cohort with colour 9
   * drawing the second hue everywhere and showing no selected swatch.
   */
  protected isSwatch(index: number): boolean {
    const chosen = this.color();
    if (!Number.isFinite(chosen)) return index === 0;
    const slot = Math.trunc(chosen) % CATEGORY_PALETTE.length;
    return (slot < 0 ? slot + CATEGORY_PALETTE.length : slot) === index;
  }

  /** The lowest palette slot no cohort holds. */
  private freeColor(): number {
    return nextCohortColor(this.savedCohorts().map((entry) => entry.cohort));
  }

  /** The name the one-click path would give the draft as it stands. */
  protected autoName(): string {
    const chrome = this.chrome();
    const value = this.formValue();
    return uniqueCohortName(
      cohortAutoName(
        chrome?.modality ?? 'bold',
        value.view as View,
        filtersFromForm(value),
        this.selections(),
        null,
      ),
      this.cohorts().map((entry) => entry.cohort.name),
    );
  }

  /** Switch where the fields come from. It overwrites them, which is why it is first. */
  protected applyStart(from: StartFrom): void {
    this.startFrom.set(from);
    const chrome = this.chrome();
    if (from === 'current') {
      const current =
        this.cohorts().find((entry) => entry.cohort.id === CURRENT_COHORT)?.cohort ?? null;
      if (current !== null) this.loadFrom(current);
      this.startCohort.set(null);
    } else if (from === 'blank') {
      this.loadFrom({
        id: 'draft',
        name: '',
        color: this.color(),
        source: 'population',
        view: chrome?.view ?? 'raw',
        filters: [],
        selections: [],
      });
      this.startCohort.set(null);
    }
    // `cohort` waits for the select below it; `pickStart` does the loading.
  }

  /** Which saved cohort "Start from: Saved cohort" copies. */
  protected pickStart(id: CohortId): void {
    this.startCohort.set(id);
    const entry = this.cohorts().find((c) => c.cohort.id === id);
    if (entry) this.loadFrom(entry.cohort);
  }

  /** Push a cohort's view, filters and metric range into the controls. */
  protected loadFrom(cohort: Cohort): void {
    const value: ControlsValue = formFromGlobal({
      modality: this.chrome()?.modality ?? 'bold',
      view: cohort.view,
      filters: cohort.filters,
    });
    this.form.setValue(value, { emitEvent: false });
    this.formValue.set(value);
    this.retainedSelections.set(cohort.selections.slice(1));
    this.rangeMetric.set(cohort.selections[0]?.metric ?? null);
    this.rangeLo.set(cohort.selections[0]?.range[0] ?? null);
    this.rangeHi.set(cohort.selections[0]?.range[1] ?? null);
    this.previewTrigger.next();
  }

  protected setName(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
    // From here the name is the reader's; nothing overwrites it.
    this.nameTouched.set(true);
  }

  protected setSpan(patch: Partial<TimeSpanValue>): void {
    this.span.update((value) => ({ ...value, ...patch }));
  }

  protected setRangeMetric(metric: string | null): void {
    this.rangeMetric.set(metric ? (asColumnId(metric) as MetricId) : null);
    this.previewTrigger.next();
  }

  protected retainedRangeLabel(selection: Cohort['selections'][number]): string {
    const metric = this.metrics().find(metric => metric.id === selection.metric);
    return `${metric?.shortLabel ?? metric?.label ?? selection.metric} ${selection.range[0]}–${selection.range[1]}`;
  }

  protected removeRetainedRange(metric: MetricId): void {
    this.retainedSelections.update(selections => selections.filter(selection => selection.metric !== metric));
    this.previewTrigger.next();
  }

  protected setRangeBound(end: 'lo' | 'hi', event: Event): void {
    const raw = (event.target as HTMLInputElement).value;
    const parsed = raw === '' ? null : Number(raw);
    const value = parsed !== null && Number.isFinite(parsed) ? parsed : null;
    if (end === 'lo') this.rangeLo.set(value);
    else this.rangeHi.set(value);
    this.previewTrigger.next();
  }

  /** The metric's own name, for the range control's label. */
  protected readonly rangeMetricLabel = computed(() => {
    const id = this.rangeMetric();
    if (id === null) return 'No range';
    return this.metrics().find((metric) => metric.id === id)?.label ?? String(id);
  });

  /** What the two range boxes amount to: a `Selection`, or none. */
  private selections(): Cohort['selections'] {
    const metric = this.rangeMetric();
    const lo = this.rangeLo();
    const hi = this.rangeHi();
    if (metric === null || lo === null || hi === null) return this.retainedSelections();
    return [{ metric, range: (lo <= hi ? [lo, hi] : [hi, lo]) as [number, number] }, ...this.retainedSelections().filter(selection => selection.metric !== metric)].slice(0, 4);
  }

  /** The cohort the form currently describes, minus its id. */
  private draft(): Omit<Cohort, 'id'> {
    const value = this.form.getRawValue() as ControlsValue;
    return {
      name: this.name().trim() === '' ? 'Cohort' : this.name().trim(),
      color: this.color(),
      source: 'population',
      view: value.view as View,
      filters: filtersFromForm(value),
      selections: this.selections(),
    };
  }

  protected readonly canSave = computed(() => {
    if (this.mode() === 'create' && this.savedCohorts().length >= MAX_COHORTS) return false;
    // A cohort with no name is a legend entry nobody can read.
    if (this.name().trim() === '') return false;
    if (this.mode() !== 'timespans') return true;
    const span = this.span();
    return (
      span.metric !== null &&
      span.fromA !== null &&
      span.toA !== null &&
      span.fromB !== null &&
      span.toB !== null
    );
  });

  protected save(): void {
    if (!this.canSave()) return;
    if (this.mode() === 'timespans') {
      this.saveTimeSpans();
      return;
    }
    if (this.mode() === 'edit' && this.data.seed !== null) {
      this.graph.dispatch({ t: 'updateCohort', id: this.data.seed.id, patch: this.draft() });
      this.dialog.close(this.data.seed.id);
      return;
    }
    const existing = this.savedCohorts().map((entry) => entry.cohort);
    const id = mintCohortId(existing);
    this.graph.dispatch({ t: 'addCohort', cohort: { ...this.draft(), id } });
    // The panel and the cohort are two commands, which is why the caller mints
    // the id: the panel has to be able to name the cohort that does not exist yet.
    if (this.addToAll()) {
      this.graph.dispatch({ t: 'addGroupToPanels', id });
    } else if (this.data.convertPanel !== null) {
      this.graph.dispatch({
        t: 'convertToComparison',
        panelId: this.data.convertPanel,
        with: id,
      });
    }
    this.dialog.close(id);
  }

  /**
   * Two cohorts, one per date range, and a comparison panel over them.
   *
   * The base is whatever the form currently describes -- its view, its filters,
   * its metric range -- with the `created_at` predicate replaced per span, so
   * "the same cohort across time" means exactly that and not "two differently
   * filtered cohorts that happen to differ in date".
   */
  private saveTimeSpans(): void {
    const span = this.span();
    if (span.metric === null) return;
    const base = this.draft();
    const existing = this.savedCohorts().map((entry) => entry.cohort);
    const labelA = spanLabel(span.fromA, span.toA);
    const labelB = spanLabel(span.fromB, span.toB);
    const idA = mintCohortId(existing);
    const cohortA: Cohort = {
      ...base,
      id: idA,
      name: `${base.name} ${labelA}`,
      filters: withDateRange(base.filters, dateFilter(span.fromA, span.toA)),
    };
    const idB = mintCohortId([...existing, cohortA]);
    const cohortB: Cohort = {
      ...base,
      id: idB,
      name: `${base.name} ${labelB}`,
      color: nextCohortColor([...existing, cohortA]),
      filters: withDateRange(base.filters, dateFilter(span.fromB, span.toB)),
    };
    this.graph.dispatch({ t: 'addCohort', cohort: cohortA });
    this.graph.dispatch({ t: 'addCohort', cohort: cohortB });
    this.graph.dispatch({
      t: 'addPanel',
      x: span.metric,
      series: [{ kind: 'cohort', id: idA }, { kind: 'cohort', id: idB }],
    });
    this.dialog.close(idA);
  }

  protected cancel(): void {
    this.dialog.close(null);
  }

  /** What the field's name does not say on its own; '' for the ones that do. */
  protected fieldTip(): string {
    return '';
  }

  protected metricLabel(id: ColumnId | null): string {
    if (id === null) return 'No range';
    return this.metrics().find((metric) => metric.id === id)?.label ?? String(id);
  }
}
