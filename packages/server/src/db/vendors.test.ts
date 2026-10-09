/**
 * The vendor normalization: the rule, the frozen mapping, and the SQL it emits.
 *
 * The rule is asserted against every legal suffix `policies/README.md` lists and
 * against every spelling the August 2026 dump actually carries, so a change to
 * either the rule or `policies/vendors.csv` that moves a real corpus value shows
 * up here rather than in a dashboard.
 */

import { describe, expect, it } from 'vitest';
import {
  LEGAL_SUFFIXES,
  NONE_CANONICAL,
  canonicalVendor,
  normalizeVendorKey,
  parseVendorCsv,
  readVendorMap,
  titleCaseVendor,
  vendorCaseSql,
  vendorMapHash,
} from './vendors.js';

const map = readVendorMap();
const canon = (raw: string | null | undefined): string | null => canonicalVendor(raw, map);

describe('normalizeVendorKey', () => {
  it('trims, collapses whitespace and lowercases', () => {
    expect(normalizeVendorKey('  SIEMENS  ')).toBe('siemens');
    expect(normalizeVendorKey('Philips\tMedical\n Systems')).toBe('philips');
    expect(normalizeVendorKey('General   Electric')).toBe('general electric');
  });

  it('strips every legal suffix the policy lists', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['Siemens Healthcare', 'siemens'],
      ['Philips Medical Systems', 'philips'],
      ['Siemens Healthineers', 'siemens'],
      ['GE Medical', 'ge'],
      ['Canon Inc', 'canon'],
      ['Hitachi Ltd', 'hitachi'],
      ['Bruker BioSpin MRI GmbH', 'bruker biospin mri'],
      ['Mediso Co.', 'mediso'],
    ];
    // One case per suffix, and the list has not grown past them.
    expect(cases).toHaveLength(LEGAL_SUFFIXES.length);
    for (const [raw, key] of cases) expect([raw, normalizeVendorKey(raw)]).toEqual([raw, key]);
  });

  it('accepts a trailing period and a comma before the suffix', () => {
    expect(normalizeVendorKey('Canon Inc.')).toBe('canon');
    expect(normalizeVendorKey('Hitachi, Ltd.')).toBe('hitachi');
  });

  it('strips suffixes repeatedly', () => {
    expect(normalizeVendorKey('Siemens Healthcare GmbH')).toBe('siemens');
    expect(normalizeVendorKey('Philips Medical Systems Inc.')).toBe('philips');
  });

  it('needs a separator, so a name merely ending in those letters survives', () => {
    expect(normalizeVendorKey('Nanoco')).toBe('nanoco');
    expect(normalizeVendorKey('Medinc')).toBe('medinc');
  });

  it('never strips a name down to nothing', () => {
    expect(normalizeVendorKey('Healthcare')).toBe('healthcare');
  });

  it('gives null, undefined and whitespace the same empty key', () => {
    expect(normalizeVendorKey(null)).toBe('');
    expect(normalizeVendorKey(undefined)).toBe('');
    expect(normalizeVendorKey('')).toBe('');
    expect(normalizeVendorKey('   ')).toBe('');
  });
});

describe('titleCaseVendor', () => {
  it('title-cases each word of the trimmed, collapsed string', () => {
    expect(titleCaseVendor('  MEDICS ')).toBe('Medics');
    expect(titleCaseVendor('acme  medical   imaging')).toBe('Acme Medical Imaging');
  });
});

