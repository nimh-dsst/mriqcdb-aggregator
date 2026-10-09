import { TestBed } from '@angular/core/testing';
import { Theme, THEME_STORAGE_KEY } from './theme';
import { ThemeToggle } from './theme-toggle';
import { WEB_ICONS } from '../app.config';

describe('viewer theme', () => {
  beforeEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    document.documentElement.removeAttribute('data-theme');
  });
  afterEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    document.documentElement.removeAttribute('data-theme');
  });
  it('uses System without an override, and stamps explicit choices', () => {
    const theme = TestBed.inject(Theme);
    expect(theme.preference()).toBe('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    theme.set('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(theme.mode()).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    theme.set('light');
    expect(document.documentElement.dataset['theme']).toBe('light');
    theme.set('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
  it('restores a dark preference on a cold load', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(TestBed.inject(Theme).mode()).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('dark');
  });
  it('cycles from the rendered theme button', async () => {
    TestBed.configureTestingModule({ imports: [ThemeToggle, WEB_ICONS] });
    const fixture = TestBed.createComponent(ThemeToggle);
    await fixture.whenStable();
    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toContain('Theme: System');
    button.click();
    await fixture.whenStable();
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(
      fixture.nativeElement.querySelector('lucide-icon').getAttribute('ng-reflect-name') ??
        fixture.nativeElement.innerHTML,
    ).toBeTruthy();
  });
  it('still changes theme when storage access is denied', () => {
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const theme = TestBed.inject(Theme);
    expect(theme.preference()).toBe('system');
    expect(() => theme.set('dark')).not.toThrow();
    expect(document.documentElement.dataset['theme']).toBe('dark');
    read.mockRestore();
    write.mockRestore();
  });
  it('tracks system changes without overriding an explicit choice', () => {
    const media = new EventTarget() as EventTarget & { matches: boolean };
    media.matches = false;
    const original = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: () => media,
    });
    try {
      const theme = TestBed.inject(Theme);
      const changed = new Event('change');
      Object.defineProperty(changed, 'matches', { value: true });
      media.dispatchEvent(changed);
      expect(theme.mode()).toBe('dark');
      theme.set('light');
      media.dispatchEvent(changed);
      expect(theme.mode()).toBe('light');
    } finally {
      window.matchMedia = original;
    }
  });
});
