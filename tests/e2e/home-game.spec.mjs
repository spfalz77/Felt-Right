// Full multi-player run of a home game on phone-sized screens:
// sign up → friends → create game → invite → join → start → play hands →
// cash out → check the ledger the database wrote.
//
// After every hand it checks that every player's screen agrees with the host
// (hand number, stacks) and that no chips were created or lost.

import { test, expect, devices } from '@playwright/test';
import { newPlayer, signUp, makeFriends, tableView, botStep, adminSelect } from './helpers.mjs';

const HANDS = Number(process.env.E2E_HANDS || 3);
const PHONES = [devices['iPhone 13'], devices['Pixel 7'], devices['iPhone SE']];

test('home game: 3 players, play hands, cash out, ledger balances', async ({ browser }) => {
  test.setTimeout(5 * 60_000);

  const [host, ...guests] = await Promise.all(
    ['Hosty', 'Guesty', 'Pixie'].map((n, i) => newPlayer(browser, n, PHONES[i % PHONES.length])),
  );
  const all = [host, ...guests];
  const fail = (msg) => {
    const logs = all.map((p) => `--- ${p.name}\n${p.log.slice(-20).join('\n')}`).join('\n');
    throw new Error(`${msg}\n${logs}`);
  };

  await test.step('sign up', async () => {
    for (const p of all) await signUp(p);
  });

  await test.step('friend requests', async () => {
    for (const g of guests) await makeFriends(host, g);
  });

  let gameId;
  await test.step('create home game and invite', async () => {
    const hp = host.page;
    await hp.evaluate(() => navTo('home'));
    await hp.locator('#screen-home .fab').click();
    await hp.fill('#new-game-name', 'E2E Home Game');
    await hp.locator('#format-home').click();
    await hp.getByRole('button', { name: 'Create Game' }).click();
    await expect(hp.locator('#screen-lobby')).toHaveClass(/active/, { timeout: 15_000 });
    gameId = await hp.evaluate(() => currentLobbyId);
    for (const g of guests) {
      await hp.locator('#lobby-friend-invite-list .list-row').filter({ hasText: g.name })
        .getByRole('button', { name: 'Invite' }).click();
    }
  });

  await test.step('guests accept the invite', async () => {
    for (const g of guests) {
      await expect(async () => {
        const banner = g.page.locator('#invite-banner').getByRole('button', { name: 'Join' });
        if (await banner.isVisible()) await banner.click();
        else await g.page.evaluate((id) => openLobby(id), gameId); // same as tapping the game card
        await expect(g.page.locator('#screen-lobby')).toHaveClass(/active/, { timeout: 3_000 });
      }).toPass({ timeout: 30_000 });
    }
    await expect(host.page.locator('#lobby-player-count')).toContainText('3', { timeout: 15_000 });
  });

  await test.step('start', async () => {
    await host.page.locator('#lobby-start-btn').click();
    for (const p of all) await expect(p.page.locator('#screen-game')).toHaveClass(/active/, { timeout: 30_000 });
  });

  const startTotal = 3 * 2000;
  const checkedHands = new Set();

  await test.step(`play ${HANDS} hands (check/call down)`, async () => {
    const deadline = Date.now() + 4 * 60_000;
    let lastProgress = Date.now();
    let lastSig = '';
    while (Date.now() < deadline) {
      for (const p of all) await botStep(p);

      const views = await Promise.all(all.map(tableView));
      const hv = views[0];
      const sig = JSON.stringify(views.map((v) => v && [v.hand, v.stage, v.pot]));
      if (sig !== lastSig) { lastSig = sig; lastProgress = Date.now(); }
      if (Date.now() - lastProgress > 45_000) fail(`Table stalled for 45s: ${sig}`);

      // At the start of each hand (pre-flop on every screen), compare screens.
      const synced = views.every((v) => v && v.hand === hv.hand && v.stage === 'preflop' && v.pot === hv.pot);
      if (hv && hv.hand > 0 && synced && !checkedHands.has(hv.hand)) {
        for (const [i, v] of views.entries()) {
          expect(v.chips, `${all[i].name}'s stacks match the host on hand ${hv.hand}`).toEqual(hv.chips);
          const sum = Object.values(v.chips).reduce((a, b) => a + b, 0) + v.pot;
          expect(sum, `chips + pot add up to the buy-ins on ${all[i].name}'s screen, hand ${hv.hand}`).toBe(startTotal);
        }
        checkedHands.add(hv.hand);
      }
      if (checkedHands.size >= HANDS + 1) break; // HANDS completed, next one dealt
      await host.page.waitForTimeout(250);
    }
    expect(checkedHands.size, 'hands played and checked').toBeGreaterThanOrEqual(HANDS + 1);
  });

  await test.step('host cashes out; database writes a balanced ledger', async () => {
    const hp = host.page;
    await hp.locator('#host-endgame-btn').click();
    await expect(hp.locator('#modal-cashout')).toBeVisible();
    await hp.locator('#cashout-confirm-btn').click();

    let game = null;
    await expect.poll(async () => {
      const [g] = await adminSelect('games', `id=eq.${gameId}&select=status,state`);
      game = g?.status === 'finished' && Array.isArray(g.state?.cashOuts) ? g : null;
      return !!game;
    }, { timeout: 20_000, message: 'game saved as finished with cash-outs' }).toBe(true);

    const cashOuts = game.state.cashOuts;
    const stacks = cashOuts.reduce((a, c) => a + c.stackCents, 0);
    const buyIns = cashOuts.reduce((a, c) => a + c.buyInCents, 0);
    expect(stacks, 'final stacks add up to the buy-ins').toBe(buyIns);

    const rows = await adminSelect('payout_ledger', `game_id=eq.${gameId}&select=user_id,opponent_id,amount`);
    const total = rows.reduce((a, r) => a + Number(r.amount), 0);
    expect(Math.abs(total), 'ledger nets to zero').toBeLessThan(0.005);
    for (const r of rows) {
      const mirror = rows.find((m) => m.user_id === r.opponent_id && m.opponent_id === r.user_id);
      expect(mirror && Number(mirror.amount), 'every ledger row has its mirror').toBe(-Number(r.amount));
    }
    const anyoneMoved = cashOuts.some((c) => c.netCents !== 0);
    if (anyoneMoved) expect(rows.length, 'ledger rows written').toBeGreaterThan(0);
  });

  for (const p of all) {
    const errors = p.log.filter((l) => l.startsWith('[pageerror]'));
    expect(errors, `${p.name} had no uncaught page errors`).toEqual([]);
  }
  await Promise.all(all.map((p) => p.context.close()));
});
