import { describe, expect, it } from 'vitest';
import { continuousAxisSpec, continuousX } from './continuous-axis';
import type { MetricAxis } from '../histogram/histogram';

const JAN_2020 = Date.UTC(2020, 0, 1);
const JAN_2024 = Date.UTC(2024, 0, 1);

const axis: MetricAxis = {
  label: 'Upload time', logScale: false, xScale: 'time', granularity: 'year',
  xRange: 'auto', countTitle: 'Scans', timeDomain: [JAN_2020, JAN_2024],
};

describe('continuous time axis', () => {
  it('spans the first bucket start to the last bucket end and ticks once per year', () => {
    const x = continuousX(axis, 'lo') as { scale: Record<string, unknown>; axis: Record<string, unknown> };
    expect(x.scale['domain']).toEqual([JAN_2020, JAN_2024]);
    expect(x.scale['type']).toBe('utc');
    expect(x.axis['tickCount']).toEqual({ interval: 'year', step: 1 });
    expect(x.axis['format']).toBe('%Y');
  });

  it('lets a custom range win over the bucket domain', () => {
    const x = continuousX({ ...axis, xRange: [JAN_2020, Date.UTC(2021, 0, 1)] }, 'lo') as { scale: Record<string, unknown> };
    expect(x.scale['domain']).toEqual([JAN_2020, Date.UTC(2021, 0, 1)]);
  });

  it('labels months every six months and days by month', () => {
    expect((continuousX({ ...axis, granularity: 'month' }, 'lo') as any).axis.tickCount).toEqual({ interval: 'month', step: 6 });
    expect((continuousX({ ...axis, granularity: 'day' }, 'lo') as any).axis.tickCount).toEqual({ interval: 'month', step: 1 });
  });

  it('clips bars so a bucket straddling the range stays inside the plot', () => {
    const spec = continuousAxisSpec({
      data: { name: 'counts' }, mark: { type: 'bar' },
      encoding: { x: { field: 'lo', type: 'quantitative' }, x2: { field: 'hi' }, y: { field: 'count', type: 'quantitative' } },
    } as never, axis);
    expect((spec as unknown as { mark: Record<string, unknown> }).mark).toMatchObject({ type: 'bar', orient: 'vertical', clip: true });
  });
});
