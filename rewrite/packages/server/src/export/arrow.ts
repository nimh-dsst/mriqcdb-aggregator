/**
 * `GET /export?modality&view&filters&columns` -> `application/vnd.apache.arrow.stream`.
 *
 * See `docs/backend-graph.md`, "Procedures": export is not a tRPC procedure. It is
 * the same predicate and the same catalog validation, read as a streaming DuckDB
 * result whose chunks go straight through an Arrow `RecordBatchStreamWriter`, so
 * nothing accumulates in memory. Row cap 2 000 000, 120 s query timeout.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DuckDBTypeId,
  JSDuckDBValueConverter,
  type DuckDBConnection,
  type DuckDBDataChunk,
  type DuckDBType,
} from '@duckdb/node-api';
import {
  AsyncByteQueue,
  Bool,
  DataType,
  Field,
  Float64,
  Int32,
  Int64,
  RecordBatch,
  RecordBatchStreamWriter,
  Schema,
  Struct,
  TimestampMillisecond,
  Utf8,
  makeData,
  vectorFromArray,
  type Data,
} from 'apache-arrow';
import type { Filter, Modality, SelectionScope, View } from '@mriqc/shared';
import { getAuthoredCatalog, normalizeSelections } from '@mriqc/shared';
import { EXPORT_ROW_CAP, EXPORT_TIMEOUT_MS } from '../config.js';
import { bindParams, type Db, type ParamValue } from '../db/instance.js';
import { tableFor } from '../db/views.js';
import { compileFilters, quoteIdent } from '../sql/filters.js';
import { fill, loadTemplate, projectionColumns, projectionSql } from '../sql/run.js';
import { filtersSchema, selectionInput } from '../trpc/inputs.js';

/** The MIME type an Arrow IPC stream is served as. */
export const ARROW_STREAM_MIME = 'application/vnd.apache.arrow.stream';

/** Everything the query string has to supply. */
export interface ExportRequest extends SelectionScope {
  modality: Modality;
  view: View;
  filters: readonly Filter[];
  columns: readonly string[];
}

/** Thrown for a query string this handler refuses; becomes a 400. */
export class ExportRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportRequestError';
  }
}

const MODALITIES = new Set(['bold', 'T1w', 'T2w']);
const VIEWS = new Set(['raw', 'k4plus', 'k3pp']);

/** A zod failure as one short, client-safe line: paths and codes, never values. */
function issuesOf(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

function parseJson(name: string, raw: string | null, fallback: unknown): unknown {
  if (raw === null || raw === '') return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new ExportRequestError(`${name} is not valid JSON`);
  }
}

/** Read and check the query string. Column and field validity is the catalog's call. */
export function parseExportRequest(search: URLSearchParams): ExportRequest {
  const modality = search.get('modality') ?? '';
  const view = search.get('view') ?? '';
  if (!MODALITIES.has(modality)) throw new ExportRequestError(`unknown modality "${modality}"`);
  if (!VIEWS.has(view)) throw new ExportRequestError(`unknown view "${view}"`);

  const columns = (search.get('columns') ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c !== '');
  if (columns.length === 0) throw new ExportRequestError('columns is required');

  // The same zod schemas the procedures validate through, which is what the design
  // promises. Checking only `Array.isArray` let a malformed but array-shaped filter
  // through to a TypeError deep in `compileFilters`, and so to a 500 for what is
  // plainly a bad request.
  const filters = filtersSchema.safeParse(parseJson('filters', search.get('filters'), []));
  if (!filters.success) {
    throw new ExportRequestError(`filters is not a valid filter list: ${issuesOf(filters.error)}`);
  }
  const selectionScope = selectionInput.safeParse({
    selections: parseJson('selections', search.get('selections'), undefined),
    selection: parseJson('selection', search.get('selection'), null),
  });
  if (!selectionScope.success) {
    throw new ExportRequestError(`selections are not valid: ${issuesOf(selectionScope.error)}`);
  }

  return {
    modality: modality as Modality,
    view: view as View,
    // The schemas type `field`/`metric` as plain strings; the catalog is what turns
    // one into a `ColumnId`, and `compileFilters` is where that check happens.
    filters: filters.data as unknown as readonly Filter[],
    selections: normalizeSelections(selectionScope.data as unknown as SelectionScope),
    columns,
  };
}

