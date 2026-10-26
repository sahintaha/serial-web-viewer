const { expect } = require('@playwright/test');

/** Answers every operator question with "Evet" unless window.__holdQuestions is set. */
async function autoAnswer(page) {
  await page.addInitScript(() => {
    new MutationObserver(() => {
      if (!window.__holdQuestions) document.querySelector('.modal.show .confirm-yes')?.click();
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] }); // runs before <html> exists
  });
}

/** Scans a serial number on the station and waits until the run is finished and saved (or refused). */
async function runTest(page, serial) {
  const phase = page.locator('#pt-phase');
  const before = await phase.getAttribute('data-transitions');
  await page.locator('#pt-serial').fill(serial);
  await page.locator('#pt-serial').press('Enter');
  await waitForEnd(page, before);
}

/** Waits until the station left the given transition count and reached COMPLETED or ERROR. */
async function waitForEnd(page, before) {
  const phase = page.locator('#pt-phase');
  await expect
    .poll(async () => ((await phase.getAttribute('data-transitions')) !== before ? phase.textContent() : ''), { timeout: 30_000 })
    .toMatch(/^(COMPLETED|ERROR)$/);
}

async function login(page, url, username, password) {
  await page.goto(`${url}/#production/station`);
  await page.locator('#auth-username').fill(username);
  await page.locator('#auth-password').fill(password);
  await page.locator('#auth-submit').click();
  await expect(page.locator('#auth-screen')).toBeHidden();
}

module.exports = { autoAnswer, runTest, waitForEnd, login };
