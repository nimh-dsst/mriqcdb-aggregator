import { ChangeDetectionStrategy, Component, computed, input, output, signal, model, inject, ViewContainerRef, TemplateRef, ElementRef, viewChild } from '@angular/core';
import { A11yModule } from '@angular/cdk/a11y';
import { LucideAngularModule } from 'lucide-angular';
import { ColumnPicker } from '../column-picker';
import { CardOptions } from './card-options';
import { MatrixControl, type MatrixDraft } from './matrix-control';
import { SeriesChips } from './series-chips';
import { ContextMenuService } from './context-menu.service';
import type { PanelView } from '../../slices/panels/view';
import type { PanelPatch } from '../../slices/panels/commands';
import type { Form, PanelOptions } from '../../graph/state';
import type { Series } from '../../slices/series/model';
import type { CardControls } from './card-projection';
@Component({
  selector: 'app-card-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [A11yModule, LucideAngularModule, ColumnPicker, CardOptions, MatrixControl, SeriesChips],
  providers: [ContextMenuService],
  templateUrl: './card-header.html',
  styles: `:host { display: contents; }`,
})
export class CardHeader {
  readonly view = input.required<PanelView>();
  readonly controls = input.required<CardControls>();
  readonly maximized = input(false);
  readonly matrixDraft = model<MatrixDraft>({ open: false, metrics: [] });
  readonly isolatedId = input<string | null>(null);
  readonly isolatedChange = output<string | null>();
  readonly maximize = output<void>();
  readonly removed = output<void>();
  readonly added = output<Series>();
  readonly seriesRemoved = output<string>();
  readonly newGroup = output<void>();
  readonly groupAction = output<{ id: string; action: 'save' | 'only' }>();
  readonly patch = output<PanelPatch>();
  readonly options = output<Partial<PanelOptions>>();
  readonly axis = output<{ target: 'x' | 'y' | 'color'; opener: HTMLElement }>();
  readonly panel = computed(() => this.view().panel);
  readonly legend = computed(() => this.view().cohorts ?? []);
  readonly focusSecondMetric = signal(false);
  readonly pendingForm = signal<Form | null>(null);
  private readonly activeMenu = signal<'columns' | 'options' | null>(null);
  private readonly menu = inject(ContextMenuService);
  private readonly container = inject(ViewContainerRef);
  private readonly columnButton = viewChild.required<ElementRef<HTMLElement>>('columnButton');
  private readonly optionsButton = viewChild.required<ElementRef<HTMLElement>>('optionsButton');
  private readonly columnTemplate = viewChild.required<TemplateRef<unknown>>('columnTemplate');
  private readonly optionsTemplate = viewChild.required<TemplateRef<unknown>>('optionsTemplate');
  readonly columnPickerOpen = computed(() => this.menu.opened() && this.activeMenu() === 'columns');
  readonly optionsOpen = computed(() => this.menu.opened() && this.activeMenu() === 'options');
  toggleColumnPicker(): void {
    this.focusSecondMetric.set(false);
    this.pendingForm.set(null);
    if (this.columnPickerOpen()) this.closeColumnPicker();
    else this.openColumns();
  }
  addSecondMetric(form: Form | null): void {
    this.focusSecondMetric.set(true);
    this.pendingForm.set(form);
    this.openColumns();
  }
  private openColumns(): void {
    this.activeMenu.set('columns');
    this.menu.openConnected(this.columnTemplate(), this.container, this.columnButton().nativeElement);
  }
  closeColumnPicker(): void {
    this.menu.close();
    this.pendingForm.set(null);
  }
  openOptions(): void {
    this.activeMenu.set('options');
    this.menu.openConnected(this.optionsTemplate(), this.container, this.optionsButton().nativeElement);
  }
  openAxis(target: 'x' | 'y' | 'color'): void {
    this.menu.close();
    this.axis.emit({ target, opener: this.optionsButton().nativeElement });
  }
  applyMatrix(options: Partial<PanelOptions>): void {
    this.patch.emit({ form: 'matrix', options: { ...this.panel().options, ...options } });
    this.closeColumnPicker();
  }

}
