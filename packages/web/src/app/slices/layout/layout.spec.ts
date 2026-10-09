import { describe, expect, it } from 'vitest';
import { asColumnId } from '@mriqc/shared';
import { defaultDashboard } from '../panels/defaults';

import { compactLayout, deriveLayout, moveLayout, preferredSize, reconcileLayout, resizeLayout, type DashboardLayout, type LayoutPanel } from './geometry';

const twelveCohorts = Array.from({ length: 12 }, (_, index) => `cohort-${index}`);

function panel(
  id: string,
  overrides: Partial<LayoutPanel> = {},
): LayoutPanel {
  return {
    id,
    x: 'metric',
    y: null,
    form: 'histogram',
    series: [],

    options: {},
    ...overrides,
  } as LayoutPanel;
}

describe('preferredSize', () => {
  it('uses only axes and form, adding two rows when series exist', () => {
    expect(preferredSize(panel('number'),3)).toMatchObject({w:4,h:10});
    expect(preferredSize(panel('time',{x:'created_at'}),3)).toMatchObject({w:8,h:10});
    expect(preferredSize(panel('field',{x:asColumnId('manufacturer')}),3)).toMatchObject({w:8,h:10});
    expect(preferredSize(panel('pair',{y:asColumnId('tsnr'),form:'scatter'}),3)).toMatchObject({w:8,h:10});
    expect(preferredSize(panel('matrix',{form:'matrix'}),3)).toMatchObject({w:8,h:14});
    for (const form of ['histogram','density','ecdf','box','table'] as const) {
      expect(preferredSize(panel(form,{form,series:[{kind:'population'}]}),3)).toMatchObject({w:4,h:12});
    }
    expect(preferredSize(panel('matrix',{form:'matrix',series:[{kind:'population'}]}),3)).toMatchObject({w:8,h:16});
  });
  it('adapts quantity width to the responsive column count', () => {
    expect(preferredSize(panel('medium'),2)).toMatchObject({w:6,h:10});
    expect(preferredSize(panel('narrow'),1)).toMatchObject({w:12,h:10});
    expect(preferredSize(panel('time',{x:'created_at'}),2)).toMatchObject({w:12,h:10});
  });
});

describe('dashboard layout', () => {
  it('derives defaults by scanning each row from left to right', () => {
    expect(deriveLayout([panel('a'), panel('b'), panel('c'), panel('d')], 3)).toEqual({
      a: { x: 0, y: 0, w: 4, h: 10 },
      b: { x: 4, y: 0, w: 4, h: 10 },
      c: { x: 8, y: 0, w: 4, h: 10 },
      d: { x: 0, y: 10, w: 4, h: 10 },
    });
  });

  it('keeps a moved panel in priority and backfills after pushing collisions down', () => {
    const layout: DashboardLayout = {
      a: { x: 0, y: 0, w: 4, h: 10 },
      b: { x: 0, y: 10, w: 4, h: 10 },
    };

    const moved = moveLayout(layout, 'b', 0, 0);

    expect(moved).toEqual({
      a: { x: 4, y: 0, w: 4, h: 10 },
      b: { x: 0, y: 0, w: 4, h: 10 },
    });
    expect(compactLayout(moved)).toEqual(moved);
    expect(reconcileLayout(moved, [panel('a'), panel('b')], 3)).toEqual(moved);
  });

  it('preserves the five default panel rectangles at 1600px', () => {
    expect(deriveLayout(defaultDashboard().panels, 3)).toEqual({
      p1: { x: 0, y: 0, w: 4, h: 10 },
      p2: { x: 4, y: 0, w: 4, h: 10 },
      p3: { x: 8, y: 0, w: 4, h: 10 },
      p4: { x: 0, y: 10, w: 4, h: 10 },
      p5: { x: 4, y: 10, w: 8, h: 10 },
    });
  });

  it('moves the eight-wide time panel to column zero after widening SNR to five', () => {
    const layout = deriveLayout(defaultDashboard().panels, 3);
    const widened = resizeLayout(layout, 'p4', 5, 10);
    expect(widened).toEqual({
      ...layout,
      p4: { x: 0, y: 10, w: 5, h: 10 },
      p5: { x: 0, y: 20, w: 8, h: 10 },
    });
    expect(layout['p4'].w).toBe(4);
    expect(compactLayout(widened, 'p4')).toEqual(widened);
    expect(compactLayout(widened)).toEqual(widened);
  });

  it('backfills a later three-wide panel beside SNR without changing panel list order', () => {
    const layout = {
      ...deriveLayout(defaultDashboard().panels, 3),
      p6: { x: 0, y: 20, w: 3, h: 10 },
    };
    const widened = resizeLayout(layout, 'p4', 5, 10);
    expect(widened['p5']).toEqual({ x: 0, y: 20, w: 8, h: 10 });
    expect(widened['p6']).toEqual({ x: 5, y: 10, w: 3, h: 10 });
    expect(Object.keys(widened)).toEqual(Object.keys(layout));
    expect(compactLayout(widened, 'p4')).toEqual(widened);
    expect(compactLayout(widened)).toEqual(widened);
  });

  it('pins the changed panel even when empty rows and columns precede it', () => {
    const moved = moveLayout({ a: { x: 0, y: 0, w: 4, h: 10 } }, 'a', 6, 12);
    expect(moved['a']).toEqual({ x: 6, y: 12, w: 4, h: 10 });
    expect(compactLayout(moved, 'a')).toEqual(moved);
  });

  it('adds in the first free position and preserves surviving geometry during reconciliation', () => {
    const a = panel('a');
    const b = panel('b');
    const added = reconcileLayout({ a: { x: 0, y: 0, w: 4, h: 10 } }, [a, b], 3);

    expect(added['b']).toEqual({ x: 4, y: 0, w: 4, h: 10 });
    expect(
      reconcileLayout(
        {
          a: { x: 0, y: 0, w: 4, h: 10 },
          b: { x: 0, y: 10, w: 4, h: 10 },
        },
        [b],
        3,
      ),
    ).toEqual({ b: { x: 0, y: 10, w: 4, h: 10 } });
  });

  it('clamps geometry and compaction is idempotent', () => {
    const clamped = resizeLayout(
      moveLayout({ a: { x: 0, y: 0, w: 4, h: 10 } }, 'a', 99, -3),
      'a',
      1,
      2,
    );

    expect(clamped['a']).toEqual({ x: 8, y: 0, w: 3, h: 5 });
    expect(compactLayout(compactLayout(clamped))).toEqual(compactLayout(clamped));
  });
});
