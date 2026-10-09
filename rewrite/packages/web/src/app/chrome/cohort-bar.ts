/**
 * The cohort chips: the top bar's secondary row.
 *
 * One chip per cohort, in its own colour, the two derived ones first. A user
 * cohort's chip opens the editor or removes the cohort; "This dashboard" and
 * "Whole population" have neither, because they are not stored -- they follow
 * the controls above them.
 *
 * It owns nothing. Opening a dialog is a call, not state, and everything the
 * dialog does it does by dispatching commands.
 */

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatDialog } from '@angular/material/dialog';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { LucideAngularModule } from 'lucide-angular';
import { Graph } from '../graph/graph';
import type { CohortChip } from '../graph/cohorts';
import { MAX_COHORTS, STUDY_COHORT, type Cohort } from '../graph/state';
import type { CohortEditorData } from './cohort-editor';
import { PHONE_QUERY, matchesMedia } from './media';

@Component({
  selector: 'app-cohort-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatMenuModule, MatTooltipModule, LucideAngularModule],
  templateUrl: './cohort-bar.html',
})
export class CohortBar {
  private readonly graph = inject(Graph);
  private readonly dialog = inject(MatDialog);

  /**
   * The breakpoint, read here rather than in `open`: `matchesMedia` registers a
   * teardown with `inject(DestroyRef)`, so it only works where an injection
   * context exists -- a field initializer, not a click handler.
   */
  private readonly phone = matchesMedia(PHONE_QUERY);

  protected readonly cohorts = toSignal(this.graph.cohorts$, { initialValue: [] });

  /**
   * True at the cohort cap.
   *
   * The buttons are disabled rather than silently refused: the reducer drops an
   * `addCohort` past the cap, and a control that does nothing and says nothing
   * is worse than one that is plainly unavailable.
   */
  protected readonly full = computed(
    () => this.saved().filter((entry) => entry.editable).length >= MAX_COHORTS,
  );

  /**
   * The cohorts this row shows: the user's, and only the user's.
   *
   * "This dashboard" and "Whole population" are derived and always present, so
   * a chip apiece was two rows of furniture on every dashboard that had no
   * cohorts at all. They are still offered wherever a cohort is *chosen*.
   */
  protected readonly saved = computed(() =>
    this.cohorts().filter((entry) => entry.editable || entry.cohort.id === STUDY_COHORT),
  );

  /** A blank cohort, seeded from "This dashboard" -- the only sensible starting point. */
  protected create(): void {
    this.open({ mode: 'create', seed: null, convertPanel: null });
  }

  protected edit(entry: CohortChip): void {
    this.open({ mode: 'edit', seed: entry.cohort, convertPanel: null });
  }

  protected remove(cohort: Cohort): void {
    this.graph.dispatch({ t: 'removeCohort', id: cohort.id });
  }

  protected clearStudy(): void {
    this.graph.dispatch({ t: 'clearStudy' });
  }

  /**
   * Open the editor, loading it on demand.
   *
   * A dynamic import rather than a static one: the editor carries a datepicker,
   * a dialog container and a form the size of the top bar's, and none of it is
   * needed to render a dashboard. Statically imported it pushed the initial
   * bundle past its budget for a component most sessions never open.
   */
  private open(data: CohortEditorData): void {
    const phone = this.phone();
    void import('./cohort-editor').then(({ CohortEditor, cohortDialogSize }) => {
      this.dialog.open(CohortEditor, {
        data,
        // The surface's own geometry: a width declared inside the component can
        // only be clipped by it.
        ...cohortDialogSize(phone),
        autoFocus: 'dialog',
        restoreFocus: true,
      });
    });
  }

  /** What a chip says on hover: the view it is on and how many filters it carries. */
  protected tip(entry: CohortChip): string {
    const cohort = entry.cohort;
    const filters = cohort.filters.length;
    const range = cohort.selections.length ? `, ${cohort.selections.length} metric range${cohort.selections.length === 1 ? '' : 's'}` : '';
    if (!entry.editable) {
      if (cohort.id === STUDY_COHORT) return 'The study loaded in this browser.';
      return cohort.id === 'current'
        ? 'The view, filters and brushed range the controls above are set to. It follows them.'
        : 'This view with no filters and no brushed range.';
    }
    return `${filters} filter${filters === 1 ? '' : 's'}${range}. Edit to change it.`;
  }
}