/** The statement and parameters one export request compiles to. */
export function compileExport(request: ExportRequest): { sql: string; params: ParamValue[] } {
  const table = tableFor(request.modality, request.view);
  const columns = projectionColumns(request.modality, request.view, request.columns);
  const compiled = compileFilters(
    request.filters,
    normalizeSelections(request),
    request.modality,
    request.view,
    getAuthoredCatalog(),
  );
  const sql = fill(loadTemplate('export', 'rows'), {
    table: quoteIdent(table),
    columns: projectionSql(columns),
    where: compiled.where,
  });
  return { sql, params: [...compiled.params, EXPORT_ROW_CAP] };
}

/**
 * The Arrow type each DuckDB column maps to. Fixed up front from the result's own
 * types so every record batch in the stream carries the same schema; deriving it
 * per chunk would let an all-null chunk change the schema mid-stream.
 */
function arrowType(type: DuckDBType): DataType {
  switch (type.typeId) {
    case DuckDBTypeId.BOOLEAN:
      return new Bool();
    case DuckDBTypeId.TINYINT:
    case DuckDBTypeId.SMALLINT:
    case DuckDBTypeId.INTEGER:
    case DuckDBTypeId.UTINYINT:
    case DuckDBTypeId.USMALLINT:
      return new Int32();
    case DuckDBTypeId.BIGINT:
    case DuckDBTypeId.UINTEGER:
    case DuckDBTypeId.UBIGINT:
    case DuckDBTypeId.HUGEINT:
      return new Int64();
    case DuckDBTypeId.FLOAT:
    case DuckDBTypeId.DOUBLE:
    case DuckDBTypeId.DECIMAL:
      return new Float64();
    case DuckDBTypeId.TIMESTAMP:
    case DuckDBTypeId.TIMESTAMP_S:
    case DuckDBTypeId.TIMESTAMP_MS:
    case DuckDBTypeId.TIMESTAMP_NS:
    case DuckDBTypeId.TIMESTAMP_TZ:
    case DuckDBTypeId.DATE:
      return new TimestampMillisecond();
    default:
      return new Utf8();
  }
}

/** Coerce one JS value from DuckDB into what the chosen Arrow builder accepts. */
function coerce(value: unknown, type: DataType): unknown {
  if (value === null || value === undefined) return null;
  if (DataType.isInt(type) && type.bitWidth === 64) {
    return typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value)));
  }
  if (DataType.isInt(type) || DataType.isFloat(type)) return Number(value);
  if (DataType.isBool(type)) return Boolean(value);
  if (DataType.isTimestamp(type)) return value instanceof Date ? value : new Date(String(value));
  if (DataType.isUtf8(type)) return typeof value === 'string' ? value : String(value);
  return value;
}

/**
 * Turn one DuckDB chunk into one Arrow record batch under the fixed schema.
 *
 * The schema is passed in rather than inferred, and every batch carries that same
 * object. Arrow derives a field's `nullable` flag from the values it was handed,
 * and `RecordBatchStreamWriter` closes the stream the moment a batch's schema
 * differs from the first one's -- so a chunk that happened to contain no nulls
 * would otherwise end the export early and silently.
 *
 * `vectorFromArray` flushes its builder once, at the end, so each column is
 * exactly one `Data`.
 */
function chunkToBatch(chunk: DuckDBDataChunk, schema: Schema): RecordBatch {
  const children = schema.fields.map((field, index) => {
    const values = chunk
      .convertColumnValues(index, JSDuckDBValueConverter)
      .map((value) => coerce(value, field.type));
    return vectorFromArray(values as never[], field.type as never).data[0] as Data;
  });
  const struct = makeData({
    type: new Struct(schema.fields),
    length: chunk.rowCount,
    nullCount: 0,
    children,
  });
  return new RecordBatch(schema, struct);
}

