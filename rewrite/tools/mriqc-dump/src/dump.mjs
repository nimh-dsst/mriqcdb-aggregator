/**
 * `mriqc-dump` -- the cron-able dump tool.
 *
 * See `../../../docs/backend-graph.md`, "Ingest from dumps (decided 2026-10-08)".
 * The owner's preference is that the server never connects to MongoDB: this tool
 * runs wherever Mongo *is* reachable, produces files, and the server ingests
 * files.
 *
 * For each collection (`T1w`, `T2w`, `bold`, `rating`) it runs
 * `mongoexport --jsonArray` with a `_updated` greater-than filter taken from the
 * output directory's `manifest.json`, writes
 * `mriqc_api.<collection>.<YYYYMMDDTHHMMSS>.json` in the same MongoDB
 * extended-JSON shape as the existing full dumps, and appends to the manifest the
 * file name, collection, record count, highest `_updated` and sha256 that
 * `packages/server/src/ingest/` reads back.
 *
 * Plain ESM with no build step and no dependencies but Node itself, so it can be
 * copied to the loader host and run from cron there. `mongoexport` is the only
 * external program it needs, and `--dry-run` prints the exact command lines
 * without running any of them -- which is also how the unit tests exercise the
 * command construction with no MongoDB and no `mongoexport` present.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The four MRIQC Web-API collections, in the order the tool exports them. */
export const COLLECTIONS = ['T1w', 'T2w', 'bold', 'rating'];

/** The manifest file name, shared with the server's `ingest/sources.ts`. */
export const MANIFEST_FILE = 'manifest.json';

/** The manifest schema version this tool writes. */
export const MANIFEST_VERSION = 1;

/* -------------------------------------------------------------- file names */

/**
 * The dated stamp in a dump file name: UTC, `YYYYMMDDTHHMMSS`.
 *
 * UTC rather than local so two hosts in different zones sort the same, and so the
 * stamp never goes backwards across a daylight-saving change.
 *
 * @param {Date} when
 * @returns {string}
 */
export function stampOf(when) {
  const iso = when.toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

/**
 * The dump file name for one collection and moment:
 * `mriqc_api.<collection>.<YYYYMMDDTHHMMSS>.json`.
 *
 * @param {string} collection
 * @param {Date} when
 * @returns {string}
 */
export function dumpFileName(collection, when) {
  return `mriqc_api.${collection}.${stampOf(when)}.json`;
}

/** The pattern a dated dump file name matches, used by `--adopt`. */
export const DUMP_FILE_PATTERN = /^mriqc_api\.(T1w|T2w|bold|rating)(?:\.(\d{8}T\d{6}))?\.json$/;

/* --------------------------------------------------------------- manifest */

/**
 * Read a directory's manifest, or an empty one when there is none.
 *
 * @param {string} dir
 * @returns {{ version: number, files: Array<Record<string, unknown>> }}
 */
export function readManifest(dir) {
  const path = join(dir, MANIFEST_FILE);
  if (!existsSync(path)) return { version: MANIFEST_VERSION, files: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(parsed.files)) {
    throw new Error(`${path} must be an object with a "files" array`);
  }
  return { version: parsed.version ?? MANIFEST_VERSION, files: parsed.files };
}

/**
 * Write a manifest through a temporary file and a rename.
 *
 * A cron job killed mid-write must not leave a half-written manifest: the server
 * refuses a malformed one, which would stop every later ingest until someone
 * noticed.
 *
 * @param {string} dir
 * @param {{ version: number, files: Array<Record<string, unknown>> }} manifest
 */
export function writeManifest(dir, manifest) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, MANIFEST_FILE);
  const temp = `${path}.writing-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`);
  rmSync(path, { force: true });
  renameSync(temp, path);
}

/**
 * The highest `_updated` the manifest records for one collection, or null.
 *
 * This is the watermark the next export filters on, so the tool is resumable
 * without being told: `--since` only overrides it.
 *
 * @param {{ files: Array<Record<string, unknown>> }} manifest
 * @param {string} collection
 * @returns {string | null}
 */
export function watermarkOf(manifest, collection) {
  let best = null;
  let bestMs = -Infinity;
  for (const entry of manifest.files) {
    if (entry.collection !== collection || typeof entry.maxUpdated !== 'string') continue;
    const ms = Date.parse(entry.maxUpdated);
    if (Number.isNaN(ms) || ms <= bestMs) continue;
    bestMs = ms;
    best = entry.maxUpdated;
  }
  return best;
}

/**
 * Add one entry to the manifest, replacing any earlier entry for the same file.
 *
 * @param {{ version: number, files: Array<Record<string, unknown>> }} manifest
 * @param {Record<string, unknown>} entry
 * @returns {{ version: number, files: Array<Record<string, unknown>> }}
 */
