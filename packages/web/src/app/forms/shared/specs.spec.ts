import { compile } from 'vega-lite';
import type { TopLevelSpec } from 'vega-lite';
import {
  boxSpec,
  countsSpec,
  ecdfSpec,
  facetedEcdfSpec,
  facetedHistogramSpec,
  histogramSpec,
  cohortBoxSpec,
  densitySpec,
  overlaidDensitySpec,
  overlaidEcdfSpec,
  overlaidHistogramSpec,
  type CohortSeries,
  type MetricAxis,
} from './index';

/** Two cohorts, as the comparison specs take them: a name and a palette hue. */
const cohorts: readonly CohortSeries[] = [
  { id: 'current', label: 'This dashboard', color: '#2a78d6' },
  { id: 'all', label: 'Whole population', color: '#eb6834' },
];

const axis: MetricAxis = {
  label: 'Mean framewise displacement',
  unit: 'mm',
  logScale: false,
  countTitle: 'Scans',
};
const logAxis: MetricAxis = {
  ...axis,
  label: 'Foreground-background energy ratio',
  unit: undefined,
  logScale: true,
};

/** Every chart the dashboard can draw, with the dataset names it expects to fill. */
const CHARTS: readonly (readonly [
  name: string,
  spec: TopLevelSpec,
  datasets: readonly string[],
])[] = [
  ['histogram', histogramSpec(axis), ['population']],
  ['ecdf', ecdfSpec(axis), ['population']],
  ['box', boxSpec(axis, 'Manufacturer'), ['groups']],
  ['facetedHistogram', facetedHistogramSpec(axis, 'Manufacturer'), ['groups']],
  ['facetedEcdf', facetedEcdfSpec(axis, 'Manufacturer'), ['groups']],
  ['density', densitySpec(axis), ['population']],
  ['overlaidHistogram', overlaidHistogramSpec(axis, cohorts), ['cohorts']],
  ['overlaidDensity', overlaidDensitySpec(axis, cohorts), ['cohorts']],
  ['overlaidEcdf', overlaidEcdfSpec(axis, cohorts), ['cohorts']],
  ['cohortBox', cohortBoxSpec(axis, cohorts), ['cohorts']],
];

