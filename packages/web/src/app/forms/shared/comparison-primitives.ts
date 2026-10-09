

import { themedColor, type ChartTheme, SERIES_LEGEND } from './palette';
import type { MetricAxis } from '../histogram/histogram';


/** The one dataset every comparison chart reads. Rows carry a `cohort` id and a `label`. */
export const COHORTS_DATA = 'cohorts';

/** A cohort as a chart knows it: an id to key on, a name to show, a hue to draw in. */
export interface CohortSeries {
  id: string;
  label: string;
  color: string;
}

/**
 * The y-axis title of a share-normalized chart, in the view's own noun: "Share
 * of scans" on a policy view, "Share of uploads" on `raw`.
 *
 * Derived from `MetricAxis.countTitle` rather than hard-coded, so the one rule
 * the copy pass established -- the unit is named once, in the view's own noun --
 * holds here too.
 */
export function shareAxisTitle(countTitle: string): string {
  return `Share of ${countTitle.toLowerCase()}`;
}

/** The same axis for a smoothed curve, which is an estimate and says so. */
export function densityAxisTitle(countTitle: string): string {
  return `${shareAxisTitle(countTitle)} (smoothed)`;
}

/**
 * The colour channel every comparison chart shares: the cohort ids in panel
 * order against their palette hues, with the legend `ui-style.md` asks for at
 * two series or more.
 *
 * The domain is declared rather than inferred so a cohort whose query has not
 * landed yet still holds its slot in the legend and its hue -- the legend is the
 * panel's statement of what it is comparing, and it must not reshuffle as
 * results arrive. `labelExpr` maps each id back to its name, because the domain
 * has to be the id while the legend has to read as English.
 *
 * The swatch is a stroke and not a square: every comparison chart is now a line
 * or an outlined area, and a filled square claims a solidity the 25% fills do
 * not have.
 */
export function cohortScale(cohorts: readonly CohortSeries[], legend: boolean, theme: ChartTheme) {
  cohorts = [...cohorts].sort((a, b) => {
    const slot = (color: string) => {
      const i = theme.categories.indexOf(themedColor(color, theme));
      return i < 0 ? theme.categories.length : i;
    };
    return slot(a.color) - slot(b.color);
  });
  const labels = cohorts.map((cohort) => `datum.value === ${JSON.stringify(cohort.id)} ? ${JSON.stringify(cohort.label)}`);
  return {
    field: 'cohort',
    type: 'nominal' as const,
    scale: {
      domain: cohorts.map((cohort) => cohort.id),
      range: cohorts.map((cohort) => themedColor(cohort.color, theme)),
    },
    ...(legend
      ? {
          legend: {
            ...SERIES_LEGEND,
            symbolType: 'stroke',
            symbolStrokeWidth: 2,
            labelExpr: `${labels.join(' : ')}${labels.length > 0 ? " : datum.value" : 'datum.value'}`,
          },
        }
      : { legend: null }),
  };
}

/** What a tooltip on a comparison mark says: which cohort, where, and the share. */
export function shareTooltip(axis: MetricAxis, withCount: boolean) {
  const tooltip: Record<string, unknown>[] = [
    { field: 'label', type: 'nominal', title: 'Cohort' },
    { field: 'range', type: 'nominal', title: 'Range' },
    { field: 'share', type: 'quantitative', title: 'Share', format: '.2%' },
  ];
  // The count is beside the share wherever there is one, because a share alone
  // cannot be sanity checked -- 4% of a cohort is 30 scans or 30,000 depending
  // on the cohort, and the reader is entitled to know which. A smoothed curve
  // has no count: its value is a weighted average over neighbouring bins.
  if (withCount) tooltip.push({ field: 'count', type: 'quantitative', title: axis.countTitle, format: ',' });
  return tooltip;
}

/** 2px, round join and cap: the outline every area and line here wears. */
export const OUTLINE = { strokeWidth: 2, strokeJoin: 'round', strokeCap: 'round' } as const;

/** The translucency of a filled area, so a cohort behind another stays readable. */
export const FILL_OPACITY = 0.25;

