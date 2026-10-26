// Node server installation: users and roles, the server-side port lock shared by every
// tab, SQLite storage, and recovery of a result whose save response was lost.
// The serial port is a SerialPortMock with a SimulatedBoard answering on it.
const crypto = require('crypto');
const { test, expect } = require('@playwright/test');
const { startServer } = require('./harness');
const { autoAnswer, runTest, waitForEnd, login } = require('./helpers');

test.describe.configure({ mode: 'serial' });

const password = () => crypto.randomBytes(12).toString('base64url');
const users = {
  admin: { username: 'yonetici', displayName: 'Yönetici', password: password() },
  operator: { username: 'op1', displayName: 'Ayşe Operatör', role: 'operator', password: password() },
  engineer: { username: 'eng1', displayName: 'Mert Mühendis', role: 'engineer', password: password() },
};

let app;
test.beforeAll(async () => {
  app = await startServer();
});
test.afterAll(async () => app?.close());

/** Connects the station to the fixture port through the server (the port is shared, so it may already be open). */
async function connectFixture(page) {
  await page.locator('#view-tabs [data-view="production"]').click();
  const health = await (await page.request.get(`${app.url}/health`)).json();
  if (health.connected) {
    await expect(page.locator('#connection-status')).toContainText('/dev/FIXTURE');
    return;
  }
  await expect(page.locator('#mode-selector [data-mode="server"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#receiver-select option[value="/dev/FIXTURE"]')).toBeAttached();
  await page.locator('#receiver-select').selectOption('/dev/FIXTURE');
  await page.locator('#connection-button').click();
  await expect(page.locator('#connection-status')).toContainText('/dev/FIXTURE');
}

test('first start has no default password: the console setup code creates the administrator', async ({ page }) => {
  await page.goto(app.url);
  await expect(page.locator('#auth-title')).toHaveText('İlk kurulum: yönetici hesabı');
  await page.locator('#auth-token').fill('yanlış-kod');
  await page.locator('#auth-username').fill(users.admin.username);
  await page.locator('#auth-display').fill(users.admin.displayName);
  await page.locator('#auth-password').fill(users.admin.password);
  await page.locator('#auth-submit').click();
  await expect(page.locator('#auth-error')).toContainText('Kurulum kodu hatalı');

  await page.locator('#auth-token').fill(app.setupToken);
  await page.locator('#auth-submit').click();
  await expect(page.locator('#user-button')).toContainText('Yönetici');
  for (const role of ['operator', 'engineer']) {
    const { username, displayName, password: pw } = users[role];
    const res = await page.request.post(`${app.url}/api/users`, { data: { username, displayName, role, password: pw } });
    expect(res.status()).toBe(201);
  }
});

test('an operator tests a real-port board; the record carries user, station and fixture', async ({ page }) => {
  await autoAnswer(page);
  await login(page, app.url, users.operator.username, users.operator.password);
  await expect(page.locator('#pt-operator-field')).toBeHidden(); // identity comes from the login
  await connectFixture(page);
  await runTest(page, 'SNS-000601');
  await expect(page.locator('#pt-result')).toContainText('PASS');
  await expect(page.locator('#pt-sim-badge')).toBeHidden();
  await expect(page.locator('#pt-save')).toContainText('Sunucuya kaydedildi');

  const list = await (await page.request.get(`${app.url}/api/tests?source=hardware&serial=SNS-000601`)).json();
  expect(list.total).toBe(1);
  const record = await (await page.request.get(`${app.url}/api/tests/${list.items[0].id}`)).json();
  expect(record).toMatchObject({ source: 'hardware', transport: 'server', operator: users.operator.displayName, safety: { state: 'SAFE' } });
  expect(record.station).toMatchObject({ id: 'E2E-01', fixture: 'FX-E2E', calibration: { id: 'CAL-E2E' } });
  expect(record.captures.firmware).toBeTruthy();
});

