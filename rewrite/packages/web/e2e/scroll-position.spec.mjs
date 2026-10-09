// Run from rewrite against the already-running API (8787) and web (4300):
// pnpm exec node packages/web/e2e/scroll-position.spec.mjs [playwright-module-path] [chromium-path]
import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const { chromium } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : 'playwright');

test('lower-card changes and browser Back preserve scroll and the dashboard instance', async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.argv[3] });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    await page.goto('http://localhost:4300');
    const card = page.locator('[data-panel-id="p3"]');
    await card.getByRole('combobox', { name: 'Form', exact: true }).waitFor();
    await page.waitForFunction(() => !new URL(location.href).searchParams.has('s'));
    await page.waitForTimeout(1000);
    const dashboard = await page.evaluateHandle(() => window.ng.getComponent(document.querySelector('app-dashboard')));
    const initialUrl = page.url();
    const initialHistory = await page.evaluate(() => history.length);
    await page.evaluate(() => window.scrollTo(0, 900));
    await page.waitForTimeout(100);
    const before = await page.evaluate(() => window.scrollY);
    assert.equal(before, 900);

    const measurements = { before };
    const verify = async (step) => {
      // Include delayed router Scroll events, focus restoration, and chart updates.
      await page.waitForTimeout(750);
      measurements[step] = await page.evaluate(() => window.scrollY);
      assert.equal(measurements[step], before, step);
      assert.equal(await page.evaluate(instance => window.ng.getComponent(document.querySelector('app-dashboard')) === instance, dashboard), true);
    };

    await card.getByRole('combobox', { name: 'Form', exact: true }).click();
    await page.getByRole('option', { name: /^ECDF/ }).click();
    await page.waitForURL(url => url.href !== initialUrl);
    const formUrl = page.url();
    assert.match(await card.getByRole('combobox', { name: 'Form', exact: true }).innerText(), /ECDF/);
    assert.equal(await page.evaluate(() => history.length), initialHistory + 1);
    await verify('afterForm');

    await card.getByRole('button', { name: 'Add comparison', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Whole population', exact: true }).click();
    await page.waitForURL(url => url.href !== formUrl);
    await card.locator('app-compare-input').getByRole('button', { name: 'Remove comparison Whole population', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => history.length), initialHistory + 2);
    await verify('afterSeries');

    await page.goBack();
    await page.waitForURL(formUrl);
    await card.locator('app-compare-input').getByRole('button', { name: 'Remove comparison Whole population', exact: true }).waitFor({ state: 'detached' });
    assert.match(await card.getByRole('combobox', { name: 'Form', exact: true }).innerText(), /ECDF/);
    await verify('afterBackSeries');

    await page.goBack();
    await page.waitForURL(initialUrl);
    await card.getByRole('combobox', { name: 'Form', exact: true }).filter({ hasText: 'Histogram' }).waitFor();
    assert.match(await card.getByRole('combobox', { name: 'Form', exact: true }).innerText(), /Histogram/);
    await verify('afterBackForm');
    console.log('scrollY:', JSON.stringify(measurements));
  } finally {
    await browser.close();
  }
});
