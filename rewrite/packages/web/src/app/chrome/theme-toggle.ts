import {ChangeDetectionStrategy, Component, inject} from '@angular/core';
import {MatTooltipModule} from '@angular/material/tooltip';
import {LucideAngularModule} from 'lucide-angular';

import {Theme, type ThemePreference} from './theme';

export type ThemeSystemMode = 'light' | 'dark';

export function nextTheme(
  preference: ThemePreference,
  systemMode: ThemeSystemMode,
): ThemePreference {
  if (preference === 'system') {
    return systemMode === 'dark' ? 'light' : 'dark';
  }

  return preference === systemMode ? 'system' : systemMode;
}

export function themeTooltip(
  preference: ThemePreference,
  systemMode: ThemeSystemMode,
): string {
  const label = (mode: Exclude<ThemePreference, 'system'>): string =>
    mode === 'light' ? 'Light' : 'Dark';
  const current = preference === 'system' ? `System (${systemMode})` : label(preference);
  const next = nextTheme(preference, systemMode);
  const nextLabel = next === 'system' ? 'System' : label(next);

  return `Theme: ${current} · click for ${nextLabel}`;
}

@Component({
  selector: 'app-theme-toggle',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, MatTooltipModule],
  template: `
    <button
      type="button"
      class="btn h-8 w-8 p-0"
      [matTooltip]="tooltip()"
      [attr.aria-label]="tooltip()"
      (click)="choose()"
    >
      <lucide-icon
        [name]="theme.preference() === 'system' ? 'sun-moon' : theme.preference() === 'dark' ? 'moon' : 'sun'"
        [size]="16"
        [strokeWidth]="1.75"
        aria-hidden="true"
      />
    </button>
  `,
})
export class ThemeToggle {
  protected readonly theme = inject(Theme);

  protected tooltip(): string {
    return themeTooltip(this.theme.preference(), this.theme.systemMode());
  }

  protected choose(): void {
    this.theme.set(nextTheme(this.theme.preference(), this.theme.systemMode()));
  }
}
