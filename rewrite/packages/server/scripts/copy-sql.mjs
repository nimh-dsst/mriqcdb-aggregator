/**
 * Copy the canonicalization policy SQL into `dist/` after `tsc`.
 *
 * `db/canonical.ts` resolves the policy SQL relative to its own module URL so the
 * same code works under vitest (from `src/`) and from the built output (from
 * `dist/`), but `tsc` only emits `.ts` files, so the `.sql` files have to be
 * copied.
 *
 * Only `src/sql/canonical/`: the five statistics templates are no longer files at
 * all. They live in `@mriqc/shared` as string constants, because the dashboard's
 * DuckDB-WASM runner compiles the same text for an uploaded study and has no
 * filesystem. The policy SQL is server-only -- it builds the database -- and stays
 * a file here.
 */

import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const to = join(packageRoot, 'dist', 'sql', 'canonical');
mkdirSync(to, { recursive: true });
cpSync(join(packageRoot, 'src', 'sql', 'canonical'), to, {
  recursive: true,
  filter: (source) => !source.endsWith('.ts'),
});
