import { availableParallelism } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  for (const name of ['DUCKDB_MEMORY_LIMIT', 'INGEST_MEMORY_LIMIT', 'DUCKDB_THREADS', 'DUCKDB_TEMP_DIR', 'DUCKDB_PATH']) {
    vi.stubEnv(name, undefined);
  }
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('config environment parsing', () => {
  it('uses memory, thread, and path defaults', async () => {
    const config = await import('./config.js');

    expect(config.DUCKDB_MEMORY_LIMIT).toBe('1GB');
    expect(config.INGEST_MEMORY_LIMIT).toBe('4GB');
    expect(config.DUCKDB_THREADS).toBe(Math.min(4, availableParallelism()));
    expect(config.DUCKDB_TEMP_DIR).toBe(resolve(dirname(config.DUCKDB_PATH), 'tmp'));
  });

  it.each(['1GB', '2.5MB', '512KB', '3GiB', '512MiB'])('accepts memory limit %s', async (value) => {
    vi.stubEnv('DUCKDB_MEMORY_LIMIT', value);
    vi.stubEnv('INGEST_MEMORY_LIMIT', value);
    const config = await import('./config.js');

    expect(config.DUCKDB_MEMORY_LIMIT).toBe(value);
    expect(config.INGEST_MEMORY_LIMIT).toBe(value);
  });

  it.each(['0GB', '0.0MB', '1', '1 GB', 'NaNGB', '1TB', '-1GB', '512KiB', '1gb', '.5GB', '1GB;SELECT 1', '9'.repeat(400) + 'GB'])(
    'rejects invalid memory limit %s',
    async (value) => {
      vi.stubEnv('DUCKDB_MEMORY_LIMIT', value);
      await expect(import('./config.js')).rejects.toThrow(/DUCKDB_MEMORY_LIMIT/);
    },
  );

  it('validates the ingest limit independently', async () => {
    vi.stubEnv('INGEST_MEMORY_LIMIT', 'invalid');
    await expect(import('./config.js')).rejects.toThrow(/INGEST_MEMORY_LIMIT/);
  });

  it('validates threads and resolves explicit relative paths from the package root', async () => {
    vi.stubEnv('DUCKDB_THREADS', '3');
    vi.stubEnv('DUCKDB_PATH', 'data/custom.duckdb');
    vi.stubEnv('DUCKDB_TEMP_DIR', 'scratch/tmp');
    const config = await import('./config.js');

    expect(config.DUCKDB_THREADS).toBe(3);
    expect(config.DUCKDB_PATH).toMatch(/[\\/]packages[\\/]server[\\/]data[\\/]custom\.duckdb$/);
    expect(config.DUCKDB_TEMP_DIR).toMatch(/[\\/]packages[\\/]server[\\/]scratch[\\/]tmp$/);
  });

  it.each(['0', '-1', '1.5', 'many', '1025'])('rejects invalid thread count %s', async (value) => {
    vi.stubEnv('DUCKDB_THREADS', value);
    await expect(import('./config.js')).rejects.toThrow(/DUCKDB_THREADS/);
  });
});
