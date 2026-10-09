/**
 * Manufacturer (vendor) normalization.
 *
 * `bids_meta.Manufacturer` is free text that uploaders typed by hand, so one
 * vendor arrives as `Siemens`, `SIEMENS`, `SIEMENS  `, `Siemens Healthineers`
 * and `Simiens`. The build keeps the uploaded string in `manufacturer_raw` and
 * writes a canonical spelling into `manufacturer`, so grouping and filtering by
 * vendor mean one bar per vendor rather than one per typo.
 *
 * The mapping is a frozen artifact, `policies/vendors.csv`, documented in
 * `policies/README.md` beside the frozen canonicalization scales. Its content
 * hash goes into `data_version`, so editing it invalidates every cache.
 *
 * Lookup is: {@link normalizeVendorKey} the uploaded string, then the CSV, then
 * -- for a spelling nobody has classified -- the trimmed, title-cased original.
 * Nothing is ever dropped: `manufacturer_raw` always holds what was uploaded.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PACKAGE_ROOT } from '../config.js';

/** The normalized column holding the canonical vendor. */
export const MANUFACTURER_COLUMN = 'manufacturer';

/** The normalized column holding the vendor exactly as uploaded. */
export const MANUFACTURER_RAW_COLUMN = 'manufacturer_raw';

/** The frozen mapping artifact, beside the canonicalization scales. */
export const VENDOR_FILE = 'vendors.csv';

/** The absolute path of the frozen mapping. */
export function vendorMapPath(): string {
  return `${PACKAGE_ROOT.replace(/\\/g, '/')}/policies/${VENDOR_FILE}`;
}

/**
 * The CSV token for "no vendor".
 *
 * It becomes SQL NULL in the database rather than the literal text: `(none)` is
 * already the label the frontend prints for a null or empty categorical value
 * (`NONE_LABEL` in `@mriqc/shared`), and a filter on it already expands to "is
 * null or is the empty string". Writing the literal string would give the UI two
 * `(none)` buckets that no filter could tell apart.
 */
export const NONE_CANONICAL = '(none)';

/**
 * Trailing legal suffixes stripped before lookup, so `GE Healthcare`,
 * `Philips Medical Systems` and `Bruker BioSpin MRI GmbH` reach the same key as
 * `GE`, `Philips` and `Bruker BioSpin MRI`. Longest first: `Medical Systems`
 * must be tried before `Medical`.
 */
export const LEGAL_SUFFIXES: readonly string[] = [
  'Healthcare',
  'Medical Systems',
  'Healthineers',
  'Medical',
  'Inc',
  'Ltd',
  'GmbH',
  'Co.',
];

/**
 * `Medical Systems` before `Medical`, an optional trailing period on each, and a
 * required separator in front, so a vendor whose name merely *ends* in one of
 * these letters -- a hypothetical `Nanoco` -- is not truncated to `Nano`.
 */
const SUFFIX_PATTERN = new RegExp(
  `[\\s,]+(?:${[...LEGAL_SUFFIXES]
    .sort((a, b) => b.length - a.length)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\.$/, '\\.?'))
    .join('|')})\\.?$`,
  'i',
);

/**
 * The lookup key of one uploaded vendor string: trimmed, inner whitespace
 * collapsed to one space, trailing legal suffixes stripped (repeatedly, so
 * `Siemens Healthcare GmbH` reduces to `siemens`), lowercased.
 *
 * Returns the empty string for null, undefined and whitespace-only input, which
 * is the "no vendor" key the caller maps to NULL. A string that *is* a legal
 * suffix -- the hypothetical upload `Healthcare` -- is left alone rather than
 * stripped to nothing.
 */
export function normalizeVendorKey(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '';
  let value = raw.replace(/\s+/g, ' ').trim();
  for (;;) {
    const stripped = value.replace(SUFFIX_PATTERN, '').trim();
    if (stripped === value || stripped === '') break;
    value = stripped;
  }
  return value.toLowerCase();
}

/**
 * The uploaded string as it is shown when nothing maps it: trimmed, inner
 * whitespace collapsed, title-cased. The suffix stripping is *not* applied here
 * -- an unclassified vendor keeps whatever words it came with.
 */
