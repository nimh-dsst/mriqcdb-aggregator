import { asColumnId } from '@mriqc/shared';
import { describe, expect, it } from 'vitest';

import { defaultForm, formAvailability } from './panel-shapes';

const x = asColumnId('example_x');
const y = asColumnId('example_y');

function availabilityFor(
  availability: ReturnType<typeof formAvailability>,
  form: (typeof availability)[number]['form'],
) {
  const result = availability.find((candidate) => candidate.form === form);
  if (!result) {
    throw new Error(`Missing ${form} availability`);
  }
  return result;
}

describe('graph form grammar', () => {
  it('requires a column y value for two-dimensional continuous forms', () => {
    const countAvailability = formAvailability(x, 'count');
    expect(availabilityFor(countAvailability, 'histogram')).toMatchObject({ state: 'enabled' });
    expect(availabilityFor(countAvailability, 'heatmap')).toMatchObject({
      state: 'disabled',
      reason: 'add a second column',
    });

    const columnAvailability = formAvailability(x, y);
    expect(availabilityFor(columnAvailability, 'heatmap')).toMatchObject({ state: 'enabled' });
    expect(availabilityFor(columnAvailability, 'scatter')).toMatchObject({ state: 'enabled' });
  });

  it('uses the grammar defaults for count, numeric y, and time with numeric y', () => {
    expect(defaultForm(x, 'count')).toBe('histogram');
    expect(defaultForm(x, y)).toBe('heatmap');
    expect(defaultForm('created_at', y)).toBe('band');
  });

  it('keeps the implicit base series for a band and rejects unsupported binned aggregates', () => {
    expect(availabilityFor(formAvailability(x, 'share', 0), 'band')).toMatchObject({
      state: 'enabled',
    });
    expect(availabilityFor(formAvailability(x, y, 1, 'sum'), 'histogram')).toMatchObject({
      state: 'disabled',
      reason: 'not available for this aggregate',
    });
  });
});
