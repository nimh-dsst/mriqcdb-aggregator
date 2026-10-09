/**
 * The colour promises the token table makes that a human eye cannot check.
 *
 * axe found 37 serious contrast failures, every one of them `--ink-3` on white
 * at 11px and 12px, and separately the focused `mat-select` carried a 1.53:1
 * indicator where 3:1 is the floor for a non-text one. Both are arithmetic, so
 * both are computed here rather than re-measured by hand the next time someone
 * nudges a token.
 *
 * The values come from `panels/specs/palette.ts`, which mirrors `styles.css`
 * because Vega renders to canvas where a CSS variable means nothing. That
 * mirror is the thing most likely to drift, so testing it is testing the
 * weaker copy -- the stronger one, the stylesheet, is checked in the browser
 * pass, which reads the computed colours off the live page.
 */

import {
  HIGHLIGHT,
  HIGHLIGHT_INK,
  LABEL_INK,
  MUTED_INK,
  SURFACE,
  SURFACE_2,
  LIGHT_THEME,
  DARK_THEME,
} from './panels/specs/palette';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** WCAG relative luminance of an `#rrggbb` colour. */
export function luminance(hex: string): number {
  const channel = (pair: string) => {
    const c = parseInt(pair, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(hex.slice(1, 3)) +
    0.7152 * channel(hex.slice(3, 5)) +
    0.0722 * channel(hex.slice(5, 7))
  );
}

/** WCAG contrast ratio between two `#rrggbb` colours. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe('contrast ratios the tokens promise', () => {
  it('defines the same colour tokens in light, system-dark and explicit-dark blocks', () => {
    const css = readFileSync(resolve('src/styles.css'), 'utf8');
    const selectors = [
      /:root \{([^}]+)\}/,
      /:root:not\(\[data-theme="light"\]\) \{([^}]+)\}/,
      /:root\[data-theme="dark"\] \{([^}]+)\}/,
    ];
    for (const selector of selectors) {
      const block = css.match(selector)?.[1];
      expect(block).toBeTruthy();
      for (const token of [
        'bg',
        'surface',
        'surface-2',
        'border',
        'ink',
        'ink-2',
        'ink-3',
        'highlight',
        'highlight-ink',
        'series-1',
      ])
        expect(block).toContain(`--${token}:`);
    }
    expect(css).toContain('@media (prefers-color-scheme: dark)');
  });
  it('keeps caption text and the single-series mark readable in both themes', () => {
    for (const theme of [LIGHT_THEME, DARK_THEME]) {
      expect(contrast(theme.mutedInk, theme.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.populationColor, theme.surface)).toBeGreaterThanOrEqual(3);
      expect(contrast(theme.highlightInk, theme.highlight)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(DARK_THEME.mutedInk, DARK_THEME.surface2)).toBeGreaterThanOrEqual(4.5);
  });
  it('computes the reference ratios correctly', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 4);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 4);
    // Symmetric, and mid grey against both ends of the range.
    expect(contrast('#767676', '#ffffff')).toBeCloseTo(contrast('#ffffff', '#767676'), 9);
    expect(contrast('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('reads --ink-3 as text on white, which needs 4.5:1 at 11 and 12px', () => {
    expect(MUTED_INK).toBe('#6e7787');
    expect(contrast(MUTED_INK, SURFACE)).toBeGreaterThanOrEqual(4.5);
  });

  it('is still short of 4.5:1 on --surface-2, which is why text there is --ink-2', () => {
    // The sample table's header sits on `--surface-2`; it uses `--ink-2`.
    expect(contrast(MUTED_INK, SURFACE_2)).toBeLessThan(4.5);
    expect(contrast(LABEL_INK, SURFACE_2)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(LABEL_INK, SURFACE)).toBeGreaterThanOrEqual(4.5);
  });

  it('gives the focus indicator a component that clears the 3:1 non-text floor', () => {
    // Amber alone never did: it is the identity of the ring, not its contrast,
    // which is why the ring is amber *and* a `--highlight-ink` edge.
    expect(contrast(HIGHLIGHT, SURFACE)).toBeLessThan(3);
    expect(contrast(HIGHLIGHT_INK, SURFACE)).toBeGreaterThanOrEqual(3);
  });

  it('keeps text on amber readable', () => {
    expect(contrast(HIGHLIGHT_INK, HIGHLIGHT)).toBeGreaterThanOrEqual(4.5);
  });
});
