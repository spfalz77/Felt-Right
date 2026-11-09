// Dealer's choice variants with scripted cards and exact chip checks.
//   Hand 1 — 3-Card Guts (10¢ ante each):
//     round 1: Ace (pair of aces) and Bo (pair of kings) go in, Cy stays out.
//              Ace wins the 30¢ pot; Bo matches it (30¢) → carried into the next round.
//     round 2: everyone antes again (pot 60¢); only Ace goes in → wins it uncontested.
//     Net: Ace +70, Bo −50, Cy −20.
//   Hand 2 — Omaha (must use exactly 2 of 4 hole cards). Board has four hearts.
//     Ace holds one heart (a flush by Hold'em rules, NOT in Omaha) and a pair of jacks;
//     Bo holds a pair of queens → Bo wins. Everyone checks/calls 10¢ → Bo +20, others −10.
// Then cash out; the ledger matches.

import { test, expect, devices } from '@playwright/test';
import { setupHomeGame, runTable, cashOutAndCheckLedger, expectNoPageErrors, tableView, cards, rigNextHand } from './helpers.mjs';

const PHONES = [devices['iPhone 13'], devices['Pixel 7'], devices['iPhone SE']];
const TOTAL = 3 * 2000;

test('dealer\'s choice: Guts progression and Omaha pay out exactly', async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  const { all, host, gameId } = await test.step('sign up, friends, create, invite, join, start', () =>
    setupHomeGame(browser, ['Ace', 'Bo', 'Cy'], PHONES, {
      beforeStart: async (h) => {
        // Consumed by the first deal of each hand: Guts round 1, then the Omaha hand
        await rigNextHand(h, { hands: { Ace: cards('As Ah 2c'), Bo: cards('Ks Kh 3c'), Cy: cards('4d 7s 9c') }, board: [] });
        await rigNextHand(h, {
          hands: { Ace: cards('Ah Jc Jd 8s'), Bo: cards('Qc Qd 7s 8c'), Cy: cards('10c 10d 4s 4c') },
          board: cards('Kh 9h 6h 3h 2c'),
        });
      },
    }));
  const [ace, bo, cy] = all;
  const byName = (v) => ({ Ace: v.chips[ace.id], Bo: v.chips[bo.id], Cy: v.chips[cy.id] });
  // Guts round 1 is hand 1, round 2 bumps to hand 2; the next dealer's choice is hand 3
  for (const p of all) { p.pickVariants = { 1: 'guts3', 3: 'omaha' }; p.pickHand = 1; }

  await test.step('Guts: two rounds, then the progression ends', async () => {
    await runTable({
      all, gameId,
      strategy: (p, v) => {
        if (v.stage !== 'guts_decision') return 'idle';
        if (v.hand === 1) return p === cy ? 'out' : 'in';
        return p === ace ? 'in' : 'out';
      },
      done: (views) => views.every((v) => v && v.hand === 3 && v.pendingDealerChoice && v.pot === 0),
    });
    for (const p of all) {
      const v = await tableView(p);
      expect(byName(v), `${p.name}'s screen after the Guts hand`).toEqual({ Ace: 2070, Bo: 1950, Cy: 1980 });
    }
  });

  await test.step('Omaha: exactly-two-cards rule decides the winner', async () => {
    for (const p of all) p.pickHand = 3;
    await runTable({
      all, gameId,
      strategy: (p, v) => (v.hand === 3 && v.variant === 'omaha' ? 'checkcall' : 'idle'),
      done: (views) => views.every((v) => v && v.hand === 4 && v.pendingDealerChoice && v.pot === 0),
    });
    for (const p of all) {
      const v = await tableView(p);
      expect(byName(v), `${p.name}'s screen after the Omaha hand (Bo's queens win)`).toEqual({ Ace: 2060, Bo: 1970, Cy: 1970 });
      expect(Object.values(v.chips).reduce((a, b) => a + b, 0), 'chips add up').toBe(TOTAL);
    }
  });

  await test.step('cash out; ledger matches', async () => {
    await expect(host.page.locator('#dc-endgame-btn')).toBeVisible();
    const { cashOuts } = await cashOutAndCheckLedger(host, gameId, { endButton: '#dc-endgame-btn' });
    expect(Object.fromEntries(cashOuts.map((c) => [c.name, c.stackCents]))).toEqual({ Ace: 2060, Bo: 1970, Cy: 1970 });
  });

  expectNoPageErrors(all);
  await Promise.all(all.map((p) => p.context.close()));
});
