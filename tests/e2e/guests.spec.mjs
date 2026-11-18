// Guests (getting-in plan, phase 1): play with no account.
// A guest opens the app → name + avatar → Play now; hosting shows as
// "in development"; an invite link (?join=) seats them in the lobby; the host
// starts and the guest is dealt in. Friends and Standings ask for an account.

import { test, expect, devices } from '@playwright/test';
import { APP_URL, newPlayer, signUp, expectNoPageErrors, setFeature } from './helpers.mjs';

// "Play now" is behind the guest_play switch (off until Anonymous sign-ins
// are enabled on the live project); the test stack has them enabled
test.beforeAll(() => setFeature('guest_play', 'on'));

test('guest: play now, hosting in development, join by link, dealt in', async ({ browser }) => {
  test.setTimeout(3 * 60_000);
  const host = await newPlayer(browser, 'Hostess', devices['iPhone 13']);
  const gus = await newPlayer(browser, 'Gus', devices['Pixel 7']);
  await signUp(host);

  await test.step('guest: name + avatar → Play now → home', async () => {
    const page = gus.page;
    await expect(page.locator('#splash-play')).toBeVisible();
    await page.fill('#guest-name', gus.name);
    await page.locator('#guest-avatars button').nth(2).click();
    await page.getByRole('button', { name: 'Play now' }).click();
    await expect(page.locator('#screen-home')).toHaveClass(/active/, { timeout: 15_000 });
    expect(await page.evaluate(() => isGuest())).toBe(true);
    gus.id = await page.evaluate(() => me.id);
  });

  await test.step('guest: hosting is in development', async () => {
    await gus.page.locator('#screen-home .fab').click();
    const sheet = gus.page.locator('#modal-guest-host');
    await expect(sheet).toHaveClass(/open/);
    await expect(sheet).toContainText('In development');
    await sheet.getByRole('button', { name: 'Not now' }).click();
    await expect(gus.page.locator('#modal-create-game')).not.toHaveClass(/open/);
  });

  await test.step('guest: friends and Standings ask for an account', async () => {
    await gus.page.evaluate(() => navTo('friends'));
    await expect(gus.page.locator('#friends-guest-gate')).toBeVisible();
    await expect(gus.page.locator('#friends-list')).toBeHidden();
    await gus.page.evaluate(() => navTo('profile'));
    await expect(gus.page.locator('#profile-guest-card')).toBeVisible();
    await expect(gus.page.locator('#profile-email')).toBeHidden();
  });

  let gameId;
  await test.step('host creates a home game', async () => {
    const hp = host.page;
    await hp.locator('#screen-home .fab').click();
    await hp.fill('#new-game-name', 'Guest Night');
    await hp.locator('#format-home').click();
    await hp.getByRole('button', { name: 'Create Game' }).click();
    await expect(hp.locator('#screen-lobby')).toHaveClass(/active/, { timeout: 15_000 });
    gameId = await hp.evaluate(() => currentLobbyId);
  });

  await test.step('guest opens the invite link → seated in the lobby', async () => {
    await gus.page.goto(`${APP_URL}?join=${gameId.slice(0, 8)}`);
    await expect(gus.page.locator('#screen-lobby')).toHaveClass(/active/, { timeout: 20_000 });
    expect(await gus.page.evaluate(() => currentLobbyId)).toBe(gameId);
    await expect(host.page.locator('#lobby-player-count')).toContainText('2', { timeout: 15_000 });
    await expect(host.page.locator('#lobby-seats')).toContainText('Guest');
  });

  await test.step('host starts: the guest is dealt in', async () => {
    await host.page.locator('#lobby-start-btn').click();
    for (const p of [host, gus]) await expect(p.page.locator('#screen-game')).toHaveClass(/active/, { timeout: 30_000 });
  });

  expectNoPageErrors([host, gus]);
});

test('a new player opening an invite link joins as a guest in two taps', async ({ browser }) => {
  test.setTimeout(2 * 60_000);
  const host = await newPlayer(browser, 'Hosta', devices['iPhone 13']);
  await signUp(host);
  const hp = host.page;
  await hp.locator('#screen-home .fab').click();
  await hp.fill('#new-game-name', 'Link Night');
  await hp.locator('#format-home').click();
  await hp.getByRole('button', { name: 'Create Game' }).click();
  await expect(hp.locator('#screen-lobby')).toHaveClass(/active/, { timeout: 15_000 });
  const gameId = await hp.evaluate(() => currentLobbyId);

  const neo = await newPlayer(browser, 'Neo', devices['iPhone SE']);
  await neo.page.goto(`${APP_URL}?join=${gameId.slice(0, 8)}`);
  await expect(neo.page.locator('#guest-invite-note')).toBeVisible();
  await neo.page.fill('#guest-name', 'Neo');
  await neo.page.getByRole('button', { name: 'Join the game' }).click();
  await expect(neo.page.locator('#screen-lobby')).toHaveClass(/active/, { timeout: 20_000 });
  await expect(hp.locator('#lobby-player-count')).toContainText('2', { timeout: 15_000 });
  expectNoPageErrors([host, neo]);
});