describe('canonicalVendor', () => {
  it('maps every spelling the August 2026 dump carries', () => {
    const corpus: ReadonlyArray<readonly [string, string | null]> = [
      ['Siemens', 'Siemens'],
      ['SIEMENS', 'Siemens'],
      ['SIEMENS  ', 'Siemens'],
      ['Siemens ', 'Siemens'],
      ['siemens', 'Siemens'],
      ['Siemens Healthineers', 'Siemens'],
      ['Simiens', 'Siemens'],
      ['Siemans', 'Siemens'],
      ['Simens', 'Siemens'],
      ['GE', 'GE'],
      ['GE MEDICAL SYSTEMS', 'GE'],
      ['GE_MEDICAL_SYSTEMS', 'GE'],
      ['GE Healthcare', 'GE'],
      ['G.E.', 'GE'],
      ['General Electric', 'GE'],
      ['General Electrics', 'GE'],
      ['GE 3 Tesla MR750', 'GE'],
      ['Philips', 'Philips'],
      ['Philips Medical Systems', 'Philips'],
      ['Philips Healthcare', 'Philips'],
      ['Phillips', 'Philips'],
      [' Philips Achieva', 'Philips'],
      ['Philips Achieva Intera 3 T Scanner', 'Philips'],
      ['Philips Ingenia 3.0T', 'Philips'],
      ['UIH', 'United Imaging'],
      ['Canon', 'Canon'],
      ['Toshiba', 'Toshiba'],
      ['Bruker BioSpin MRI GmbH', 'Bruker'],
      ['Hyperfine', 'Hyperfine'],
      ['Synthesized', 'Synthesized'],
      ['MEDICS', 'Medics'],
      ['scanner', null],
      ['Unknown', null],
      ['n/a', null],
    ];
    for (const [raw, expected] of corpus) expect([raw, canon(raw)]).toEqual([raw, expected]);
  });

  it('keeps Toshiba out of Canon, which bought it after these scans were made', () => {
    expect(canon('Toshiba')).toBe('Toshiba');
    expect(canon('Toshiba Medical Systems')).toBe('Toshiba');
    expect(canon('Canon Medical Systems')).toBe('Canon');
  });

  it('gives null for every empty, unknown-like and placeholder value', () => {
    for (const raw of [null, undefined, '', '   ', 'n/a', 'N/A', 'na', 'Unknown', 'UNKNOWN', 'none', 'NaN', 'not specified', '-', '?', 'scanner', 'Scanner']) {
      expect([raw, canon(raw)]).toEqual([raw, null]);
    }
  });

  it('leaves an unmapped vendor as its trimmed, title-cased self', () => {
    expect(canon('  elscint ')).toBe('Elscint');
    expect(canon('ACME medical imaging')).toBe('Acme Medical Imaging');
    // The suffix rule is a lookup key, not a rewrite: an unclassified vendor
    // keeps every word it arrived with.
    expect(canon('Elscint Ltd')).toBe('Elscint Ltd');
  });
});

describe('the frozen mapping', () => {
  it('maps only onto the documented canonical set', () => {
    const allowed = new Set([
      'Siemens', 'GE', 'Philips', 'Canon', 'Toshiba', 'Bruker', 'United Imaging',
      'Hitachi', 'Fujifilm', 'Mediso', 'Agilent', 'Hyperfine',
      // Observed, ruled on, and not a vendor name: kept as themselves rather
      // than folded into `(none)` (`policies/README.md`, "Values decided case
      // by case").
      'Synthesized', 'Medics',
    ]);
    for (const [key, value] of map) {
      if (value === null) continue;
      expect([key, allowed.has(value)]).toEqual([key, true]);
    }
  });

  it('lists post-rule keys only, so every key is its own normalization', () => {
    for (const key of map.keys()) expect([key, normalizeVendorKey(key)]).toEqual([key, key]);
  });

  it('hashes to a stable 64-hex content digest', () => {
    expect(vendorMapHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(vendorMapHash()).toBe(vendorMapHash());
  });
});

describe('parseVendorCsv', () => {
  it('turns the (none) token into null and normalizes the keys', () => {
    const parsed = parseVendorCsv(`raw,canonical\n  SIEMENS Healthcare ,Siemens\nUnknown,${NONE_CANONICAL}\n`);
    expect(parsed.get('siemens')).toBe('Siemens');
    expect(parsed.get('unknown')).toBe(null);
  });

  it('refuses a bad header, an empty cell and a contradiction', () => {
    expect(() => parseVendorCsv('from,to\na,b')).toThrow(/header/);
    expect(() => parseVendorCsv('raw,canonical\nGE,')).toThrow(/canonical value/);
    expect(() => parseVendorCsv('raw,canonical\n ,GE')).toThrow(/empty key/);
    expect(() => parseVendorCsv('raw,canonical\nGE,GE\nge,Philips')).toThrow(/both/);
  });
});

describe('vendorCaseSql', () => {
  it('emits a branch only for a value that changes', () => {
    const sql = vendorCaseSql('"m"', ['Siemens', 'SIEMENS', 'Unknown', null], map);
    expect(sql).toContain(`WHEN 'SIEMENS' THEN 'Siemens'`);
    expect(sql).toContain(`WHEN 'Unknown' THEN NULL`);
    expect(sql).not.toContain(`WHEN 'Siemens'`);
    expect(sql).toContain('ELSE "m" END');
  });

  it('escapes an apostrophe in a source value', () => {
    expect(vendorCaseSql('"m"', ["o'brien imaging"], map)).toContain(`WHEN 'o''brien imaging'`);
  });

  it('degenerates to a plain cast when nothing needs rewriting', () => {
    expect(vendorCaseSql('"m"', ['Siemens', null], map)).toBe('CAST("m" AS VARCHAR)');
  });
});
