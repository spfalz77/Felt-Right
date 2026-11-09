// Tournament first break (re-buys on). Blind levels are set to 1 minute and the
// host's clock is jumped ahead, so the break (after 4 levels) comes right away.
//   - The break pauses the table on every screen.
//   - Cy takes the add-on ($10 → 750 chips); chips on the table go up by 750.
//   - Everyone taps Ready → play resumes and re-buys close.
//   - Bo then busts (scripted all-in against Cy): with re-buys closed Bo is
//     knocked out straight away ("ELIMINATED — 3rd of 3"), no re-buy offered.

import { test, expect, devices } from '@playwright/test';
import { setupHomeGame, runTable, expectNoPageErrors, tableView, cards, rigNextHand, chipsOnTable } from './helpers.mjs';

const PHONES = [devices['iPhone 13'], devices['Pixel 7'], devices['iPhone SE']];
const BOARD = cards('2c 7d 9h 3s 4d');
const allChips = chipsOnTable;

test('tournament break: add-on, everyone ready, re-buys close', async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  const { all, host, gameId } = await test.step('sign up, friends, create tournament (re-buys on, 1-minute levels), start', () =>
    setupHomeGame(browser, ['Ace', 'Bo', 'Cy'], PHONES, {
      format: 'tournament',
      rebuys: true,
      fakeClock: true,
      beforeStart: async (h) => { await h.page.fill('#blind-duration-input', '1'); },
    }));
  const [ace, bo, cy] = all;

  await test.step('4 blind levels pass → the first break starts on every screen', async () => {
    await runTable({ all, gameId, strategy: () => 'idle', done: (views) => views[0]?.hand === 1 && views[0].stage === 'preflop' });
    for (let i = 0; i < 6 && !(await tableView(host)).breakActive; i++) {
      await host.page.clock.fastForward(61_000);
      await host.page.waitForTimeout(1_500);
    }
    expect((await tableView(host)).breakActive, 'break started after 4 levels').toBe(true);
    for (const p of all) {
      await expect(p.page.locator('#break-overlay'), `${p.name} sees the break`).toContainText('BREAK', { timeout: 15_000 });
    }
  });

  await test.step('Cy takes the add-on; everyone taps Ready; play resumes with re-buys closed', async () => {
    const before = allChips(await tableView(host));
    await cy.page.locator('#break-addon-btn').click({ force: true });
    await expect.poll(async () => allChips(await tableView(host)), { timeout: 15_000, message: 'add-on chips on the table' }).toBe(before + 750);
    expect((await tableView(host)).buyIn[cy.id], "Cy's buy-in now includes the add-on ($20 + $10)").toBe(3000);
    for (const p of all) {
      await expect(async () => {
        await p.page.locator('#break-ready-btn').click({ force: true, timeout: 3_000 });
      }).toPass({ timeout: 15_000 });
    }
    await expect.poll(async () => (await tableView(host)).breakActive, { timeout: 15_000, message: 'break over' }).toBe(false);
    expect((await tableView(host)).rebuyClosed, 're-buys closed after the break').toBe(true);
    for (const p of all) await expect(p.page.locator('#break-overlay')).toBeHidden({ timeout: 15_000 });
  });

  await test.step('Bo busts after the break: knocked out, no re-buy offered', async () => {
    const hv = await tableView(host);
    const bustHand = hv.hand + 1; // the current hand finishes first
    await rigNextHand(host, { hands: { Cy: cards('As Ah'), Bo: cards('Kc Kd'), Ace: cards('Qc Qd') }, board: BOARD });
    await runTable({
      all, gameId,
      strategy: (p, v) => (v.hand < bustHand ? 'checkcall' : v.hand > bustHand ? 'idle' : p === ace ? 'fold' : 'allin'),
      done: (views) => views[0]?.broke[bo.id] === true || views[0]?.eliminated[bo.id] === true,
    });
    // Re-buys are closed, so busting means out: no re-buy offer, straight to the result
    const banner = bo.page.locator('#elim-overlay .elim-banner');
    await expect(banner, 'Bo is told they are out').toContainText('ELIMINATED', { timeout: 15_000 });
    await expect(banner).toContainText('3rd of 3');
    await expect(bo.page.locator('#elim-overlay #rebuy-btn'), 'no re-buy offered').toHaveCount(0);
    expect((await tableView(host)).eliminated[bo.id], 'Bo is out').toBe(true);
    expect(allChips(await tableView(host)), 'chips add up (buy-ins + add-on)').toBe(4500 + 750);
  });

  expectNoPageErrors(all);
  await Promise.all(all.map((p) => p.context.close()));
});
