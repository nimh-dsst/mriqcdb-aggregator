import { compile } from 'vega-lite';
import { parse, View } from 'vega';
import { describe, expect, it } from 'vitest';

import {
  medianBandChart,
  timeSummaryRows,
  type TimeSeries,
} from './median-band';

const series: readonly TimeSeries[] = [
  {
    id: 'included',
    name: 'Included scans',
    color: '#1261a0',
    result: {
      buckets: [
        {
          start: '2026-01-01',
          group: 1,
          isOther: false,
          n: 24,
          quantiles: { p05: 0, p25: 2, p50: 3, p75: 4, p95: 5 },
          mean: 3,
          thin: false,
        },
        {
          start: '2026-02-01',
          group: 1,
          isOther: false,
          n: 8,
          quantiles: { p05: 1, p25: 3, p50: 4, p75: 6, p95: 7 },
          mean: 4,
          thin: true,
        },
      ],
    },
  },
  {
    id: 'excluded',
    name: 'Excluded scans',
    color: '#d95f02',
    result: {
      buckets: [
        {
          start: '2026-01-01',
          group: 1,
          isOther: false,
          n: 21,
          quantiles: { p05: 2, p25: 4, p50: 5, p75: 6, p95: 9 },
          mean: 5,
          thin: false,
        },
      ],
    },
  },
];

type Layer = {
  encoding?: {
    color?: { scale?: unknown };
  };
  mark?: { opacity?: number; type?: string };
  transform?: readonly { filter?: string }[];
};

function layersOf(spec: unknown): readonly Layer[] {
  return (spec as { layer: readonly Layer[] }).layer;
}

describe('medianBandChart', () => {
  it('draws a quartile area spanning adjacent buckets', async () => {
    const chart = medianBandChart(series, 'Median value');
    const compiled = compile({ ...chart.spec, width: 400, datasets: chart.datasets }).spec;
    const view = await new View(parse(compiled), { renderer: 'none' }).runAsync();
    type Scene = { marktype?: string; items?: Scene[]; x?: number; y?: number; y2?: number };
    const areas: Scene[] = [];
    const visit = (item: Scene) => {
      if (item.marktype === 'area') areas.push(item);
      item.items?.forEach(visit);
    };
    visit((view.scenegraph() as unknown as { root: Scene }).root);
    expect(areas).toHaveLength(1);
    expect(areas[0].items).toHaveLength(2);
    const [first, last] = areas[0].items!;
    expect(last.x! - first.x!).toBeGreaterThan(0);
    expect(Math.abs(first.y2! - first.y!)).toBeGreaterThan(0);
    view.finalize();
  });

  it('compiles a named-dataset chart even with no summary buckets', () => {
    expect(() => compile(medianBandChart([], 'Median value').spec)).not.toThrow();
    expect(() => compile(medianBandChart(series, 'Median value').spec)).not.toThrow();
  });

  it('keeps every bucket and its thin-summary metadata', () => {
    expect(timeSummaryRows(series)).toEqual([
      {
        seriesId: 'included',
        seriesName: 'Included scans',
        bucket: '2026-01-01',
        value: 1,
        date: '2026-01-01',
        isOther: false,
        n: 24,
        p25: 2,
        p50: 3,
        p75: 4,
        thin: false,
        note: undefined,
        isolated: false,
      },
      {
        seriesId: 'included',
        seriesName: 'Included scans',
        bucket: '2026-02-01',
        value: 1,
        date: '2026-02-01',
        isOther: false,
        n: 8,
        p25: 3,
        p50: 4,
        p75: 6,
        thin: true,
        note: '<20 observations',
        isolated: false,
      },
      {
        seriesId: 'excluded',
        seriesName: 'Excluded scans',
        bucket: '2026-01-01',
        value: 1,
        date: '2026-01-01',
        isOther: false,
        n: 21,
        p25: 4,
        p50: 5,
        p75: 6,
        thin: false,
        note: undefined,
        isolated: true,
      },
    ]);
  });

  it('maps supplied cohort colours by series id', () => {
    const [band] = layersOf(medianBandChart(series, 'Median value').spec);

    expect(band.encoding?.color?.scale).toEqual({
      domain: ['included', 'excluded'],
      range: ['#1261a0', '#d95f02'],
    });
  });

  it('renders lower-N buckets as faded points', () => {
    const thinLayer = layersOf(medianBandChart(series, 'Median value').spec).find(
      (layer) => JSON.stringify(layer.mark).includes('point'),
    );

    expect(thinLayer?.mark).toMatchObject({ type: 'point' });
    expect(JSON.stringify(thinLayer?.encoding)).toContain('datum.thin');
  });

  it('fades line and band segments that touch a lower-N bucket', () => {
    const chartLayers = layersOf(medianBandChart(series, 'Median value').spec);

    expect(JSON.stringify(chartLayers[0].encoding)).toContain('datum.segmentThin');
    expect(JSON.stringify(chartLayers[1].encoding)).toContain('datum.segmentThin');
  });
});
