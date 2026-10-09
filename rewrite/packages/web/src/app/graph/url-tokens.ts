/**
 * The wire alphabet: the versioned token tables every catalog-drawn identifier
 * is written as, and the scalar codecs both the current and the legacy decoder
 * share.
 *
 * A token is this identifier's **position in the authored catalog**, written in
 * one or two characters. That makes a link short -- `fd_mean` is one character
 * instead of seven -- and it makes the catalog's authored order part of the wire
 * format: insert a metric in the middle of the list and every older link would
 * name the metric after it. {@link TOKEN_VERSION} is the guard. It is the first
 * character of the payload, and a payload written under any other version is
 * refused outright (the dashboard opens on its default), because a link that
 * decodes to the *wrong* metric is worse than one that does not decode.
 *
 * The preset dictionary also contains catalog identifiers. Any change to its
 * bytes, including appending catalog entries, requires a version bump.
 */

import {
  MODALITIES,
  VIEWS,
  getAuthoredCatalog,
  type Modality,
  type View,
} from '@mriqc/shared';
import { MAX_BINS, MIN_BINS, defaultPanelOptions } from './state';

/**
 * The payload's first character. Bump it when the authored catalog's order
 * changes, when a token table gains an entry anywhere but the end, or when the
 * grammar below changes, or whenever URL_DICTIONARY changes.
 */
export const TOKEN_VERSION = '2';
export const RAW_TOKEN_VERSION = '3';

/**
 * The 64 characters a token is written in: URL-safe, so the deflated payload is
 * the only thing that needs base64.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** An identifier list, as codes both ways. */
export interface TokenTable {
  readonly code: ReadonlyMap<string, string>;
  readonly id: ReadonlyMap<string, string>;
}

/**
 * A table over one list, in its authored order. One character up to 64 entries,
 * two past it -- unambiguous because a token is always a whole field value.
 */
export function tokenTable(ids: readonly string[]): TokenTable {
  const code = new Map<string, string>();
  const id = new Map<string, string>();
  ids.forEach((value, index) => {
    const token =
      index < 64
        ? ALPHABET[index]
        : `${ALPHABET[Math.floor(index / 64)]}${ALPHABET[index % 64]}`;
    if (code.has(value)) return;
    code.set(value, token);
    id.set(token, value);
  });
  return { code, id };
}

const authored = getAuthoredCatalog();

/** Every metric the catalog defines, in authored order. */
export const METRIC_TOKENS = tokenTable(authored.metrics.map((metric) => String(metric.id)));
/** Every field, which is where filter columns, split fields and group fields come from. */
export const FIELD_TOKENS = tokenTable(authored.fields.map((field) => String(field.id)));
export const VIEW_TOKENS = tokenTable(VIEWS as readonly string[]);
export const MODALITY_TOKENS = tokenTable(MODALITIES as readonly string[]);
/** Panel kinds, charts, clips, granularities and filter ops: small closed lists. */
export const KIND_TOKENS = tokenTable(['distribution', 'grouped', 'coverage', 'sample', 'comparison']);
export const CHART_TOKENS = tokenTable([
  'histogram',
  'ecdf',
  'density',
  'box',
  'facetedHistogram',
  'facetedEcdf',
  'stackedBar',
  'area',
  'table',
  'overlaidHistogram',
  'overlaidEcdf',
  'density2d', 'scatter', 'hexbin', 'correlation', 'clusters', 'line', 'medianBand',
]);
export const CLIP_TOKENS = tokenTable(['p01p99', 'p05p95', 'none']);
export const GRANULARITY_TOKENS = tokenTable(['day', 'week', 'month', 'year']);
export const OP_TOKENS = tokenTable(['in', 'between', 'isNull', 'notNull']);
export const SOURCE_TOKENS = tokenTable(['population', 'study']);

