/**
 * The command union: one variant per thing that can happen to the dashboard.
 *
 * Verbatim from `docs/dashboard-graph.md`, "Inputs". Commands are plain
 * serializable data (the one exception is `studyChosen`, which carries a
 * `File`), so a session is a replayable log.
 */

import type {
Cohort,
CohortId
} from '../../graph/state';

import type { Command } from '../../loop/commands';
export type CohortsCommand =
  | { t: 'retargetCohorts' } | { t: 'hydrateCohorts'; cohorts: readonly Cohort[] }
  | { t: 'addCohort'; cohort: Cohort }
  | { t: 'patchCohort'; id: CohortId; patch: CohortPatch; create?: boolean }
  | { t: 'saveCurrentAsCohort' }
  | { t: 'updateCohort'; id: CohortId; patch: CohortPatch }
  | { t: 'removeCohort'; id: CohortId };

export type CohortPatch = Partial<Omit<Cohort, 'id'>>;

/** A change to one cohort: the id, the patch, and whether it may create it. */
export interface CohortChange {
  id: CohortId;
  patch: CohortPatch;
  /** True for a new cohort, whose id is re-minted when that one is taken. */
  create: boolean;
}

/**
 * The cohort change a command carries, or null for a command that is not one.
 *
 * `addCohort` is `patchCohort` with `create`, and it carries the whole cohort
 * because the caller has to be able to name the thing it just made.
 */
export function cohortChange(command: Command): CohortChange | null {
  switch (command.t) {
    case 'patchCohort':
      return { id: command.id, patch: command.patch ?? {}, create: command.create === true };
    case 'addCohort': {
      const { id, ...rest } = command.cohort;
      return { id, patch: rest, create: true };
    }
    case 'updateCohort':
      return { id: command.id, patch: command.patch ?? {}, create: false };
    default:
      return null;
  }
}
