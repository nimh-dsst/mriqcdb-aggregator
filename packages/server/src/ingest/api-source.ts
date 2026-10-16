/**
 * The third ingest source: the public MRIQC web API, for the ongoing pull.
 *
 * The API is Eve over the same MongoDB, open for reading at
 * `https://mriqc.nimh.nih.gov/api/v1/<collection>`. It is not a way to *build* a
 * database -- a full pull is millions of records a thousand at a time -- but it
 * is a way to keep one current without a Mongo credential or a dump host.
 *
 * Two things about the deployment shape how it is read:
 *
 * - It ignores `where` and `sort` entirely, so there is no `_updated > watermark`
 *   query to ask. What it does keep is MongoDB's natural order, which is
 *   insertion order: page 1 is 2017 and the last page is today. So the source
 *   searches back from the end, one record per request, for where the watermark
 *   falls, and reads every page from there to the end.
 * - Its records are plain JSON: `_id` a bare string and `_created`/`_updated` as
 *   RFC 1123 text. They are rewritten into the relaxed extended JSON
 *   `mongoexport` writes, so they stage exactly like a dump.
 *
 * A record re-sent long after it was first inserted keeps its old position, so
 * it is not seen; the dump and Mongo sources remain the way to catch those.
 */

import { MRIQC_API_PAGE_SIZE, MRIQC_API_URL } from '../config.js';
import { INGEST_COLLECTIONS, type IngestCollection } from './flatten.js';
import type { IngestSource, IngestState, IngestUnit } from './sources.js';

/** What `fetch` needs to be for this source; injectable so tests need no network. */
export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** One Eve listing page. */
interface EvePage {
  _items: Record<string, unknown>[];
  _meta: { total: number; page: number; max_results: number };
  _links?: { next?: unknown };
}

export interface ApiSourceOptions {
  /** The API root, `.../api/v1`. */
  url?: string;
  /** Records per page; Eve caps it at 1000. */
  pageSize?: number;
  /**
   * Records to re-read before the boundary the search found. Natural order is
   * insertion order, which tracks `_updated` only approximately.
   */
  overlap?: number;
  collections?: readonly IngestCollection[];
  fetch?: FetchLike;
  /** Tries per request before the run fails. */
  attempts?: number;
  log?: (message: string) => void;
}

/**
 * Parse an Eve response. Python's encoder writes non-finite floats as bare
 * `NaN` and `Infinity`, which JSON does not allow; in a value position they
 * become the extended-JSON `$numberDouble` a dump carries for them.
 */
export function parseEveJson(text: string): EvePage {
  try {
    return JSON.parse(text) as EvePage;
  } catch {
    const repaired = text.replace(
      /([:[,]\s*)(-?Infinity|NaN)(?=\s*[,\]}])/g,
      (_match, prefix: string, token: string) => `${prefix}{"$numberDouble":"${token}"}`,
    );
    return JSON.parse(repaired) as EvePage;
  }
}

/** An RFC 1123 date as `mongoexport` writes one, or the value untouched. */
function asExtendedDate(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const time = Date.parse(value);
  return Number.isNaN(time) ? value : { $date: new Date(time).toISOString() };
}

/** One Eve record in the relaxed extended-JSON shape of a dump record. */
export function toDumpRecord(item: Record<string, unknown>): Record<string, unknown> {
  const { _links: _ignored, ...record } = item;
  return {
    ...record,
    _created: asExtendedDate(record['_created']),
    _updated: asExtendedDate(record['_updated']),
  };
}

