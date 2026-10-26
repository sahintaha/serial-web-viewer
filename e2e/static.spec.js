// Browser-only installation (GitHub Pages): simulator, IndexedDB store, outbox.
const { test, expect } = require('@playwright/test');
const { startStatic } = require('./harness');
const { autoAnswer, runTest, waitForEnd } = require('./helpers');

let site;
test.beforeAll(async () => {
  site = await startStatic();
});
test.afterAll(async () => site.close());

test.beforeEach(async ({ page }) => {
  await autoAnswer(page);
  await page.goto(`${site.url}/?demo#production/station`);
  await expect(page.locator('#connection-status')).toContainText('Simülatör');
  await page.locator('#sim-fault').selectOption('none');
});

async function historyTotal(page) {
  await page.locator('#pt-subtabs [data-page="history"]').click();
  await page.locator('#pt-filter-source').selectOption('all');
  await page.locator('#pt-filters button[type="submit"]').click();
  return Number(await page.locator('#pt-stats .pt-stat').first().locator('strong').textContent());
}

test('a simulator run passes, is stored once and is labelled as simulation', async ({ page }) => {
  await runTest(page, 'SNS-000501');
  await expect(page.locator('#pt-result')).toContainText('PASS');
  await expect(page.locator('#pt-result')).toContainText('simülasyon');
  await expect(page.locator('#pt-safety')).toContainText('güvenli durumda');
  await expect(page.locator('#pt-save')).toContainText('kaydedildi');

  expect(await historyTotal(page)).toBe(1);
  await expect(page.locator('#pt-history-body tr').first()).toContainText('simülasyon');
  // On the simulator the reports show simulation results; the production view never includes them
  await page.locator('#pt-subtabs [data-page="reports"]').click();
  await expect(page.locator('#rp-source')).toHaveValue('simulation');
  await expect(page.locator('#rp-products')).toContainText('SVB-100');
  await page.locator('#rp-source').selectOption('production');
  await page.locator('#rp-filters button[type="submit"]').click();
  await expect(page.locator('#rp-products')).toContainText('üretim testi yok');
});

test('double Enter, repeated submit and a click start exactly one run', async ({ page }) => {
  await page.locator('#pt-serial').fill('SNS-000502');
  const before = await page.locator('#pt-phase').getAttribute('data-transitions');
  await page.evaluate(() => {
    const form = document.getElementById('pt-form');
    form.requestSubmit();
    form.requestSubmit();
    document.getElementById('pt-start').click();
  });
  await page.locator('#pt-serial').press('Enter');
  await waitForEnd(page, before);
  expect(await historyTotal(page)).toBe(1);
});

test('a supply that does not switch off is reported as unsafe and blocks the next test', async ({ page }) => {
  await page.locator('#sim-fault').selectOption('stuckpower');
  await runTest(page, 'SNS-000503');
  await expect(page.locator('#pt-safety')).toContainText('GÜVENLİ DEĞİL');
  await expect(page.locator('#pt-result')).toHaveClass(/pt-attention/);
  await expect(page.locator('#pt-start')).toBeDisabled();
  await page.getByRole('button', { name: 'Beslemeyi kontrol ettim, kart güvenli' }).click();
  await expect(page.locator('#pt-start')).toBeEnabled();
});

