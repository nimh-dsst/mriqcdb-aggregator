// Existing servers only. Usage: pnpm exec node packages/web/e2e/study-flows.spec.mjs <playwright index.mjs> <chrome.exe>
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const browser = await chromium.launch({ headless: true, executablePath: process.argv[3] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
// Keep this browser's loaded code stable while other lanes edit the hot-reload
// workspace. Servers continue running and all API requests remain live.
let deferredHotReloads = 0;
await page.routeWebSocket(url => url.hostname === 'localhost' && url.port === '4300', socket => {
  const server = socket.connectToServer();
  server.onMessage(message => {
    if (typeof message === 'string') {
      try {
        if (['update', 'full-reload'].includes(JSON.parse(message).type)) { deferredHotReloads++; return; }
      } catch { /* Non-JSON messages are forwarded unchanged. */ }
    }
    socket.send(message);
  });
});
page.setDefaultTimeout(45000);
const directory = 'scratchpad/e2e/heuristics';
await mkdir(directory, { recursive: true });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const fixture = await readFile('packages/web/src/app/study/fixtures/bold-300.csv', 'utf8');
const card = () => page.locator('[data-panel-id="p1"]');
const snapshot = () => card().evaluate(el => window.ng.getComponent(el.closest('app-panel-card')).view());
const ready = async () => {
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-panel-id="p1"]');
    const view = el && window.ng?.getComponent(el.closest('app-panel-card'))?.view();
    if (!(view?.status.kind === 'ready' && !view.status.stale && !view.partial && view.hasRows)) return false;
    if (view.table) return true;
    const component = window.ng.getComponent(el.closest('app-panel-card'));
    const host = el.querySelector('.chart-box');
    const renderer = host && window.ng.getDirectives(host).find(d => d.appVegaView);
    return !!renderer?.view && renderer.renderedSpecKey === component.vegaInput()?.specKey &&
      renderer.updating === 0 && renderer.resizeFrame === null && !!host.querySelector('canvas');
  }, null, { timeout: 45000 });
};
const capture = async name => {
  await card().scrollIntoViewIfNeeded();
  if (name !== 'missing-upload-time') {
    await page.locator('.cdk-overlay-pane [role="listbox"]').waitFor({ state: 'hidden' });
    await ready();
  }
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const pixels = await card().evaluate(el => {
    const canvas = el.querySelector('.chart-box canvas');
    if (!canvas) return null;
    const rgba = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let index = 3; index < rgba.length; index += 4) if (rgba[index]) painted++;
    return painted;
  });
  if (pixels !== null) assert.ok(pixels > 100, `${name} canvas is empty`);
  if (name === 'matrix') {
    const sizes = await card().evaluate(el => {
      const host = el.querySelector('.chart-box');
      const renderer = window.ng.getDirectives(host).find(d => d.appVegaView);
      const sizes = [];
      const visit = node => {
        if (node.mark?.marktype === 'rect' && node.datum?.value !== undefined) sizes.push([node.width, node.height]);
        node.items?.forEach(visit);
      };
      visit(renderer.view.scenegraph().root);
      return sizes;
    });
    assert.ok(sizes.length > 0 && sizes.every(([width, height]) => width > 10 && height > 10), 'Matrix cells must have visible area');
  }
  await page.screenshot({ path: `${directory}/codex-laneU-${name}.png` });
};
const quantity = async (x, y = null) => {
  await card().getByTestId('metric-title').click();
  const drawer = page.getByRole('dialog', { name: 'Choose column', exact: true });
  await drawer.getByRole('combobox', { name: 'X slot', exact: true }).waitFor();
  if (await drawer.getByRole('button', { name: 'Clear Y slot', exact: true }).count()) {
    await drawer.getByRole('button', { name: 'Clear Y slot', exact: true }).click();
  }
  await drawer.getByRole('combobox', { name: 'X slot', exact: true }).click();
  await drawer.locator(`[data-option-id="${x}"]`).click();
  if (y) {
    await drawer.getByRole('combobox', { name: 'Y slot (optional)', exact: true }).click();
    await drawer.locator(`[data-option-id="${y}"]`).click();
  } else if (await drawer.getByRole('button', { name: 'Clear Y slot', exact: true }).count()) {
    await drawer.getByRole('button', { name: 'Clear Y slot', exact: true }).click();
  }
  await drawer.getByRole('button', { name: 'Apply', exact: true }).click();
  await ready();
  const selected = (await snapshot()).panel;
  assert.equal(selected.x, x);
  assert.equal(selected.y, y);
};
const changeForm = async name => {
  await card().getByRole('combobox', { name: 'Form', exact: true }).click();
  await page.getByRole('option', { name: new RegExp(`^${name}\\b`) }).click();
  await ready();
};
const upload = async (name, data, addToAll = false) => {
  await page.getByTestId('study-open').click();
  assert.equal(await page.getByRole('checkbox', { name: 'Add my study to all cards' }).isChecked(), true);
  if (!addToAll) await page.getByRole('checkbox', { name: 'Add my study to all cards' }).uncheck();
  await page.getByTestId('study-file').setInputFiles({ name, mimeType: name.endsWith('.zip') ? 'application/zip' : 'text/plain', buffer: Buffer.from(data) });
  await page.getByTestId('study-ready').waitFor({ timeout: 90000 });
  assert.match(await page.getByTestId('study-ready').innerText(), /300 scans/);
};
const queryRunner = async () => page.evaluate(async () => {
  const runner = window.ng.getComponent(document.querySelector('app-top-bar')).graph.studyApi;
  const run = observable => new Promise((resolve, reject) => observable.subscribe({ next: resolve, error: reject }));
  const scope = { source: 'study', modality: 'bold', view: 'raw', filters: [] };
  const distribution = await run(runner.distribution({ ...scope, proc: 'distribution', metric: 'fd_mean', bins: 30, clip: 'none' }));
  const density = await run(runner.density2d({ ...scope, proc: 'density2d', x: 'fd_mean', y: 'tsnr', bins: 20, clip: 'none', sampleSize: 300, seed: 42 }));
  const band = await run(runner.binnedSummary({ ...scope, proc: 'binnedSummary', x: 'fd_mean', y: 'tsnr', bins: 10, range: [distribution.min, distribution.max] }));
  const matrix = await run(runner.correlation({ ...scope, proc: 'correlation', metrics: ['fd_mean', 'tsnr'], method: 'both' }));
  const rows = []; let cursor = null; let pages = 0;
  do {
    const result = await run(runner.sample({ ...scope, proc: 'sample', columns: ['bids_name', 'fd_mean'], cursor }));
    rows.push(...result.rows); cursor = result.nextCursor; pages++;
  } while (cursor && pages < 5);
  return { n: distribution.n, densityN: density.n, gridN: density.counts.reduce((a,b) => a+b, 0), points: density.sample.length,
    bandN: band.buckets.reduce((a,b) => a+b.n, 0), matrixN: matrix.minPairN, rows: rows.length, ids: new Set(rows.map(row => row.id)).size,
    uploadDates: rows.filter(row => row.created_at !== null).length, pages };
});