export function titleCaseVendor(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\S+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

/** The parsed mapping: normalized key to canonical vendor, `(none)` as null. */
export type VendorMap = ReadonlyMap<string, string | null>;

/**
 * Parse `vendors.csv`.
 *
 * Hand-parsed for the same reason the scale CSVs are: a malformed artifact is a
 * clear error here rather than a silently retyped column, and the parse can be
 * unit-tested without a database. Keys are run through
 * {@link normalizeVendorKey}, so the file may be written in any casing.
 */
export function parseVendorCsv(text: string): Map<string, string | null> {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
  const header = (lines.shift() ?? '').trim();
  if (header !== 'raw,canonical') {
    throw new Error(`${VENDOR_FILE} header must be "raw,canonical"; got "${header}"`);
  }
  const map = new Map<string, string | null>();
  for (const line of lines) {
    const comma = line.indexOf(',');
    if (comma < 0) throw new Error(`${VENDOR_FILE} row has no comma: "${line}"`);
    const key = normalizeVendorKey(line.slice(0, comma));
    const canonical = line.slice(comma + 1).trim();
    if (key === '') throw new Error(`${VENDOR_FILE} row has an empty key: "${line}"`);
    if (canonical === '') throw new Error(`${VENDOR_FILE} row has no canonical value: "${line}"`);
    const existing = map.get(key);
    const value = canonical === NONE_CANONICAL ? null : canonical;
    if (existing !== undefined && existing !== value) {
      throw new Error(`${VENDOR_FILE} maps "${key}" to both "${existing}" and "${canonical}"`);
    }
    map.set(key, value);
  }
  return map;
}

let cached: { map: Map<string, string | null>; hash: string } | null = null;

function load(): { map: Map<string, string | null>; hash: string } {
  if (cached === null) {
    const text = readFileSync(vendorMapPath(), 'utf8');
    cached = {
      map: parseVendorCsv(text),
      // Over the bytes, not over the parsed map: an edit that changes nothing
      // semantically still changes the artifact, and `data_version` is a claim
      // about what the build read.
      hash: createHash('sha256').update(text).digest('hex'),
    };
  }
  return cached;
}

/** The frozen mapping, read once per process. */
export function readVendorMap(): VendorMap {
  return load().map;
}

/** The content hash of the frozen mapping, which `data_version` includes. */
export function vendorMapHash(): string {
  return load().hash;
}

/**
 * The canonical vendor of one uploaded string, or null for "no vendor".
 *
 * An unmapped spelling becomes its own trimmed, title-cased self rather than
 * null or `Other`: it is a real vendor nobody has classified yet, and collapsing
 * it would hide it from the very list that is meant to surface it.
 */
export function canonicalVendor(
  raw: string | null | undefined,
  map: VendorMap = readVendorMap(),
): string | null {
  const key = normalizeVendorKey(raw);
  if (key === '') return null;
  const mapped = map.get(key);
  if (mapped !== undefined) return mapped;
  return titleCaseVendor(raw as string);
}

/** Quote a string literal for DuckDB, doubling any embedded apostrophe. */
function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * A `CASE` expression mapping `sourceExpr` to its canonical vendor.
 *
 * Generated from the *observed* distinct values rather than from the CSV, so the
 * normalization rule stays in TypeScript where it is unit-tested and DuckDB only
 * ever compares exact literals. A value that is already canonical contributes no
 * branch; the `ELSE` is the source itself, so an unobserved value -- a race
 * between the DISTINCT scan and the load cannot happen here, but a future caller
 * passing a short list could -- passes through unchanged rather than vanishing.
 */
export function vendorCaseSql(
  sourceExpr: string,
  distinctValues: ReadonlyArray<string | null>,
  map: VendorMap = readVendorMap(),
): string {
  const branches: string[] = [];
  for (const value of distinctValues) {
    if (value === null) continue;
    const canonical = canonicalVendor(value, map);
    if (canonical === value) continue;
    branches.push(`WHEN ${literal(value)} THEN ${canonical === null ? 'NULL' : literal(canonical)}`);
  }
  if (branches.length === 0) return `CAST(${sourceExpr} AS VARCHAR)`;
  return `CAST(CASE ${sourceExpr}\n    ${branches.join('\n    ')}\n    ELSE ${sourceExpr} END AS VARCHAR)`;
}
