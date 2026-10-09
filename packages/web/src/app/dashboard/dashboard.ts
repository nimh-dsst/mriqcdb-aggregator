/**
 * The page: the top bar, the panel grid, and the menu that adds panels.
 *
 * It subscribes to exactly two projections through `toSignal` and dispatches
 * commands. No layout decision here feeds back into state.
 */

import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  computed,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatMenuModule } from '@angular/material/menu';
import { OverlayModule } from '@angular/cdk/overlay';
import { A11yModule } from '@angular/cdk/a11y';
import { ColumnPicker } from '../panels/column-picker';
import { QuestionPicker } from '../panels/question-picker';
import { asColumnId, metricsFor, fieldsFor } from '@mriqc/shared';
import { MatTooltipModule } from '@angular/material/tooltip';
import { LucideAngularModule } from 'lucide-angular';
import { panelsWithPreferredRows, type DashboardLayout } from '../graph/layout';
import { GridInteractionDirective } from './grid-interaction.directive';
import { map, distinctUntilChanged } from 'rxjs';
import { TopBar } from '../chrome/top-bar';
import {
  THREE_COLUMN_QUERY,
  TWO_COLUMN_QUERY,
  gridColumns,
  matchesMedia,
} from '../chrome/media';
import { Graph } from '../graph/graph';
import { PanelCard } from '../panels/panel-card';
import type { Panel } from '../graph/state';
import { environment } from '../../environments/environment';

/** The resting label of the share action, and how long its confirmation stays. */
const SHARE_LABEL = 'Share this view';
const SHARE_NOTICE_MS = 3000;

/** How long "Removed … · Undo" stays up. */
export const UNDO_NOTICE_MS = 6000;

/** A removed panel, held just long enough for its undo offer. */
interface RemovedPanel {
  panel: Panel;
  at: number;
  title: string;
  layout?: DashboardLayout;
}

type AddMode = 'guided' | 'columns';
const ADD_MODE_KEY = 'mriqc.addPanelMode';
function readAddMode(): AddMode | null {
  try {
    const value = localStorage.getItem(ADD_MODE_KEY);
    return value === 'guided' || value === 'columns' ? value : null;
  } catch {
    return null;
  }
}

@Component({
  selector: 'app-dashboard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatMenuModule,
    MatTooltipModule,
    LucideAngularModule,
    PanelCard,
    TopBar,
    GridInteractionDirective,
    OverlayModule,
    A11yModule,
    ColumnPicker, QuestionPicker,
  ],
  templateUrl: './dashboard.html',
  host: { '(document:keydown.escape)': 'restoreMaximized()' },
})
export class Dashboard {
  private readonly graph = inject(Graph);

  protected readonly panels = toSignal(this.graph.panels$, { initialValue: [] });
  protected readonly chrome = toSignal(this.graph.chrome$);
  protected readonly addOpen = signal(false);
  /** Guided (questions) or columns, remembered per browser; null until first asked. */
  protected readonly addMode = signal<AddMode | null>(readAddMode());
  protected setAddMode(mode: AddMode): void {
    this.addMode.set(mode);
    try { localStorage.setItem(ADD_MODE_KEY, mode); } catch { /* Storage may be blocked. */ }
  }
  protected readonly metrics = computed(() => metricsFor(this.chrome()?.modality ?? 'bold'));
  protected readonly fields = computed(() => fieldsFor(this.chrome()?.modality ?? 'bold', this.chrome()?.view ?? 'raw', 'group'));
  protected addMetric(metric: string): void {
    this.graph.dispatch({ t: 'addPanel', x: asColumnId(metric) });
    this.addOpen.set(false);
  }
  protected readonly gridState = toSignal(this.graph.state$.pipe(map(state => ({layout:state.layout,panels:panelsWithPreferredRows(state)}))));
  protected readonly maximized = toSignal(this.graph.state$.pipe(map(state => state.maximizedPanel), distinctUntilChanged()));
  protected readonly announcement = signal('');
  private readonly host = inject(ElementRef<HTMLElement>).nativeElement;
  protected readonly maximizedHeight = signal(600);

  /* ------------------------------------------------------------- the grid */

