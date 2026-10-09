import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { quoteIdent } from './build.js';
import type { DbConnection } from './instance.js';
import { jsonPathOf } from '../ingest/flatten.js';

export interface ColumnPolicyRow {
  modality: string;
  table: string;
  column: string;
  sourceName: string;
  duckType: string;
  jsonPath: string;
  nullable: boolean;
}

const CSV_HEADER = [
  'modality',
  'table',
  'column',
  'source_name',
  'duck_type',
  'json_path',
  'nullable',
] as const;

const TABLES_BY_MODALITY = {
  bold: ['raw_bold', 'canon_bold_k4plus'],
  T1w: ['raw_t1w', 'canon_t1w_k3pp'],
  T2w: ['raw_t2w', 'canon_t2w_k3pp'],
  k4plus_scales: ['k4plus_scales'],
  scanners: ['scanners'],
  ratings: ['ratings'],
} as const;

const TABLE_ORDER = [
  'raw_bold',
  'canon_bold_k4plus',
  'raw_t1w',
  'canon_t1w_k3pp',
  'raw_t2w',
  'canon_t2w_k3pp',
  'k4plus_scales',
  'scanners',
  'ratings',
] as const;

const DUMP_TABLE_ORDER = ['raw_bold', 'raw_t1w', 'raw_t2w', 'ratings', 'scanners', 'k4plus_scales'] as const;

const MODALITY_BY_TABLE = new Map<string, string>(
  Object.entries(TABLES_BY_MODALITY).flatMap(([modality, tables]) =>
    tables.map((table) => [table, modality] as const),
  ),
);

const TYPE_PATTERN = /^(?:VARCHAR|TEXT|STRING|BOOLEAN|BOOL|TINYINT|SMALLINT|INTEGER|INT|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|REAL|DOUBLE|DATE|TIMESTAMP(?:\s+WITH\s+TIME\s+ZONE)?|TIMESTAMPTZ|UUID|JSON|BLOB|DECIMAL\s*\(\s*\d+\s*,\s*\d+\s*\))(?:\s*\[\])?$/i;

function parseCsvError(message: string, row: number): Error {
  return new Error(`Invalid columns policy CSV at row ${row}: ${message}`);
}

/** Parse RFC 4180-style CSV, including quoted commas, newlines, and quotes. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;
  let rowNumber = 1;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];

    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (afterQuote) {
      if (character === ',') {
        row.push(field);
        field = '';
        afterQuote = false;
        continue;
      }
      if (character === '\n' || character === '\r') {
        if (character === '\r' && input[index + 1] === '\n') {
          index += 1;
        }
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        afterQuote = false;
        rowNumber += 1;
        continue;
      }
      throw parseCsvError('unexpected data after closing quote', rowNumber);
    }

    if (character === '"') {
      if (field.length !== 0) {
        throw parseCsvError('quote must begin a field', rowNumber);
      }
      quoted = true;
      continue;
    }
    if (character === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (character === '\n' || character === '\r') {
      if (character === '\r' && input[index + 1] === '\n') {
        index += 1;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      rowNumber += 1;
      continue;
    }
    field += character;
  }

  if (quoted) {
    throw parseCsvError('unterminated quoted field', rowNumber);
  }
  if (row.length !== 0 || field.length !== 0 || afterQuote) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function requiredString(value: string, name: string, row: number): string {
  if (value.length === 0) {
    throw parseCsvError(`${name} is required`, row);
  }
  return value;
}

function requiredBoolean(value: string, row: number): boolean {
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw parseCsvError('nullable must be true or false', row);
}

/** Parse and validate a columns.csv file. */
export function parseColumnPolicy(csv: string): ColumnPolicyRow[] {
  const records = parseCsv(csv);
  const [header, ...data] = records;
  if (
    header === undefined ||
    header.length !== CSV_HEADER.length ||
    header.some((value, index) => value !== CSV_HEADER[index])
  ) {
    throw new Error(`Invalid columns policy CSV header; expected ${CSV_HEADER.join(',')}`);
  }

  const rows = data.map((record, index) => {
    const rowNumber = index + 2;
    if (record.length !== CSV_HEADER.length) {
      throw parseCsvError(`expected ${CSV_HEADER.length} fields, received ${record.length}`, rowNumber);
    }
    return {
      modality: requiredString(record[0] ?? '', 'modality', rowNumber),
      table: requiredString(record[1] ?? '', 'table', rowNumber),
      column: requiredString(record[2] ?? '', 'column', rowNumber),
      sourceName: requiredString(record[3] ?? '', 'source_name', rowNumber),
      duckType: requiredString(record[4] ?? '', 'duck_type', rowNumber),
      jsonPath: requiredString(record[5] ?? '', 'json_path', rowNumber),
      nullable: requiredBoolean(record[6] ?? '', rowNumber),
    };
  });
  validateColumnPolicy(rows);
  return rows;
}

