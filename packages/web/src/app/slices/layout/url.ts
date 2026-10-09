/**
 * The stream grammar. Every record is one presence bitmap (six optional fields
 * per character), then its non-default values in schema order. Both directions
 * walk these same tables; scalar codecs alone know how to represent a value.
 */
import { unsigned } from '../../codec/tokens';
import type { UrlState } from '../../graph/state';
import { deriveLayout, type DashboardLayout } from './geometry';

import { readRecord, writeRecord, type Context, type ContextCodec, type Schema } from '../../codec/records';
export const LAYOUT_FIELDS: Schema = [
  { field: 'missing', codec: { write() {}, read: () => true }, default: false },
  ...(['x', 'y', 'w', 'h'] as const).map((field) => ({
    field,
    codec: unsigned,
    default: (ctx: Context) => ctx.baseline?.[field],
  })),
];
export const layout: ContextCodec = {
  write(writer, value: DashboardLayout, ctx) {
    const panels = ctx.root['panels'] as UrlState['panels'];
    const baseline = deriveLayout(panels, 3);
    // Length and IDs come from the panel list, so neither appears in geometry.
    panels.forEach((panel, index) =>
      writeRecord(
        writer,
        LAYOUT_FIELDS,
        value[panel.id] ? { ...value[panel.id] } : { missing: true },
        { ...ctx, index, baseline: { ...baseline[panel.id] } },
      ),
    );
  },
  read(reader, ctx) {
    const panels = ctx.root['panels'] as UrlState['panels'];
    const baseline = deriveLayout(panels, 3);
    return Object.fromEntries(
      panels.flatMap((panel, index) => {
        const { missing, ...position } = readRecord(reader, LAYOUT_FIELDS, {
          ...ctx,
          index,
          baseline: { ...baseline[panel.id] },
        });
        return missing ? [] : [[panel.id, position]];
      }),
    );
  },
};
