import type { State } from '../../graph/state';
import { axisType } from './shapes';

const SHARE_FORMS: readonly string[] = ['histogram', 'line', 'area', 'density'];

/**
 * Groups of different sizes only compare as shapes, so a distribution that
 * gains its first split, is created with one, or is switched to from a
 * non-distribution form while split, shows each group's own share. Count
 * stays one click away on the card.
 */
export function shareOnFirstSplit(before: State, after: State): State {
  if (after.panels === before.panels) return after;
  const previous = new Map(before.panels.map(panel => [panel.id, panel]));
  let changed = false;
  const panels = after.panels.map(panel => {
    const old = previous.get(panel.id);
    const enteredShareForm = !!old && !SHARE_FORMS.includes(old.form);
    if (panel.series.length === 0 || (old && old.series.length > 0 && !enteredShareForm)) return panel;
    if (panel.options.yMode !== 'count' || !SHARE_FORMS.includes(panel.form) || axisType(panel.x) !== 'numeric') return panel;
    changed = true;
    return { ...panel, options: { ...panel.options, yMode: 'share' as const } };
  });
  return changed ? { ...after, panels } : after;
}

