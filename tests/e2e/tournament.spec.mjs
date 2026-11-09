// A tournament played to the end, with scripted cards so it takes two hands:
//   Hand 1: Cy and Ace go all-in, Bo folds. Ace has the better hand → Cy is out (3rd).
//   Hand 2: Ace and Bo go all-in. Ace wins → Bo 2nd, Ace wins the tournament.
// Checks: eliminations on every screen, chips add up, final placements and the
// prize ($20 buy-in × 3 = $60, winner takes all with ≤4 players) on every
// screen, the saved result, and the friends ledger once everyone records it.

import { test, expect, devices } from '@playwright/test';
import { setupHomeGame, runTable, expectNoPageErrors, adminSelect, tableView, cards, rigNextHand } from './helpers.mjs';

const PHONES = [devices['iPhone 13'], devices['Pixel 7'], devices['iPhone SE']];
const TOTAL = 3 * 1500;
const BOARD = cards('2c 7d 9h 3s 4d');

test('tournament: eliminations, final placements, prize and ledger', async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  const { all, host, gameId } = await test.step('sign up, friends, create tournament, invite, join, start', () =>
    setupHomeGame(browser, ['Ace', 'Bo', 'Cy'], PHONES, {
      format: 'tournament',
      beforeStart: async (h) => {
        await rigNextHand(h, { hands: { Ace: cards('As Ah'), Bo: cards('Qc Qd'), Cy: cards('Kc Kd') }, board: BOARD });
        await rigNextHand(h, { hands: { Ace: cards('As Ah'), Bo: cards('Kc Kd') }, board: BOARD });
      },
    }));
  const [ace, bo, cy] = all;
  const sum = (v) => Object.values(v.chips).reduce((a, b) => a + b, 0) + v.pot;

  await test.step('hand 1: Cy all-in against Ace, Bo folds → Cy is out in 3rd', async () => {
    await runTable({
      all, gameId,
      strategy: (p, v) => (v.hand !== 1 ? 'idle' : p === bo ? 'fold' : 'allin'),
      done: (views) => views.every((v) => v && v.eliminated[cy.id]),
    });
    for (const p of all) {
      const v = await tableView(p);
      expect(v.eliminated[cy.id], `${p.name}'s screen shows Cy out`).toBe(true);
      expect(v.chips[cy.id], 'Cy has no chips').toBe(0);
      expect(sum(v), `chips add up on ${p.name}'s screen`).toBe(TOTAL);
    }
    // Cy is told they're out, and where they finished
    await expect(cy.page.locator('#elim-overlay .elim-banner')).toContainText('ELIMINATED', { timeout: 15_000 });
    await expect(cy.page.locator('#elim-overlay .elim-banner')).toContainText('3rd of 3');
  });

  await test.step('hand 2: Ace and Bo all-in → Ace wins the tournament', async () => {
    await runTable({
      all, gameId,
      strategy: (p, v) => (v.hand !== 2 || p === cy ? 'idle' : 'allin'),
      done: (views) => views.every((v) => v && v.finished),
    });
    for (const p of all) {
      // The wrapper has no height; the results panel inside fills the table
      const ov = p.page.locator('#tourney-overlay .tourney-result');
      try {
        await expect(ov, `${p.name} sees the final results`).toBeVisible({ timeout: 15_000 });
      } catch (e) {
        const d = await p.page.evaluate(() => {
          const o = document.getElementById('tourney-overlay');
          const r = o.getBoundingClientRect();
          return { screen: document.querySelector('.screen.active')?.id, display: o.style.display, rect: [r.width, r.height],
            html: o.innerHTML.length, stage: G?.stage, over: G?.tournamentOver, amHost,
            overlays: ['showdown-overlay', 'elim-overlay'].filter((id) => document.getElementById(id)?.style.display === 'flex'),
            sdKind: document.getElementById('showdown-overlay')?.dataset.kind };
        });
        throw new Error(`${p.name} doesn't see the results: ${JSON.stringify(d)}`);
      }
      await expect(ov).toContainText(p === ace ? 'You Won!' : 'Ace Wins!');
      // Placements in order, with the prize next to 1st
      const rows = ov.locator('.place-row');
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0)).toContainText('Ace');
      await expect(rows.nth(0)).toContainText('$60');
      await expect(rows.nth(1)).toContainText('Bo');
      await expect(rows.nth(2)).toContainText('Cy');
    }
    const [g] = await adminSelect('games', `id=eq.${gameId}&select=status,state`);
    expect(g.status, 'game saved as finished').toBe('finished');
    expect(g.state.finalPlacements.map((x) => x.name), 'saved placements').toEqual(['Ace', 'Bo', 'Cy']);
    expect(g.state.players.reduce((a, x) => a + x.chips, 0), 'all chips with the winner').toBe(TOTAL);
  });

  await test.step('everyone records to the friends ledger: Bo and Cy each owe Ace $20', async () => {
    for (const p of all) {
      const btn = p.page.locator('#record-ledger-btn');
      await btn.scrollIntoViewIfNeeded();
      await btn.click();
      await expect(p.page.locator('#tourney-overlay .tourney-result')).toContainText('Recorded to ledger', { timeout: 10_000 });
    }
    const rows = await adminSelect('payout_ledger', `game_id=eq.${gameId}&select=user_id,opponent_id,amount`);
    const net = (id) => rows.filter((r) => r.user_id === id).reduce((a, r) => a + Number(r.amount), 0);
    expect(net(ace.id), 'Ace +$40').toBeCloseTo(40, 2);
    expect(net(bo.id), 'Bo −$20').toBeCloseTo(-20, 2);
    expect(net(cy.id), 'Cy −$20').toBeCloseTo(-20, 2);
    for (const r of rows) {
      const mirror = rows.find((m) => m.user_id === r.opponent_id && m.opponent_id === r.user_id);
      expect(mirror && Number(mirror.amount), 'every ledger row has its mirror').toBe(-Number(r.amount));
    }
  });

  expectNoPageErrors(all);
  await Promise.all(all.map((p) => p.context.close()));
});