export function withEntry(manifest, entry) {
  const files = manifest.files.filter((existing) => existing.file !== entry.file);
  files.push(entry);
  return { version: MANIFEST_VERSION, files };
}

/* ------------------------------------------------------- the export command */

/**
 * The `mongoexport` argument vector for one collection.
 *
 * `--jsonArray` is what makes the output the same pretty JSON array shape as the
 * existing full dumps, which is what the server's `read_json(..., format='array')`
 * staging reads. The `_updated` filter is a greater-than on an extended-JSON
 * date, so Mongo compares dates rather than strings.
 *
 * @param {{ uri: string, collection: string, out: string, since?: string | null, db?: string | null }} options
 * @returns {string[]}
 */
export function mongoexportArgs({ uri, collection, out, since = null, db = null }) {
  const args = ['--uri', uri];
  if (db !== null && db !== '') args.push('--db', db);
  args.push('--collection', collection, '--jsonArray', '--out', out);
  if (since !== null && since !== '') {
    args.push('--query', JSON.stringify({ _updated: { $gt: { $date: since } } }));
  }
  return args;
}

/**
 * The command line as a human would type it, for `--dry-run` and the log.
 *
 * The URI is redacted: it carries a password, and this string is printed and
 * written to cron's mail.
 *
 * @param {string} program
 * @param {string[]} args
 * @returns {string}
 */
export function commandLine(program, args) {
  const shown = args.map((arg, index) => {
    const value = args[index - 1] === '--uri' ? redactUri(arg) : arg;
    return /[\s"{}$]/.test(value) ? JSON.stringify(value) : value;
  });
  return [program, ...shown].join(' ');
}

/**
 * A connection string with its credentials replaced.
 *
 * @param {string} uri
 * @returns {string}
 */
export function redactUri(uri) {
  return uri.replace(/\/\/[^@/]*@/, '//***:***@');
}

/* ------------------------------------------------------- reading a dump back */

/**
 * Yield each top-level element of a JSON array file as text.
 *
 * Streamed with a brace counter rather than `JSON.parse` of the whole file,
 * because a full T1w dump is 7.7 GB and would not fit in a Node heap. The scanner
 * only has to know about strings and escapes to count braces correctly.
 *
 * @param {string} path
 * @returns {AsyncGenerator<string, void, unknown>}
 */
export async function* jsonArrayRecords(path) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let started = false;
  let current = '';

  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) {
    for (const character of chunk) {
      if (!started) {
        // Everything before the array's opening bracket is whitespace.
        if (character === '[') started = true;
        continue;
      }
      if (depth > 0) current += character;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === '{' || character === '[') {
        depth += 1;
        if (depth === 1) current = character;
        continue;
      }
      if (character === '}' || character === ']') {
        if (depth === 0) return; // The array's closing bracket.
        depth -= 1;
        if (depth === 0) {
          yield current;
          current = '';
        }
      }
    }
  }
}

/**
 * The record count and highest `_updated` of a dump file.
 *
 * Each record is parsed rather than regexed: `_updated` arrives as
 * `{"$date": "..."}` in relaxed extended JSON and as
 * `{"$date": {"$numberLong": "..."}}` in canonical, and a parse handles both
 * without a second code path.
 *
 * @param {string} path
 * @returns {Promise<{ records: number, maxUpdated: string | null }>}
 */
export async function summarizeDump(path) {
  let records = 0;
  let maxMs = -Infinity;
  let maxUpdated = null;
  for await (const text of jsonArrayRecords(path)) {
    records += 1;
    const updated = updatedOf(JSON.parse(text));
    if (updated === null) continue;
    const ms = Date.parse(updated);
    if (Number.isNaN(ms) || ms <= maxMs) continue;
    maxMs = ms;
    maxUpdated = updated;
  }
  return { records, maxUpdated };
}

/**
 * One record's `_updated` as ISO-8601 text, or null when it has none.
 *
 * @param {Record<string, unknown>} record
 * @returns {string | null}
 */
export function updatedOf(record) {
  const value = record?._updated;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return null;
  const date = /** @type {Record<string, unknown>} */ (value).$date;
  if (typeof date === 'string') return date;
  if (typeof date === 'number') return new Date(date).toISOString();
  if (typeof date === 'object' && date !== null) {
    const long = /** @type {Record<string, unknown>} */ (date).$numberLong;
    if (typeof long === 'string') return new Date(Number(long)).toISOString();
  }
  return null;
}

/**
 * The sha256 of a file, streamed.
 *
 * @param {string} path
 * @returns {Promise<string>}
 */
