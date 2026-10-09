import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { delimiter, dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

// Run from rewrite/: pnpm dlx --package playwright node packages/web/e2e/lane-q.mjs
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', {
  paths: [process.cwd(), ...process.env.PATH.split(delimiter).map(dirname)],
}));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const responses = [];
page.on('response', async response => {
  if (!response.url().includes('/trpc/')) return;
  try { responses.push({ url: response.url(), body: await response.json() }); } catch {}
});
const screenshots = resolve('scratchpad/e2e/heuristics');
await mkdir(screenshots, { recursive: true });
try {
  await page.goto('http://localhost:4300/', { waitUntil: 'networkidle' });
  const card = page.locator('[data-panel-id="p1"]');
  await card.locator('.vega-axis-band-x').first().waitFor({ state: 'visible', timeout: 60000 });
  const coordinates = await card.locator('.vega-axis-band-x').first().evaluate(band => {
    const host = band.parentElement;
    const directive = window.ng.getDirectives(host).find(item => item.view?.scale);
    const view = directive.view;
    const scale = view.scale('x');
    const rect = band.getBoundingClientRect();
    const start = Math.min(...scale.range());
    return { x1: rect.left + scale(0.1) - start,
      x2: rect.left + scale(0.6) - start, y: rect.top + 12 };
  });
  responses.length = 0;
  await page.mouse.move(coordinates.x1, coordinates.y);
  await page.mouse.down();
  await page.mouse.move(coordinates.x2, coordinates.y, { steps: 15 });
  await page.screenshot({ path: resolve(screenshots, 'codex-laneQ-axis-drag.png') });
  await page.mouse.up();
  await page.waitForTimeout(1500);
  await card.getByRole('button', { name: 'Panel options', exact: true }).click();
  const lo = page.getByRole('spinbutton', { name: 'X minimum', exact: true });
  const hi = page.getByRole('spinbutton', { name: 'X maximum', exact: true });
  const actual = [Number(await lo.inputValue()), Number(await hi.inputValue())];
  assert.deepEqual(actual, [0.1, 0.6]);
  await page.screenshot({ path: resolve(screenshots, 'codex-laneQ-axis-options.png') });
  const ranged = responses.find(response => {
    const input = new URL(response.url).searchParams.get('input');
    return input && input.includes('range') && input.includes('fd_mean');
  });
  assert.ok(ranged, 'The drag must send a new ranged server request');
  const findHistogram = value => {
    if (!value || typeof value !== 'object') return null;
    if (value.histogram?.counts) return value.histogram;
    for (const child of Object.values(value)) { const found = findHistogram(child); if (found) return found; }
    return null;
  };
  const histogram = findHistogram(ranged.body);
  assert.ok(histogram, 'Ranged response must contain histogram bins');
  assert.ok(Math.abs(histogram.lo - actual[0]) < 1e-9);
  assert.ok(Math.abs(histogram.hi - actual[1]) < 1e-9);
  assert.ok(Math.abs(histogram.lo + histogram.width * histogram.counts.length - actual[1]) < 1e-9);
  await page.keyboard.press('Escape');
  await card.locator('.vega-axis-band-x').first().dblclick();
  await page.waitForTimeout(800);
  await card.getByRole('button', { name: 'Panel options', exact: true }).click();
  assert.equal(await lo.inputValue(), '');
  assert.equal(await hi.inputValue(), '');
  await page.keyboard.press('Escape');
  await page.locator('.cdk-overlay-backdrop').waitFor({ state: 'detached' });

  // A plot-area gesture remains a linked brush until Zoom to brush is chosen.
  const plot = await card.locator('.vega-axis-band-x').first().evaluate(band => {
    const view = window.ng.getDirectives(band.parentElement).find(item => item.view?.scale).view;
    const rect = band.getBoundingClientRect();
    return { x1: rect.left + 40, x2: rect.left + 100, y: rect.top - view.height() / 2 };
  });
  await page.mouse.move(plot.x1, plot.y);
  await page.mouse.down();
  await page.mouse.move(plot.x2, plot.y, { steps: 8 });
  await page.mouse.up();
  await page.getByTestId('brush-chip').first().waitFor();
  const brushed = await card.evaluate(element => {
    const component = window.ng.getComponent(element.closest('app-panel-card'));
    return { range: component.state().selections.find(item => item.from === 'p1').range, xRange: component.panel().options.xRange };
  });
  assert.equal(brushed.xRange, 'auto');
  await page.getByRole('button', { name: 'Zoom to brush', exact: true }).first().click();
  assert.equal(await page.getByTestId('brush-chip').count(), 0);
  await card.getByRole('button', { name: 'Panel options', exact: true }).click();
  assert.deepEqual([Number(await lo.inputValue()), Number(await hi.inputValue())], brushed.range);
  await page.getByRole('menuitem', { name: 'Reset axes', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  const yCoordinates = await card.locator('.vega-axis-band-y').first().evaluate(band => {
    const view = window.ng.getDirectives(band.parentElement).find(item => item.view?.scale).view;
    const rect = band.getBoundingClientRect();
    return { x: rect.left + 12, y1: rect.top + view.scale('y')(10000), y2: rect.top + view.scale('y')(100000) };
  });
  await page.mouse.move(yCoordinates.x, yCoordinates.y1);
  await page.mouse.down();
  await page.mouse.move(yCoordinates.x, yCoordinates.y2, { steps: 8 });
  await page.mouse.up();
  await card.getByRole('button', { name: 'Panel options', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: 'Y mode', exact: true }).inputValue(), 'count');
  assert.deepEqual([Number(await page.getByRole('spinbutton', { name: 'Y minimum', exact: true }).inputValue()),
    Number(await page.getByRole('spinbutton', { name: 'Y maximum', exact: true }).inputValue())], [10000, 100000]);
  await page.getByRole('menuitem', { name: 'Reset axes', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByTestId('add-panel').click();
  const drawer = page.getByTestId('add-panel-picker');
  await drawer.getByText('Or pick the columns yourself').click();
  await drawer.locator('[data-column-id="fd_mean"]').click();
  await drawer.locator('[data-column-id="tsnr"]').click();
  await page.screenshot({ path: resolve(screenshots, 'codex-laneQ-drawer-pair.png') });
  await drawer.getByRole('button', { name: 'Create panel', exact: true }).click();
  const pair = page.locator('[data-panel-id="p6"]');
  await pair.getByTestId('metric-title').waitFor();
  assert.match(await pair.getByTestId('metric-title').innerText(), /tSNR vs FD mean/);
  await pair.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: resolve(screenshots, 'codex-laneQ-created-pair.png') });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ range: actual, bins: { lo: histogram.lo, hi: histogram.hi, count: histogram.counts.length }, consoleErrors: errors.length, screenshots }, null, 2));
} finally {
  await browser.close();
}
