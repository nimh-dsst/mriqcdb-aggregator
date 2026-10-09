import type { Panel, PanelOptions } from '../graph/state';
import type { OptionCodecs } from '../slices/panels/url';
import type { SchemaField } from '../codec/records';
export function commonOptionFields({ enumeration, pair, roundedNumber, unsigned, optionDefault, tokenCodec,
  CLIP_TOKENS, bool, GRANULARITY_TOKENS, filterValue, shortText, list, metricToken, exactNumber }: OptionCodecs): readonly (SchemaField & { slot: number })[] {
  return [
    { slot: 5, field: 'clip', codec: tokenCodec(CLIP_TOKENS), default: optionDefault('clip') },
    { slot: 6,
    field: 'yMode',
    codec: enumeration(['count', 'share', 'logCount']),
    default: optionDefault('yMode'),
  },
    { slot: 7, field: 'useSelection', codec: bool, default: optionDefault('useSelection') },
    { slot: 8,
    field: 'granularity',
    codec: tokenCodec(GRANULARITY_TOKENS),
    default: optionDefault('granularity'),
  },
    { slot: 9,
    field: 'splitPresentation',
    codec: enumeration(['overlay', 'facets']),
    default: optionDefault('splitPresentation'),
  },
    { slot: 10, field: 'cumulative', codec: bool, default: optionDefault('cumulative') },
    { slot: 12,
    field: 'coverageWindow',
    codec: enumeration(['all', '12m', '5y', 'custom']),
    default: optionDefault('coverageWindow'),
  },
    { slot: 13, field: 'coverageCustom', codec: pair(filterValue), default: optionDefault('coverageCustom') },
    { slot: 14, field: 'coverageLogY', codec: bool, default: optionDefault('coverageLogY') }
  ];
}
export function validateCommonOptions(options: PanelOptions, panel: Panel): void {
  const canStack = (panel: Panel) => panel.series.length === 1 && ['field', 'values', 'buckets'].includes(panel.series[0].kind);
  for (const key of ['xScale', 'yScale'] as const) if (!['linear', 'log', 'symlog'].includes(options[key])) options[key] = 'linear';
  for (const key of ['xRange', 'yRange'] as const) {
    const range = options[key];
    options[key] = Array.isArray(range) && range.length === 2 && range.every(Number.isFinite) && range[0] !== range[1]
      ? [Math.min(...range), Math.max(...range)] : 'auto';
  }
  if (!['count', 'share', 'logCount'].includes(options.yMode)) options.yMode = 'count';
  if (!canStack(panel) || !['stacked', 'stacked100'].includes(options.layout)) options.layout = 'overlaid';
  options.splitPresentation = options.splitPresentation === 'facets' ? 'facets' : 'overlay';
  if (!['12m', '5y', 'custom'].includes(options.coverageWindow)) options.coverageWindow = 'all';
  if (!Array.isArray(options.coverageCustom) || options.coverageCustom.length !== 2 || !options.coverageCustom.every(d => typeof d === 'string')) options.coverageCustom = null;
  else if (options.coverageCustom[0] > options.coverageCustom[1]) options.coverageCustom = [options.coverageCustom[1], options.coverageCustom[0]];
  for (const key of ['cumulative','share','coverageLogY'] as const) options[key] = options[key] === true;
}
