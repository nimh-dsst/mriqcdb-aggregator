import type { State } from '../../graph/state';
import type { LayoutPanel } from './geometry';

export function panelsWithPreferredRows(state: State): readonly LayoutPanel[] { return state.panels; }
