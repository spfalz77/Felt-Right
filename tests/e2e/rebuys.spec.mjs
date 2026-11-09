// Re-buys, with scripted all-ins so players bust on cue.
//   Home game: Cy busts and re-buys ($20 → $20 in chips); Bo busts and sits out.
//     Cash-out must count Cy's $40 total buy-in; the ledger must balance.
//   Tournament with re-buys: Cy busts and re-buys ($10 → 750 chips), the
//     tournament is played to the end. The prize is $20 × 3 + $10 = $70, and
//     the ledger must count Cy's re-buy: Ace +$50, Bo −$20, Cy −$30.

import { test, expect, devices } from '@playwright/test';
import { setupHomeGame, runTable, cashOutAndCheckLedger, expectNoPageErrors, adminSelect, tableView, cards, rigNextHand } from './helpers.mjs';

const PHONES = [devices['iPhone 13'], devices['Pixel 7'], devices['iPhone SE']];
const BOARD = cards('2c 7d 9h 3s 4d');
const allChips = (v) => Object.values(v.chips).reduce((a, b) => a + b, 0) + v.pot;

async function tapOverlay(p, selector, label) {
  const btn = p.page.locator(`#elim-overlay ${selector}`);
  try {
    await expect(btn, `${p.name} is offered: ${label}`).toBeVisible({ timeout: 15_000 });
  } catch (e) {
    const d = await p.page.evaluate(() => {
      const myP = G?.players?.find((x) => x.id === me.id);
      const sd = document.getElementById('showdown-overlay');
      const el = document.getElementById('elim-overlay');
      return { stage: G?.stage, hand: G?.handNumber, broke: myP?.broke, elim: myP?.eliminated, chips: myP?.chips,
        rebuysEnabled: G?.rebuysEnabled, windowClosed: G?.rebuyWindowClosed, format: G?.format,
        sd: sd?.style.display + '/' + sd?.dataset.kind, el: el?.style.display + '/' + (el?.innerText || '').slice(0, 80),
        shown: typeof _rebuyOverlayShown !== 'undefined' ? _rebuyOverlayShown : '?', pending: typeof _rebuyActionPending !== 'undefined' ? _rebuyActionPending : '?' };
    });
    throw new Error(`${p.name} wasn't offered ${label}: ${JSON.stringify(d)}`);
  }
  await btn.click({ force: true });
}

test('home game: bust → re-buy; bust → sit out; cash-out counts every buy-in', async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  const { all, host, gameId } = await test.step('sign up, friends, create, invite, join, start', () =>
    setupHomeGame(browser, ['Hana', 'Ivo', 'Jem'], PHONES, {
      beforeStart: async (h) => {
        await rigNextHand(h, { hands: { Hana: cards('As Ah'), Jem: cards('Kc Kd'), Ivo: cards('Qc Qd') }, board: BOARD });
        await rigNextHand(h, { hands: { Hana: cards('As Ah'), Ivo: cards('Kc Kd'), Jem: cards('Qc Qd') }, board: BOARD });
      },
    }));
  const [hana, ivo, jem] = all;

  await test.step('hand 1: Jem all-in against Hana, loses, and re-buys', async () => {
    await runTable({
      all, gameId,
      strategy: (p, v) => (v.hand !== 1 ? 'idle' : p === ivo ? 'fold' : 'allin'),
      done: (views) => views[0]?.broke[jem.id] === true,
    });
    await tapOverlay(jem, '#rebuy-btn', 'Re-Buy');
    await expect.poll(async () => (await tableView(host)).chips[jem.id], { timeout: 15_000, message: 'Jem has chips again' }).toBe(2000);
    const v = await tableView(host);
    expect(v.buyIn[jem.id], "Jem's total buy-in is now $40").toBe(4000);
    expect(allChips(v), 'chips on the table include the re-buy').toBe(8000);
  });

  await test.step('hand 2: Ivo all-in against Hana, loses, and sits out', async () => {
    await runTable({
      all, gameId,
      strategy: (p, v) => (v.hand !== 2 ? 'idle' : p === jem ? 'fold' : 'allin'),
      done: (views) => views[0]?.broke[ivo.id] === true,
    });
    await tapOverlay(ivo, '#sit-out-btn', 'Sit Out');
    await expect.poll(async () => (await tableView(host)).eliminated[ivo.id], { timeout: 15_000, message: 'Ivo is out' }).toBe(true);
  });

  await test.step('Hana and Jem play a hand; cash out counts every buy-in', async () => {
    await runTable({
      all, gameId,
      strategy: (p, v) => (v.hand === 3 && p !== ivo ? 'checkcall' : 'idle'),
      done: (views) => views[0]?.hand === 4 && views[0].pendingDealerChoice && views[0].pot === 0,
    });
    for (const p of [hana, jem]) expect(allChips(await tableView(p)), `chips add up on ${p.name}'s screen`).toBe(8000);
    const { cashOuts } = await cashOutAndCheckLedger(host, gameId, { endButton: '#dc-endgame-btn' });
    const byName = Object.fromEntries(cashOuts.map((c) => [c.name, c]));
    expect(byName.Jem.buyInCents, "Jem's buy-in includes the re-buy").toBe(4000);
    expect(byName.Ivo.stackCents, 'Ivo left with nothing').toBe(0);
    expect(byName.Ivo.netCents, 'Ivo is down his $20').toBe(-2000);
  });

  expectNoPageErrors(all);
  await Promise.all(all.map((p) => p.context.close()));
});

