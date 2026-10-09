import { type Selection } from '@mriqc/shared';
import { type Panel, type State } from '../../graph/state';

export function effectiveSelection(state: State, panel: Panel): readonly Selection[] {
  return panel.options.useSelection ? state.selections.filter(selection => selection.from !== panel.id).map(({ metric, range }) => ({ metric, range })) : [];
}
