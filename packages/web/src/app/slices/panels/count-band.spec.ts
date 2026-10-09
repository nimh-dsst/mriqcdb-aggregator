import { describe, expect, it } from 'vitest';

import { countBand, fineGranularity, truncate } from '../../graph/count-band';

const day = (iso: string, n: number, group = 'SIEMENS') => ({ start: `${iso}T00:00:00.000Z`, group, n });

describe('count band', () => {
  it('counts days inside months, and months inside years', () => {
    expect(fineGranularity('month')).toBe('day');
    expect(fineGranularity('week')).toBe('day');
    expect(fineGranularity('year')).toBe('month');
  });

  it('cuts weeks on Mondays, like date_trunc', () => {
    expect(new Date(truncate(Date.UTC(2024, 0, 7), 'week')).toISOString()).toBe('2024-01-01T00:00:00.000Z');
  });

  it('sums groups per day and counts quiet days as zero', () => {
    const band = countBand({ buckets: [
      day('2024-01-01', 10), day('2024-01-01', 5, 'GE'),
      day('2024-01-03', 3),
    ] }, 'month');

    // Jan 1–3: 15, 0, 3. Days after the last upload are not counted.
    expect(band.buckets).toHaveLength(1);
    expect(band.buckets[0].n).toBe(18);
    expect(band.buckets[0].quantiles.p50).toBe(3);
    expect(band.buckets[0].quantiles.p25).toBe(1.5);
  });

  it('gives a steady month a tight band and a one-dump month a tall one', () => {
    const steady = Array.from({ length: 28 }, (_, i) => day(`2024-02-${String(i + 1).padStart(2, '0')}`, 10));
    const dump = [day('2024-03-01', 1), day('2024-03-15', 280), day('2024-03-31', 1)];
    const [february, march] = countBand({ buckets: [...steady, ...dump] }, 'month').buckets;

    expect(february.quantiles.p95 - february.quantiles.p05).toBe(0);
    expect(march.quantiles.p95).toBeGreaterThan(march.quantiles.p50);
    expect(march.quantiles.p50).toBe(0);
  });
});
