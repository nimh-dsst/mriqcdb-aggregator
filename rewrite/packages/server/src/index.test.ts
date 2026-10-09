/**
 * The HTTP layer: what a malformed request does, what every response carries, what
 * the static route will and will not serve, what an internal error says, and that
 * shutdown finishes while a subscription is open.
 *
 * The malformed-target cases are sent over a raw socket, because every HTTP client
 * worth the name would normalize them away before they reached the server.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getCompletedCatalog, invalidateCatalog } from './catalog/complete.js';
import { Db } from './db/instance.js';
import { makeFixture, type Fixture } from './testing/fixture.js';
import {
  createRequestListener,
  isInside,
  shutdownServer,
  startServer,
  warmCatalog,
} from './index.js';

let dir: string;
let fixture: Fixture;
let webRoot: string;
let server: Server;
let port: number;
let base: string;

/** A file big enough that a client can abort while it is still being sent. */
const BIG_FILE_BYTES = 24 * 1024 * 1024;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Send one request line over a raw socket and return the whole response text. */
function raw(requestLine: string, headers = ''): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`${requestLine}\r\nHost: 127.0.0.1\r\n${headers}Connection: close\r\n\r\n`);
    });
    let text = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      text += chunk;
    });
    socket.on('end', () => resolve(text));
    socket.on('close', () => resolve(text));
    socket.on('error', reject);
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mriqc-http-'));
  fixture = await makeFixture(dir);

  webRoot = join(dir, 'browser');
  mkdirSync(webRoot, { recursive: true });
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>dashboard</title>');
  writeFileSync(join(webRoot, 'big.js'), 'x'.repeat(BIG_FILE_BYTES));
  // A sibling whose name merely begins with the root's, which a bare `startsWith`
  // containment check would have admitted.
  mkdirSync(join(dir, 'browser-old'), { recursive: true });
  writeFileSync(join(dir, 'browser-old', 'secret.txt'), 'NOT FOR SERVING');

  server = createServer(createRequestListener({ db: fixture.db, webRoot }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  port = address.port;
  base = `http://127.0.0.1:${port}`;
}, 180_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await fixture?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('malformed requests', () => {
  it('answers 400 for a request target `new URL` cannot parse', async () => {
    const response = await raw('GET //[::1 HTTP/1.1');
    expect(response).toMatch(/^HTTP\/1\.1 400 /);
  });

  it('answers 400 for a bad percent-escape', async () => {
    const response = await raw('GET /% HTTP/1.1');
    expect(response).toMatch(/^HTTP\/1\.1 400 /);
  });

  it('keeps serving afterwards', async () => {
    // The point of the fix: neither of the above is an uncaught exception in the
    // `'request'` listener, which would have taken the process with it.
    const response = await fetch(`${base}/index.html`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('dashboard');

    const health = await fetch(`${base}/trpc/health`);
    expect(health.status).toBe(200);
  });
});

describe('response validators', () => {
  it('carries a quoted ETag and Cache-Control on a static asset', async () => {
    const response = await fetch(`${base}/index.html`);
    expect(response.headers.get('etag')).toBe(`"${fixture.result.dataVersion}"`);
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('carries them on a route with no web root too', async () => {
    const bare = createServer(createRequestListener({ db: fixture.db, webRoot: null }));
    await new Promise<void>((resolve) => bare.listen(0, '127.0.0.1', resolve));
    const address = bare.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/nothing-here`);
      expect(response.status).toBe(404);
      expect(response.headers.get('etag')).toBe(`"${fixture.result.dataVersion}"`);
      expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    } finally {
      bare.closeAllConnections();
      await new Promise<void>((resolve) => bare.close(() => resolve()));
    }
  }, 30_000);
});

describe('routing ahead of the SPA fallback', () => {
  it('serves /export as Arrow even when the dashboard is being served', async () => {
    // The fallback answers 200 + index.html for anything it does not recognise, so
    // `/export` being a route and not a page is what the dev proxy mirrors.
    const response = await fetch(`${base}/export?modality=bold&view=raw&columns=id,manufacturer`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/vnd.apache.arrow.stream');
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  }, 60_000);

  it('serves /trpc as JSON, and only an unknown path as the shell', async () => {
    const trpc = await fetch(`${base}/trpc/health`);
    expect(trpc.headers.get('content-type')).toMatch(/json/);
    const page = await fetch(`${base}/some/deep/route`);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
  }, 30_000);
});

describe('static files', () => {
  it('refuses a path that normalizes into a sibling of the root', async () => {
    const response = await fetch(`${base}/..%2fbrowser-old/secret.txt`);
    // Falls back to the SPA shell rather than serving the sibling.
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain('NOT FOR SERVING');
    expect(body).toContain('dashboard');
  });

  it('knows containment from a shared name prefix', () => {
    expect(isInside(join(dir, 'browser'), join(dir, 'browser', 'main.js'))).toBe(true);
    expect(isInside(join(dir, 'browser'), join(dir, 'browser'))).toBe(true);
    expect(isInside(join(dir, 'browser'), join(dir, 'browser-old', 'secret.txt'))).toBe(false);
    expect(isInside(join(dir, 'browser'), join(dir, 'other'))).toBe(false);
  });

  it('releases the file when the client aborts mid-transfer', async () => {
    const controller = new AbortController();
    const response = await fetch(`${base}/big.js`, { signal: controller.signal });
    const reader = response.body?.getReader();
    await reader?.read();
    controller.abort();
    await reader?.cancel().catch(() => undefined);

    // On Windows an open handle makes this throw, so a successful delete is the
    // assertion that the read stream was destroyed rather than left paused.
    const target = join(webRoot, 'big.js');
    let lastError: unknown;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        rmSync(target);
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        await delay(50);
      }
    }
    expect(lastError).toBeUndefined();
    writeFileSync(target, 'x'.repeat(1024));
  }, 60_000);
});

describe('catalog warming', () => {
  it('fills the cache so the first request does not pay for it', async () => {
    invalidateCatalog(fixture.db);
    await warmCatalog(fixture.db);
    const reads = vi.spyOn(fixture.db, 'withRead');
    await getCompletedCatalog(fixture.db);
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
  }, 120_000);

  it('resolves rather than throwing when the database cannot be read', async () => {
    const broken = new Db(join(dir, 'no-such-directory', 'missing.duckdb'), 1);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Startup must survive it: `startServer` only ever `void`s this promise.
    await expect(warmCatalog(broken)).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
    await broken.close().catch(() => undefined);
  }, 60_000);
});

describe('internal errors', () => {
  let broken: Server;
  let brokenBase: string;

  beforeAll(async () => {
    // A database file that cannot be opened: every query fails, from the inside.
    const db = new Db(join(dir, 'no-such-directory', 'missing.duckdb'), 1);
    broken = createServer(createRequestListener({ db, webRoot: null }));
    await new Promise<void>((resolve) => broken.listen(0, '127.0.0.1', resolve));
    const address = broken.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    brokenBase = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    broken.closeAllConnections();
    await new Promise<void>((resolve) => broken.close(() => resolve()));
  });

  it('says nothing about DuckDB in an export failure', async () => {
    const response = await fetch(`${brokenBase}/export?modality=bold&view=raw&columns=id`);
    expect(response.status).toBe(500);
    const body = (await response.text()).toLowerCase();
    expect(body).toBe(JSON.stringify({ error: 'internal server error' }));
    expect(body).not.toMatch(/duckdb|\.duckdb|no-such-directory/);
  }, 30_000);

  it('says nothing about DuckDB, and carries no stack, in a procedure failure', async () => {
    const response = await fetch(`${brokenBase}/trpc/health`);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toMatch(/duckdb|no-such-directory|at .*\.ts:/i);
    const payload = JSON.parse(text) as { error: { message: string; data?: { stack?: string } } };
    expect(payload.error.message).toBe('internal server error');
    expect(payload.error.data?.stack).toBeUndefined();
  }, 30_000);
});

describe('shutdown', () => {
  it('finishes while a subscription is still open', async () => {
    const running = startServer(0, { db: fixture.db, webRoot: null });
    await new Promise<void>((resolve) => running.once('listening', resolve));
    const address = running.address();
    if (address === null || typeof address === 'string') throw new Error('no port');

    // A long-lived SSE response: `server.close()` on its own waits for this
    // forever, so DuckDB never got closed and the supervisor had to SIGKILL.
    const socket = connect(address.port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write(
      'GET /trpc/dataVersion HTTP/1.1\r\nHost: 127.0.0.1\r\n' +
        'Accept: text/event-stream\r\nConnection: keep-alive\r\n\r\n',
    );
    const first = await new Promise<string>((resolve) => {
      socket.setEncoding('utf8');
      socket.once('data', (chunk: string) => resolve(chunk));
      setTimeout(() => resolve(''), 3000);
    });
    expect(first).toMatch(/^HTTP\/1\.1 200 /);

    const started = Date.now();
    await shutdownServer(running, 5000);
    expect(Date.now() - started).toBeLessThan(4000);
    socket.destroy();
  }, 60_000);
});