  private readonly twoColumns = matchesMedia(TWO_COLUMN_QUERY);
  private readonly threeColumns = matchesMedia(THREE_COLUMN_QUERY);

  /** 1 below 900px, 2 from 900, 3 from 1500. */
  protected readonly columns = computed(() => gridColumns(this.twoColumns(), this.threeColumns()));

  protected readonly geometry = computed(() => this.gridState()?.layout ?? {});
  protected readonly visiblePanels = computed(() => {
    const panels = this.panels();
    if (this.maximized()) return panels.filter(panel => panel.id === this.maximized());
    if (this.columns() > 1) return panels;
    const layout = this.geometry();
    return [...panels].sort((a, b) => layout[a.id].y - layout[b.id].y || layout[a.id].x - layout[b.id].x);
  });
  protected resetLayout(): void { this.graph.dispatch({ t: 'resetLayout' }); }
  protected restoreMaximized(): void {
    if (this.maximized()) this.graph.dispatch({ t: 'maximizePanel', id: null });
  }

  /* ------------------------------------------------------------ remove / undo */

  /**
   * The panel the last removal took away, for the length of its snackbar and no
   * longer.
   *
   * Local component state on purpose: whether a toast is showing decides
   * nothing about what the dashboard shows, it is not in the URL, and it must
   * not survive a reload. The *undo* goes through the reducer like everything
   * else, as `restorePanel` with the whole panel value, so the card comes back
   * identical and in the place it left.
   */
  protected readonly removed = signal<RemovedPanel | null>(null);

  private undoTimer: ReturnType<typeof setTimeout> | null = null;

  protected onRemoved(entry: RemovedPanel): void {
    this.removed.set(entry);
    if (this.undoTimer !== null) clearTimeout(this.undoTimer);
    this.undoTimer = setTimeout(() => this.removed.set(null), UNDO_NOTICE_MS);
  }

  protected undoRemove(): void {
    const entry = this.removed();
    if (!entry) return;
    this.graph.dispatch({ t: 'restorePanel', panel: entry.panel, at: entry.at, layout: entry.layout });
    this.dismissUndo();
  }

  protected dismissUndo(): void {
    this.removed.set(null);
    if (this.undoTimer !== null) clearTimeout(this.undoTimer);
    this.undoTimer = null;
  }

  /**
   * "Share this view" -- the whole dashboard is already in the address bar
   * (`url.ts`), so sharing it is a clipboard write and nothing else. No state:
   * the label is the only thing that changes, and it changes back.
   */
  protected readonly shareLabel = signal(SHARE_LABEL);

  private shareTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const measureMaximized = () => {
      const grid = this.host.querySelector('[data-testid="panel-grid"]');
      if (!grid || !this.maximized()) return;
      const footer = this.host.querySelector('footer')?.getBoundingClientRect().height ?? 56;
      this.maximizedHeight.set(Math.max(300, window.innerHeight - grid.getBoundingClientRect().top - footer - 24));
    };
    effect(() => {
      if (this.maximized()) requestAnimationFrame(measureMaximized);
    });
    window.addEventListener('resize', measureMaximized);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('resize', measureMaximized);
      if (this.shareTimer !== null) clearTimeout(this.shareTimer);
      if (this.undoTimer !== null) clearTimeout(this.undoTimer);
    });
  }

  protected shareView(): void {
    const href = typeof window === 'undefined' ? '' : window.location.href;
    const done = (label: string) => {
      this.shareLabel.set(label);
      if (this.shareTimer !== null) clearTimeout(this.shareTimer);
      this.shareTimer = setTimeout(() => this.shareLabel.set(SHARE_LABEL), SHARE_NOTICE_MS);
    };
    // `navigator.clipboard` is absent over plain http on a non-localhost host
    // and in jsdom, and a denied permission rejects. Either way the address bar
    // still has the link, which is what the tooltip says.
    const clipboard = navigator.clipboard;
    if (!clipboard || href === '') {
      done('Copy from the address bar');
      return;
    }
    clipboard.writeText(href).then(
      () => done('Link copied'),
      () => done('Copy from the address bar'),
    );
  }
}
