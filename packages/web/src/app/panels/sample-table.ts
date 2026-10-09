/**
 * The raw drill-down: a scrolling grid over `sample` rows.
 *
 * It is presentational. Reaching the end of the loaded rows emits
 * `requestPage`, which is a command like any other; the next page arrives as a
 * dataset entry, not as an accumulation inside the component.
 *
 * One scroll container, both axes. The CDK virtual viewport it replaced gave
 * the body its own scrollport, which meant a column pinned with `position:
 * sticky; left: 0` had nothing to be sticky against -- and without an
 * identifier in view, a row of numbers 1300px to the right belongs to nothing.
 * The column chooser is what keeps the DOM small instead: five columns of a
 * hundred rows is five hundred cells.
 */

import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import type { SampleRow } from '@mriqc/shared';
import type { PanelTable } from '../view/panel-view';

/** How many columns the table shows before the reader asks for more. */
export const DEFAULT_COLUMNS = 5;

/** Width of one column; the grid is this wide per column and scrolls sideways. */
const COLUMN_WIDTH = 130;

/** How close to the bottom the scroller gets before the next page is asked for. */
const PAGE_AHEAD_PX = 240;

/**
 * The columns actually drawn: the reader's own choice if they made one, in
 * table order, otherwise the first few.
 *
 * The chooser never changes the query. The `sample` procedure already fetches
 * every exportable field of the view -- all of them -- and the card was simply
 * clipping the rest off its right edge with no scrollbar and no way to say
 * which ones it wanted. So this is a display choice over rows already on the
 * client, and it stays local to the component for exactly that reason: it
 * decides nothing about what is fetched and nothing a link could carry.
 */
export function shownColumns(
  all: readonly string[],
  chosen: readonly string[] | null,
): readonly string[] {
  if (chosen === null) return all.slice(0, DEFAULT_COLUMNS);
  const picked = new Set(chosen);
  const kept = all.filter((column) => picked.has(column));
  // Never zero columns: an empty grid is not a readable answer to "show me
  // fewer", so the last one the reader unticks stays.
  return kept.length > 0 ? kept : all.slice(0, 1);
}

@Component({
  selector: 'app-sample-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatMenuModule, MatTooltipModule],
  template: `
    @if (table(); as data) {
      <div
        class="flex h-full min-w-0 min-h-0 flex-col overflow-hidden rounded-card border border-border"
      >
        <!-- Focusable because the box scrolls: a region a mouse can scroll
             and a keyboard cannot is an axe scrollable-region-focusable
             failure and, more to the point, eighteen columns a keyboard user
             cannot reach. -->
        <div
          class="min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-auto"
          tabindex="0"
          role="group"
          aria-label="Raw records"
          (scroll)="onScroll($event, data)"
          data-testid="sample-scroll"
        >
          <div class="min-w-full" [style.min-width.px]="minWidth(data)">
            <div
              class="sticky top-0 z-30 grid border-b border-border bg-surface-2 text-label font-semibold uppercase tracking-[0.04em] text-ink-2"
              [style.grid-template-columns]="columnTemplate(data)"
            >
              @for (column of columns(data); track column; let first = $first) {
                <div
                  class="truncate px-2 py-2"
                  [class]="first ? 'sticky left-0 z-40 bg-surface-2' : ''"
                  [title]="header(data, column)"
                >
                  {{ header(data, column) }}
                </div>
              }
            </div>
            @for (row of data.rows; track $index) {
              <div
                class="tnum grid border-b border-border text-caption"
                [style.grid-template-columns]="columnTemplate(data)"
              >
                @for (column of columns(data); track column; let first = $first) {
                  <div
                    class="truncate px-2 py-1.5 text-ink"
                    [class]="first ? 'sticky left-0 z-10 bg-surface' : ''"
                    [title]="cell(row, column)"
                  >
                    {{ cell(row, column) }}
                  </div>
                }
              </div>
            }
          </div>
        </div>
        <div
          class="flex shrink-0 items-center gap-3 border-t border-border px-2 py-1.5 text-caption text-ink-2"
        >
          <span class="min-w-0"
            >{{ data.rows.length }} rows loaded{{ data.nextCursor ? ', more on scroll' : '' }}</span
          >
          @if (data.columns.length > columns(data).length) {
            <span class="shrink-0 text-ink-3" data-testid="sample-horizontal-affordance"
              >Scroll horizontally for more columns</span
            >
          }
          <button
            type="button"
            class="btn btn-quiet ml-auto h-7 px-2"
            [matMenuTriggerFor]="columnMenu"
            data-testid="column-chooser"
            matTooltip="Which of this view's exportable fields the table draws. The rows already carry all of them."
          >
            Columns ({{ columns(data).length }} of {{ data.columns.length }})
          </button>
          <mat-menu #columnMenu="matMenu">
            <div
              class="flex max-h-80 w-64 flex-col gap-2 overflow-auto p-4"
              (click)="$event.stopPropagation()"
              data-testid="column-chooser-menu"
            >
              @for (column of data.columns; track column) {
                <label class="flex h-7 min-h-7 items-center gap-2 text-control text-ink">
                  <input
                    type="checkbox"
                    class="accent-highlight"
                    [checked]="isShown(data, column)"
                    (change)="toggle(data, column)"
                    [attr.data-column]="column"
                  />
                  <span class="truncate" [title]="header(data, column)">{{
                    header(data, column)
                  }}</span>
                </label>
              }
            </div>
          </mat-menu>
        </div>
      </div>
    }
  `,
})
export class SampleTable {
  readonly table = input<PanelTable | null>(null);

  /** The cursor to load next; emitted once the scroller nears the end. */
  readonly requestPage = output<string | null>();

  /** The reader's column choice, or null while they have not made one. */
  private readonly chosen = signal<readonly string[] | null>(null);

  /** Recomputed per table, so a view change with different fields cannot strand the choice. */
  protected columns(table: PanelTable): readonly string[] {
    return shownColumns(table.columns as readonly string[], this.chosen());
  }

  protected isShown(table: PanelTable, column: string): boolean {
    return this.columns(table).includes(column);
  }

  protected toggle(table: PanelTable, column: string): void {
    const current = this.columns(table);
    const next = current.includes(column)
      ? current.filter((id) => id !== column)
      : [...current, column];
    this.chosen.set(next);
  }

  protected header(table: PanelTable, column: string): string {
    const index = (table.columns as readonly string[]).indexOf(column);
    return index >= 0 ? table.headers[index] : column;
  }

  protected minWidth(table: PanelTable): number {
    return this.columns(table).length * COLUMN_WIDTH;
  }

  protected columnTemplate(table: PanelTable): string {
    return `repeat(${this.columns(table).length}, minmax(${COLUMN_WIDTH}px, 1fr))`;
  }

  protected cell(row: SampleRow, column: string): string {
    const value = row[column];
    if (value === null || value === undefined) return '';
    return String(value);
  }

  protected onScroll(event: Event, table: PanelTable): void {
    if (!table.nextCursor) return;
    const box = event.target as HTMLElement;
    if (box.scrollTop + box.clientHeight >= box.scrollHeight - PAGE_AHEAD_PX) {
      this.requestPage.emit(table.nextCursor);
    }
  }
}