test('every screen runs under the strict content security policy', async ({ page }) => {
  const problems = [];
  page.on('console', (m) => /Content Security Policy|Refused to/i.test(m.text()) && problems.push(m.text()));
  page.on('pageerror', (err) => problems.push(err.message));
  await autoAnswer(page);
  await login(page, app.url, users.operator.username, users.operator.password);
  await connectFixture(page);
  await runTest(page, 'SNS-000605');
  for (const sub of ['reports', 'products', 'history']) {
    await page.locator(`#pt-subtabs [data-page="${sub}"]`).click();
    await page.waitForTimeout(400);
  }
  await page.locator('#pt-history-body tr[data-index="0"]').click();
  await expect(page.locator('#pt-detail')).toHaveClass(/show/);
  await page.keyboard.press('Escape');
  await page.locator('#view-tabs [data-view="monitor"]').click();
  await page.locator('[data-action="hex-raw"]').first().click();
  await page.waitForTimeout(400);
  expect(problems).toEqual([]);
});

test('another tab cannot write to or disconnect the port while a test owns it', async ({ context }) => {
  const station = await context.newPage();
  await login(station, app.url, users.operator.username, users.operator.password);
  await connectFixture(station);
  await expect(station.locator('#connection-status')).toContainText('/dev/FIXTURE');

  await station.locator('#pt-serial').fill('SNS-000602');
  const before = await station.locator('#pt-phase').getAttribute('data-transitions');
  await station.locator('#pt-serial').press('Enter');
  await expect(station.locator('.modal.show .confirm-yes')).toBeVisible({ timeout: 20_000 }); // test holds the port

  const other = await context.newPage();
  await other.goto(`${app.url}/`);
  await expect(other.locator('#connection-status')).toContainText('testte');
  await other.locator('#send-input').fill('PWR ON');
  await other.locator('#send-form button[type="submit"]').click();
  await expect(other.locator('#toast-message')).toContainText('kilitli');
  await other.locator('#connection-button').click();
  await expect(other.locator('#toast-message')).toContainText('kilitli');
  await expect(station.locator('#pt-phase')).toHaveAttribute('data-phase', 'RUNNING');

  await station.locator('.modal.show .confirm-yes').click();
  await waitForEnd(station, before);
  await expect(station.locator('#pt-result')).toContainText('PASS');
});

test('a lost save response is recovered after a reload without a second attempt', async ({ page }) => {
  await autoAnswer(page);
  await login(page, app.url, users.operator.username, users.operator.password);
  await connectFixture(page);
  // The server stores the result, but the browser never sees the answer
  await page.route('**/api/tests', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fetch();
    await route.abort('connectionreset');
  });
  await runTest(page, 'SNS-000603');
  await expect(page.locator('#pt-save')).toContainText('henüz gönderilemedi');
  await expect(page.locator('#pt-outbox-pill')).toBeVisible();

  await page.unroute('**/api/tests');
  await page.reload();
  await expect(page.locator('#pt-outbox-pill')).toBeHidden();
  const list = await (await page.request.get(`${app.url}/api/tests?source=hardware&serial=SNS-000603`)).json();
  expect(list.total).toBe(1);
  expect(list.items[0].attempt).toBe(1);
});