/** Versioned authored values only: live catalog counts must never change link decoding. */
export const URL_DICTIONARY = new TextEncoder().encode([
  ALPHABET, 'mvfcpSsGZikmgybolXRYMLunPCDAr',
  ...[METRIC_TOKENS, FIELD_TOKENS, VIEW_TOKENS, MODALITY_TOKENS, KIND_TOKENS, CHART_TOKENS,
    CLIP_TOKENS, GRANULARITY_TOKENS, OP_TOKENS, SOURCE_TOKENS].flatMap(table => [...table.code].flat()),
  ...authored.fields.flatMap(field => {
    const values = (field as unknown as { values?: readonly unknown[] }).values;
    return values ? values.map(String).sort() : [];
  }),
  'Siemens', 'GE', 'Philips', 'Bruker', 'Canon', 'Hitachi', 'Toshiba', 'United Imaging',
  'Fujifilm', 'Mediso', 'Agilent', 'Hyperfine', 'Synthesized', 'Medics', 'Unknown',
  'afni', 'fsl', 'unknown', 'current', 'all', 'Whole population',
  'family', 'metrics', 'clusterOrder', 'sampleSize', 'seed', 'coefficient', 'spearman', 'pearson',
].join('|'));

/**
 * This identifier's token, or `''` when no table knows it.
 *
 * `''` is "absent", so a link cannot carry a metric or a column the catalog
 * does not have -- which is the same place validation would have left it, one
 * step earlier.
 */
export function toToken(table: TokenTable, value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return table.code.get(value) ?? '';
}

/** The identifier a token names, or null -- which every reader treats as "absent". */
export function fromToken(table: TokenTable, text: string): string | null {
  return table.id.get(text) ?? null;
}

/** The modality a token names, or null. */
export function modalityFromToken(text: string): Modality | null {
  return fromToken(MODALITY_TOKENS, text) as Modality | null;
}

/** The view a token names, or null. */
export function viewFromToken(text: string): View | null {
  return fromToken(VIEW_TOKENS, text) as View | null;
}

/* --------------------------------------------------------------- free text */

/**
 * The separators, one per nesting level. They are structure, so any text that
 * could contain one is escaped rather than quoted -- the payload is deflated
 * afterwards, so the few escapes cost nothing.
 */
export const SEP = [';', ',', ':', '|', '~', '!'] as const;

