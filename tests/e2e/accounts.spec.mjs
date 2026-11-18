// Accounts (getting-in plan, phase 2): sign in with an emailed code, pick a
// unique player name, a guest verifies and stays the same player, delete
// account. The code flow is behind the email_code_login switch; these tests
// turn it on in their own pages only (the live switch stays off until email
// sending is set up), and read the codes from the local test inbox (Mailpit).

import { test, expect, devices } from '@playwright/test';
import { APP_URL, newPlayer, expectNoPageErrors, setFeature } from './helpers.mjs';

const MAIL = process.env.MAILPIT_URL || 'http://127.0.0.1:55324';
const RUN = Date.now().toString(36);

async function emailCode(to, after) {
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`).then((x) => x.json()).catch(() => null);
    const msg = (r?.messages || []).find((m) => Date.parse(m.Created) >= after);
    if (msg) {
      const full = await fetch(`${MAIL}/api/v1/message/${msg.ID}`).then((x) => x.json());
      const code = (full.Text || full.HTML || '').match(/\b(\d{6})\b/);
      if (code) return code[1];
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`no code emailed to ${to}`);
}

// Switch the code flow on in this page only
async function codeLoginOn(page) {
  await page.waitForFunction(() => typeof FEATURES === 'object' && Object.keys(FEATURES).length > 0, null, { timeout: 15_000 });
  await page.evaluate(() => { FEATURES.email_code_login = { state: 'on' }; renderAccountPanel(); });
}

test.beforeAll(() => setFeature('guest_play', 'on'));

test('sign in with an emailed code, pick a unique name, delete the account', async ({ browser }) => {
  test.setTimeout(2 * 60_000);
  const p = await newPlayer(browser, 'Coda', devices['iPhone 13']);
  const page = p.page;
  page.on('dialog', (d) => d.accept());
  await codeLoginOn(page);
  await page.evaluate(() => showAccountPanel());
  await expect(page.locator('#account-code')).toBeVisible();
  await expect(page.locator('#account-password')).toBeHidden();

  const email = `coda-${RUN}@test.local`;
  const t0 = Date.now() - 2000;
  await page.fill('#code-email', email);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.locator('#code-step-code')).toBeVisible();
  await page.fill('#code-input', await emailCode(email, t0));
  await page.getByRole('button', { name: 'Sign in' }).click();

  // New player: picks a name, checked as they type
  const sheet = page.locator('#modal-player-name');
  await expect(sheet).toHaveClass(/open/, { timeout: 15_000 });
  await page.fill('#player-name-input', 'Admin');
  await expect(page.locator('#player-name-status')).toContainText('reserved');
  const name = `Coda ${RUN}`.slice(0, 20);
  await page.fill('#player-name-input', name);
  await expect(page.locator('#player-name-status')).toContainText('Available');
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(sheet).not.toHaveClass(/open/);
  await expect(page.locator('#screen-home')).toHaveClass(/active/);
  await expect(page.locator('#my-name')).toHaveText(name);

  // Delete account (red, in the profile)
  await page.evaluate(() => navTo('profile'));
  const del = page.getByRole('button', { name: 'Delete account' });
  await expect(del).toBeVisible();
  await del.click();
  await expect(page.locator('#screen-splash')).toHaveClass(/active/, { timeout: 15_000 });
  expectNoPageErrors([p]);
});

test('a guest verifies with an emailed code and keeps playing as the same player', async ({ browser }) => {
  test.setTimeout(2 * 60_000);
  const p = await newPlayer(browser, 'Gwen', devices['Pixel 7']);
  const page = p.page;
  await expect(page.locator('#splash-play')).toBeVisible({ timeout: 15_000 });
  await page.fill('#guest-name', 'Gwen');
  await page.getByRole('button', { name: 'Play now' }).click();
  await expect(page.locator('#screen-home')).toHaveClass(/active/, { timeout: 15_000 });
  const guestId = await page.evaluate(() => me.id);
  await codeLoginOn(page);

  await page.evaluate(() => navTo('friends'));
  await page.locator('#friends-guest-gate').getByRole('button', { name: 'Create an account' }).click();
  const sheet = page.locator('#modal-verify');
  await expect(sheet).toHaveClass(/open/);
  const email = `gwen-${RUN}@test.local`;
  const t0 = Date.now() - 2000;
  await page.fill('#verify-email', email);
  await sheet.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.locator('#verify-step-code')).toBeVisible({ timeout: 15_000 });
  await page.fill('#verify-code', await emailCode(email, t0));
  await sheet.getByRole('button', { name: 'Verify' }).click();

  await expect(page.locator('#modal-player-name')).toHaveClass(/open/, { timeout: 15_000 });
  const name = `Gwen ${RUN}`.slice(0, 20);
  await page.fill('#player-name-input', name);
  await page.getByRole('button', { name: 'Save name' }).click();
  await expect(page.locator('#modal-player-name')).not.toHaveClass(/open/);

  expect(await page.evaluate(() => me.id)).toBe(guestId);
  expect(await page.evaluate(() => isGuest())).toBe(false);
  await expect(page.locator('body')).not.toHaveClass(/is-guest/);
  await page.evaluate(() => navTo('friends'));
  await expect(page.locator('#friends-guest-gate')).toBeHidden();
  expectNoPageErrors([p]);
});
