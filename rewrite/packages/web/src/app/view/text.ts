import { axisType } from '../graph/panel-shapes';
/**
 * The words a card says, and the numbers in them.
 *
 * Everything here is copy: the one sentence under a card's title, the noun a
 * count is counted in, the chips that follow it, and the rounding every figure
 * on the page goes through. The rule behind the wording is in
 * `docs/ui-style.md`, "Copy"; the per-kind sentences are templates in
 * `PANEL_KINDS`, so this file composes and that table words.
 *
 * A cohort's auto-generated name is *not* here: it is composed from filters
 * rather than from a panel, and lives in `graph/cohort-name.ts`.
 */

import {
  fieldsFor,
  metricsFor,
  viewsFor,
  type ClipMode,
  type ColumnId,
  type FieldDef,
  type Granularity,
  type MetricDef,
  type Modality,
  type ViewDef,
} from '@mriqc/shared';
import { effectiveSelection } from '../graph/queries';
import type { Panel, PanelChart, State } from '../graph/state';

/* ------------------------------------------------- what the view layer reads */

/** The metric a panel is on, as the catalog defines it. */
export function metricDef(state: State, id: string | null): MetricDef | null {
  if (!id) return null;
  return metricsFor(state.global.modality).find((m) => m.id === id) ?? null;
}

/** Meaning lines for the two-metric and metric-family shapes. */
export function analysisMeaning(x: string, y: string, n: number | null, noun: string, family?: string): string {
  const count = n?.toLocaleString('en-US') ?? '…';
  return family === undefined
    ? `How ${x} relates to ${y}, across ${count} ${noun}.`
    : `How the ${family} metrics correlate with each other, across ${count} ${noun}.`;
}

/** The field a panel is split by, as the catalog defines it. */
export function fieldDef(state: State, id: ColumnId | null): FieldDef | null {
  if (!id) return null;
  const { modality, view } = state.global;
  return fieldsFor(modality, view, 'group').find((f) => f.id === id) ?? null;
}

/** The `ViewDef` the whole page is on, which every unit noun is read off. */
export function activeView(state: State): ViewDef | undefined {
  return viewsFor(state.global.modality).find((v) => v.id === state.global.view);
}

/* ------------------------------------------------------------------ numbers */

/**
 * `value` to `digits` significant digits, as a plain decimal where that stays
 * readable and in exponent form where it does not. Rounding through
 * `toPrecision` and back through `Number` drops the trailing zeros that make
 * `0.0400` read as a measurement rather than a rounded one.
 */
export function significant(value: number | null | undefined, digits = 3): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '--';
  const rounded = Number(value.toPrecision(digits));
  if (rounded === 0) return '0';
  const abs = Math.abs(rounded);
  if (abs >= 1e6 || abs < 1e-4) return rounded.toExponential(digits - 1);
  return String(rounded);
}

/* -------------------------------------------------------------- unit nouns */

/**
 * What one row of a view is, in a word: the noun every count, axis title and
 * stat label on the page uses.
 *
 * Read off the `ViewDef` rather than keyed by view id, so a fourth view gets an
 * answer without a fourth branch. A raw row is an upload -- the same scan can
 * be in there ten times -- a canonical row is a scan, and a canonical-plus-
 * quarantine row is one or the other.
 */
export function unitNoun(view: ViewDef | undefined): string {
  if (!view || view.policy === undefined) return 'uploads';
  return view.includesQuarantined === true ? 'scans and unstable uploads' : 'scans';
}

/** `SCANS` or `UPLOADS`: the stat row's first label, which has no room for the long form. */
export function statUnitLabel(view: ViewDef | undefined): string {
  return view?.policy === undefined ? 'UPLOADS' : 'SCANS';
}

/**
 * The count axis title: "Scans" or "Uploads", never "Records".
 *
 * Short on purpose -- it is a 12px vertical label beside the ticks -- so the
 * `_all` views say "Scans" too, and the card's sentence underneath is where the
 * quarantined uploads in that total get named.
 */
export function countAxisTitle(view: ViewDef | undefined): string {
  return view?.policy === undefined ? 'Uploads' : 'Scans';
}

/** How a modality is written in a sentence. */
const MODALITY_NOUN: Record<Modality, string> = {
  bold: 'BOLD',
  T1w: 'T1w',
  T2w: 'T2w',
};

/**
 * The whole corpus in a noun phrase: "778,075 deduplicated BOLD scans",
 * "BOLD uploads", "deduplicated T1w scans and unstable uploads".
 */
export function viewNoun(modality: Modality, view: ViewDef | undefined): string {
  const unit = unitNoun(view);
  const modalityNoun = MODALITY_NOUN[modality] ?? String(modality);
  return view?.policy === undefined
    ? `${modalityNoun} ${unit}`
    : `deduplicated ${modalityNoun} ${unit}`;
}

/* ------------------------------------------------------------ the sentence */

/**
 * How short a catalog description has to be to ride along in the card's
 * sentence rather than waiting in the info popover.
 *
 * Past this the sentence stops being one: "How many scans fall in each range of
 * DVARS Standard (DVARS-based temporal change metric across successive volumes)"
 * is a definition wearing a parenthesis.
 */
export const GLOSS_LIMIT = 40;

/** A description as it reads mid-sentence: no full stop, and no stray capital. */
function gloss(description: string): string {
  const trimmed = description.replace(/\.\s*$/, '');
  return /^[A-Z][a-z]/.test(trimmed) ? trimmed[0].toLowerCase() + trimmed.slice(1) : trimmed;
}

