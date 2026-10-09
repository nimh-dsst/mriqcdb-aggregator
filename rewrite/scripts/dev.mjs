import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const stateDir = join(root, '.dev');
const windows = process.platform === 'win32';
const servers = {
  api: { port: 8787, path: '/trpc/health', args: ['--filter', '@mriqc/server', 'start'] },
  web: { port: 4300, path: '/', args: ['--filter', '@mriqc/web', 'exec', 'ng', 'serve', '--port', '4300'] },
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const healthTimeoutMs = (name) => name === 'web' ? 180_000 : 90_000;

function tailLines(contents, count = 20) {
  return contents.replace(/\r?\n$/, '').split(/\r?\n/).slice(-count).join('\n');
}

function failure(name, message) {
  const path = join(stateDir, `${name}.log`);
  const tail = tailLines(readFileSync(path, 'utf8'));
  return new Error(`${message}\nLast 20 lines of .dev/${name}.log:\n${tail || '(empty)'}`);
}

function pnpmLaunch(args) {
  const entry = process.env.npm_execpath;
  if (entry && /\.[cm]?js$/i.test(entry)) return { command: process.execPath, args: [entry, ...args] };
  const corepack = process.env.COREPACK_ROOT && join(process.env.COREPACK_ROOT, 'dist', 'pnpm.js');
  if (corepack && existsSync(corepack)) return { command: process.execPath, args: [corepack, ...args] };
  if (windows) return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `pnpm ${args.join(' ')}`] };
  return { command: 'pnpm', args };
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  return result;
}

function csv(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      if (quoted && line[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (line[i] === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else field += line[i];
  }
  fields.push(field);
  return fields;
}

function localPort(address, port) {
  return address?.endsWith(`:${port}`) &&
    /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\]|::|\*):\d+$/i.test(address);
}

function netstatListener(line, port) {
  const parts = line.trim().split(/\s+/);
  return parts[0] === 'TCP' && localPort(parts[1], port) &&
    parts[3] === 'LISTENING' && /^\d+$/.test(parts[4]) ? Number(parts[4]) : null;
}

function listener(port) {
  if (windows) {
    const result = run('netstat', ['-ano']);
    if (result.status !== 0) throw new Error(result.stderr.trim() || 'netstat failed');
    for (const line of result.stdout.split(/\r?\n/)) {
      const pid = netstatListener(line, port);
      if (pid) return pid;
    }
    return null;
  }
  try {
    const lsof = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
    if (lsof.status === 0) return Number(lsof.stdout.trim().split(/\s+/)[0]) || null;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const ss = run('ss', ['-ltnp']);
  if (ss.status !== 0) throw new Error(ss.stderr.trim() || 'lsof and ss failed');
  const line = ss.stdout.split('\n').find((item) => {
    const parts = item.trim().split(/\s+/);
    return parts[0] === 'LISTEN' && localPort(parts[3], port);
  });
  if (line && !/pid=(\d+)/.test(line)) throw new Error(`Port ${port} is listening, but ss cannot show its PID`);
  return Number(line?.match(/pid=(\d+)/)?.[1]) || null;
}

function rss(pid) {
  if (!pid) return '-';
  if (windows) {
    const result = run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    if (result.status !== 0) return '?';
    const line = result.stdout.split(/\r?\n/).find((item) => csv(item)[1] === String(pid));
    const kb = Number(csv(line || '')[4]?.replace(/[^\d]/g, ''));
    return kb ? `${Math.round(kb / 1024)} MiB` : '?';
  }
  const result = run('ps', ['-o', 'rss=', '-p', String(pid)]);
  const kb = Number(result.stdout.trim());
  return kb ? `${Math.round(kb / 1024)} MiB` : '?';
}

function recorded(name) {
  try { return Number(readFileSync(join(stateDir, `${name}.pid`), 'utf8').trim()) || null; }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function healthy(name) {
  const server = servers[name];
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    try {
      const response = await fetch(`http://${host}:${server.port}${server.path}`, {
        signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) continue;
      if (name === 'api' && (await response.json()).result?.data?.ok !== true) continue;
      return true;
    } catch { /* Try the next loopback address. */ }
  }
  return false;
}

function processAgeSeconds(created) {
  if (!/^\d{14}/.test(created)) return null;
  const started = new Date(Number(created.slice(0, 4)), Number(created.slice(4, 6)) - 1,
    Number(created.slice(6, 8)), Number(created.slice(8, 10)),
    Number(created.slice(10, 12)), Number(created.slice(12, 14)));
  return (Date.now() - started.getTime()) / 1000;
}

function processes() {
  if (windows) {
    const result = run('wmic', ['process', 'get', 'CommandLine,CreationDate,Name,ParentProcessId,ProcessId', '/FORMAT:CSV']);
    if (result.status !== 0) throw new Error(result.stderr.trim() || 'wmic failed');
    return result.stdout.split(/[\r\n]+/).map(csv).filter((row) => /^\d+$/.test(row.at(-1)))
      .map((row) => ({ pid: Number(row.at(-1)), ppid: Number(row.at(-2)),
        name: row.at(-3), command: row[1], ageSeconds: processAgeSeconds(row[2]) }));
  }
  const result = run('ps', ['-eo', 'pid=,ppid=,etimes=,comm=,args=']);
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'ps failed');
  return result.stdout.split('\n').map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/))
    .filter(Boolean).map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]),
      ageSeconds: Number(match[3]), name: match[4], command: match[5] }));
}