/** Serialize a validated policy in its stable, CSV-file representation. */
export function serializeColumnPolicy(rows: readonly ColumnPolicyRow[]): string {
  validateColumnPolicy(rows);
  const records = [
    [...CSV_HEADER],
    ...rows.map((row) => [
      row.modality,
      row.table,
      row.column,
      row.sourceName,
      row.duckType,
      row.jsonPath,
      String(row.nullable),
    ]),
  ];
  return `${records.map((record) => record.map(csvField).join(',')).join('\n')}\n`;
}

export function validateColumnPolicy(rows: readonly ColumnPolicyRow[]): void {
  const seenTableColumns = new Set<string>();
  const sharedColumns = new Map<string, ColumnPolicyRow>();

  for (const row of rows) {
    if (
      row.modality.length === 0 ||
      row.column.length === 0 ||
      row.sourceName.length === 0 ||
      row.duckType.length === 0 ||
      row.jsonPath.length === 0
    ) {
      throw new Error(`Columns policy has an empty required field for ${row.table}.${row.column}`);
    }
    const expectedModality = MODALITY_BY_TABLE.get(row.table);
    if (expectedModality === undefined) {
      throw new Error(`Unsupported serving table in columns policy: ${row.table}`);
    }
    if (row.modality !== expectedModality) {
      throw new Error(
        `Columns policy table ${row.table} belongs to ${expectedModality}, not ${row.modality}`,
      );
    }
    if (!TYPE_PATTERN.test(row.duckType)) {
      throw new Error(`Unsafe or unsupported DuckDB type for ${row.table}.${row.column}: ${row.duckType}`);
    }
    if (row.jsonPath !== jsonPathOf(row.sourceName)) {
      throw new Error(
        `Unexpected json_path for ${row.table}.${row.column}: expected ${jsonPathOf(row.sourceName)}`,
      );
    }
    if (typeof row.nullable !== 'boolean') {
      throw new Error(`nullable must be boolean for ${row.table}.${row.column}`);
    }

    const tableColumnKey = `${row.table}\u0000${row.column}`;
    if (seenTableColumns.has(tableColumnKey)) {
      throw new Error(`Duplicate columns policy entry for ${row.table}.${row.column}`);
    }
    seenTableColumns.add(tableColumnKey);

    const sharedKey = `${row.modality}\u0000${row.column}`;
    const first = sharedColumns.get(sharedKey);
    if (first === undefined) {
      sharedColumns.set(sharedKey, row);
      continue;
    }
    if (first.sourceName !== row.sourceName || first.jsonPath !== row.jsonPath) {
      throw new Error(
        `Inconsistent catalog definition for ${row.modality}.${row.column} between ${first.table} and ${row.table}`,
      );
    }
  }
}

export function readColumnPolicy(): ColumnPolicyRow[] {
  return parseColumnPolicy(
    readFileSync(new URL('../../policies/columns.csv', import.meta.url), 'utf8'),
  );
}

export function columnPolicyHash(rows: readonly ColumnPolicyRow[] = readColumnPolicy()): string {
  return createHash('sha256').update(serializeColumnPolicy(rows), 'utf8').digest('hex');
}

function describeNullable(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value.trim().toUpperCase() !== 'NO';
  }
  throw new Error(`DESCRIBE returned invalid nullability: ${String(value)}`);
}