test('manual and periodic sends stop while a test owns the port', async ({ page }) => {
  await page.locator('#view-tabs [data-view="monitor"]').click();
  await page.locator('#send-input').fill('STATUS?');
  await page.locator('#auto-send-checkbox').check();
  await page.locator('#view-tabs [data-view="production"]').click();

  await page.evaluate(() => (window.__holdQuestions = true));
  await page.locator('#pt-serial').fill('SNS-000504');
  const before = await page.locator('#pt-phase').getAttribute('data-transitions');
  await page.locator('#pt-serial').press('Enter');
  await expect(page.locator('.modal.show .confirm-yes')).toBeVisible({ timeout: 20_000 }); // waiting on the operator

  await expect(page.locator('#auto-send-checkbox')).not.toBeChecked();
  await expect(page.locator('#send-input')).toBeDisabled();
  await expect(page.locator('#connection-button')).toBeDisabled();
  await expect(page.locator('#mode-selector [data-mode="webserial"]')).toBeDisabled();

  // Releasing the hold lets the auto-answer reply; answer here too in case nothing changes on the page
  await page.evaluate(() => {
    window.__holdQuestions = false;
    document.querySelector('.modal.show .confirm-yes')?.click();
  });
  await waitForEnd(page, before);
  await expect(page.locator('#pt-result')).toContainText('PASS');
  await expect(page.locator('#send-input')).toBeEnabled();
});

test('a draft recipe does not reach the station until it is published', async ({ page }) => {
  await page.locator('#pt-subtabs [data-page="products"]').click();
  await page.locator('.product-item[data-code="SVB-100"]').click();
  await page.locator('#pr-recipe').evaluate((ta) => {
    const recipe = JSON.parse(ta.value);
    recipe.steps.find((s) => s.type === 'measure').limits[0].max = 5.05;
    ta.value = JSON.stringify(recipe, null, 2);
    ta.dispatchEvent(new Event('input'));
  });
  await page.locator('#pr-save').click();
  await expect(page.locator('#pr-meta')).toContainText('taslak: rev 2');
  await expect(page.locator('#pt-product option:checked')).toContainText('rev 1');

  await page.locator('#pr-publish').click();
  await expect(page.locator('#pr-diff')).toContainText('5.05');
  await page.locator('.modal.show textarea').fill('Voltaj üst limiti müşteri şartnamesine göre');
  await page.locator('.modal.show button[type="submit"]').click();
  await expect(page.locator('#pt-product option:checked')).toContainText('rev 2');
  await expect(page.locator('#pr-revisions')).toContainText('müşteri şartnamesine');
});

test('the FAIL limit blocks a board until it is reopened with a reason', async ({ page }) => {
  await page.locator('#sim-fault').selectOption('overcurrent');
  for (let i = 0; i < 3; i += 1) await runTest(page, 'SNS-000505');
  await runTest(page, 'SNS-000505');
  await expect(page.locator('#pt-result')).toContainText('ONARIM');

  await page.locator('#pt-result').getByRole('button', { name: /yeniden aç/ }).click();
  await page.locator('.modal.show textarea').fill('Şönt direnci değiştirildi');
  await page.locator('.modal.show button[type="submit"]').click();
  await page.locator('#sim-fault').selectOption('none');
  await runTest(page, 'SNS-000505');
  await expect(page.locator('#pt-result')).toContainText('PASS');
  await expect(page.locator('#pt-result')).toContainText('4. deneme');
});

test('the operator question has its own stop button; the teardown still switches the board off', async ({ page }) => {
  await page.evaluate(() => (window.__holdQuestions = true));
  await page.locator('#pt-serial').fill('SNS-000507');
  const before = await page.locator('#pt-phase').getAttribute('data-transitions');
  await page.locator('#pt-serial').press('Enter');
  await page.locator('.modal.show').getByRole('button', { name: 'Testi durdur' }).click();
  await waitForEnd(page, before);
  await expect(page.locator('#pt-result')).toContainText('HATA');
  await expect(page.locator('#pt-result')).toContainText('durduruldu');
  await expect(page.locator('#pt-safety')).toContainText('güvenli durumda');
  await expect(page.locator('#pt-phase')).toHaveText('Bitti');
});