test('unplugging the cable mid-test gives ERROR with an unverified shutdown; reconnecting works', async ({ page }) => {
  await login(page, app.url, users.operator.username, users.operator.password);
  await connectFixture(page);
  await page.locator('#pt-serial').fill('SNS-000604');
  const before = await page.locator('#pt-phase').getAttribute('data-transitions');
  await page.locator('#pt-serial').press('Enter');
  await expect(page.locator('.modal.show .confirm-yes')).toBeVisible({ timeout: 20_000 });

  app.ctx.bridge.state.receiver.emit('error', new Error('USB cable unplugged'));
  await waitForEnd(page, before);
  await expect(page.locator('#pt-result')).toContainText('HATA');
  await expect(page.locator('#pt-safety')).toContainText('doğrulanamadı');
  await expect(page.locator('#pt-save')).toContainText('Sunucuya kaydedildi');
  await expect(page.locator('#pt-start')).toBeDisabled(); // board state must be checked by hand first
  await expect(page.locator('#connection-status')).toContainText('Bağlı değil'); // no automatic reconnect

  await autoAnswer(page);
  await page.reload();
  await expect(page.locator('#pt-safety')).toContainText('doğrulanamadı'); // a reload does not skip the check
  await expect(page.locator('#pt-start')).toBeDisabled();
  await page.getByRole('button', { name: 'Beslemeyi kontrol ettim, kart güvenli' }).click();
  await connectFixture(page);
  await runTest(page, 'SNS-000604');
  await expect(page.locator('#pt-result')).toContainText('PASS');
  await expect(page.locator('#pt-result')).toContainText('2. deneme');
});

test('a retest after PASS asks for a reason, and the reason is stored', async ({ page }) => {
  await autoAnswer(page);
  await login(page, app.url, users.operator.username, users.operator.password);
  await connectFixture(page);
  await page.locator('#pt-serial').fill('SNS-000601');
  await page.locator('#pt-serial').press('Enter');
  await expect(page.locator('.modal.show textarea')).toBeVisible();
  const before = await page.locator('#pt-phase').getAttribute('data-transitions');
  await page.locator('.modal.show textarea').fill('Müşteri iadesi kontrolü');
  await page.locator('.modal.show button[type="submit"]').click();
  await waitForEnd(page, before);
  await expect(page.locator('#pt-result')).toContainText('2. deneme');
  const list = await (await page.request.get(`${app.url}/api/tests?source=hardware&serial=SNS-000601`)).json();
  const latest = await (await page.request.get(`${app.url}/api/tests/${list.items[0].id}`)).json();
  expect(latest.retestReason).toBe('Müşteri iadesi kontrolü');
});

test('operators cannot change recipes; an engineer publishes with a note and it is audited', async ({ browser }) => {
  const operatorContext = await browser.newContext();
  const operator = await operatorContext.newPage();
  await login(operator, app.url, users.operator.username, users.operator.password);
  await operator.locator('#pt-subtabs [data-page="products"]').click();
  await expect(operator.locator('#pr-readonly')).toBeVisible();
  await expect(operator.locator('#pr-save')).toBeHidden();
  const denied = await operator.request.put(`${app.url}/api/products/SVB-100/draft`, { data: { definition: { name: 'x' } } });
  expect(denied.status()).toBe(403);
  await operatorContext.close();

  const engineerContext = await browser.newContext();
  const engineer = await engineerContext.newPage();
  await login(engineer, app.url, users.engineer.username, users.engineer.password);
  await engineer.locator('#pt-subtabs [data-page="products"]').click();
  await engineer.locator('.product-item[data-code="SVB-200"]').click();
  await engineer.locator('#pr-attempts').fill('3');
  await engineer.locator('#pr-save').click();
  await expect(engineer.locator('#pr-meta')).toContainText('taslak');
  await engineer.locator('#pr-publish').click();
  await engineer.locator('.modal.show textarea').fill('FAIL sınırı 3 — yeni fikstürle tekrar ölçüm');
  await engineer.locator('.modal.show button[type="submit"]').click();
  await expect(engineer.locator('#pr-meta')).toContainText('yayında: rev 2');

  const audit = await (await engineer.request.get(`${app.url}/api/audit?entity=product&entityId=SVB-200`)).json();
  expect(audit.find((a) => a.action === 'publish')).toMatchObject({ user: users.engineer.displayName, detail: { revision: 2, note: 'FAIL sınırı 3 — yeni fikstürle tekrar ölçüm' } });
  await engineerContext.close();
});
