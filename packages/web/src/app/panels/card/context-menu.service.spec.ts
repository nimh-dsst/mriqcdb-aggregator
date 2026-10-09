import { Component, ElementRef, TemplateRef, ViewChild, ViewContainerRef } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { A11yModule } from '@angular/cdk/a11y';
import { OverlayContainer, OverlayModule } from '@angular/cdk/overlay';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { ContextMenuService } from './context-menu.service';

@Component({
  standalone: false,
  template: `
    <button #opener type="button">Open menu</button>
    <ng-template #menu>
      <div cdkTrapFocus>
        <button type="button">First</button>
        <button type="button" disabled>Disabled</button>
        <button type="button">Second</button>
        <input aria-label="Filter menu" />
      </div>
    </ng-template>
  `,
})
class HostComponent {
  @ViewChild('menu', { static: true }) menu!: TemplateRef<unknown>;
  @ViewChild('opener', { static: true }) opener!: ElementRef<HTMLButtonElement>;

  constructor(
    readonly viewContainerRef: ViewContainerRef,
    readonly contextMenu: ContextMenuService,
  ) {}
}

describe('ContextMenuService', () => {
  let host: HostComponent;
  let fixture: ComponentFixture<HostComponent>;
  let overlayContainer: OverlayContainer;

  beforeEach(() => {
    TestBed.configureTestingModule({
      declarations: [HostComponent],
      imports: [A11yModule, OverlayModule],
      providers: [ContextMenuService],
    });

    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    overlayContainer = TestBed.inject(OverlayContainer);
    fixture.detectChanges();
  });

  afterEach(() => {
    host.contextMenu.close();
    overlayContainer.ngOnDestroy();
    TestBed.resetTestingModule();
  });

  it('positions the menu at the requested viewport point', async () => {
    host.contextMenu.openAt(host.menu, host.viewContainerRef, { x: 120, y: 80 });
    fixture.detectChanges();
    await fixture.whenStable();

    const pane = overlayContainer.getContainerElement().querySelector<HTMLElement>('.cdk-overlay-pane');
    expect(pane?.style.marginLeft).toBe('120px');
    expect(pane?.style.marginTop).toBe('80px');
  });

  it('clamps menu positions to the visible viewport', async () => {
    host.contextMenu.openAt(host.menu, host.viewContainerRef, {
      x: window.innerWidth + 50,
      y: window.innerHeight + 50,
    });
    fixture.detectChanges();
    await fixture.whenStable();

    const pane = overlayContainer.getContainerElement().querySelector<HTMLElement>('.cdk-overlay-pane');
    expect(pane?.style.marginLeft).toBe(`${Math.max(0, window.innerWidth - 320)}px`);
    expect(pane?.style.marginTop).toBe(`${Math.max(0, window.innerHeight - 260)}px`);
  });

  it('closes on a backdrop click and restores focus to the opener', () => {
    host.opener.nativeElement.focus();
    host.contextMenu.openAt(host.menu, host.viewContainerRef, { x: 0, y: 0 }, host.opener.nativeElement);

    overlayContainer.getContainerElement()
      .querySelector<HTMLElement>('.cdk-overlay-backdrop')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(overlayContainer.getContainerElement().querySelector('.cdk-overlay-pane')).toBeNull();
    expect(document.activeElement).toBe(host.opener.nativeElement);
  });

  it('closes on backdrop contextmenu and Escape', () => {
    host.contextMenu.openAt(host.menu, host.viewContainerRef, { x: 0, y: 0 });
    overlayContainer.getContainerElement()
      .querySelector<HTMLElement>('.cdk-overlay-backdrop')
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(overlayContainer.getContainerElement().querySelector('.cdk-overlay-pane')).toBeNull();

    host.contextMenu.openAt(host.menu, host.viewContainerRef, { x: 0, y: 0 });
    overlayContainer.getContainerElement()
      .querySelector<HTMLElement>('.cdk-overlay-pane')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(overlayContainer.getContainerElement().querySelector('.cdk-overlay-pane')).toBeNull();
  });

  it('moves focus among enabled menu buttons and leaves inputs alone', () => {
    host.contextMenu.openAt(host.menu, host.viewContainerRef, { x: 0, y: 0 });
    const overlay = overlayContainer.getContainerElement();
    const buttons = overlay.querySelectorAll<HTMLButtonElement>('button');
    const input = overlay.querySelector<HTMLInputElement>('input')!;

    buttons[0].focus();
    buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(buttons[2]);

    buttons[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(buttons[0]);

    buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(buttons[2]);

    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(input);
  });
});
