import { brushable } from './panel-shapes';
import { deriveLayout, moveLayout, resizeLayout, reconcileLayout, panelsWithPreferredRows } from './layout';
/**
 * The reducer: `(state, command) => state`, pure, and the only writer of state.
 *
 * Every rule under "Reducer behaviour worth stating" in
 * `docs/dashboard-graph.md` is applied here -- which command changes what, in
 * what order, and what has to be evicted or pruned afterwards. The rules
 * themselves live beside the thing they are rules about: `panels.ts` for a
 * panel's shape, `cohorts.ts` for a cohort's, `filters.ts` for a filter list,
 * `datasets.ts` for the entries map, `url.ts` for anything that arrived from a
 * link. This file is the fold.
 */

import {
  asColumnId,
  canonicalViewFor,
  viewsFor,
  type Filter,
} from '@mriqc/shared';
import { cohortAutoName, uniqueCohortName } from './cohort-name';
import {
  isKnownCohortId,
  mintCohortId,
  nextCohortColor,
  patchCohort,
  retargetCohorts,
  validCohortList,
} from './cohorts';
import { sameFilters, validFilters } from './filters';
import { cohortChange, panelPatch, type Command } from './commands';
import { evict, touch } from './datasets';
import { validForm } from './panel-shapes';
import { seriesKey, type Series } from './series';
import {
  mapPanel,
  addSeries,
  removeSeries,
  newPanel,
  patchPanel,
  pruneCohortRefs,
  pruneSelection,
  retargetPanels,
  revertToDistribution,
} from './panels';
import { CATALOG_KEY, studyFormReason } from './queries';
import {
  CURRENT_COHORT,
  FIRST_PAGE,
  INITIAL_STATE,
  MIN_COMPARISON_COHORTS,
  STUDY_COHORT,
  defaultPanelOptions,
  isDerivedCohort,
  type CohortId,
  type DatasetEntry,
  type Panel,
  type State,
} from './state';
import { validateUrlState, type UrlState } from './url';

const STUDY_LINK_NOTICE = 'This view compared against a study that is not in the link.';

function withoutStudyDatasets(state: State): State {
  const entries = Object.entries(state.datasets).filter(([key]) => !key.startsWith('study/'));
  if (entries.length === Object.keys(state.datasets).length) return state;
  return { ...state, datasets: Object.fromEntries(entries) };
}

function referencesStudy(url: UrlState): boolean {
  return url.panels.some(panel => panel.series.some(series => series.kind === 'study'));
}

/* ----------------------------------------------------------- default layout */

/**
 * The dashboard an empty URL opens: bold on its canonical view, four
 * distributions and coverage.
 *
 * Canonical rather than `raw` because the raw log counts one image once per
 * upload, so every figure on a raw-view dashboard is a count of uploads
 * presented as a count of images. `raw` stays one click away in the view select
 * (`k3pp-structural-canonicalization.md`, "Decisions").
 */
export function defaultDashboard(): UrlState {
  const options = defaultPanelOptions();
  const metrics: readonly string[] = ['fd_mean', 'tsnr', 'dvars_std', 'snr'];
  const panels = metrics.map((metric, i) => ({
    id: `p${i + 1}`,
    x: asColumnId(metric),
    y: null,
    form: 'histogram' as const,
    series: [],
    options: { ...options },
  }));
  return {
    global: { modality: 'bold', view: canonicalViewFor('bold'), filters: [] },
    // No cohorts: `current` and `all` are derived and always there, and a
    // default dashboard is metric lookup, which is what the comparison panel
    // exists to be an answer to rather than a replacement for.
    cohorts: [],
    panels: [
      ...panels,
      {
        id: `p${metrics.length + 1}`,
        x: 'created_at',
        y: null,
        form: 'histogram' as const,
        series: [],
        options: { ...options },
      },
    ],
    selections: [],
  };
}

/* ----------------------------------------------------------------- reducer */

