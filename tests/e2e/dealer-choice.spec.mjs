// Dealer's choice (home games): the dealer picks Hold'em / Omaha / Guts before
// each hand. If they never pick (stepped away), the host deals Hold'em after
// 25s. And the host can end the game from the picker screen, which covers the
// table's own End button.

import { test, expect, devices } from '@playwright/test';
import { setupHomeGame, runTable, expectScreensAgree, cashOutAndCheckLedger, expectNoPageErrors, skipTime } from './helpers.mjs';

const PHONES = [devices['iPhone 13'], devices['Pixel 7'], devices['iPhone SE']];
const TOTAL = 3 * 2000;

test("dealer's choice: no pick → Hold'em after 25s; host can end the game from the picker", async ({ browser }) => {
  test.setTimeout(5 * 60_000);
  const { all, host, gameId } = await test.step('sign up, friends, create, invite, join, start', () =>
    setupHomeGame(browser, ['Dora', 'Neil', 'Cass'], PHONES, { fakeClock: true }));

  await test.step('hand 1: dealer never picks; host deals Hold\'em after 25s', async () => {
    for (const p of all) p.pickHand = -1; // nobody taps a variant
    await expect.poll(async () => {
      const v = await host.page.evaluate(() => G && { pending: G.pendingDealerChoice, hand: G.handNumber });
      return v?.pending && v.hand === 1;
    }, { timeout: 20_000, message: 'picker is showing for hand 1' }).toBe(true);
    // Every screen shows the picker, and says what happens if nobody picks
    for (const p of all) await expect(p.page.locator('#showdown-overlay')).toContainText("Hold'em is dealt");

    await skipTime(host, 26_000);
    await runTable({
      all, gameId,
      strategy: () => 'idle',
      done: (views) => views.every((v) => v && v.hand === 1 && v.stage === 'preflop' && v.variant === 'holdem' && v.pot === views[0].pot),
    });
    const views = await Promise.all(all.map((p) => p.page.evaluate(() => ({ chips: Object.fromEntries(G.players.map((x) => [x.id, x.chips])), pot: G.pot }))));
    expectScreensAgree(all, views, TOTAL, "hand 1 auto-dealt as Hold'em");
  });

  await test.step('finish hand 1; picker for hand 2 appears', () => runTable({
    all, gameId,
    done: (views) => views.every((v) => v && v.hand === 2 && v.pendingDealerChoice && v.pot === 0),
  }));

  await test.step('host ends the game from the picker screen; ledger balances', async () => {
    await expect(host.page.locator('#dc-endgame-btn')).toBeInViewport();
    await cashOutAndCheckLedger(host, gameId, { endButton: '#dc-endgame-btn' });
    // Ending the game must not leave the auto-deal timer running
    await skipTime(host, 30_000);
    await host.page.waitForTimeout(1_500);
    expect(await host.page.evaluate(() => G.stage), 'no hand dealt after the game ended').toBe('finished');
  });

  expectNoPageErrors(all);
  await Promise.all(all.map((p) => p.context.close()));
});
