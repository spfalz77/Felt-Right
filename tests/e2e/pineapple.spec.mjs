// Pineapple and Crazy Pineapple (server rules only: the server runs the discards).
// Scripted cards; everyone checks/calls 10¢ and discards their third card (index 2).
//   Hand 1 — Pineapple, discard before betting. Ace keeps A-A, Bo K-K, Cy Q-Q;
//     board 7c 8d 9h Jc 2s → Ace wins 30¢: Ace +20, Bo −10, Cy −10.
//   Hand 2 — Crazy Pineapple, everyone bets with 3 cards, discards after the flop
//     (9h 5h 2c). Ace keeps A-K, Bo 9-9 (trips), Cy Jh-10h; turn 8d, river Kh →
//     Cy's flush wins 30¢: Cy +20, Ace −10, Bo −10.
// Then cash out; the ledger matches.

import { test, expect, devices } from '@playwright/test';
import { setupHomeGame, runTable, cashOutAndCheckLedger, expectNoPageErrors, tableView, cards, rigNextHand, SERVER_RULES } from './helpers.mjs';

const PHONES = [devices['iPhone 13'], devices['Pixel 7'], devices['iPhone SE']];

test('dealer\'s choice: Pineapple and Crazy Pineapple discards and payouts', async ({ browser }) => {
  test.skip(!SERVER_RULES, 'Pineapple variants run on the server engine only');
  test.setTimeout(6 * 60_000);
  const { all, host, gameId } = await test.step('sign up, friends, create, invite, join, start', () =>
    setupHomeGame(browser, ['Ace', 'Bo', 'Cy'], PHONES, {
      beforeStart: async (h) => {
        await rigNextHand(h, { hands: { Ace: cards('As Ah 2c'), Bo: cards('Ks Kh 3c'), Cy: cards('Qs Qh 4d') }, board: cards('7c 8d 9h Jc 2s') });
        await rigNextHand(h, { hands: { Ace: cards('As Kd 3c'), Bo: cards('9s 9d 2h'), Cy: cards('Jh 10h 4c') }, board: cards('9h 5h 2c 8d Kh') });
      },
    }));
  const [ace, bo, cy] = all;
  const byName = (v) => ({ Ace: v.chips[ace.id], Bo: v.chips[bo.id], Cy: v.chips[cy.id] });
  for (const p of all) { p.pickVariants = { 1: 'pineapple', 2: 'crazy_pineapple' }; p.pickHand = 1; }
  const play = (hand) => (p, v) => (v.hand !== hand ? 'idle' : v.stage === 'discard' ? 'discard2' : 'checkcall');

  await test.step('Pineapple: discard first, aces win', async () => {
    await runTable({
      all, gameId, strategy: play(1),
      onTick: async (views) => {
        // While discarding, nobody has action buttons and each phone shows 3 cards to pick from
        for (const [i, v] of views.entries()) {
          if (v?.stage === 'discard' && v.hand === 1) expect(v.actorId, `${all[i].name}: no one on turn while discarding`).toBe(null);
        }
      },
      done: (views) => views.every((v) => v && v.hand === 2 && v.pendingDealerChoice && v.pot === 0),
    });
    for (const p of all) {
      const v = await tableView(p);
      expect(byName(v), `${p.name}'s screen after Pineapple`).toEqual({ Ace: 2020, Bo: 1990, Cy: 1990 });
    }
  });

  await test.step('Crazy Pineapple: discard after the flop, flush wins', async () => {
    for (const p of all) p.pickHand = 2;
    await runTable({
      all, gameId, strategy: play(2),
      done: (views) => views.every((v) => v && v.hand === 3 && v.pendingDealerChoice && v.pot === 0),
    });
    for (const p of all) {
      const v = await tableView(p);
      expect(byName(v), `${p.name}'s screen after Crazy Pineapple`).toEqual({ Ace: 2010, Bo: 1980, Cy: 2010 });
    }
  });

  await test.step('cash out; ledger matches', async () => {
    await expect(host.page.locator('#dc-endgame-btn')).toBeVisible();
    const { cashOuts } = await cashOutAndCheckLedger(host, gameId, { endButton: '#dc-endgame-btn' });
    expect(Object.fromEntries(cashOuts.map((c) => [c.name, c.stackCents]))).toEqual({ Ace: 2010, Bo: 1980, Cy: 2010 });
  });

  expectNoPageErrors(all);
  await Promise.all(all.map((p) => p.context.close()));
});