test('a test interrupted by closing the page releases the board when the station opens again', async ({ page, context }) => {
  await page.evaluate(() => (window.__holdQuestions = true));
  await page.locator('#pt-serial').fill('SNS-000508');
  await page.locator('#pt-serial').press('Enter');
  await expect(page.locator('.modal.show .confirm-yes')).toBeVisible({ timeout: 20_000 });
  await page.close(); // like a crashed tab: no teardown, no result, the reservation stays open

  const next = await context.newPage();
  await autoAnswer(next);
  await next.goto(`${site.url}/?demo#production/station`);
  await expect(next.locator('#pt-result')).toContainText('yarıda kaldı');
  await expect(next.locator('#pt-safety')).toContainText('doğrulanamadı');
  await expect(next.locator('#pt-start')).toBeDisabled();
  await next.getByRole('button', { name: 'Beslemeyi kontrol ettim, kart güvenli' }).click();
  await expect(next.locator('#connection-status')).toContainText('Simülatör');
  await next.locator('#sim-fault').selectOption('none');
  await runTest(next, 'SNS-000508');
  await expect(next.locator('#pt-result')).toContainText('PASS');
});

test('a first visit without ?demo opens on the simulator, with live data', async ({ browser }) => {
  const context = await browser.newContext();
  const visitor = await context.newPage();
  await visitor.goto(`${site.url}/`);
  await expect(visitor.locator('#mode-selector [data-mode="demo"]')).toHaveAttribute('aria-checked', 'true');
  await expect(visitor.locator('#connection-status')).toContainText('Simülatör');
  await context.close();
});

test('sample data fills history and reports in seconds and can be deleted again', async ({ page }) => {
  await page.locator('#pt-subtabs [data-page="reports"]').click();
  await page.locator('#rp-products [data-action="sample-data"]').click();
  await expect(page.locator('#rp-products tr')).toHaveCount(2, { timeout: 60_000 }); // SVB-100 and SVB-200
  await expect(page.locator('#rp-source')).toHaveValue('simulation');
  await expect(page.locator('#rp-stats')).toContainText('Cpk');
  await expect(page.locator('#rp-stats')).not.toContainText('koşullar sağlanmıyor');

  await page.locator('#pt-subtabs [data-page="history"]').click();
  await expect(page.locator('#pt-filter-source')).toHaveValue('simulation');
  const total = Number(await page.locator('#pt-stats .pt-stat strong').first().textContent());
  expect(total).toBeGreaterThan(150);
  await expect(page.locator('#pt-history-body tr').first()).toContainText('simülasyon');

  await page.evaluate(() => (window.__holdQuestions = true)); // the auto-answer would pick the safe "Vazgeç"
  await page.locator('#pt-sample-delete').click();
  await page.locator('.modal.show').getByRole('button', { name: 'Sil' }).click();
  await expect(page.locator('#pt-stats .pt-stat strong').first()).toHaveText('0');
});

test('quick-try buttons: a good board passes, a faulty one is caught, sample reports open', async ({ page }) => {
  const tryBoard = async (name) => {
    const before = await page.locator('#pt-phase').getAttribute('data-transitions');
    await page.getByRole('button', { name }).click();
    await waitForEnd(page, before);
  };
  await tryBoard('Sağlam kartı dene');
  await expect(page.locator('#pt-result')).toContainText('PASS');
  await tryBoard('Arızalı kartı dene');
  await expect(page.locator('#pt-result')).toContainText('FAIL');
  await expect(page.locator('#pt-result')).toContainText('Akım limit dışı');

  await page.getByRole('button', { name: 'Örnek raporları gör' }).click();
  await expect(page.locator('#rp-products tr')).toHaveCount(2, { timeout: 60_000 });
  await expect(page.locator('#rp-source')).toHaveValue('simulation');
});

test('on a phone the demo shows the test area before the connection panel', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const station = await page.locator('#pt-page-station').boundingBox();
  const sidebar = await page.locator('.sidebar').boundingBox();
  expect(station.y).toBeLessThan(sidebar.y);
  await expect(page.getByRole('button', { name: 'Sağlam kartı dene' })).toBeInViewport();
});