/**
 * The sink the Arrow writer hands its bytes to.
 *
 * `writer.pipe(res)` was the obvious thing and the wrong one: apache-arrow's
 * writer pushes into an unbounded internal array whenever no reader is pending, so
 * a slow or disconnected client let DuckDB be consumed at full speed and up to
 * `EXPORT_ROW_CAP` rows of serialized Arrow accumulated in process memory --
 * exactly the "nothing accumulates in memory" the design forbids. Collecting the
 * bytes instead lets the loop write them to `res` itself and wait for drain, so
 * the socket's own high-water mark is what bounds the export.
 */
class ByteCollector extends AsyncByteQueue<Uint8Array> {
  #chunks: Uint8Array[] = [];

  override write(value: Uint8Array): void {
    const bytes = asBytes(value);
    if (bytes.byteLength > 0) this.#chunks.push(bytes);
  }

  /** Everything written since the last call. */
  take(): Uint8Array[] {
    return this.#chunks.splice(0);
  }
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return new Uint8Array(0);
}

/**
 * Resolve once `res` can take more bytes, or once it is gone. `once(res, 'drain')`
 * alone would hang forever on a client that disappeared without draining, so
 * `close` and `error` end the wait too.
 */
function drained(res: ServerResponse): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      res.off('error', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
    res.once('error', done);
  });
}

/** Write everything the writer has produced, waiting for drain. False once `res` is gone. */
async function flush(sink: ByteCollector, res: ServerResponse): Promise<boolean> {
  for (const bytes of sink.take()) {
    if (res.destroyed || res.writableEnded) return false;
    if (!res.write(bytes)) await drained(res);
  }
  return !res.destroyed && !res.writableEnded;
}

/**
 * Stream one export to `res`. Holds a pooled read connection for the whole
 * response, which is what bounds how many exports can run at once.
 *
 * The loop stops the moment the client goes away and interrupts the connection, so
 * an aborted download does not keep a pooled connection busy reading rows nobody
 * will ever receive.
 */
export async function streamExport(
  db: Db,
  request: ExportRequest,
  res: ServerResponse,
  req?: IncomingMessage,
): Promise<void> {
  const { sql, params } = compileExport(request);

  await db.withRead(async (connection) => {
    const result = await connection.raw.stream(sql, bindParams(params));
    // Every column is declared nullable so one fixed schema fits every chunk.
    const schema = new Schema(
      result
        .columnNames()
        .map((name, index) => new Field(name, arrowType(result.columnType(index)), true)),
    );

    res.setHeader('Content-Type', ARROW_STREAM_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="mriqc-${request.modality}.arrow"`);

    const sink = new ByteCollector();
    const writer = new RecordBatchStreamWriter();
    writer.reset(sink);

    let abandoned = false;
    const abandon = (): void => {
      if (abandoned) return;
      abandoned = true;
      interrupt(connection.raw);
    };
    res.on('close', abandon);
    req?.on('close', abandon);

    try {
      let written = 0;
      for (;;) {
        if (abandoned || res.destroyed) break;
        const chunk = await result.fetchChunk();
        if (chunk === null || chunk.rowCount === 0) break;
        writer.write(chunkToBatch(chunk, schema));
        written += chunk.rowCount;
        if (!(await flush(sink, res))) break;
        if (written >= EXPORT_ROW_CAP) break;
      }
    } catch (error) {
      // A client that walked away interrupts the connection; that error is its
      // own doing, not a failure worth reporting.
      if (!abandoned) throw error;
    } finally {
      res.off('close', abandon);
      req?.off('close', abandon);
      writer.close();
      if (!abandoned && !res.destroyed && !res.writableEnded) {
        await flush(sink, res);
        res.end();
      } else {
        sink.take();
        res.destroy();
      }
    }
  }, EXPORT_TIMEOUT_MS);
}

function interrupt(connection: DuckDBConnection): void {
  try {
    connection.interrupt();
  } catch {
    // Interrupting a connection that already finished is not an error worth having.
  }
}

/** The `/export` route: parse, validate, stream. Errors before the first byte become 400. */
export async function handleExport(
  db: Db,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const request = parseExportRequest(url.searchParams);
  await streamExport(db, request, res, req);
}