function describeValue(record: Record<string, unknown>, key: string, table: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`DESCRIBE ${table} did not return a ${key}`);
  }
  return value;
}

/** Capture the current serving-table shapes as a policy, retaining each table's real DuckDB types. */
export async function captureColumnPolicy(connection: DbConnection): Promise<ColumnPolicyRow[]> {
  const catalog = await connection.all(
    'SELECT modality, "column", source_name, duck_type FROM columns',
  );
  const catalogByColumn = new Map<string, { sourceName: string; duckType: string }>();

  for (const entry of catalog) {
    const modality = describeValue(entry, 'modality', 'columns');
    const column = describeValue(entry, 'column', 'columns');
    const sourceName = describeValue(entry, 'source_name', 'columns');
    const duckType = describeValue(entry, 'duck_type', 'columns');
    const key = `${modality}\u0000${column}`;
    if (catalogByColumn.has(key)) {
      throw new Error(`columns contains duplicate catalog entry for ${modality}.${column}`);
    }
    catalogByColumn.set(key, { sourceName, duckType });
  }

  const rows: ColumnPolicyRow[] = [];
  for (const table of TABLE_ORDER) {
    const modality = MODALITY_BY_TABLE.get(table);
    if (modality === undefined) {
      throw new Error(`No modality registered for ${table}`);
    }
    const description = await connection.all(`DESCRIBE ${quoteIdent(table)}`);
    for (const entry of description) {
      const column = describeValue(entry, 'column_name', table);
      const duckType = describeValue(entry, 'column_type', table);
      const catalogEntry = catalogByColumn.get(`${modality}\u0000${column}`);
      if (catalogEntry === undefined) {
        throw new Error(`columns has no entry for ${modality}.${column} used by ${table}`);
      }
      if (!TYPE_PATTERN.test(catalogEntry.duckType)) {
        throw new Error(`columns has an unsafe DuckDB type for ${modality}.${column}`);
      }
      rows.push({
        modality,
        table,
        column,
        sourceName: catalogEntry.sourceName,
        duckType,
        jsonPath: jsonPathOf(catalogEntry.sourceName),
        nullable: describeNullable(entry.null),
      });
    }
  }
  validateColumnPolicy(rows);
  return rows;
}

function createTableSql(table: string, rows: readonly ColumnPolicyRow[]): string {
  if (rows.length === 0) {
    throw new Error(`Columns policy has no fields for required dump table ${table}`);
  }
  const definitions = rows.map(
    (row) => `${quoteIdent(row.column)} ${row.duckType}${row.nullable ? '' : ' NOT NULL'}`,
  );
  return `CREATE TABLE ${quoteIdent(table)} (${definitions.join(', ')})`;
}

function preferredCatalogRows(rows: readonly ColumnPolicyRow[]): ColumnPolicyRow[] {
  const selected = new Map<string, ColumnPolicyRow>();
  for (const row of rows) {
    const key = `${row.modality}\u0000${row.column}`;
    const current = selected.get(key);
    if (current === undefined || (row.table.startsWith('raw_') && !current.table.startsWith('raw_'))) {
      selected.set(key, row);
    }
  }
  return [...selected.values()];
}

/** Create the dump-imported raw tables and their shared source-column catalog. */
export async function createDumpSchema(
  connection: DbConnection,
  rows: readonly ColumnPolicyRow[] = readColumnPolicy(),
): Promise<void> {
  validateColumnPolicy(rows);

  for (const table of DUMP_TABLE_ORDER) {
    await connection.exec(createTableSql(table, rows.filter((row) => row.table === table)));
  }

  await connection.exec(
    'CREATE TABLE columns (modality VARCHAR, "column" VARCHAR, source_name VARCHAR, duck_type VARCHAR)',
  );

  const catalogRows = preferredCatalogRows(rows);
  if (catalogRows.length === 0) {
    return;
  }
  const placeholders = catalogRows.map(() => '(?, ?, ?, ?)').join(', ');
  await connection.exec(
    `INSERT INTO columns (modality, "column", source_name, duck_type) VALUES ${placeholders}`,
    catalogRows.flatMap((row) => [row.modality, row.column, row.sourceName, row.duckType]),
  );
}
