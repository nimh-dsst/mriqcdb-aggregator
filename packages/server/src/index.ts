/**
 * The HTTP server: `/trpc` for the procedures, `/export` for Arrow streams, and in
 * production the built dashboard.
 *
 * See `docs/backend-graph.md`: every response carries `ETag: <data_version>` and
 * `Cache-Control: public, max-age=60`. The frontend does not use HTTP caching -- it
 * has the datasets map -- but nginx and browsers can.
 */

// First, and before anything that loads the DuckDB binding: libuv reads
// `UV_THREADPOOL_SIZE` once, the first time its threadpool is used.
import './bootstrap.js';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createHTTPHandler } from '@trpc/server/adapters/standalone';
import { getCompletedCatalog } from './catalog/complete.js';
import { PACKAGE_ROOT, PORT } from './config.js';
import { closeDb, getDb, type Db } from './db/instance.js';
import { UnknownViewError } from './db/views.js';
import { ExportRequestError, handleExport } from './export/arrow.js';
import { startIngestSchedule, type IngestSchedule } from './ingest/schedule.js';
import { getDataVersion } from './ingest/version.js';
import { FilterError } from './sql/filters.js';
import { TemplateError } from './sql/run.js';
import { appRouter } from './trpc/router.js';

export { appRouter } from './trpc/router.js';
export type { AppRouter } from './trpc/router.js';
export type { Context } from './trpc/context.js';

const TRPC_PREFIX = '/trpc/';

/** The most procedure calls one batched tRPC request may carry. */
export const MAX_TRPC_BATCH_SIZE = 50;

/** How long shutdown waits for open responses before closing DuckDB anyway. */
export const SHUTDOWN_GRACE_MS = 5_000;

/** Where the built dashboard lives, if it was built. Angular nests its browser bundle. */
function findWebRoot(): string | null {
  const base = resolve(PACKAGE_ROOT, '../web/dist');
  for (const candidate of [join(base, 'web', 'browser'), join(base, 'browser'), base]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * True when `candidate` really is inside `root`.
 *
 * A bare `startsWith(root)` accepts any sibling whose name merely begins with the
 * root's -- `dist/browser` would admit `dist/browser-old/...` -- so containment is
 * checked with `relative`, which has no such edge.
 */
export function isInside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(`${sep}..`) && rel !== '..';
}

/**
 * Serve one static file, falling back to `index.html` so client routing works.
 *
 * `stream.pipeline`, not `.pipe`: a client that aborts mid-transfer leaves a
 * manual pipe's `fs.ReadStream` paused with its descriptor open forever, and a
 * read error after the headers are written is never propagated to `res`, which
 * then hangs until the client times out.
 */
function serveStatic(root: string, pathname: string, res: ServerResponse): void {
  // `normalize` plus the containment check is what keeps `..` from escaping the root.
  const requested = normalize(join(root, pathname));
  const file =
    isInside(root, requested) && existsSync(requested) && statSync(requested).isFile()
      ? requested
      : join(root, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
  pipeline(createReadStream(file), res, () => {
    // `pipeline` has already destroyed both ends; the client aborting is routine.
  });
}

/** The status an error before the first byte deserves. */
function statusFor(error: unknown): number {
  return error instanceof ExportRequestError ||
    error instanceof FilterError ||
    error instanceof TemplateError ||
    error instanceof UnknownViewError
    ? 400
    : 500;
}

/** Write a small JSON error body, if nothing has been written yet. */
function sendError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: message }));
}

/** What a request listener may be built against, instead of the process defaults. */
export interface ListenerOptions {
  /** The database the procedures and `/export` read. Defaults to the process-wide one. */
  db?: Db;
  /** Where the built dashboard is served from, or null for none. */
  webRoot?: string | null;
}

