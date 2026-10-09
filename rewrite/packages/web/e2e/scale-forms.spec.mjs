// Uses the existing API and dev server; never starts or stops either.
import assert from 'node:assert/strict';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve, sep } from 'node:path';

const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const browser = await chromium.launch({ headless: true, executablePath: process.argv[3] });
const directory = 'scratchpad/e2e/heuristics';
await mkdir(directory, { recursive: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
// Optional fresh development bundle when the long-running dev compiler still
// caches an earlier shared contract. Only static assets are served locally;
// every /trpc request goes through the existing server to the live API.
if (process.argv[4]) {
  const root = resolve(process.argv[4]);
  await page.route('http://localhost:4300/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/trpc') || pathname.startsWith('/export')) return route.continue();
    const file = resolve(root, pathname === '/' ? 'index.html' : pathname.slice(1));
    if (!file.startsWith(root + sep)) return route.continue();
    if (!(await stat(file).catch(() => null))?.isFile()) return route.continue();
    const contentType = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream';
    return route.fulfill({ status:200, contentType, body:await readFile(file) });
  });
}
page.setDefaultTimeout(45000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const ready = async (id, form) => {
  await page.waitForFunction(({id, form}) => {
    const el = document.querySelector(`[data-panel-id="${id}"]`);
    const view = el && window.ng?.getComponent(el.closest('app-panel-card'))?.view();
    return view?.status.kind === 'ready' && !view.status.stale && view.hasRows && (!form || view.panel.form === form.toLowerCase());
  }, {id, form}, { timeout: 90000 });
  await page.locator(`[data-panel-id="${id}"] canvas`).waitFor();
};
const changeForm = async (id, name) => {
  const card = page.locator(`[data-panel-id="${id}"]`);
  await card.getByRole('combobox', { name: 'Form', exact: true }).click();
  await page.getByRole('option', { name: new RegExp(name) }).click();
  await ready(id, name);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};
const capture = async (id, name) => {
  const card = page.locator(`[data-panel-id="${id}"]`);
  await card.scrollIntoViewIfNeeded();
  await card.screenshot({ path: `${directory}/codex-laneW-${name}.png` });
};
try {
  await page.goto('http://localhost:4300');
  await ready('p5');
  const results = {};
  for (const form of ['Histogram', 'Density', 'ECDF', 'Box']) {
    await changeForm('p5', form);
    results[form] = await page.locator('[data-panel-id="p5"]').evaluate(el => {
      const component = window.ng.getComponent(el.closest('app-panel-card'));
      const view = component.view();
      return { form: component.panel().form, title: view.title, n: view.n,
        rows: Object.values(view.datasets).flat(), temporal: JSON.stringify(view.spec).includes('"type":"temporal"') };
    });
    assert.equal(results[form].title, 'Uploads over time');
    assert.equal(results[form].temporal, true);
    assert.ok(results[form].rows.length);
    if (form === 'ECDF') {
      console.log(JSON.stringify({ form, first: results[form].rows[0], last: results[form].rows.at(-1) }));
      assert.equal(results[form].rows.filter(row => typeof row.p === 'number').at(-1)?.p, 1);
    }
    if (form === 'Box') assert.equal(results[form].rows.find(row => 'p50' in row).note, 'from monthly counts');
    await capture('p5', form.toLowerCase());
  }
  const fd = page.locator('[data-panel-id="p1"]');
  await fd.locator('[data-testid="metric-title"]').click();
  const y = page.locator('.column-drawer select');
  await y.selectOption('tsnr');
  await page.getByRole('button', { name: 'Close column drawer', exact: true }).click();
  await changeForm('p1', 'Band');
  const band = await fd.evaluate(el => {
    const component = window.ng.getComponent(el.closest('app-panel-card'));
    return { panel: component.panel(), rows: component.view().datasets['binnedSummary'] };
  });
  assert.equal(band.panel.x, 'fd_mean');
  assert.equal(band.panel.y, 'tsnr');
  assert.ok(band.rows.length);
  await capture('p1', 'numeric-band');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ forms: Object.fromEntries(Object.entries(results).map(([key, value]) => [key, { n: value.n, rows: value.rows.length }])), cumulativeShare: 1, numericBandBuckets: band.rows.length, consoleErrors: errors }));
} catch (error) {
  console.error(JSON.stringify({ error: String(error), consoleErrors: errors, body: (await page.locator('body').innerText()).slice(-6000) }));
  throw error;
} finally {
  await browser.close();
}
