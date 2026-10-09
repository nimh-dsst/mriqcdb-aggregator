import {nextTheme, themeTooltip} from './theme-toggle';

describe('theme cycle', () => {
  it('cycles through opposite system mode, same explicit mode, and system when the OS is dark', () => {
    expect(nextTheme('system', 'dark')).toBe('light');
    expect(nextTheme('light', 'dark')).toBe('dark');
    expect(nextTheme('dark', 'dark')).toBe('system');
  });

  it('cycles through opposite system mode, same explicit mode, and system when the OS is light', () => {
    expect(nextTheme('system', 'light')).toBe('dark');
    expect(nextTheme('dark', 'light')).toBe('light');
    expect(nextTheme('light', 'light')).toBe('system');
  });

  it('describes every preference and next action for both OS modes', () => {
    expect(themeTooltip('system', 'dark')).toBe('Theme: System (dark) · click for Light');
    expect(themeTooltip('light', 'dark')).toBe('Theme: Light · click for Dark');
    expect(themeTooltip('dark', 'dark')).toBe('Theme: Dark · click for System');
    expect(themeTooltip('system', 'light')).toBe('Theme: System (light) · click for Dark');
    expect(themeTooltip('dark', 'light')).toBe('Theme: Dark · click for Light');
    expect(themeTooltip('light', 'light')).toBe('Theme: Light · click for System');
  });
});