/**
 * The metric as the sentence names it: its label, then a parenthesis carrying
 * whichever of the short description and the unit exist. No parenthesis at all
 * when neither does.
 */
export function metricPhrase(
  label: string,
  description: string | null,
  unit: string | null,
): string {
  const parts: string[] = [];
  if (description !== null && description.length <= GLOSS_LIMIT) parts.push(gloss(description));
  if (unit !== null && unit !== '') parts.push(unit);
  return parts.length > 0 ? `${label} (${parts.join(', ')})` : label;
}

/** Everything the meaning line reads, so it can be tested without a `State`. */
export interface MeaningInput {
  x?: Panel['x'];
  kind?: string;
  form: PanelChart;
  modality: Modality;
  view: ViewDef | undefined;
  metricLabel: string | null;
  metricDescription: string | null;
  metricUnit: string | null;
  groupLabel: string | null;
  granularity: Granularity;
  /** Number of resolved plotted series. */
  cohortCount?: number;
}

/**
 * One sentence per card, composed from its quantity, form, series and row policy.
 *
 * Pure, and the only place the dashboard says what a figure *is*. Every other
 * always-visible string on a card is a number or a control label; the
 * explanations live in the info popover and the About dialog.
 *
 * It states no count. The line underneath it is a count and nothing else, and
 * saying "across 778,075 deduplicated BOLD scans" here only to say "778,075
 * deduplicated BOLD scans with a value" immediately below printed the same
 * figure twice -- and cost the phone layout a whole wrapped line.
 */
export function panelMeaning(input: MeaningInput): string {
  const unit = unitNoun(input.view);
  const metric = input.metricLabel ? metricPhrase(input.metricLabel, input.metricDescription, input.metricUnit) : 'values';
  const across = (input.cohortCount ?? 0) > 1 ? `, across ${input.cohortCount} series` : '';
  if (input.form === 'table') return `The individual ${unit} behind these charts, most recent first.`;
  if (input.x === 'created_at') {
    if (input.form === 'band') return `${metric} over upload time: median and middle half${across}.`;
    if (input.form === 'lines') return `${metric} over upload time: 5th, 50th and 95th percentiles${across}.`;
    if (input.form === 'ecdf') return `Cumulative share of ${unit} uploaded by each date${across}.`;
    if (input.form === 'density') return `Smoothed ${unit} counts per ${input.granularity}${across}.`;
    if (input.form === 'box') return `Spread of upload dates, approximated from ${input.granularity} counts${across}.`;
    return `${unit[0].toUpperCase() + unit.slice(1)} uploaded per ${input.granularity}${across}.`;
  }
  if (input.form === 'bars' || input.form === 'share') return `${input.form === 'share' ? 'Share' : 'Number'} of ${unit} per ${input.groupLabel ?? 'category'}${across}.`;
  if (input.form === 'ecdf') return `Share of ${unit} at or below each value of ${metric}${across}.`;
  if (input.form === 'density') return `Smoothed share of ${unit} at each value of ${metric}${across}.`;
  if (input.form === 'histogram') return `How many ${unit} fall in each range of ${metric}${across}.`;
  if (input.form === 'line' || input.form === 'area') return `${input.form === 'area' && (input.cohortCount ?? 0) > 1 ? 'Share' : 'Number'} of ${unit} per bin of ${metric}${across}.`;
  return `Spread of ${metric}${across}.`;
}

/* ------------------------------------------------------- notes and the clip */

/**
 * The qualifiers that follow a panel's count: that a brush is narrowing it, and
 * that this is the panel the brush was drawn on.
 *
 * A brush drops four cards from 778,075 to 102,020 while the card it was drawn
 * on keeps the full count, and nothing used to say why.
 */
export function panelNotes(state: State, panel: Panel): readonly string[] {
  const notes: string[] = [];
  if (state.selections.length) {
    if (state.selections.some(selection => selection.from === panel.id)) notes.push('brush source');
    else if (effectiveSelection(state, panel).length > 0) notes.push('filtered by brush');
  }
  return notes;
}

/** The range each clip mode names, in the one spelling the options menu also uses. */
export const CLIP_CHIP: Record<ClipMode, string> = {
  p01p99: 'p01–p99',
  p05p95: 'p05–p95',
  none: 'Full range',
};

/**
 * The clip, but only when it is not the one this metric opens on.
 *
 * Every panel is clipped to p01–p99 by default, so printing it on all five
 * cards reported that nothing had been changed. As a chip it means what a chip
 * should mean: someone changed this.
 */
export function clipChip(clip: ClipMode, metric: MetricDef | null, panel: Panel): string | null {
  if (axisType(panel.x) !== 'numeric' || panel.form === 'table' || panel.form === 'matrix') return null;
  if (clip === (metric?.clipDefault ?? 'p01p99')) return null;
  return CLIP_CHIP[clip];
}

/**
 * What a panel's `n` counts, in the whole corpus's own noun: "deduplicated BOLD
 * scans", and for a metric panel only the ones that actually carried a value
 * for it.
 *
 * The full `viewNoun` and not the bare unit, because this line is now the only
 * place the card names the corpus: the meaning line above it used to end in
 * "across 778,075 deduplicated BOLD scans" and printed the same number twice.
 *
 * "records" is gone everywhere. It was the one word on the page that was true
 * of both views and therefore informative about neither.
 */
export function countLabel(state: State, panel: Panel): string {
  const noun = viewNoun(state.global.modality, activeView(state));
  return axisType(panel.x) === 'numeric' && panel.form !== 'table' ? `${noun} with a value` : noun;
}