function isAncestor(ancestor, pid, byPid) {
  const seen = new Set();
  while (pid && !seen.has(pid)) {
    if (pid === ancestor) return true;
    seen.add(pid);
    pid = byPid.get(pid)?.ppid;
  }
  return false;
}

function serverCommand(command) {
  if (!command) return false;
  const match = command.match(/^\s*("[^"]+"|\S+)\s+("[^"]+"|\S+)(.*)$/);
  if (!match || !/(?:^|[\\/])node(?:\.exe)?$/i.test(match[1].replace(/^"|"$/g, ''))) return false;
  const script = match[2].replace(/^"|"$/g, '');
  if (/(?:^|[\\/])ng\.js$/i.test(script)) return /^\s+serve(?:\s|$)/i.test(match[3]);
  if (/[\\/]dist[\\/]index\.js$/i.test(script)) return true;
  return /(?:^|[\\/])pnpm\.[cm]?js$/i.test(script) && /\bstart\b/i.test(match[3]);
}

function classifyStrays(all, listeners, known) {
  const byPid = new Map(all.map((process) => [process.pid, process]));
  return all.filter(({ pid, name, command, ageSeconds }) =>
    /^(node|node\.exe)$/i.test(name) && ageSeconds >= 120 && !known.has(pid) &&
    !listeners.some((listenerPid) => isAncestor(pid, listenerPid, byPid) ||
      isAncestor(listenerPid, pid, byPid)) && serverCommand(command));
}

function strays(live) {
  const known = new Set(Object.keys(servers).map(recorded).filter(Boolean));
  return classifyStrays(processes(), Object.values(live).filter(Boolean), known);
}

async function status(names) {
  const live = Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, listener(server.port)]));
  for (const name of names) {
    const { port } = servers[name];
    const pid = live[name];
    let saved = recorded(name);
    if (pid && saved !== pid) {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, `${name}.pid`), `${pid}\n`);
      console.log(`${name}: adopted listening PID ${pid} into .dev/${name}.pid`);
      saved = pid;
    }
    const health = pid ? (await healthy(name) ? 'healthy' : 'unhealthy') : 'down';
    console.log(`${name} :${port} ${pid ? `LISTENING PID ${pid}` : 'not listening'} RSS ${rss(pid)} pidfile ${saved ?? '-'} ${pid ? (saved === pid ? 'match' : 'mismatch') : '-'} health ${health}`);
  }
  const others = strays(live);
  console.log(others.length ? `strays: ${others.map(({ pid }) => pid).join(', ')}` : 'strays: none');
  return others;
}