export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/* ------------------------------------------------------------- the run loop */

/**
 * Run one program to completion.
 *
 * @param {string} program
 * @param {string[]} args
 * @returns {Promise<void>}
 */
function run(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${program} exited with code ${String(code)}`));
    });
  });
}

/**
 * Export every collection, then update the manifest.
 *
 * The manifest is written after *each* collection rather than once at the end, so
 * a run that dies on the third collection still records the two that landed and
 * the next run does not re-export them.
 *
 * @param {{
 *   uri: string, out: string, since?: string | null, db?: string | null,
 *   collections?: string[], dryRun?: boolean, mongoexport?: string,
 *   now?: Date, log?: (message: string) => void, runner?: (program: string, args: string[]) => Promise<void>,
 * }} options
 * @returns {Promise<{ commands: string[], entries: Array<Record<string, unknown>> }>}
 */
export async function dump(options) {
  const {
    uri,
    out,
    since = null,
    db = null,
    collections = COLLECTIONS,
    dryRun = false,
    mongoexport = process.env.MRIQC_MONGOEXPORT ?? 'mongoexport',
    now = new Date(),
    log = (message) => console.log(message),
    runner = run,
  } = options;

  if (typeof uri !== 'string' || uri.trim() === '') {
    throw new Error('mriqc-dump needs --uri, or MRIQC_MONGO_URI in the environment');
  }
  mkdirSync(out, { recursive: true });

  const commands = [];
  const entries = [];
  for (const collection of collections) {
    const manifest = readManifest(out);
    // `--since` overrides the manifest for every collection; without it each
    // collection resumes from its own watermark, which is what makes a nightly
    // cron entry need no state of its own.
    const from = since ?? watermarkOf(manifest, collection);
    const file = dumpFileName(collection, now);
    const path = join(out, file);
    const args = mongoexportArgs({ uri, collection, out: path, since: from, db });
    const line = commandLine(mongoexport, args);
    commands.push(line);
    log(`${dryRun ? '[dry run] ' : ''}${line}`);
    if (dryRun) continue;

    await runner(mongoexport, args);
    if (!existsSync(path)) {
      throw new Error(`${mongoexport} reported success but wrote no ${file}`);
    }
    const entry = await describeDump(out, file, collection, from);
    if (entry.records === 0) {
      // An empty export is the normal nightly outcome for a quiet collection.
      // Keeping the file would leave the directory full of empty arrays and the
      // manifest full of entries the server has to hash and skip.
      rmSync(path, { force: true });
      log(`  ${collection}: no new records, ${file} removed`);
      continue;
    }
    writeManifest(out, withEntry(manifest, entry));
    entries.push(entry);
    log(
      `  ${collection}: ${entry.records} record(s), _updated up to ${String(entry.maxUpdated)},` +
        ` ${entry.bytes} bytes, sha256 ${String(entry.sha256).slice(0, 12)}...`,
    );
  }
  return { commands, entries };
}

/**
 * The manifest entry describing one dump file already on disk.
 *
 * @param {string} dir
 * @param {string} file
 * @param {string} collection
 * @param {string | null} since
 * @returns {Promise<Record<string, unknown>>}
 */
export async function describeDump(dir, file, collection, since = null) {
  const path = join(dir, file);
  const { records, maxUpdated } = await summarizeDump(path);
  return {
    file,
    collection,
    records,
    maxUpdated,
    since,
    sha256: await sha256File(path),
    bytes: statSync(path).size,
    exportedAt: new Date().toISOString(),
  };
}

/**
 * Take dump files already in a directory into the manifest, without exporting.
 *
 * This is how the existing full dumps in `C:/Users/licc/projects/mriqc` become
 * "valid first files": point `--adopt` at a directory holding them and the server
 * can ingest them, after which the nightly deltas chain off their `_updated`.
 *
 * @param {{ out: string, log?: (message: string) => void }} options
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function adopt({ out, log = (message) => console.log(message) }) {
  let manifest = readManifest(out);
  const known = new Set(manifest.files.map((entry) => entry.file));
  const added = [];
  for (const file of readdirSync(out).sort()) {
    const match = DUMP_FILE_PATTERN.exec(file);
    if (match === null || known.has(file)) continue;
    log(`adopting ${file}...`);
    const entry = await describeDump(out, file, /** @type {string} */ (match[1]), null);
    manifest = withEntry(manifest, entry);
    writeManifest(out, manifest);
    added.push(entry);
    log(`  ${entry.records} record(s), _updated up to ${String(entry.maxUpdated)}`);
  }
  if (added.length === 0) log('nothing to adopt');
  return added;
}
