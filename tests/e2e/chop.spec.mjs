// Heads-up chop (tournament). Cy busts in hand 1 (scripted all-in), leaving
// Ace (host) and Bo. On Bo's turn Bo offers a chop; Ace accepts.
// Pool $60 (3 × $20) split in half: Ace $30, Bo $30, Cy $0.
// Every screen shows the chop result; everyone records to the friends ledger:
// Ace +$10, Bo +$10, Cy −$20.

import { test, expect, devices } from '@playwright/test';
import { setupHomeGame, runTable, expectNoPageErrors, adminSelect, tableView, cards, rigNextHand, tapRecordLedger, ledgerRows } from './helpers.mjs';

const PHONES = [devices['iPhone 13'], devices['Pixel 7'], devices['iPhone SE']];
const BOARD = cards('2c 7d 9h 3s 4d');

test('tournament: heads-up chop splits the pool; ledger balances', async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  const { all, host, gameId } = await test.step('sign up, friends, create tournament, start', () =>
    setupHomeGame(browser, ['Ace', 'Bo', 'Cy'], PHONES, {
      format: 'tournament',
      beforeStart: async (h) => {
        await rigNextHand(h, { hands: { Ace: cards('As Ah'), Cy: cards('Kc Kd'), Bo: cards('Qc Qd') }, board: BOARD });
      },
    }));
  const [ace, bo, cy] = all;

  await test.step('hand 1: Cy busts → Ace and Bo heads-up', async () => {
    await runTable({
      all, gameId,
      strategy: (p, v) => (v.hand !== 1 ? 'idle' : p === bo ? 'fold' : 'allin'),
      done: (views) => views[0]?.eliminated[cy.id] === true,
    });
  });

  await test.step("Bo offers a chop on Bo's turn; Ace accepts", async () => {
    await runTable({
      all, gameId,
      strategy: (p, v) => (p === bo ? 'idle' : 'checkcall'),
      done: (views) => views[1]?.myTurn === true && ['preflop', 'flop', 'turn', 'river'].includes(views[1].stage),
    });
    await expect(async () => {
      await bo.page.locator('button[onclick="offerChopShortcut()"]').click({ force: true, timeout: 3_000 });
      await expect(ace.page.locator('button[onclick="acceptChop()"]')).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 20_000 });
    await ace.page.locator('button[onclick="acceptChop()"]').click({ force: true });
    await expect.poll(async () => (await tableView(host)).finished, { timeout: 15_000, message: 'game over by chop' }).toBe(true);
  });

  await test.step('every screen shows the chop result with $30 each; everyone records to the ledger', async () => {
    for (const p of all) {
      const ov = p.page.locator('#tourney-overlay .tourney-result');
      await expect(ov, `${p.name} sees the chop result`).toContainText('Chop', { timeout: 15_000 });
      await expect(ov).toContainText('3,000');
      const rows = ov.locator('.place-row');
      await expect(rows, 'Cy is still listed, 3rd').toHaveCount(3);
      await expect(rows.nth(2)).toContainText('Cy');
      await tapRecordLedger(p);
      await expect(ov).toContainText('Recorded to Standings', { timeout: 10_000 });
    }
    const rows = await ledgerRows(gameId);
    const net = (id) => rows.filter((r) => r.user_id === id).reduce((a, r) => a + Number(r.amount), 0);
    expect({ Ace: net(ace.id), Bo: net(bo.id), Cy: net(cy.id) }).toEqual({ Ace: 10, Bo: 10, Cy: -20 });
  });

  expectNoPageErrors(all);
  await Promise.all(all.map((p) => p.context.close()));
});