/** Fold one command into the dashboard. Pure; never throws on bad input. */
export function reduce(state: State, command: Command): State {
  switch (command.t) {
    /* ------------------------------------------------------ global controls */

    case 'setModality': {
      const modality = command.modality;
      if (modality === state.global.modality) return state;
      const views = viewsFor(modality).map((v) => v.id);
      // The view the user is on if the new modality has it -- `raw` is common to
      // all three, so an explicit choice of the raw log survives a switch -- and
      // otherwise that modality's canonical view rather than `raw`: K4+ has no
      // T1w counterpart, and the honest substitute for one canonical policy is
      // the other, not the unaggregated log.
      const view = views.includes(state.global.view)
        ? state.global.view
        : canonicalViewFor(modality);
      const cohorts = retargetCohorts(state.cohorts, modality);
      return evict({
        ...state,
        global: { modality, view, filters: [] },
        selections: [],
        cohorts,
        // Cohort refs survive -- a cohort keeps its id across a modality switch
        // -- but a panel whose metric the new modality has none of reverts, and
        // `pruneCohortRefs` is the one place that rule lives.
        panels: pruneCohortRefs(retargetPanels(state.panels, modality, view), {
          ...state,
          global: { modality, view, filters: [] },
          cohorts,
        }),
      });
    }

    case 'setView': {
      const view = command.view;
      if (view === state.global.view) return state;
      const { modality } = state.global;
      if (!viewsFor(modality).some((v) => v.id === view)) return state;
      return evict({
        ...state,
        global: {
          ...state.global,
          view,
          filters: validFilters(state.global.filters, modality, view),
        },
        panels: retargetPanels(state.panels, modality, view),
      });
    }

    case 'setFilters': {
      const { modality, view } = state.global;
      const filters = validFilters(command.filters, modality, view);
      // The reducer is the single equality check: the form sources resend the
      // whole control value on every change, and a filter list that did not
      // change must leave the state reference alone or every unrelated keystroke
      // would re-derive the dashboard.
      if (sameFilters(filters, state.global.filters)) return state;
      return evict({ ...state, global: { ...state.global, filters } });
    }

    /* ---------------------------------------------------------------- panels */

    case 'addPanel': {
      const made = newPanel(state, command.x);
      const configured = patchPanel({ ...state, panels: [...state.panels, made] }, made.id, {
        ...(command.y !== undefined ? { y: command.y } : {}),
        ...(command.form ? { form: command.form } : {}),
        ...(command.series ? { series: command.series } : {}),
      });
      const panels = configured.panels;
      return evict({
        ...state,
        panels,
        ...(state.layout ? { layout: reconcileLayout(state.layout, panelsWithPreferredRows({...state, panels}), 3) } : {}),
      });
    }

    case 'removePanel': {
      const panels = state.panels.filter((panel) => panel.id !== command.id);
      if (panels.length === state.panels.length) return state;
      const selections = state.selections.filter(selection => selection.from !== command.id);
      return evict({ ...state, panels, selections,
        ...(state.layout ? { layout: reconcileLayout(state.layout, panelsWithPreferredRows({...state, panels}), 3) } : {}),
        ...(state.maximizedPanel === command.id ? { maximizedPanel: null } : {}),
      });
    }

    case 'restorePanel': {
      // An undo that arrives twice, or after the same id was added back by
      // hand, must not duplicate the card.
      if (state.panels.some((panel) => panel.id === command.panel.id)) return state;
      const at = Math.min(Math.max(0, Math.trunc(command.at)), state.panels.length);
      const panels = [...state.panels];
      // Cursors are not in the URL and not in the undo: a restored sample panel
      // starts at its first page like a hydrated one.
      panels.splice(at, 0, { ...command.panel, cursors: FIRST_PAGE });
      // Through the same prune `hydrate` uses: a cohort the panel drew can have
      // been deleted inside the undo window, and a restored panel naming a dead
      // cohort would sit in the comparison empty state and write that id into
      // the shared link.
      return evict({ ...state, panels: pruneCohortRefs(panels, state),
        ...(state.layout ? { layout: reconcileLayout(state.layout, panelsWithPreferredRows({...state, panels}), 3) } : {}),
      });
    }

    case 'movePanel': {
      if (!state.panels.some(panel => panel.id === command.id)) return state;
      const layout = state.layout ?? deriveLayout(panelsWithPreferredRows(state), command.columnsWide ?? 3);
      return { ...state, layout: moveLayout(layout, command.id, command.x, command.y) };
    }
    case 'resizePanel': {
      if (!state.panels.some(panel => panel.id === command.id)) return state;
      const layout = state.layout ?? deriveLayout(panelsWithPreferredRows(state), command.columnsWide ?? 3);
      return { ...state, layout: resizeLayout(layout, command.id, command.w, command.h) };
    }
    case 'resetLayout':
      return { ...state, layout: null };
    case 'maximizePanel':
      return command.id === null || state.panels.some(panel => panel.id === command.id)
        ? { ...state, maximizedPanel: command.id } : state;

    case 'patchPanel':
    case 'setPanelMetric':
    case 'setPanelAxis':
    case 'setPanelSplit':
    case 'setPanelChart':
    case 'setPanelForm':
    case 'setPanelRange':
    case 'resetPanelRanges':
    case 'setPanelGroup':
    case 'setPanelOptions':
    case 'setPanelCohort':
    case 'setPanelReference': {
      // The five one-field commands are aliases over `patchPanel`
      // (`commands.ts`, `panelPatch`), so every per-field rule is in one table.
      const change = panelPatch(command);
      return change === null ? state : patchPanel(state, change.id, change.patch);
    }

    case 'addPanelSeries': return addSeries(state, command.id, command.series);
    case 'removePanelSeries': return removeSeries(state, command.id, command.key);
    case 'addGroupToPanels': {
      let next = state;
      for (const panel of state.panels) {
        if (!command.panelIds || command.panelIds.includes(panel.id)) next = addSeries(next, panel.id, { kind: 'cohort', id: command.id });
      }
      return next;
    }
    case 'removePanelCohort': {
      const panel = state.panels.find(panel => panel.id === command.panelId);
      const item = panel?.series.find(series =>
        series.kind === 'cohort' ? series.id === command.cohort :
        series.kind === 'population' ? command.cohort === 'all' :
        series.kind === 'study' && command.cohort === 'study');
      return item ? removeSeries(state, command.panelId, seriesKey(item)) : state;
    }
    case 'revertPanelToSingle': return patchPanel(state, command.id, { series: [] });

    case 'requestPage':
      // Paging extends the chain; the table shows every page it has loaded, so
      // the earlier keys have to stay referenced.
      return evict(
        mapPanel(state, command.id, (panel) =>
          panel.cursors.includes(command.cursor)
            ? panel
            : { ...panel, cursors: [...panel.cursors, command.cursor] },
        ),
      );

    /* --------------------------------------------------------------- cohorts */

    case 'addCohort':
    case 'patchCohort':
    case 'updateCohort': {
      // All three are the same operation: a patch over the cohort an id names,
      // creating it when the command says it may (`commands.ts`, `cohortChange`).
      const change = cohortChange(command);
      if (change === null) return state;
      const cohorts = patchCohort(state, change.id, change.patch, change.create);
      return cohorts === null ? state : evict({ ...state, cohorts });
    }

    case 'saveCurrentAsCohort': {
      const { modality, view, filters } = state.global;
      const selections = state.selections.map(({ metric, range }) => ({ metric, range }));
      const name = uniqueCohortName(
        cohortAutoName(modality, view, filters, selections, state.catalog),
        state.cohorts.map((cohort) => cohort.name),
      );
      // A snapshot: the arrays are the ones state holds, and state is
      // immutable, so nothing can change under the cohort later. The view, the
      // colour and the source are `blankCohort`'s, which reads them off this
      // same dashboard.
      const cohorts = patchCohort(
        state,
        mintCohortId(state.cohorts),
        { name, filters, selections },
        true,
      );
      return cohorts === null ? state : evict({ ...state, cohorts });
    }

    case 'removeCohort': {
      if (isDerivedCohort(command.id)) return state;
      const cohorts = state.cohorts.filter((cohort) => cohort.id !== command.id);
      if (cohorts.length === state.cohorts.length) return state;
      return evict({
        ...state,
        cohorts,
        panels: pruneCohortRefs(state.panels, { ...state, cohorts }),
      });
    }

    case 'convertToComparison': {
      let next = state;
      for (const id of Array.isArray(command.with) ? command.with : [command.with]) {
        if (id === 'current') continue;
        const series: Series = id === 'all' ? { kind: 'population' } : id === 'study' ? { kind: 'study' } : { kind: 'cohort', id };
        next = addSeries(next, command.panelId, series);
      }
      return next;
    }

    /* ------------------------------------------------------ linked selection */

    case 'clearSelections':
      return state.selections.length ? evict({ ...state, selections: [] }) : state;
    case 'zoomToBrush': {
      const panel = state.panels.find(panel => panel.id === command.from);
      const selection = state.selections.find(selection => selection.from === command.from && selection.metric === panel?.x);
      if (!panel || !selection || selection.range[0] === selection.range[1]) return state;
      return patchPanel({ ...state, selections: state.selections.filter(selection => selection.from !== command.from) }, panel.id,
        { options: { xRange: [...selection.range] as [number, number] } });
    }
    case 'brush2d':
    case 'brush': {
      const origin = state.panels.find(panel => panel.id === command.from);
      const metrics = command.t === 'brush' ? [command.metric] : [command.x, command.y];
      const ranges = command.t === 'brush' ? (command.range ? [command.range] : null)
        : command.ranges ? [command.ranges.x, command.ranges.y] : null;
      if (ranges === null) {
        const selections = state.selections.filter(selection => !metrics.includes(selection.metric));
        return selections.length === state.selections.length ? state : evict({ ...state, selections });
      }
      if (!origin || !brushable(origin) ||
          origin.x !== metrics[0] || (command.t === 'brush2d' && origin.y !== metrics[1]) ||
          ranges.some(range => !range.every(Number.isFinite))) return state;
      const replacements = metrics.map((metric, i) => ({ from: command.from, metric,
        range: [...ranges[i]].sort((a, b) => a - b) as [number, number] }));
      const selections = [...state.selections.filter(selection => !metrics.includes(selection.metric)), ...replacements];
      if (selections.length > 4) return { ...state, notice: 'Up to four metric ranges can be brushed. Clear a range first.' };
      if (JSON.stringify(selections) === JSON.stringify(state.selections)) return state;
      return evict({ ...state, selections, notice: null });
    }

    /* -------------------------------------------------------------------- url */

    case 'hydrate': {
      const omittedStudy = referencesStudy(command.url);
      const url = validateUrlState(command.url);
      return evict({
        ...state,
        global: url.global,
        cohorts: url.cohorts,
        panels: pruneCohortRefs(
          url.panels.map((panel) => ({ ...panel, cursors: FIRST_PAGE })),
          { ...state, global: url.global, cohorts: url.cohorts },
        ),
        selections: url.selections,
        layout: url.layout ?? null,
        maximizedPanel: url.maximizedPanel ?? null,
        notice: command.notice ?? (omittedStudy ? STUDY_LINK_NOTICE : null),
      });
    }

    /* ------------------------------------------------------------------- data */

    case 'dataArrived': {
      const existing = state.datasets[command.key];
      // An entry already at the current version outranks an arrival tagged with
      // any other version: that arrival is from a superseded fetch.
      if (
        existing &&
        existing.version === state.dataVersion &&
        existing.version !== command.version
      ) {
        return state;
      }
      const datasets = touch(state.datasets, command.key, {
        status: 'ready',
        version: command.version,
        result: command.result,
      });
      const catalog =
        command.key === CATALOG_KEY ? (command.result as State['catalog']) : state.catalog;
      return { ...state, datasets, catalog };
    }

    case 'dataFailed': {
      const version = state.dataVersion ?? '';
      const existing = state.datasets[command.key];
      if (existing && existing.status === 'ready' && existing.version === version) return state;
      return {
        ...state,
        datasets: touch(state.datasets, command.key, {
          status: 'error',
          version,
          error: command.error,
        }),
      };
    }

    case 'retryKey': {
      if (state.datasets[command.key] === undefined) return state;
      const datasets = { ...state.datasets };
      delete datasets[command.key];
      return { ...state, datasets };
    }

    case 'dataVersionChanged':
      return state.dataVersion === command.version
        ? state
        : { ...state, dataVersion: command.version };

    /* ------------------------------------------------------------------ study */

    case 'studyChosen':
      return withoutStudyDatasets({ ...state, study: { status: 'loading' } });

    case 'studyLoaded': {
      let loaded: State = {
        ...state,
        study: {
          status: 'ready',
          name: command.name,
          rows: command.rows,
          metrics: command.metrics,
          totalMetrics: command.totalMetrics,
          ignoredColumns: command.ignoredColumns,
          missingMetrics: command.missingMetrics,
          ...(command.columns ? { columns: command.columns } : {}),
          ...(command.columnMapping ? { columnMapping: command.columnMapping } : {}),
        },
      };
      if (command.addToAll) {
        for (const panel of loaded.panels) {
          if (!panel.series.some(series => series.kind === 'study') && !studyFormReason(panel, loaded)) {
            loaded = addSeries(loaded, panel.id, { kind: 'study' });
          }
        }
      }
      return evict(loaded);
    }

    case 'studyFailed':
      return withoutStudyDatasets({ ...state, study: { status: 'error', error: command.error } });

    case 'clearStudy': {
      if (state.study === 'none') return state;
      const cleared = withoutStudyDatasets({ ...state, study: 'none' });
      return evict({ ...cleared, panels: pruneCohortRefs(cleared.panels, cleared) });
    }

    /* ----------------------------------------------------------------- export */

    case 'openExport':
      return { ...state, exportDialogOpen: true };

    case 'requestExport':
      return { ...state, export: { status: 'running', rows: 0, request: {
        ...state.global, columns: command.columns, format: command.format ?? 'arrow',
        selections: state.selections.map(({ metric, range }) => ({ metric, range })),
      } } };

    case 'exportProgress':
      return typeof state.export === 'object' && state.export.status === 'running'
        ? { ...state, export: { ...state.export, rows: command.rows } }
        : state;

    case 'exportFinished':
      return { ...state, export: 'idle' };

    case 'cancelExport':
      return { ...state, export: 'idle', exportDialogOpen: false };

    case 'exportFailed':
      return { ...state, export: { status: 'error', error: command.error } };
  }
}

/** The state a fresh dashboard folds from. */
export const initialState: State = INITIAL_STATE;
