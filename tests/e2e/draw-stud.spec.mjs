// 5-card draw and 5-card stud (server rules only). Scripted cards; everyone checks/calls.
//   Hand 1 — 5-card draw (blinds 5¢/10¢). Ace keeps A-A and draws 3 (Ad Ac 5h → four
//     aces); Bo (trip queens) and Cy (9-high) stand pat. Ace wins 30¢: Ace +20, Bo −10, Cy −10.
//   Hand 2 — 5-card stud: 5¢ antes, Cy's 3♣ is the lowest upcard and brings it in for 5¢,
//     everyone calls, then checks it down. Board ranks never pair or straight anyone, so
//     Ace's aces win 30¢: Ace +20, Bo −10, Cy −10.
// Then cash out; the ledger matches.

import { test, expect, devices } from '@playwright/test';
import { setupHomeGame, runTable, cashOutAndCheckLedger, expectNoPageErrors, tableView, cards, rigNextHand, SERVER_RULES } from './helpers.mjs';

const PHONES = [devices['iPhone 13'], devices['Pixel 7'], devices['iPhone SE']];

test('dealer\'s choice: 5-card draw and 5-card stud pay out exactly', async ({ browser }) => {
  test.skip(!SERVER_RULES, 'Draw and stud run on the server engine only');
  test.setTimeout(6 * 60_000);
  const { all, host, gameId } = await test.step('sign up, friends, create, invite, join, start', () =>
    setupHomeGame(browser, ['Ace', 'Bo', 'Cy'], PHONES, {
      beforeStart: async (h) => {
        await rigNextHand(h, { hands: { Ace: cards('As Ah Kd 7c 2s'), Bo: cards('Qs Qh Qd 4c 3s'), Cy: cards('9s 8s 7s 6s 2h') }, board: cards('Ad Ac 5h') });
        await rigNextHand(h, { hands: { Ace: cards('As Ah'), Bo: cards('2c 3d'), Cy: cards('2d 3c') }, board: cards('7h 8c 9d 10s Jh Qc Kd 4s 6h') });
      },
    }));
  const [ace, bo, cy] = all;
  const byName = (v) => ({ Ace: v.chips[ace.id], Bo: v.chips[bo.id], Cy: v.chips[cy.id] });
  for (const p of all) { p.pickVariants = { 1: 'draw5', 2: 'stud5' }; p.pickHand = 1; }

  await test.step('5-card draw: Ace draws three to four aces', async () => {
    await runTable({
      all, gameId,
      strategy: (p, v) => (v.hand !== 1 ? 'idle' : v.stage === 'draw' ? (p === ace ? 'draw:2,3,4' : 'draw:') : 'checkcall'),
      done: (views) => views.every((v) => v && v.hand === 2 && v.pendingDealerChoice && v.pot === 0),
    });
    for (const p of all) {
      const v = await tableView(p);
      expect(byName(v), `${p.name}'s screen after 5-card draw`).toEqual({ Ace: 2020, Bo: 1990, Cy: 1990 });
    }
  });

  await test.step('5-card stud: bring-in, upcards on every screen, aces win', async () => {
    for (const p of all) p.pickHand = 2;
    let sawUpcards = false;
    await runTable({
      all, gameId,
      strategy: (p, v) => (v.hand === 2 && v.variant === 'stud5' ? 'checkcall' : 'idle'),
      onTick: async () => {
        if (sawUpcards) return;
        // On Bo's phone, Ace's A♥ upcard is face up and his A♠ down card isn't
        const seat = bo.page.locator('.player-seat .stud-up');
        if (await seat.count()) {
          const texts = await seat.allTextContents();
          if (texts.some((t) => t.includes('A♥'))) { expect(texts.some((t) => t.includes('A♠'))).toBe(false); sawUpcards = true; }
        }
      },
      done: (views) => views.every((v) => v && v.hand === 3 && v.pendingDealerChoice && v.pot === 0),
    });
    expect(sawUpcards, 'upcards shown face up on other phones').toBe(true);
    for (const p of all) {
      const v = await tableView(p);
      expect(byName(v), `${p.name}'s screen after 5-card stud`).toEqual({ Ace: 2040, Bo: 1980, Cy: 1980 });
    }
  });

  await test.step('cash out; ledger matches', async () => {
    await expect(host.page.locator('#dc-endgame-btn')).toBeVisible();
    const { cashOuts } = await cashOutAndCheckLedger(host, gameId, { endButton: '#dc-endgame-btn' });
    expect(Object.fromEntries(cashOuts.map((c) => [c.name, c.stackCents]))).toEqual({ Ace: 2040, Bo: 1980, Cy: 1980 });
  });

  expectNoPageErrors(all);
  await Promise.all(all.map((p) => p.context.close()));
});
