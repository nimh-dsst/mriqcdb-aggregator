import { panelPatch, type Command } from './commands';
import { evict } from './datasets';
import { FORM_INFO } from './panel-shapes';
import { pruneCohortRefs } from './panels';
import { reduce } from './reducer';
import { seriesKey, seriesLabel } from './series';
import type { State } from './state';
import { encodeUrlState, urlState } from './url';

type Snapshot = Pick<State, 'global' | 'panels' | 'cohorts' | 'selections' | 'layout' | 'maximizedPanel'>;
interface Step { state: Snapshot; label: string }
export interface History {
  undo: readonly Step[];
  redo: readonly Step[];
  run: { key: string; at: number } | null;
  urlMode: 'push' | 'replace';
  studyChanged: boolean;
}
const EMPTY: History = { undo: [], redo: [], run: null, urlMode: 'replace', studyChanged: false };
const snapshot = ({ global, panels, cohorts, selections, layout, maximizedPanel }: State): Snapshot =>
  ({ global, panels, cohorts, selections, layout, maximizedPanel });
const capped = (steps: readonly Step[], step: Step): readonly Step[] => [...steps.slice(-99), step];
const studyCommand = (command: Command) => ['studyChosen', 'studyLoaded', 'studyFailed', 'clearStudy'].includes(command.t);

/** The URL push boundary and the undo boundary are the same decision. */
export function historyWorthy(before: State, after: State, command: Command): boolean {
  return before !== after && command.t !== 'hydrate' && command.t !== 'undo' && command.t !== 'redo' &&
    !studyCommand(command) && encodeUrlState(urlState(before)) !== encodeUrlState(urlState(after));
}

export function continuousKey(command: Command): string | null {
  switch (command.t) {
    case 'brush': return command.range ? `brush/${command.from}/${command.metric}` : null;
    case 'brush2d': return command.ranges ? `brush2d/${command.from}` : null;
    case 'movePanel': case 'resizePanel': return `${command.t}/${command.id}`;
    case 'setFilters': return 'filters';
    case 'setPanelRange': return Array.isArray(command.range) ? `range/${command.id}/${command.axis}` : null;
    default: {
      const patch = panelPatch(command);
      const options = patch?.patch.options;
      return options && Object.keys(patch!.patch).length === 1 &&
        Object.keys(options).every(key => key === 'xRange' || key === 'yRange') &&
        Object.values(options).some(value => Array.isArray(value))
        ? `range/${patch!.id}/${Object.keys(options).sort().join(',')}` : null;
    }
  }
}

export function commandLabel(command: Command, before: State, after: State): string {
  const patch = panelPatch(command)?.patch;
  if (patch?.form) return `form → ${FORM_INFO[patch.form].label}`;
  if (patch?.x || patch?.metric || 'y' in (patch ?? {})) return 'changed quantity';
  if (patch?.options) return Object.keys(patch.options).some(key => key.endsWith('Range')) ? 'changed axis range' : 'changed chart options';
  const cohortName = (id: string) => after.cohorts.find(cohort => cohort.id === id)?.name ?? before.cohorts.find(cohort => cohort.id === id)?.name ?? id;
  switch (command.t) {
    case 'addPanelSeries': return `added series ${seriesLabel(command.series, undefined, cohortName)}`;
    case 'removePanelSeries': {
      const series = before.panels.find(panel => panel.id === command.id)?.series.find(series => seriesKey(series) === command.key);
      return `removed series${series ? ` ${seriesLabel(series, undefined, cohortName)}` : ''}`;
    }
    case 'setModality': return `modality → ${command.modality}`;
    case 'setView': return `rows → ${command.view}`;
    case 'setFilters': return 'changed filters';
    case 'brush': case 'brush2d': return 'changed brushed range';
    case 'clearSelections': return 'cleared brushed ranges';
    case 'addPanel': return 'added chart';
    case 'removePanel': return 'removed chart';
    case 'restorePanel': return 'restored chart';
    case 'movePanel': return 'moved chart';
    case 'resizePanel': return 'resized chart';
    case 'resetLayout': return 'reset layout';
    case 'maximizePanel': return command.id ? 'maximized chart' : 'restored chart size';
    case 'zoomToBrush': return 'zoomed to brush';
    case 'addCohort': return `added group ${command.cohort.name}`;
    case 'removeCohort': return `removed group ${cohortName(command.id)}`;
    case 'updateCohort': case 'patchCohort': return `changed group ${cohortName(command.id)}`;
    case 'saveCurrentAsCohort': return 'saved current rows as group';
    case 'addGroupToPanels': return `added group ${cohortName(command.id)} to charts`;
    case 'convertToComparison': return 'added comparison';
    case 'revertPanelToSingle': return 'removed comparisons';
    case 'removePanelCohort': return `removed group ${cohortName(command.cohort)} from chart`;
    default: return patch?.series ? 'changed series' : patch?.split !== undefined || patch?.group !== undefined ? 'changed grouping' : 'changed chart';
  }
}

/** Fold history with analytical state, retaining live data/study/export state on restore. */
export function reduceHistory(state: State, command: Command, now: number): State {
  const history = state.history ?? EMPTY;
  if (command.t === 'endHistoryRun') return history.run ? { ...state, history: { ...history, run: null } } : state;
  if (command.t === 'undo' || command.t === 'redo') {
    const source = history[command.t];
    const step = source.at(-1);
    const studyNote = history.studyChanged ? ' Study upload is not undoable.' : '';
    if (!step) return { ...state, history: { ...history, run: null, urlMode: 'replace' }, notice: `Nothing to ${command.t}.${studyNote}` };
    const opposite = command.t === 'undo' ? 'redo' : 'undo';
    const restored = { ...state, ...step.state };
    return evict({ ...restored, panels: pruneCohortRefs(restored.panels, restored),
      notice: `${command.t === 'undo' ? 'Undid' : 'Redid'}: ${step.label}${studyNote}`,
      history: { ...history, [command.t]: source.slice(0, -1),
        [opposite]: capped(history[opposite], { state: snapshot(state), label: step.label }),
        run: null, urlMode: 'replace', studyChanged: false } });
  }
  const next = reduce(state, command);
  if (command.t === 'hydrate') return { ...next, history: { ...EMPTY } };
  if (studyCommand(command)) return { ...next, history: { ...history, run: null, urlMode: 'replace', studyChanged: true } };
  if (!historyWorthy(state, next, command)) return next;
  const key = continuousKey(command);
  const coalesced = key !== null && history.run?.key === key && now - history.run.at < 500;
  return { ...next, notice: null, history: {
    undo: coalesced ? history.undo : capped(history.undo, { state: snapshot(state), label: commandLabel(command, state, next) }),
    redo: [], run: key ? { key, at: now } : null, urlMode: coalesced ? 'replace' : 'push', studyChanged: false,
  } };
}

/** Keep native editing and Material overlay keyboard handling intact. */
export function historyShortcut(event: KeyboardEvent, document: Document): 'undo' | 'redo' | null {
  if (event.defaultPrevented || event.altKey || !(event.ctrlKey || event.metaKey)) return null;
  const active = document.activeElement;
  if (active?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])') ||
    document.querySelector('.mat-mdc-select-panel, .mat-mdc-menu-panel, .mat-select-panel, .mat-menu-panel')) return null;
  const key = event.key.toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  return key === 'y' && event.ctrlKey && !event.shiftKey ? 'redo' : null;
}
