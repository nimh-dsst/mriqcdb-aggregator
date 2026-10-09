#!/usr/bin/env node
/**
 * A stand-in for `mongoexport`, so the dump tool can be tested end to end with
 * no MongoDB and no Mongo tools installed.
 *
 * It accepts the flags `mongoexport` accepts, reads its records from the JSON
 * file named by `FAKE_MONGOEXPORT_DATA` (an object keyed by collection), honours
 * `--query` for the one filter shape the tool ever builds
 * (`{"_updated":{"$gt":{"$date":...}}}`), and writes a `--jsonArray` file.
 *
 * `FAKE_MONGOEXPORT_FAIL=1` makes it exit non-zero instead, so the failure path
 * is covered too.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
/** @type {Record<string, string>} */
const flags = {};
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (!arg.startsWith('--')) continue;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) flags[arg] = 'true';
  else {
    flags[arg] = next;
    i += 1;
  }
}

if (process.env.FAKE_MONGOEXPORT_FAIL === '1') {
  process.stderr.write('fake mongoexport: refusing on purpose\n');
  process.exit(3);
}

const dataPath = process.env.FAKE_MONGOEXPORT_DATA;
if (dataPath === undefined) {
  process.stderr.write('fake mongoexport: FAKE_MONGOEXPORT_DATA is not set\n');
  process.exit(2);
}
const all = JSON.parse(readFileSync(dataPath, 'utf8'));
const collection = flags['--collection'];
let records = Array.isArray(all[collection]) ? all[collection] : [];

if (flags['--query'] !== undefined) {
  const query = JSON.parse(flags['--query']);
  const since = query?._updated?.$gt?.$date;
  if (typeof since === 'string') {
    const cut = Date.parse(since);
    records = records.filter((record) => {
      const value = record?._updated?.$date ?? record?._updated;
      return typeof value === 'string' && Date.parse(value) > cut;
    });
  }
}

if (flags['--jsonArray'] === undefined) {
  process.stderr.write('fake mongoexport: this stand-in only writes --jsonArray\n');
  process.exit(2);
}
writeFileSync(flags['--out'], `${JSON.stringify(records, null, 2)}\n`);
process.stderr.write(`fake mongoexport: exported ${records.length} record(s)\n`);
