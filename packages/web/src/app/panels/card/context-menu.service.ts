import { DestroyRef, Injectable, TemplateRef, ViewContainerRef, inject, signal } from '@angular/core';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { TemplatePortal } from '@angular/cdk/portal';
import { Subscription } from 'rxjs';

export interface ContextMenuPoint {
  x: number;
  y: number;
}

/**
 * Creates one disposable context-menu overlay for the card that provides it.
 *
 * This deliberately has no root provider: cards provide their own instance so
 * opening a menu in one card cannot close a menu owned by another card.
 */
@Injectable()
export class ContextMenuService {
  private readonly overlay = inject(Overlay);
  private readonly destroyRef = inject(DestroyRef);

  private overlayRef?: OverlayRef;
  private opener: HTMLElement | null = null;
  private eventSubscriptions = new Subscription();
  readonly opened = signal(false);

  constructor() {
    this.destroyRef.onDestroy(() => this.close());
  }

  openAt(
    template: TemplateRef<unknown>,
    viewContainerRef: ViewContainerRef,
    point: ContextMenuPoint,
    opener?: HTMLElement | null,
  ): void {
    this.close();

    this.opener = opener ?? null;
    this.overlayRef = this.overlay.create({
      hasBackdrop: true,
      backdropClass: 'cdk-overlay-transparent-backdrop',
      positionStrategy: this.overlay.position().global()
        .left(`${this.clampHorizontal(point.x)}px`)
        .top(`${this.clampVertical(point.y)}px`),
    });

    this.overlayRef.attach(new TemplatePortal(template, viewContainerRef));
    this.opened.set(true);
    this.listenForClose(this.overlayRef);
  }

  openConnected(template: TemplateRef<unknown>, container: ViewContainerRef, opener: HTMLElement): void {
    this.close();
    this.opener = opener;
    this.overlayRef = this.overlay.create({
      hasBackdrop: true,
      backdropClass: 'cdk-overlay-transparent-backdrop',
      scrollStrategy: this.overlay.scrollStrategies.reposition(),
      positionStrategy: this.overlay.position().flexibleConnectedTo(opener)
        .withPositions([
          { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top' },
          { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom' },
          { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'bottom' },
          { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top' },
        ]).withPush(true).withViewportMargin(16),
    });
    this.overlayRef.attach(new TemplatePortal(template, container));
    this.opened.set(true);
    this.listenForClose(this.overlayRef, false);
  }

  close(): void {
    const overlayRef = this.overlayRef;
    const opener = this.opener;

    this.overlayRef = undefined;
    this.opener = null;
    this.opened.set(false);
    this.eventSubscriptions.unsubscribe();
    this.eventSubscriptions = new Subscription();
    overlayRef?.dispose();
    opener?.focus();
  }

  private listenForClose(overlayRef: OverlayRef, navigate = true): void {
    this.eventSubscriptions.add(
      overlayRef.backdropClick().subscribe(() => this.close()),
    );
    this.eventSubscriptions.add(
      overlayRef.keydownEvents().subscribe((event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          this.close();
          return;
        }

        if (navigate) this.navigateButtons(event);
      }),
    );

    const backdrop = overlayRef.backdropElement;
    if (backdrop) {
      const listener = (event: MouseEvent) => {
        event.preventDefault();
        this.close();
      };
      backdrop.addEventListener('contextmenu', listener);
      this.eventSubscriptions.add(() => {
        backdrop.removeEventListener('contextmenu', listener);
      });
    }
  }

  private navigateButtons(event: KeyboardEvent): void {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || this.isTextInput(event.target)) {
      return;
    }

    const buttons = Array.from(
      this.overlayRef?.overlayElement.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
    ).filter((button) => !button.disabled);
    if (!buttons.length) {
      return;
    }

    event.preventDefault();
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number;

    switch (event.key) {
      case 'ArrowDown':
        nextIndex = currentIndex < 0 || currentIndex === buttons.length - 1 ? 0 : currentIndex + 1;
        break;
      case 'ArrowUp':
        nextIndex = currentIndex <= 0 ? buttons.length - 1 : currentIndex - 1;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = buttons.length - 1;
        break;
      default:
        return;
    }

    buttons[nextIndex].focus();
  }

  private isTextInput(target: EventTarget | null): boolean {
    return target instanceof HTMLInputElement
      || target instanceof HTMLSelectElement
      || target instanceof HTMLTextAreaElement;
  }

  private clampHorizontal(x: number): number {
    return Math.max(0, Math.min(x, window.innerWidth - 320));
  }

  private clampVertical(y: number): number {
    return Math.max(0, Math.min(y, window.innerHeight - 260));
  }
}
