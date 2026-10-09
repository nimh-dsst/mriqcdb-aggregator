import {
  DARK_THEME,
  LIGHT_THEME,
  histogramSpec,
  coverageSpec,
  overlaidDensitySpec,
  boxSpec,
} from './index';
import { compile } from 'vega-lite';

describe('chart themes', () => {
  const axis = { label: 'Metric', logScale: false, countTitle: 'Scans' };
  it('emits dark axis, grid, median, series and selection colours', () => {
    const spec = histogramSpec({ ...axis, theme: DARK_THEME }) as any;
    expect(spec.config.axis.labelColor).toBe('#9aa5b8');
    expect(spec.config.axis.gridColor).toBe('#2d3645');
    expect(spec.mark.color).toBe('#009aed');
    expect(spec.params[0].select.mark.fill).toBe('#ffd54f');
    const box = boxSpec({ ...axis, theme: DARK_THEME }, 'Group') as any;
    expect(box.layer[3].mark.color).toBe('#e8ecf2');
    expect(box.layer[1].encoding.color.scale.range).toEqual([...DARK_THEME.categories, '#8c9196']);
    expect(compile(spec).spec).toBeTruthy();
  });
  it('uses the dark surface for stack separators and dark palette variants for cohorts', () => {
    const coverage = coverageSpec(
      'bars',
      'Manufacturer',
      'month',
      'Scans',
      undefined,
      ['A', 'B', 'Other'],
      false,
      DARK_THEME,
    ) as any;
    expect(coverage.mark.stroke).toBe(DARK_THEME.surface);
    expect(coverage.encoding.color.scale.range).toEqual([
      DARK_THEME.categories[0],
      DARK_THEME.categories[1],
      '#8c9196',
    ]);
    const comparison = overlaidDensitySpec({ ...axis, theme: DARK_THEME }, [
      { id: 'one', label: 'One', color: LIGHT_THEME.categories[1] },
    ]) as any;
    expect(comparison.encoding.color.scale.range).toEqual([DARK_THEME.categories[1]]);
  });
  it('keeps the default light and builders independent between calls', () => {
    histogramSpec({ ...axis, theme: DARK_THEME });
    const light = histogramSpec(axis) as any;
    expect(light.config.axis.labelColor).toBe(LIGHT_THEME.labelInk);
    expect(light.mark.color).toBe(LIGHT_THEME.populationColor);
  });
});