describe('chart specs', () => {
  for (const [name, spec, datasets] of CHARTS) {
    describe(name, () => {
      it('matches its snapshot', () => {
        expect(spec).toMatchSnapshot();
      });

      it('compiles without throwing', () => {
        const compiled = compile(spec);
        expect(compiled.spec).toBeDefined();
        expect(compiled.spec.marks?.length ?? 0).toBeGreaterThan(0);
      });

      it('names its data, so datasets can be swapped without re-embedding', () => {
        const names = (compile(spec).spec.data ?? []).map((source) => source.name);
        for (const dataset of datasets) expect(names).toContain(dataset);
      });
    });
  }

  it('declares a brush on the distribution and comparison charts only', () => {
    const brushable = [
      histogramSpec(axis),
      ecdfSpec(axis),
      densitySpec(axis),
      overlaidHistogramSpec(axis, cohorts),
      overlaidDensitySpec(axis, cohorts),
      overlaidEcdfSpec(axis, cohorts),
    ];
    for (const spec of brushable) {
      expect(JSON.stringify(spec)).toContain('"name":"brush"');
    }
    const plain = [
      boxSpec(axis, 'g'),
      facetedHistogramSpec(axis, 'g'),
      countsSpec({ ...axis, xScale: "time", label: "Upload time" }, "line", cohorts),
      // A box is a summary per row, not a distribution over the value axis, so
      // there is no interval on it to drag.
      cohortBoxSpec(axis, cohorts),
    ];
    for (const spec of plain) {
      expect(JSON.stringify(spec)).not.toContain('"name":"brush"');
    }
  });

  it('removes histogram gaps above 100 bins to avoid pattern glare', () => {
    expect(JSON.stringify(histogramSpec(axis, null, 100))).toContain('"binSpacing":2');
    expect(JSON.stringify(histogramSpec(axis, null, 101))).toContain('"binSpacing":0');
  });

  it('labels the value axis with the metric label and unit', () => {
    expect(JSON.stringify(histogramSpec(axis))).toContain('Mean framewise displacement (mm)');
    expect(JSON.stringify(histogramSpec(logAxis))).toContain('Foreground-background energy ratio"');
  });

  it('names the count axis after the view, never "Records"', () => {
    // The y axis of a histogram and of a coverage stack both count the same
    // thing, so both are named in the same noun -- and that noun is a fact
    // about the view, not a word that is true of every view.
    expect(JSON.stringify(histogramSpec(axis))).toContain('"title":"Scans"');
    expect(JSON.stringify(histogramSpec({ ...axis, countTitle: 'Uploads' }))).toContain(
      '"title":"Uploads"',
    );
    expect(
      JSON.stringify(countsSpec({ ...axis, countTitle: 'Uploads', xScale: "time", label: "Upload time" }, "line", cohorts)),
    ).toContain('"title":"Uploads"');
    for (const spec of [
      histogramSpec(axis),
      overlaidHistogramSpec(axis, cohorts),
      overlaidDensitySpec(axis, cohorts),
      facetedHistogramSpec(axis, 'Manufacturer'),
      countsSpec({ ...axis, xScale: "time", label: "Upload time" }, "line", cohorts),
    ]) {
      expect(JSON.stringify(spec)).not.toContain('Records');
    }
  });

  describe('comparison charts', () => {
    it('names the share axis in the view’s own noun, never a raw count', () => {
      const spec = JSON.stringify(overlaidHistogramSpec(axis, cohorts));
      expect(spec).toContain('"title":"Share of scans"');
      expect(
        JSON.stringify(overlaidHistogramSpec({ ...axis, countTitle: 'Uploads' }, cohorts)),
      ).toContain('"title":"Share of uploads"');
    });

    it('keys the colour scale on cohort ids, labelled by name', () => {
      // Declared rather than inferred from the rows: a cohort whose query has
      // not landed contributes no rows, and an inferred scale would hand its
      // colour to the next cohort along and repaint the chart as results
      // arrive. Keyed on the *id*, because two cohorts can share a name and a
      // name-keyed domain would collapse them into one series.
      const spec = JSON.stringify(overlaidEcdfSpec(axis, cohorts));
      expect(spec).toContain('"domain":["current","all"]');
      expect(spec).toContain('"range":["#2a78d6","#eb6834"]');
      // The legend still reads as English.
      expect(spec).toContain('This dashboard');
      expect(spec).toContain('Whole population');
    });

    it('keeps two cohorts that share a name as two series', () => {
      const twins: readonly CohortSeries[] = [
        { id: 'c1', label: 'Cohort', color: '#2a78d6' },
        { id: 'c2', label: 'Cohort', color: '#eb6834' },
      ];
      const spec = JSON.stringify(overlaidEcdfSpec(axis, twins));
      expect(spec).toContain('"domain":["c1","c2"]');
      // Two hues, because there are two cohorts -- a name-keyed domain would
      // have de-duplicated to one and drawn a single line through both curves.
      expect(spec).toContain('"range":["#2a78d6","#eb6834"]');
    });

    it('carries a legend on the overlays and none on the box', () => {
      // `ui-style.md`: a legend at two series or more, and a direct label where
      // there is one -- the box names every cohort on its own y axis.
      expect(JSON.stringify(overlaidHistogramSpec(axis, cohorts))).toContain('"orient":"bottom"');
      expect(JSON.stringify(overlaidEcdfSpec(axis, cohorts))).toContain('"orient":"bottom"');
      expect(JSON.stringify(cohortBoxSpec(axis, cohorts))).not.toContain('"orient":"bottom"');
    });

    it('tooltips the cohort, the bin range, the share and the count', () => {
      const spec = JSON.stringify(overlaidHistogramSpec(axis, cohorts));
      for (const title of ['"Cohort"', '"Range"', '"Share"', '"Scans"']) {
        expect(spec).toContain(title);
      }
    });

    it('draws a translucent step area with a 2px outline, not grouped bars', () => {
      // Thin bars side by side read as zebra striping at any useful bin count:
      // the eye follows the alternation rather than either distribution. A
      // histogram's shape is a silhouette, which is what an outlined area is.
      const spec = JSON.stringify(overlaidHistogramSpec(axis, cohorts));
      expect(spec).toContain('"type":"area"');
      expect(spec).toContain('"interpolate":"step-after"');
      expect(spec).toContain('"fillOpacity":0.25');
      expect(spec).toContain('"strokeWidth":2');
      expect(spec).not.toContain('"type":"bar"');
    });

    it('smooths the density with a monotone curve, never overshooting into negative share', () => {
      const spec = JSON.stringify(overlaidDensitySpec(axis, cohorts));
      expect(spec).toContain('"type":"area"');
      expect(spec).toContain('"interpolate":"monotone"');
      expect(spec).toContain('"title":"Share of scans (smoothed)"');
    });

    it('layers area series and gives every overlay a 2px line swatch', () => {
      for (const spec of [
        overlaidHistogramSpec(axis, cohorts),
        overlaidDensitySpec(axis, cohorts),
        overlaidEcdfSpec(axis, cohorts),
      ]) {
        const json = JSON.stringify(spec);
        expect(json).toContain('"symbolType":"stroke"');
        expect(json).toContain('"symbolStrokeWidth":2');
      }
      expect(JSON.stringify(overlaidHistogramSpec(axis, cohorts))).toContain('"stack":null');
      expect(JSON.stringify(overlaidDensitySpec(axis, cohorts))).toContain('"stack":null');
    });

    it('compiles with any number of cohorts', () => {
      for (const k of [2, 3, 8]) {
        const many = Array.from({ length: k }, (_, i) => ({
          id: `c${i}`,
          label: `Cohort ${i}`,
          color: '#2a78d6',
        }));
        for (const spec of [
          overlaidHistogramSpec(axis, many),
          overlaidDensitySpec(axis, many),
          overlaidEcdfSpec(axis, many),
          cohortBoxSpec(axis, many),
        ]) {
          expect(() => compile(spec)).not.toThrow();
        }
      }
    });
  });

  it('compiles a log-scaled value axis', () => {
    expect(() => compile(histogramSpec(logAxis))).not.toThrow();
    expect(() => compile(ecdfSpec(logAxis))).not.toThrow();
    expect(() => compile(boxSpec(logAxis, 'Manufacturer'))).not.toThrow();
  });
});
