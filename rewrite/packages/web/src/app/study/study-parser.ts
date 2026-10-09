import { unzipStudyArchive } from './study-zip';
import {
  asColumnId,
  getAuthoredCatalog,
  isDroppedColumn,
  normalizeColumnName,
  type ColumnId,
  type FieldKind,
} from '@mriqc/shared';

export type StudyScalar = string | number | boolean | null;

export interface ParsedStudy {
  rows: readonly Readonly<Record<string, StudyScalar>>[];
  columns: readonly string[];
  metrics: readonly ColumnId[];
  totalMetrics: number;
  ignoredColumns: readonly string[];
  missingMetrics: readonly ColumnId[];
  columnMapping: readonly { source: string; target: string }[];
}

interface RawStudy {
  columns: readonly string[];
  rows: readonly (readonly unknown[])[];
}

interface KnownColumn {
  kind: FieldKind | 'metric' | 'identity';
}

const catalog = getAuthoredCatalog();
const knownColumns = new Map<string, KnownColumn>([['bids_name', { kind: 'identity' }]]);
for (const metric of catalog.metrics) knownColumns.set(metric.id, { kind: 'metric' });
for (const field of catalog.fields) knownColumns.set(field.id, { kind: field.kind });

// load() has no modality argument, so its coverage summary deliberately uses the
// distinct union of authored metric ids across all modalities. Query-time
// validation still applies the current query's modality.
const metricUniverse = [...new Set(catalog.metrics.map((metric) => metric.id))];

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Flatten a per-scan MRIQC document. Arrays stay scalar JSON values. */
export function flattenStudyJson(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, StudyScalar>> {
  const result: Record<string, StudyScalar> = {};
  const visit = (prefix: string, item: unknown): void => {
    if (Array.isArray(item)) {
      result[prefix] = JSON.stringify(item);
      return;
    }
    if (isRecord(item)) {
      for (const key of Object.keys(item).sort()) {
        visit(prefix === '' ? key : `${prefix}.${key}`, item[key]);
      }
      return;
    }
    if (
      item === null ||
      typeof item === 'string' ||
      typeof item === 'number' ||
      typeof item === 'boolean'
    ) {
      result[prefix] = item;
      return;
    }
    result[prefix] = item === undefined ? null : String(item);
  };
  for (const key of Object.keys(value).sort()) visit(key, value[key]);
  return result;
}

/** RFC-4180-style rows, including escaped quotes and quoted newlines. */
export function parseDelimitedRows(text: string, delimiter: ',' | '\t'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] as string;
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field === '') {
      quoted = true;
    } else if (character === delimiter) {
      row.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('The delimited study has an unterminated quoted field');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function delimiterFor(name: string, text: string): ',' | '\t' {
  if (name.toLowerCase().endsWith('.tsv')) return '\t';
  if (name.toLowerCase().endsWith('.csv')) return ',';
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  return (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? '\t' : ',';
}

function delimitedStudy(name: string, bytes: Uint8Array): RawStudy {
  const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, '');
  const parsed = parseDelimitedRows(text, delimiterFor(name, text));
  const header = parsed[0];
  if (header === undefined || header.length === 0 || header.every((value) => value.trim() === '')) {
    throw new Error('The study table needs one header row');
  }
  const columns = header.map((value) => value.trim());
  if (columns.some((value) => value === ''))
    throw new Error('The study table has an empty column name');
  const rows: string[][] = [];
  for (const source of parsed.slice(1)) {
    if (source.length === 1 && source[0] === '') continue;
    if (
      source.length > columns.length &&
      source.slice(columns.length).some((value) => value !== '')
    ) {
      throw new Error('A study row has more values than the header');
    }
    rows.push(columns.map((_column, index) => source[index] ?? ''));
  }
  return { columns, rows };
}

function basename(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return path.slice(slash + 1).replace(/\.json$/i, '');
}

async function zippedStudy(bytes: Uint8Array): Promise<RawStudy> {
  const archive = await unzipStudyArchive(bytes);
  const paths = Object.keys(archive)
    .filter((path) => path.toLowerCase().endsWith('.json') && !path.startsWith('__MACOSX/'))
    .sort();
  if (paths.length === 0) throw new Error('The zip does not contain any per-scan JSON files');

  const flattened: Readonly<Record<string, StudyScalar>>[] = paths.map((path) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(archive[path] as Uint8Array));
    } catch {
      throw new Error(`Could not parse ${path} as JSON`);
    }
    if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object`);
    const row = { ...flattenStudyJson(parsed) };
    if (row['bids_name'] === undefined || row['bids_name'] === null || row['bids_name'] === '') {
      row['bids_name'] = basename(path);
    }
    return row;
  });
  const columns = [...new Set(flattened.flatMap((row) => Object.keys(row)))].sort();
  return { columns, rows: flattened.map((row) => columns.map((column) => row[column] ?? null)) };
}

function scalar(value: unknown, kind: KnownColumn['kind']): StudyScalar {
  if (value === null || value === undefined) return null;
  if (kind === 'metric' || kind === 'numeric') {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const text = String(value).trim();
    if (text === '' || /^(n\/?a|null|nan|[-+]?inf(?:inity)?)$/i.test(text)) return null;
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
  }
  if (kind === 'categorical' || kind === 'identity' || kind === 'date') {
    if (typeof value === 'boolean' && kind === 'categorical') return value;
    return String(value).trim() === '' ? null : String(value);
  }
  return null;
}

/** Normalize, deterministically keep the first collision, and project to catalog columns. */
export function normalizeStudy(raw: RawStudy): ParsedStudy {
  const targetByIndex = new Map<number, string>();
  const claimed = new Set<string>();
  const ignored: string[] = [];

  raw.columns.forEach((source, index) => {
    if (isDroppedColumn(source)) {
      ignored.push(source);
      return;
    }
    const target = normalizeColumnName(source);
    if (target === '' || !knownColumns.has(target) || claimed.has(target)) {
      ignored.push(source);
      return;
    }
    claimed.add(target);
    targetByIndex.set(index, target);
  });

  if (!claimed.has('bids_name')) throw new Error('The study needs a bids_name column');
  const columns = [...targetByIndex.values()];
  const rows = raw.rows.map((source) => {
    const result: Record<string, StudyScalar> = {};
    for (const [index, target] of targetByIndex) {
      result[target] = scalar(source[index], (knownColumns.get(target) as KnownColumn).kind);
    }
    return result;
  });
  const metrics = metricUniverse.filter((metric) => claimed.has(metric));
  return {
    rows,
    columns,
    columnMapping: [...targetByIndex].map(([index, target]) => ({ source: raw.columns[index], target })),
    metrics,
    totalMetrics: metricUniverse.length,
    ignoredColumns: [...new Set(ignored)],
    missingMetrics: metricUniverse.filter((metric) => !claimed.has(metric)).map(asColumnId),
  };
}

/** Parse a browser file without retaining its bytes or raw rows after load completes. */
export async function parseStudyFile(file: File): Promise<ParsedStudy> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const raw = file.name.toLowerCase().endsWith('.zip')
    ? await zippedStudy(bytes)
    : delimitedStudy(file.name, bytes);
  if (raw.rows.length === 0) throw new Error('The study contains no scan rows');
  return normalizeStudy(raw);
}
