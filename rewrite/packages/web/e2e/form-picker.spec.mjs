// Uses the existing API and dev server; never starts or stops either.
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const browser = await chromium.launch({ headless: true, executablePath: process.argv[3] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
// Optional fresh frontend bundle, while /trpc still reaches the existing API.
if (process.argv[4]) {
  const root = resolve(process.argv[4]);
  await page.route('http://localhost:4300/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith('/trpc') || pathname.startsWith('/export')) return route.continue();
    const file = resolve(root, pathname === '/' ? 'index.html' : pathname.slice(1));
    if (!file.startsWith(root + sep) || !(await stat(file).catch(() => null))?.isFile()) return route.continue();
    const contentType = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'application/octet-stream';
    return route.fulfill({ status: 200, contentType, body: await readFile(file) });
  });
}
page.setDefaultTimeout(45000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const visible = ['Histogram', 'Line', 'Area', 'Density', 'ECDF', 'Box', 'Table', 'Heatmap', 'Scatter', 'Hexbin', 'Clusters', 'Band', 'Lines'];
const screenshot = join(tmpdir(), 'codex-laneP-picker.png');

try {
  await page.goto('http://localhost:4300');
  const card = page.locator('[data-panel-id="p1"]');
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-panel-id="p1"]');
    const view = el && window.ng?.getComponent(el.closest('app-panel-card'))?.view();
    return view?.status.kind === 'ready' && !view.status.stale && view.hasRows;
  }, undefined, { timeout: 90000 });
  const picker = card.getByRole('combobox', { name: 'Form', exact: true });
  await picker.click();
  const rows = page.locator('.form-picker-panel mat-option');
  assert.equal(await rows.count(), 13);
  for (let index = 0; index < visible.length; index++) {
    const row = rows.nth(index);
    assert.ok((await row.innerText()).startsWith(visible[index]));
    assert.equal(await row.getAttribute('aria-disabled'), String(index >= 7));
    if (index >= 7) {
      assert.match(await row.getAttribute('aria-label'), /add a second metric/);
      assert.equal(await row.locator('.form-option-hint').innerText(), 'add a second metric');
    }
  }
  for (const name of ['Bars', 'Share', 'Matrix']) assert.equal(await page.getByRole('option', { name: new RegExp(`^${name}:`) }).count(), 0);
  const heatmap = page.getByRole('option', { name: 'Heatmap: add a second metric', exact: true });
  const before = await card.getAttribute('data-panel-form');
  await heatmap.locator('.font-medium').click({ force: true });
  assert.equal(await card.getAttribute('data-panel-form'), before);
  await page.screenshot({ path: screenshot });
  // Disabled rows remain in keyboard navigation and expose their state/reason.
  await picker.focus();
  await page.keyboard.press('Home');
  for (let i = 0; i < 7; i++) await page.keyboard.press('ArrowDown');
  await page.waitForFunction(id => document.querySelector('[data-panel-id="p1"] [aria-label="Form"]')?.getAttribute('aria-activedescendant') === id, await heatmap.getAttribute('id'));
  await page.keyboard.press('Enter');
  assert.equal(await card.getAttribute('data-panel-form'), before);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'add a second metric');
  await page.keyboard.press('Enter');
  const y = page.locator('.column-drawer select');
  await y.waitFor({ timeout: 10000 });
  assert.equal(await y.evaluate(el => el === document.activeElement), true);
  assert.equal(await card.getAttribute('data-panel-form'), before);
  await page.locator('.form-picker-panel').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Close column drawer', exact: true }).click();
  await picker.click();
  await page.getByRole('option', { name: /^Density:/ }).click();
  await page.waitForFunction(() => document.querySelector('[data-panel-id="p1"]')?.getAttribute('data-panel-form') === 'density');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ enabled: 7, disabled: 6, hidden: ['Bars', 'Share', 'Matrix'], keyboardReasonLink: 'focused y select', enabledSelection: 'density', screenshot, consoleErrors: errors }));
} catch (error) {
  console.error(JSON.stringify({ error: String(error), consoleErrors: errors, state: await page.locator('[data-panel-id="p1"]').evaluate(el => { const c = window.ng.getComponent(el.closest('app-panel-card')); return { open: c.columnPickerOpen(), focusY: c.focusSecondMetric(), focus: document.activeElement?.outerHTML.slice(0, 300), attach: c.attachFormLinks?.toString().slice(0, 250) }; }), body: (await page.locator('body').innerText()).slice(-4000) }));
  throw error;
} finally {
  await browser.close();
}
