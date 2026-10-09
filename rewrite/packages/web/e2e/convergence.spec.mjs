// Against the existing servers only; run from rewrite with Playwright and Chromium paths.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const playwright = await import(pathToFileURL(process.argv[2]).href);
const { chromium } = playwright.default ?? playwright;
const browser = await chromium.launch({ headless: true, executablePath: process.argv[3] });
const screenshots = 'scratchpad/e2e/heuristics';
await mkdir(screenshots, { recursive: true });
const errors = [];
const lengths = {};
const watch = page => {
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(60000);
};
const ready = async (page, id) => {
  await page.waitForFunction(id => {
    const element = document.querySelector(`[data-panel-id="${id}"]`);
    const component = element && window.ng?.getComponent(element.closest('app-panel-card'));
    const view = component?.view();
    return view?.status.kind === 'ready' && !view.status.stale && !view.partial && view.hasRows;
  }, id, { timeout: 120000 });
  await page.locator(`[data-panel-id="${id}"] .chart-box canvas`).waitFor();
};
const capture = async (page, name, id) => {
  lengths[name] = new URL(page.url()).searchParams.get('s')?.length ?? 0;
  if (id) {
    const card = page.locator(`[data-panel-id="${id}"]`);
    await card.evaluate(element => element.scrollIntoView({ block: 'center' }));
    await card.screenshot({ path: `${screenshots}/codex-converge-${name}.png` });
  }
  else await page.screenshot({ path: `${screenshots}/codex-converge-${name}.png`, fullPage: true });
};
const snapshot = page => page.locator('[data-testid="panel-card"]').evaluateAll(elements => elements.map(element => {
  const component = window.ng.getComponent(element.closest('app-panel-card'));
  const panel = component.panel();
  const { cursors, ...persisted } = panel;
  return {
    panel: persisted, title: component.view().title,
    counts: component.view().cohorts?.map(({ id, name, color, n }) => ({ id, name, color, n })),
    table: element.querySelector('[data-testid="comparison-table"]')?.textContent.replace(/\s+/g, ' ').trim(),
    datasets: component.view().datasets,
  };
}));

try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage(); watch(page);
  await page.goto('http://localhost:4300');
  await ready(page, 'p1'); await ready(page, 'p5');
  assert.equal(new URL(page.url()).searchParams.has('s'), false);
  await capture(page, 'default');

  await page.getByRole('button', { name: 'Add panel', exact: true }).click();
  await page.locator('.column-drawer [data-column-id="created_at"]').click();
  const time = page.locator('[data-panel-id="p6"]');
  await ready(page, 'p6');
  assert.match(await time.getByRole('combobox', { name: 'Form', exact: true }).innerText(), /Bars/);
  await capture(page, 'bars', 'p6');

  await time.locator('[data-testid="metric-title"]').click();
  await page.getByRole('combobox', { name: 'Metric over time (y)', exact: true }).selectOption('fd_mean');
  await page.getByRole('button', { name: 'Close column drawer', exact: true }).click();
  await ready(page, 'p6');
  assert.match(await time.getByRole('combobox', { name: 'Form', exact: true }).innerText(), /Band/);
  const band = await time.evaluate(element => {
    const view = window.ng.getComponent(element.closest('app-panel-card')).view();
    return { spec: JSON.stringify(view.spec), rows: view.datasets['timeSummary']?.length };
  });
  assert.match(band.spec, /"type":"area"/); assert.ok(band.rows > 0);
  await capture(page, 'band', 'p6');

  const snr = page.locator('[data-panel-id="p4"]');
  await snr.getByRole('button', { name: 'Add comparison', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Chosen values…', exact: true }).click();
  await snr.getByRole('combobox', { name: 'Choose field', exact: true }).click();
  await page.getByRole('option', { name: 'Manufacturer', exact: true }).click();
  await snr.getByRole('combobox', { name: 'Choose values', exact: true }).click();
  await page.getByRole('option', { name: /^Siemens \(/ }).click();
  await page.getByRole('option', { name: /^GE \(/ }).click();
  await page.keyboard.press('Escape');
  await snr.getByRole('button', { name: 'Add values', exact: true }).click();
  await ready(page, 'p4');
  await snr.getByRole('button', { name: 'Add comparison', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Whole population', exact: true }).click();
  await ready(page, 'p4');
  const chips = snr.locator('[data-testid="compare-series-chip"]');
  assert.equal(await chips.count(), 3);
  for (const chip of await chips.all()) {
    assert.match(await chip.innerText(), /n=[\d,]+/);
    assert.ok(await chip.locator('[aria-hidden="true"]').first().evaluate(dot => getComputedStyle(dot).backgroundColor !== 'rgba(0, 0, 0, 0)'));
  }
  assert.equal(await snr.locator('table').count(), 1);
  assert.equal(await snr.locator('[data-testid="series-legend"]').count(), 0);
  const isolation = chips.first().locator('button[aria-pressed]');
  await isolation.click();
  await page.waitForFunction(() => document.querySelector('[data-panel-id="p4"] [data-testid="compare-series-chip"] button[aria-pressed]')?.getAttribute('aria-pressed') === 'true');
  await isolation.dblclick();
  await page.waitForFunction(() => document.querySelector('[data-panel-id="p4"] [data-testid="compare-series-chip"] button[aria-pressed]')?.getAttribute('aria-pressed') === 'false');
  await snr.evaluate(element => element.scrollIntoView({ block: 'center' }));
  const bounds = await snr.evaluate(element => {
    const card = element.getBoundingClientRect();
    const chart = element.querySelector('.panel-chart-slot').getBoundingClientRect();
    return { cardTop: card.top, cardBottom: card.bottom, chartTop: chart.top, chartBottom: chart.bottom, chartHeight: chart.height, viewport: innerHeight };
  });
  assert.ok(bounds.chartHeight >= 160, JSON.stringify(bounds));
  assert.ok(bounds.chartTop >= bounds.cardTop && bounds.chartBottom <= bounds.cardBottom, JSON.stringify(bounds));
  assert.ok(bounds.chartTop < bounds.viewport, JSON.stringify(bounds));
  await capture(page, 'compare', 'p4');
  const before = await snapshot(page);
  const url = page.url();
  const fresh = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const restored = await fresh.newPage(); watch(restored);
  await restored.goto(url);
  for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) await ready(restored, id);
  assert.equal(restored.url(), url);
  assert.deepEqual(await snapshot(restored), before);
  await capture(restored, 'reload', 'p4');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ consoleErrors: errors.length, sLengths: lengths, chartBounds: bounds, reloadIdentical: true }));
} finally {
  await browser.close();
}