test('tournament with re-buys: prize pool and ledger include the re-buy', async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  const { all, host, gameId } = await test.step('sign up, friends, create tournament (re-buys on), invite, join, start', () =>
    setupHomeGame(browser, ['Kai', 'Lux', 'Moe'], PHONES, {
      format: 'tournament',
      rebuys: true,
      beforeStart: async (h) => {
        await rigNextHand(h, { hands: { Kai: cards('As Ah'), Moe: cards('Kc Kd'), Lux: cards('Qc Qd') }, board: BOARD });
        await rigNextHand(h, { hands: { Kai: cards('As Ah'), Lux: cards('Kc Kd'), Moe: cards('Qc Qd') }, board: BOARD });
        await rigNextHand(h, { hands: { Kai: cards('As Ah'), Moe: cards('Kc Kd') }, board: BOARD });
      },
    }));
  const [kai, lux, moe] = all;

  await test.step('hand 1: Moe busts and re-buys ($10 → 750 chips)', async () => {
    await runTable({
      all, gameId,
      strategy: (p, v) => (v.hand !== 1 ? 'idle' : p === lux ? 'fold' : 'allin'),
      done: (views) => views[0]?.broke[moe.id] === true,
    });
    await tapOverlay(moe, '#rebuy-btn', 'Re-Buy');
    await expect.poll(async () => (await tableView(host)).chips[moe.id], { timeout: 15_000, message: 'Moe has 750 chips' }).toBe(750);
    expect(allChips(await tableView(host)), 'chips include the re-buy').toBe(4500 + 750);
  });

  await test.step('hand 2: Lux busts and sits out; hand 3: Moe busts again and sits out', async () => {
    await runTable({
      all, gameId,
      strategy: (p, v) => (v.hand !== 2 ? 'idle' : p === moe ? 'fold' : 'allin'),
      done: (views) => views[0]?.broke[lux.id] === true,
    });
    await tapOverlay(lux, '#sit-out-btn', 'Sit Out');
    await runTable({
      all, gameId,
      strategy: (p, v) => (v.hand !== 3 || p === lux ? 'idle' : 'allin'),
      done: (views) => views[0]?.broke[moe.id] === true,
    });
    await tapOverlay(moe, '#sit-out-btn', 'Sit Out');
    await expect.poll(async () => (await tableView(host)).finished, { timeout: 20_000, message: 'tournament over' }).toBe(true);
  });

  await test.step('results: Kai wins the $70 pool; ledger counts the re-buy', async () => {
    for (const p of all) {
      const ov = p.page.locator('#tourney-overlay .tourney-result');
      await expect(ov).toBeVisible({ timeout: 15_000 });
      const rows = ov.locator('.place-row');
      await expect(rows.nth(0)).toContainText('Kai');
      await expect(rows.nth(0), 'prize includes the re-buy').toContainText('$70');
      await expect(rows.nth(1)).toContainText('Moe');
      await expect(rows.nth(2)).toContainText('Lux');
    }
    for (const p of all) {
      const btn = p.page.locator('#record-ledger-btn');
      await btn.scrollIntoViewIfNeeded();
      await btn.click();
      await expect(p.page.locator('#tourney-overlay .tourney-result')).toContainText('Recorded to ledger', { timeout: 10_000 });
    }
    const rows = await adminSelect('payout_ledger', `game_id=eq.${gameId}&select=user_id,opponent_id,amount`);
    const net = (id) => rows.filter((r) => r.user_id === id).reduce((a, r) => a + Number(r.amount), 0);
    expect({ Kai: net(kai.id), Lux: net(lux.id), Moe: net(moe.id) }).toEqual({ Kai: 50, Lux: -20, Moe: -30 });
    expect(Math.abs(rows.reduce((a, r) => a + Number(r.amount), 0)), 'ledger nets to zero').toBeLessThan(0.005);
  });

  expectNoPageErrors(all);
  await Promise.all(all.map((p) => p.context.close()));
});