function kill(pid) {
  const result = windows ? run('taskkill', ['/PID', String(pid), '/F']) : run('kill', [String(pid)]);
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `Could not kill PID ${pid}`);
}

function killLaunch(pid) {
  if (!pid) return;
  if (windows) run('taskkill', ['/PID', String(pid), '/T', '/F']);
  else {
    try { process.kill(-pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

async function stop(name) {
  const { port } = servers[name];
  const pid = listener(port);
  if (pid) {
    console.log(`Stopping ${name} listening PID ${pid}`);
    kill(pid);
  }
  rmSync(join(stateDir, `${name}.pid`), { force: true });
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!listener(port)) {
      console.log(`${name} :${port} stopped`);
      return;
    }
    await sleep(500);
  }
  throw new Error(`${name} :${port} is still listening`);
}

async function start(name, fresh = false) {
  const server = servers[name];
  if (listener(server.port)) {
    await status([name]);
    throw new Error(`${name} port ${server.port} is occupied; use pnpm dev restart ${name}`);
  }
  if (name === 'web' && fresh) {
    rmSync(join(root, 'packages', 'web', '.angular', 'cache'), { recursive: true, force: true });
  }
  mkdirSync(stateDir, { recursive: true });
  const log = openSync(join(stateDir, `${name}.log`), 'a');
  let child;
  let launchError;
  let exitCode;
  try {
    const launch = pnpmLaunch(server.args);
    child = spawn(launch.command, launch.args, {
      cwd: root, env: { ...process.env, NG_CLI_ANALYTICS: 'false', CI: '1' },
      detached: true, windowsHide: true,
      stdio: ['ignore', log, log],
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
  } catch (error) {
    throw failure(name, `${name} launch failed: ${error.message}`);
  } finally { closeSync(log); }
  child.on('error', (error) => { launchError = error; });
  child.on('exit', (code) => { exitCode = code; });
  child.unref();
  writeFileSync(join(stateDir, `${name}.pid`), `${child.pid}\n`);
  const timeout = healthTimeoutMs(name);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const pid = listener(server.port);
    if (pid && await healthy(name)) {
      writeFileSync(join(stateDir, `${name}.pid`), `${pid}\n`);
      console.log(`${name} healthy at http://127.0.0.1:${server.port}/ (PID ${pid})`);
      return;
    }
    if (launchError || exitCode !== undefined) {
      rmSync(join(stateDir, `${name}.pid`), { force: true });
      if (exitCode === undefined) killLaunch(child.pid);
      throw failure(name, `${name} launch exited (${launchError?.message || exitCode})`);
    }
    await sleep(1000);
  }
  rmSync(join(stateDir, `${name}.pid`), { force: true });
  killLaunch(child.pid);
  throw failure(name, `${name} did not become healthy within ${timeout / 1000} s`);
}

function usage() {
  throw new Error('Usage: pnpm dev <status|start|stop|restart> [api|web] [--fresh|--build], or pnpm dev kill-strays');
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!['status', 'start', 'stop', 'restart', 'kill-strays'].includes(command)) usage();
  if (command === 'kill-strays') {
    if (args.length) usage();
    const others = await status(Object.keys(servers));
    for (const { pid } of others) {
      const live = Object.fromEntries(Object.entries(servers).map(([name, server]) => [name, listener(server.port)]));
      if (!strays(live).some((process) => process.pid === pid)) continue;
      console.log(`Killing stray PID ${pid}`);
      kill(pid);
    }
    return;
  }
  const names = args.filter((arg) => !arg.startsWith('--'));
  if (names.length > 1 || (names.length && !servers[names[0]])) usage();
  const selected = names.length ? names : Object.keys(servers);
  const flags = args.filter((arg) => arg.startsWith('--'));
  if (flags.some((flag) => !['--fresh', '--build'].includes(flag)) ||
      (flags.includes('--fresh') && (!['start', 'restart'].includes(command) || !selected.includes('web'))) ||
      (flags.includes('--build') && (command !== 'restart' || selected.join() !== 'api'))) usage();
  if (command === 'status') return status(selected);
  if (command === 'start' || command === 'restart') {
    if (command === 'start' && selected.some((name) => listener(servers[name].port))) {
      await status(selected);
      throw new Error(`Port already occupied; use pnpm dev restart [api|web]`);
    }
    if (flags.includes('--build')) {
      console.log('Building API...');
      const result = spawnSync(windows ? process.env.ComSpec || 'cmd.exe' : 'pnpm',
        windows ? ['/d', '/s', '/c', 'pnpm --filter @mriqc/server build'] : ['--filter', '@mriqc/server', 'build'], {
        cwd: root, env: process.env, stdio: 'inherit',
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(`API build failed (${result.status})`);
    }
  }
  if (command === 'stop' || command === 'restart') for (const name of selected) await stop(name);
  if (command === 'start' || command === 'restart') for (const name of selected) await start(name, flags.includes('--fresh'));
}

if (process.argv[2] === '--test-helpers') {
  const { default: assert } = await import('node:assert/strict');
  const { test } = await import('node:test');

  test('netstat listener parser accepts IPv4 and IPv6 loopback and wildcard addresses', () => {
    for (const address of ['0.0.0.0', '127.0.0.1', '[::]', '[::1]']) {
      assert.equal(netstatListener(`  TCP    ${address}:4300    [::]:0    LISTENING    42856`, 4300), 42856);
    }
    assert.equal(netstatListener('TCP [::1]:4300 [::]:0 TIME_WAIT 42856', 4300), null);
    assert.equal(netstatListener('TCP [::1]:4301 [::]:0 LISTENING 42856', 4300), null);
    assert.equal(localPort(':::4300', 4300), true);
  });

  test('strays exclude listeners, their ancestors and descendants, and young processes', () => {
    const process = (pid, ppid, command, ageSeconds = 121, name = 'node.exe') =>
      ({ pid, ppid, command, ageSeconds, name });
    const all = [
      process(80, 1, 'cmd.exe', 121, 'cmd.exe'),
      process(95, 90, 'cmd.exe', 121, 'cmd.exe'),
      process(105, 100, 'cmd.exe', 121, 'cmd.exe'),
      process(90, 80, 'node pnpm.js --filter @mriqc/server start'),
      process(100, 95, 'node dist/index.js'),
      process(110, 105, 'node dist/index.js'),
      process(91, 90, 'node pnpm.js --filter @mriqc/server start'),
      process(190, 1, 'node pnpm.js --filter @mriqc/web exec ng serve'),
      process(200, 190, 'node ng.js serve'),
      process(300, 1, 'node ng.js serve'),
      process(301, 1, 'node ng.js serve', 119),
      process(302, 1, 'node ng.js serve', 120),
      process(400, 1, 'node ng.js serve', 121, 'cmd.exe'),
      process(500, 1, 'node dist/index.js'),
      process(600, 1, 'node codex.js exec "fix pnpm dev start web"'),
    ];
    assert.deepEqual(classifyStrays(all, [100, 200], new Set([500])).map(({ pid }) => pid), [91, 300, 302]);
    assert.deepEqual(classifyStrays(all, [100, 200, 300, 302], new Set([500])).map(({ pid }) => pid), [91]);
  });

  test('log tail returns the last 20 lines with Windows line endings', () => {
    const lines = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`);
    assert.equal(tailLines(`${lines.join('\r\n')}\r\n`), lines.slice(-20).join('\n'));
    assert.equal(tailLines(''), '');
  });

  test('web has a 180 second health timeout', () => {
    assert.equal(healthTimeoutMs('web'), 180_000);
    assert.equal(healthTimeoutMs('api'), 90_000);
  });
} else {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