// A deterministic stored ZIP, with real CRCs, for the per-scan JSON upload path.
function zipJson(rows) {
  const locals = [], central = []; let offset = 0;
  for (let i = 0; i < rows.length; i++) {
    const name = Buffer.from(`scan-${i}.json`), data = Buffer.from(JSON.stringify(rows[i]));
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(header, name, data); central.push(entry, name); offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(rows.length, 8); end.writeUInt16LE(rows.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

try {
  await page.goto('http://localhost:4300');
  console.log('Opened live dashboard');
  await ready();
  await upload('bold-300.csv', fixture);
  console.log('Uploaded 300-row CSV');
  assert.match(await page.getByTestId('study-ready').innerText(), /fd_mean/);
  await page.getByTestId('study-mapping').locator('summary').click();
  await page.screenshot({ path: `${directory}/codex-laneU-upload-mapping.png` });
  await page.getByTestId('study-close').click();
  await card().getByRole('button', { name: 'Add comparison', exact: true }).click();
  await page.getByRole('menuitem', { name: 'My study', exact: true }).click();
  await ready();
  const forms = {};
  for (const form of ['Histogram', 'Density', 'ECDF', 'Line', 'Area', 'Box', 'Table']) {
    await changeForm(form);
    const view = await snapshot();
    const study = view.comparison?.rows.find(row => row.id === 'study');
    assert.ok(study, `study stats missing for ${form}`);
    assert.equal(view.cohorts.find(cohort => cohort.id === 'study').n, 300);
    if (form === 'Table') assert.ok(view.table.rows.some(row => row.__series === 'My study'));
    forms[form] = { studyN: 300, differences: view.comparison };
    console.log(`Verified ${form}`);
    await capture(form.toLowerCase());
  }
  const wasm = await queryRunner();
  assert.deepEqual(wasm, { n: 300, densityN: 300, gridN: 300, points: 300, bandN: 300, matrixN: 300, rows: 300, ids: 300, uploadDates: 0, pages: 3 });
  await quantity('created_at');
  await changeForm('Histogram');
  await card().getByRole('button', { name: 'Add comparison', exact: true }).click();
  const missingTime = page.getByRole('menuitem', { name: /My study/ });
  assert.equal(await missingTime.isDisabled(), true);
  assert.match(await missingTime.innerText(), /your file has no upload time/);
  await capture('missing-upload-time');
  await page.keyboard.press('Escape');

  await quantity('tsnr', 'fd_mean');
  await changeForm('Heatmap');
  assert.ok((await snapshot()).cohorts.some(cohort => cohort.id === 'study' && cohort.n === 300));
  assert.ok((await snapshot()).datasets['density-contours'].some(row => row.seriesId === 'study'));
  await capture('heatmap-contours');
  for (const form of ['Scatter', 'Hexbin', 'Clusters', 'Band', 'Lines']) {
    await changeForm(form);
    assert.ok((await snapshot()).cohorts.some(cohort => cohort.id === 'study'));
    await capture(form.toLowerCase());
  }
  await card().getByTestId('metric-title').click();
  await page.getByRole('button', { name: 'Metric correlations', exact: true }).click();
  await page.getByRole('combobox', { name: 'Metric set', exact: true }).click();
  await page.getByRole('option', { name: 'Temporal SNR', exact: true }).click();
  await page.getByRole('option', { name: 'Mean framewise displacement', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Create matrix', exact: true }).click();
  await ready();
  assert.ok((await snapshot()).cohorts.some(cohort => cohort.id === 'study'));
  await capture('matrix');
  const sharedLink = page.url();
  await card().getByRole('button', { name: 'Remove comparison My study', exact: true }).click();
  await ready();
  assert.ok(!(await snapshot()).panel.series.some(series => series.kind === 'study'));
  await page.goto(sharedLink);
  await ready();
  assert.match(await page.locator('body').innerText(), /study that is not in the link/);
  assert.equal(await page.getByTestId('study-status').count(), 0);
  await capture('link-notice');

  // A dated/category variant keeps all 300 metric rows, including ten unknown
  // dates and 100 unknown categories. These must remain in Table/category counts.
  const lines = fixture.trim().split(/\r?\n/);
  const dated = [lines[0] + ',_created,bids_meta.Manufacturer,unmatched_column', ...lines.slice(1).map((line, i) =>
    line + `,${i < 10 ? '' : i % 2 ? '2024-01-15' : '2024-02-15'},${['Siemens', 'GE', ''][i % 3]},ignored`)].join('\n');
  await upload('dated-300.tsv', dated.replaceAll(',', '\t'), true);
  assert.match(await page.getByTestId('study-mapping').textContent(), /_created → created_at/);
  assert.match(await page.getByTestId('study-ignored').textContent(), /unmatched_column/);
  await page.getByTestId('study-close').click();
  const counts = await page.evaluate(async () => {
    const runner = window.ng.getComponent(document.querySelector('app-top-bar')).graph.studyApi;
    const run = observable => new Promise((resolve, reject) => observable.subscribe({ next: resolve, error: reject }));
    const scope = { source: 'study', modality: 'bold', view: 'raw', filters: [] };
    const coverage = await run(runner.coverage({ ...scope, proc: 'coverage', group: 'created_at', granularity: 'month' }));
    const category = await run(runner.coverage({ ...scope, proc: 'coverage', group: 'manufacturer', granularity: 'month', countsOnly: true }));
    const grouped = await run(runner.groupedSummary({ ...scope, proc: 'groupedSummary', metric: 'fd_mean', group: 'manufacturer' }));
    const timeBand = await run(runner.binnedSummary({ ...scope, proc: 'binnedSummary', x: 'created_at', y: 'fd_mean', bins: 'month' }));
    const timeDensity = await run(runner.density2d({ ...scope, proc: 'density2d', x: 'created_at', y: 'fd_mean', bins: 20, clip: 'none', sampleSize: 300, seed: 42 }));
    const filtered = await run(runner.coverage({ ...scope, filters: [{ field: 'manufacturer', op: 'in', values: ['Siemens'] }], proc: 'coverage', group: 'manufacturer', granularity: 'month', countsOnly: true }));
    return { coverage: coverage.buckets.reduce((n,b) => n+b.n, 0), category: category.buckets.reduce((n,b) => n+b.n, 0),
      missingCategory: category.buckets.find(b => b.group === null)?.n, grouped: grouped.groups.reduce((n,g) => n+g.n, 0),
      band: timeBand.buckets.reduce((n,b) => n+b.n, 0), density: timeDensity.n, filtered: filtered.buckets.reduce((n,b) => n+b.n, 0) };
  });
  assert.deepEqual(counts, { coverage: 290, category: 300, missingCategory: 100, grouped: 300, band: 290, density: 290, filtered: 100 });
  await quantity('created_at');
  for (const form of ['Histogram', 'Line', 'Area', 'Density', 'ECDF', 'Box', 'Table']) {
    await changeForm(form);
    assert.ok((await snapshot()).cohorts.some(cohort => cohort.id === 'study'));
    await capture(`time-${form.toLowerCase()}`);
  }
  await quantity('created_at', 'fd_mean');
  for (const form of ['Heatmap', 'Scatter', 'Hexbin', 'Clusters', 'Band', 'Lines']) {
    await changeForm(form);
    assert.ok((await snapshot()).cohorts.some(cohort => cohort.id === 'study'));
    await capture(`time-${form.toLowerCase()}`);
  }
  await quantity('manufacturer');
  for (const form of ['Bars', 'Share']) {
    await changeForm(form);
    assert.ok((await snapshot()).cohorts.some(cohort => cohort.id === 'study'));
    await capture(`category-${form.toLowerCase()}`);
  }
  const header = lines[0].split(',');
  const json = lines.slice(1).map(line => Object.fromEntries(line.split(',').map((value, i) => [header[i], i ? Number(value) : value])));
  await upload('bold-300.zip', zipJson(json));
  await page.screenshot({ path: `${directory}/codex-laneU-zip-upload.png` });
  await page.getByTestId('study-close').click();
  assert.deepEqual(await queryRunner(), wasm);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ metricForms: Object.keys(forms), wasm, counts, consoleErrors: errors, deferredHotReloads, screenshots: directory }));
} catch (error) {
  const rendererError = await card().evaluate(async el => {
    const host = el.querySelector('.chart-box');
    const renderer = host && window.ng.getDirectives(host).find(d => d.appVegaView);
    if (!renderer) return null;
    try {
      const embed = await renderer.embed(), input = renderer.appVegaView();
      const result = await embed(document.createElement('div'), { ...input.spec, datasets: input.datasets }, { renderer: 'canvas', actions: false });
      result.finalize();
      return { keyMatched: renderer.renderedSpecKey === input.specKey, updating: renderer.updating };
    } catch (error) { return String(error); }
  }).catch(() => null);
  await page.screenshot({ path: `${directory}/codex-laneU-failure.png` }).catch(() => {});
  console.error(JSON.stringify({ error: String(error), rendererError, consoleErrors: errors, body: (await page.locator('body').innerText()).slice(-7000) }));
  throw error;
} finally {
  await browser.close();
}
