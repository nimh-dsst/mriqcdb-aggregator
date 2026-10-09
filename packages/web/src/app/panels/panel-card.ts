import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { LucideAngularModule } from 'lucide-angular';
import { cohortDialogSize } from '../chrome/cohort-editor';
import { Graph } from '../graph/graph';
import type { Command, PanelPatch } from '../graph/commands';
import type { DashboardLayout } from '../graph/layout';
import { panelFormAvailability } from '../graph/panel-shapes';
import type { Form, Panel, PanelOptions } from '../graph/state';
import type { Series } from '../graph/series';
import { encodeUrlState } from '../graph/url';
import { CardProjection, type CardView } from './card/card-projection';
import { CardHeader } from './card/card-header';
import { CardFooter } from './card/card-footer';
import { FormPicker } from './card/form-picker';
import { BinControl } from './card/bin-control';
import { AxisMenu } from './card/axis-menu';
import { SeriesChips } from './card/series-chips';
import { StatsSheet } from './card/stats-sheet';
import { ChartHost } from './card/chart-host';
import { MatrixControl, type MatrixDraft } from './card/matrix-control';

@Component({
  selector: 'app-panel-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CardHeader, CardFooter, FormPicker, BinControl, AxisMenu, SeriesChips, StatsSheet, ChartHost, MatrixControl, LucideAngularModule],
  templateUrl: './panel-card.html',
  styles: `
    :host { container-type: inline-size; display: block; min-width: 0; }
    .panel-controls { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; }
    .panel-controls > :first-child { flex: 1 1 12rem; }
    .panel-form { margin-left: auto; flex-wrap: wrap; justify-content: flex-end; }
  `,
})
export class PanelCardShell {
  private readonly graph = inject(Graph);
  private readonly dialog = inject(MatDialog);
  readonly view = input<CardView | null>(null);
  readonly index = input(0);
  readonly count = input(1);
  readonly columns = input(3);
  readonly maximized = input(false);
  readonly removed = output<{ panel: Panel; at: number; title: string; layout?: DashboardLayout }>();
  readonly panel = computed(() => this.view()?.panel ?? null);
  readonly panelId = computed(() => this.panel()!.id);
  readonly forms = computed(() => this.panel() ? panelFormAvailability(this.panel()!).filter(entry => entry.state !== 'hidden') : []);
  readonly statsOpen = signal(false);
  readonly matrixDraft = signal<MatrixDraft>({ open: false, metrics: [] });
  readonly isolatedId = signal<string | null>(null);
  readonly copyLinkError = signal<string | null>(null);
  dispatch(command: Command): void { this.graph.dispatch(command); }
  patchOptions(options: Partial<PanelOptions>): void {
    this.patch({ options: { ...this.panel()!.options, ...options } });
  }
  zoomToBrush(): void { this.graph.dispatch({ t: 'zoomToBrush', from: this.panelId() }); }
  exportCard(): void { this.graph.dispatch({ t: 'openExport', panelId: this.panelId() }); }
  cardLink(): string {
    const url = new URL(window.location.href);
    url.searchParams.set('s', encodeUrlState({ ...this.view()!.controls.url, maximizedPanel: this.panelId() }));
    url.searchParams.set('view', 'panel');
    url.searchParams.set('panel', this.panelId());
    return url.toString();
  }
  async copyCardLink(): Promise<void> {
    try { await navigator.clipboard.writeText(this.cardLink()); }
    catch { this.copyLinkError.set(this.cardLink()); }
  }
  setAxisRange(event: { axis: 'x' | 'y'; range: [number, number] | 'auto' }): void {
    this.graph.dispatch({ t: 'setPanelRange', id: this.panelId(), ...event });
  }

  resetPanelRanges(): void {
    this.graph.dispatch({ t: 'resetPanelRanges', id: this.panelId() });
  }

  changeForm(form: Form): void {
    if (!this.forms().some(entry => entry.form === form && entry.state === 'enabled')) return;
    this.graph.dispatch({ t: 'setPanelForm', id: this.panelId(), form });
  }

  patch(patch: PanelPatch): void {
    this.graph.dispatch({ t: 'patchPanel', id: this.panelId(), patch });
  }

  addSeries(series: Series): void {
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

  async groupAction(event: { id: string; action: 'save' | 'only' }): Promise<void> {
    const cohort = this.view()?.controls.groupActions.find(item => item.id === event.id);
    if (!cohort) return;
    if (event.action === 'only') {
      this.graph.dispatch({ t: 'setFilters', filters: cohort.filters });
      return;
    }
    const { CohortEditor } = await import('../chrome/cohort-editor');
    this.dialog.open(CohortEditor, {
      ...cohortDialogSize(false),
      data: { mode: 'create', seed: cohort, convertPanel: this.panelId() },
    });
  }
  contextAction(action: 'zoom' | 'reset' | 'maximize' | 'export' | 'copy'): void {
    switch (action) {
      case 'zoom': this.zoomToBrush(); break;
      case 'reset': this.resetPanelRanges(); break;
      case 'maximize': this.toggleMaximized(); break;
      case 'export': this.exportCard(); break;
      case 'copy': void this.copyCardLink(); break;
    }
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
    const layout = this.view()!.controls.layout;
    this.graph.dispatch({ t: 'removePanel', id: panel.id });
    this.removed.emit({ panel, at: this.index(), title: this.view()?.title ?? 'Panel', layout });
  }

  retry(retryKey: string): void {
    this.graph.dispatch({ t: 'retryKey', key: retryKey });
  }

}

/** Standalone import bundle: the shell and its per-panel subscription edge. */
export const PanelCard = [PanelCardShell, CardProjection] as const;