/** Build the request listener. Exported so a test can drive it without binding a port. */
export function createRequestListener(
  options: ListenerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const db = options.db ?? getDb();
  const trpc = createHTTPHandler({
    router: appRouter,
    createContext: () => ({ db }),
    basePath: TRPC_PREFIX,
    // One GET may otherwise enqueue arbitrarily many procedure calls, each of
    // which parks a waiter on the read pool.
    maxBatchSize: MAX_TRPC_BATCH_SIZE,
  });
  const webRoot =
    options.webRoot !== undefined
      ? options.webRoot
      : process.env['NODE_ENV'] === 'production'
        ? findWebRoot()
        : null;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Both of these throw on a malformed request target -- an absolute-form target
    // like `http://[::1`, or a bad percent-escape like `/%`. They run in the
    // `'request'` listener, where an exception is uncaught and takes the process
    // with it, so neither is allowed to escape.
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      sendError(res, 400, 'malformed request target');
      return;
    }

    // Awaited, not fired off: `serveStatic` and the 404 branch call `writeHead`
    // synchronously, so a `.then()` would have landed after the headers were
    // already on the wire and those responses would carry no validator at all.
    // The value is cached in-process after the first read, so this is one await.
    const version = await getDataVersion(db).catch(() => null);
    if (version !== null && !res.headersSent && !res.destroyed) {
      // RFC 9110 entity-tags are quoted; a bare hex digest is not a valid one.
      res.setHeader('ETag', `"${version}"`);
      res.setHeader('Cache-Control', 'public, max-age=60');
    }

    if (pathname === '/export') {
      try {
        await handleExport(db, req, res);
      } catch (error: unknown) {
        if (res.headersSent) {
          res.destroy(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        const status = statusFor(error);
        // A 400 is the client's own input described back. A 500 is ours, and its
        // message can carry column names, expected formats and even table values
        // out of DuckDB, so only the log sees it.
        if (status >= 500) console.error('[export]', error);
        sendError(
          res,
          status,
          status < 500 && error instanceof Error ? error.message : 'internal server error',
        );
      }
      return;
    }

    if (pathname === '/trpc' || pathname.startsWith(TRPC_PREFIX)) {
      trpc(req, res);
      return;
    }

    if (webRoot !== null) {
      serveStatic(webRoot, pathname, res);
      return;
    }

    sendError(res, 404, 'not found');
  };

  return (req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error('[request]', error);
      if (res.headersSent) res.destroy();
      else sendError(res, 500, 'internal server error');
    });
  };
}

/**
 * Compute the completed catalog before anyone asks for it.
 *
 * It is the first request of every dashboard load and the only one that scans
 * every table, so a cold server made the first browser pay about 2.5 s for it.
 * Started alongside `listen` rather than before it: the server is up either way,
 * and `getCompletedCatalog` caches the in-flight promise, so a request that
 * arrives mid-warm joins this computation instead of starting a second one.
 *
 * A failure is logged and dropped. The cache does not keep failed attempts, so
 * the first real request retries -- a database that is not ready yet must not
 * stop the server from starting.
 */
export function warmCatalog(db: Db): Promise<void> {
  const started = Date.now();
  return getCompletedCatalog(db).then(
    (catalog) => {
      console.log(
        `@mriqc/server catalog warm in ${Date.now() - started} ms` +
          ` (data_version ${catalog.dataVersion})`,
      );
    },
    (error: unknown) => {
      console.error('[catalog warm]', error);
    },
  );
}

/**
 * The nightly ingest, when `INGEST_ENABLED=1`. Module-level so shutdown can
 * cancel the pending timer; null when the schedule is off, which is the default.
 */
let ingestSchedule: IngestSchedule | null = null;

/** Start listening. Returns the server so a caller can close it. */
export function startServer(
  port: number = PORT,
  options: ListenerOptions = {},
): ReturnType<typeof createServer> {
  const db = options.db ?? getDb();
  const server = createServer(createRequestListener({ ...options, db }));
  void warmCatalog(db);
  // The nightly in-process ingest. Off unless `INGEST_ENABLED=1`, and it says so
  // either way, so a server that is not going to ingest does not look as if it will.
  ingestSchedule ??= startIngestSchedule({ db });
  server.listen(port, () => {
    console.log(
      `@mriqc/server listening on http://127.0.0.1:${port}` +
        ` (trpc ${TRPC_PREFIX}, export /export, duckdb ${db.path},` +
        ` read pool ${db.poolSize}, UV_THREADPOOL_SIZE ${process.env['UV_THREADPOOL_SIZE'] ?? '?'})`,
    );
  });
  return server;
}

// `pnpm --filter @mriqc/server start` and `dev` both run this module directly; an
// import of it (the tests, the web app's type-only import) must not start a server.
/**
 * Stop accepting connections, end the ones still open, close DuckDB, exit.
 *
 * `server.close()` alone waits for every active connection, and the long-lived
 * SSE `dataVersion` subscription never ends by itself: with one dashboard tab
 * connected the callback would never fire, `closeDb()` would never run, and the
 * supervisor would eventually SIGKILL the process with its WAL left for replay.
 * So open connections are ended explicitly, and the wait is bounded regardless.
 */
export async function shutdownServer(
  server: ReturnType<typeof createServer>,
  graceMs: number = SHUTDOWN_GRACE_MS,
): Promise<void> {
  ingestSchedule?.stop();
  ingestSchedule = null;
  const closed = new Promise<void>((done) => server.close(() => done()));
  server.closeIdleConnections();
  server.closeAllConnections();
  let timer: NodeJS.Timeout | undefined;
  const grace = new Promise<void>((done) => {
    timer = setTimeout(done, graceMs);
  });
  try {
    await Promise.race([closed, grace]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  await closeDb();
}

const entry = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (entry !== null && resolve(fileURLToPath(import.meta.url)) === entry) {
  const server = startServer();
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void shutdownServer(server).then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('[shutdown]', error);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