const ESCAPED = /[%;,:|~!#?]/g;
const UNESCAPE = /%([0-9A-F]{2})/g;

/** Free text with every character the grammar uses escaped. */
export function escapeText(value: string): string {
  return value.replace(ESCAPED, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The inverse. Total: an unfinished escape is left as it stands. */
export function unescapeText(value: string): string {
  return value.replace(UNESCAPE, (_all, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * A list's items. `''` is no items rather than one empty one -- but an empty
 * item *inside* a list is kept, because `''` is the value a "Not reported"
 * filter carries.
 */
export function splitList(text: string, sep: string): readonly string[] {
  return text === '' ? [] : text.split(sep);
}

/* ----------------------------------------------------------------- numbers */

/**
 * A number at three significant figures, as short as it prints.
 *
 * Only the brush and a cohort's metric range go through this: they are ranges a
 * reader dragged out of a chart and the card prints them at three figures
 * anyway, so the link carries what the page shows. A *filter* bound is typed, or
 * is one of the two open-end sentinels, and is written exactly.
 */
export function writeRounded(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return String(Number(value.toPrecision(3)));
}

/** A finite number, or null for anything else -- including the empty string. */
export function readNumber(text: string): number | null {
  if (text === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** Bin counts outside 10..200 are clamped rather than rejected; the server caps them too. */
export function clampBins(bins: unknown): number {
  const n = Math.round(Number(bins));
  if (!Number.isFinite(n)) return defaultPanelOptions().bins;
  return Math.min(MAX_BINS, Math.max(MIN_BINS, n));
}

/* ------------------------------------------------------------------- dates */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.000Z$/;

/**
 * A date bound as digits: eight for a plain date, fourteen for an instant.
 *
 * Null for anything else, which the caller then writes as free text. The
 * instant is kept to the second rather than truncated to its date, because the
 * picker hands back local midnight and truncating in UTC moves the date a user
 * chose by a day.
 */
export function writeDate(value: string): string | null {
  const date = DATE_ONLY.exec(value);
  if (date !== null) return `${date[1]}${date[2]}${date[3]}`;
  const instant = INSTANT.exec(value);
  if (instant === null) return null;
  return instant.slice(1).join('');
}

/** The date or instant eight or fourteen digits name, or null. */
export function readDate(text: string): string | null {
  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }
  if (!/^\d{14}$/.test(text)) return null;
  const d = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  return `${d}T${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}.000Z`;
}

/* ------------------------------------------------------------------ shapes */

/**
 * A string with an unpaired surrogate survives a decode but makes
 * `encodeURIComponent` throw, which would error the fold from inside query-key
 * construction. Such a string is not a value any catalog column holds, so it is
 * dropped here rather than defended against everywhere downstream.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** True when every surrogate in the string is paired, so `encodeURIComponent` is safe. */
export function isWellFormed(value: string): boolean {
  return !LONE_SURROGATE.test(value);
}

/**
 * Panel ids address the memo table, `removePanel`, `mapPanel` and the grid's
 * track function, so a link carrying the same id twice would corrupt all four.
 * The second occurrence is re-minted rather than dropped: the thing was asked
 * for, only its name was unusable.
 */
export function uniqueIds<T extends { id: string }>(
  items: readonly T[],
  prefix: 'p' | 'c' = 'p',
): readonly T[] {
  // Seeded with *every* id in the list, not only the ones already walked past:
  // re-minting against a partial set can hand the duplicate an id a later
  // element still owns, and then a panel referencing that id binds to the wrong
  // thing -- which is worse than the collision it was fixing.
  const taken = new Set(items.map((item) => item.id));
  const seen = new Set<string>();
  let candidate = 1;
  return items.map((item) => {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      return item;
    }
    while (seen.has(`${prefix}${candidate}`) || taken.has(`${prefix}${candidate}`)) {
      candidate += 1;
    }
    const id = `${prefix}${candidate}`;
    seen.add(id);
    return { ...item, id };
  });
}

/* ------------------------------------------------------------------- limits */

/**
 * Sanity bounds on what one link may carry. They are not security limits --
 * the server validates independently -- only a guard against a hand-written
 * parameter turning into an unbounded panel list or filter.
 */
export const MAX_PANELS = 50;
export const MAX_FILTER_VALUES = 500;
export const MAX_ID_LENGTH = 32;
/** More predicates than there are filterable columns is not a cohort a form made. */
export const MAX_COHORT_FILTERS = 50;
/** A cohort name past this was not typed into the editor's name box. */
export const MAX_COHORT_NAME = 80;
/** The longest `s` parameter worth trying to read, and the most it may inflate to. */
export const MAX_PARAM_LENGTH = 4096;
export const MAX_PAYLOAD_BYTES = 64 * 1024;
/**
 * A cohort id may be much longer than a panel id, because a group cohort's id
 * *is* its definition: `g\0<field>\0<value>`, and both halves are catalog
 * strings.
 */
export const MAX_COHORT_ID_LENGTH = 160;

/* ----------------------------------------------------------- base64url i/o */

/** Bytes as base64url, unpadded: the only thing in the link that is not text. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The inverse. Throws on anything that is not base64, which every caller catches. */
export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/* -------------------------------------------------------------- selections */

/** Finite and ordered, the same normalization the interactive `brush` path applies. */
export function normalizeSelection<T extends { range: [number, number] }>(selection: T): T | null {
  const [lo, hi] = selection.range;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  return lo <= hi ? selection : { ...selection, range: [hi, lo] };
}
