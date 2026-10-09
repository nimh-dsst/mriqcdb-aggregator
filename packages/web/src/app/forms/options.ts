import type { ClipMode, Granularity, Modality } from '@mriqc/shared';
import type { Panel, PanelOptions as CompatibilityOptions, SplitPresentation, CoverageWindow } from '../graph/state';
import type { SchemaField } from '../codec/records';
import type { OptionCodecs } from '../slices/panels/url';
import type { FORM_DEFS } from './registry';

export interface OptionContext { clampBins(value: unknown): number; modality?: Modality; colorScale: 'linear' | 'log' }
export interface AnyOptionSchema {
  fields: readonly string[];
  defaults(): object;
  url(codecs: OptionCodecs): readonly (SchemaField & { slot: number })[];
  validate(options: PanelOptions, panel: Panel, context: OptionContext): void;
}
export interface OptionSchema<Options extends object> extends AnyOptionSchema {
  fields: readonly (keyof Options & string)[];
  defaults(): Options;
}
export function optionSchema<Options extends object>(schema: OptionSchema<Options>): OptionSchema<Options> { return schema; }

export interface CommonOptions {
  clip: ClipMode;
  xScale: 'linear' | 'log' | 'symlog';
  xRange: 'auto' | readonly [number, number];
  yScale: 'linear' | 'log' | 'symlog';
  yRange: 'auto' | readonly [number, number];
  yMode: 'count' | 'share' | 'logCount';
  layout: 'overlaid' | 'stacked' | 'stacked100';
  useSelection: boolean;
  granularity: Granularity;
  splitPresentation: SplitPresentation;
  cumulative: boolean;
  coverageWindow: CoverageWindow;
  coverageLogY: boolean;
  coverageCustom: readonly [string, string] | null;
}
type Definition = (typeof FORM_DEFS)[number];
export type FormOptionBags = {
  [D in Definition as D['id']]: ReturnType<D['options']['defaults']>
};
type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void ? I : never;
/** Flat representation preserves the existing reducer patch and URL contracts. */
export type PanelOptions = CommonOptions & UnionToIntersection<FormOptionBags[keyof FormOptionBags]>;

/** Typed bridge for form controls while graph/state.ts retains its compatibility declaration. */
export function optionPatch(patch: Partial<PanelOptions>): Partial<CompatibilityOptions> & Partial<PanelOptions> {
  return patch;
}
/** Read a form's typed bag from the flat phase-1 representation. */
export function optionValues<Options extends object>(schema: OptionSchema<Options>, source: object): Options {
  const flat = source as Record<string, unknown>;
  return { ...schema.defaults(), ...Object.fromEntries(schema.fields.filter(key => flat[key] !== undefined).map(key => [key, flat[key]])) } as Options;
}