function updatedOf(item: Record<string, unknown> | undefined): number {
  const value = item?.['_updated'];
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

function isoOf(time: number): string | null {
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

export class ApiSource implements IngestSource {
  readonly kind = 'api' as const;
  readonly #url: string;
  readonly #pageSize: number;
  readonly #overlap: number;
  readonly #collections: readonly IngestCollection[];
  readonly #fetch: FetchLike;
  readonly #attempts: number;
  readonly #log: (message: string) => void;

  constructor(options: ApiSourceOptions = {}) {
    this.#url = (options.url ?? MRIQC_API_URL).replace(/\/+$/, '');
    this.#pageSize = options.pageSize ?? MRIQC_API_PAGE_SIZE;
    this.#overlap = options.overlap ?? 100;
    this.#collections = options.collections ?? INGEST_COLLECTIONS;
    this.#fetch = options.fetch ?? ((url) => fetch(url));
    this.#attempts = options.attempts ?? 4;
    this.#log = options.log ?? ((): void => undefined);
  }

  describe(): string {
    return `MRIQC web API ${this.#url} (${this.#collections.join(', ')})`;
  }

  async #page(collection: IngestCollection, page: number, size: number): Promise<EvePage> {
    const url = `${this.#url}/${collection}?max_results=${size}&page=${page}`;
    let failure: unknown = null;
    for (let attempt = 1; attempt <= this.#attempts; attempt += 1) {
      try {
        const response = await this.#fetch(url);
        if (!response.ok) throw new Error(`${url} answered ${response.status}`);
        return parseEveJson(await response.text());
      } catch (error) {
        failure = error;
        if (attempt < this.#attempts) {
          await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 250));
        }
      }
    }
    throw failure instanceof Error ? failure : new Error(String(failure));
  }

  /**
   * A 1-based position at most one page before the first record at or after
   * `watermark`, or `total + 1` when there is none.
   *
   * Every probe is a deep skip, and those are slow -- seconds each near the end of
   * a million records -- so it gallops back from the end first: a nightly pull
   * finds the boundary in the last page with one probe. Only a longer gap is then
   * bisected, and only down to a page, since reading a page is as cheap as
   * probing one.
   */
  async #boundary(collection: IngestCollection, watermark: number, total: number): Promise<number> {
    const olderAt = async (position: number): Promise<boolean> =>
      updatedOf((await this.#page(collection, position, 1))._items[0]) < watermark;

    let lo = 1;
    let hi = total + 1;
    for (let step = this.#pageSize; ; step *= 2) {
      const probe = total + 1 - step;
      if (probe <= 1) break;
      if (await olderAt(probe)) {
        lo = probe;
        break;
      }
      hi = probe;
    }
    while (hi - lo > this.#pageSize) {
      const mid = Math.floor((lo + hi) / 2);
      if (await olderAt(mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  async *units(state: IngestState): AsyncIterable<IngestUnit> {
    for (const collection of this.#collections) {
      const mark = state.watermarks.get(collection) ?? state.servedWatermarks?.get(collection) ?? null;
      if (mark === null) {
        throw new Error(
          `the API source only pulls what is newer than the database, and ${collection} has` +
            ' nothing to resume from; build the database from dumps first',
        );
      }
      const watermark = mark.getTime();

      const total = (await this.#page(collection, 1, 1))._meta.total;
      const boundary = await this.#boundary(collection, watermark, total);
      const start = Math.max(1, boundary - this.#overlap);

      let page = Math.floor((start - 1) / this.#pageSize) + 1;
      let records = 0;
      let pages = 0;
      for (;;) {
        const listing = await this.#page(collection, page, this.#pageSize);
        const fresh = listing._items.filter((item) => !(updatedOf(item) < watermark));
        if (fresh.length > 0) {
          pages += 1;
          records += fresh.length;
          yield {
            collection,
            file: null,
            sha256: null,
            records: fresh.map(toDumpRecord),
            recordCount: fresh.length,
            window: { lo: isoOf(updatedOf(fresh[0])), hi: isoOf(updatedOf(fresh.at(-1))) },
          };
        }
        if (listing._items.length < this.#pageSize || listing._links?.next === undefined) break;
        page += 1;
      }
      this.#log(
        `  ${collection}: ${records} record(s) in ${pages} page(s) since ${mark.toISOString()}` +
          ` (from position ${boundary} of ${total})`,
      );
    }
  }

  async close(): Promise<void> {
    // Nothing to release: every request is its own.
  }
}
