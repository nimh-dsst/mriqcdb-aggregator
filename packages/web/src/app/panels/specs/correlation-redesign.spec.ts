import { describe, expect, it } from 'vitest';
import { correlationChart } from './analysis-charts';
import { LIGHT_THEME } from './palette';

describe('correlationChart redesign', () => {
  const result = {
    metrics: ['a', 'b', 'c'],
    pearson: [
      [1, 0.11, 0.22],
      [0.11, 1, 0.33],
      [0.22, 0.33, 1],
    ],
    spearman: [
      [1, -0.11, -0.22],
      [-0.11, 1, -0.33],
      [-0.22, -0.33, 1],
    ],
    pairN: [
      [10, 11, 12],
      [11, 13, 14],
      [12, 14, 15],
    ],
    minPairN: 10,
  };

  it('renders only the lower triangle while retaining the complete axis domain', () => {
    const chart = correlationChart(result as any, { a: 'Alpha metric', b: 'Beta metric', c: 'Gamma metric' }, false, LIGHT_THEME);
    const rows = chart.datasets['correlation-cells'] as Array<Record<string, unknown>>;

    expect(rows.map((row) => [row['xMetric'], row['yMetric']])).toEqual([
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'c'],
    ]);
    expect(rows.every((row) => row['xMetric'] !== row['yMetric'])).toBe(true);
    expect(rows.every((row) => row['label'] !== '')).toBe(true);
    expect(rows.map((row) => row['label'])).toEqual(['-0.11', '-0.22', '-0.33']);

    const rectEncoding = (chart.spec as any).layer[0].encoding;
    expect(rectEncoding.x.sort).toEqual(['Alpha\nmetric', 'Beta\nmetric', 'Gamma\nmetric']);
    expect(rectEncoding.y.sort).toEqual(['Alpha\nmetric', 'Beta\nmetric', 'Gamma\nmetric']);
    expect(rectEncoding.x.axis.labelLimit).toBe(0);
    expect(chart.spec).toMatchObject({ width: 'container', height: 'container' });
    expect(rectEncoding.x.scale.range).toEqual([0, { expr: 'min(width, height)' }]);
    expect(rectEncoding.y.scale).toEqual(rectEncoding.x.scale);
    expect(rectEncoding.x.scale.paddingInner).toBe(0);
    expect(rectEncoding.color.legend.orient).toBe('right');
  });

  it('uses the selected coefficient for colour, text, and tooltip', () => {
    const chart = correlationChart(result as any, { a: 'Alpha', b: 'Beta', c: 'Gamma' }, false, LIGHT_THEME, 'pearson');
    const layers = (chart.spec as any).layer;
    const rectEncoding = layers[0].encoding;
    const textEncoding = layers[1].encoding;

    expect(rectEncoding.color.title).toBe('Pearson r (linear)');
    expect(rectEncoding.tooltip).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'value', title: 'Pearson r' }),
    ]));
    expect(textEncoding.opacity).toBeUndefined();
    expect((chart.datasets['correlation-cells'] as Array<Record<string, unknown>>).map((row) => row['label']))
      .toEqual(['0.11', '0.22', '0.33']);
  });
});
