import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';

export type ThemePreference = 'system' | 'light' | 'dark';
export const THEME_STORAGE_KEY = 'mriqc.theme';

/** Viewer convenience only: never serialized into the analytical dashboard URL. */
@Injectable({ providedIn: 'root' })
export class Theme {
  private readonly document = inject(DOCUMENT);
  private readonly media = this.document.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
  private readonly systemDark = signal(this.media?.matches ?? false);
  readonly systemMode = computed<'light' | 'dark'>(() => this.systemDark() ? 'dark' : 'light');
  readonly preference = signal<ThemePreference>(this.read());
  readonly mode = computed<'light' | 'dark'>(() =>
    this.preference() === 'system'
      ? this.systemDark()
        ? 'dark'
        : 'light'
      : (this.preference() as 'light' | 'dark'),
  );

  constructor() {
    this.stamp();
    const changed = (event: MediaQueryListEvent) => this.systemDark.set(event.matches);
    this.media?.addEventListener('change', changed);
    inject(DestroyRef).onDestroy(() => this.media?.removeEventListener('change', changed));
  }

  set(preference: ThemePreference): void {
    this.preference.set(preference);
    this.stamp();
    try {
      this.document.defaultView?.localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      /* Storage may be blocked. */
    }
  }

  private read(): ThemePreference {
    try {
      const value = this.document.defaultView?.localStorage.getItem(THEME_STORAGE_KEY);
      if (value === 'light' || value === 'dark') return value;
    } catch {
      /* System remains available without storage. */
    }
    return 'system';
  }

  private stamp(): void {
    if (this.preference() === 'system') this.document.documentElement.removeAttribute('data-theme');
    else this.document.documentElement.setAttribute('data-theme', this.preference());
  }
}
