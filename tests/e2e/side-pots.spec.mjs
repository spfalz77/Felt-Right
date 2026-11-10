// Side pots with a scripted deal. Three players end up with three different
// stacks, then all go all-in with known cards:
//   shortest stack has the best hand  → wins the main pot (3 × short)
//   middle stack has the 2nd best     → wins the side pot (2 × (mid − short))
//   biggest stack has the worst hand  → gets back only what nobody could call (big − mid)
// Every screen must show exactly those stacks, and the ledger must balance.

import { test, expect, devices } from '@playwright/test';
import {
  setupHomeGame, runTable, expectScreensAgree, cashOutAndCheckLedger, expectNoPageErrors,
  cards, rigNextHand,
} from './helpers.mjs';

const PHONES = [devices['iPhone 13'], devices['Pixel 7'], devices['iPhone SE']];
const TOTAL = 3 * 2000;
const BOARD = cards('2c 7d 9h 3s 4d'); // no straight or flush possible with the hole cards below

test('side pots: three all-ins with different stacks pay out exactly', async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  const { all, host, gameId } = await test.step('sign up, friends, create, invite, join, start', () =>
    setupHomeGame(browser, ['Shelly', 'Marco', 'Bigs'], PHONES));
  const byId = (id) => all.find((p) => p.id === id);

  // Dealer's choice is only picked for the hand this test has queued a deal for
  const allowPick = (hand) => { for (const p of all) p.pickHand = hand; };
  allowPick(0);

  await test.step('hand 1: small blind folds, the other two check it down (makes 3 different stacks)', async () => {
    await rigNextHand(host, { hands: { Shelly: cards('Ks Kh'), Marco: cards('Qs Qh'), Bigs: cards('Js Jh') }, board: BOARD });
    allowPick(1);
    await runTable({
      all, gameId,
      strategy: (p, v) => (v.hand === 1 && v.stage === 'preflop' && v.sbId === p.id ? 'fold' : 'checkcall'),
      done: (views) => views.every((v) => v && v.hand === 2 && v.pendingDealerChoice && v.pot === 0),
    });
  });

  let expected;
  await test.step('hand 2: everyone all-in; best hand on the shortest stack', async () => {
    const start = await Promise.all(all.map((p) => p.page.evaluate(() => Object.fromEntries(G.players.map((x) => [x.id, x.chips])))));
    for (const s of start) expect(s, 'screens agree before the all-in hand').toEqual(start[0]);
    const [short, mid, big] = Object.entries(start[0]).sort((a, b) => a[1] - b[1]);
    expect(new Set([short[1], mid[1], big[1]]).size, `three different stacks: ${JSON.stringify(start[0])}`).toBe(3);

    expected = {
      [short[0]]: 3 * short[1],
      [mid[0]]: 2 * (mid[1] - short[1]),
      [big[0]]: big[1] - mid[1],
    };
    await rigNextHand(host, {
      hands: { [byId(short[0]).name]: cards('As Ah'), [byId(mid[0]).name]: cards('Kc Kd'), [byId(big[0]).name]: cards('Qc Qd') },
      board: BOARD,
    });
    allowPick(2);
    await runTable({
      all, gameId,
      strategy: () => 'allin',
      done: (views) => views.every((v) => v && v.hand === 3 && v.pendingDealerChoice && v.pot === 0),
    });
    const views = await Promise.all(all.map((p) => p.page.evaluate(() => ({
      chips: Object.fromEntries(G.players.map((x) => [x.id, x.chips])), pot: G.pot,
    }))));
    expectScreensAgree(all, views, TOTAL, 'after the all-in hand');
    const named = (o) => Object.fromEntries(Object.entries(o).map(([id, c]) => [byId(id).name, c]));
    expect(named(views[0].chips), 'main pot to the short stack, side pot to the middle, excess back to the big stack')
      .toEqual(named(expected));
  });

  await test.step('cash out; ledger matches the final stacks', async () => {
    // The dealer's-choice screen covers the host's End button, so let hand 3 be
    // dealt first. Cash Out mid-hand gives the blinds back, so stacks are unchanged.
    // Nobody acts in hand 3: a fold could end it (and move the blinds) before Cash Out.
    allowPick(3);
    await runTable({ all, gameId, strategy: () => 'idle', done: (views) => views.every((v) => v?.hand === 3 && v.stage === 'preflop') });
    const { cashOuts } = await cashOutAndCheckLedger(host, gameId);
    for (const c of cashOuts) expect(c.stackCents, `${c.name} cashes out what they hold`).toBe(expected[c.id]);
  });

  expectNoPageErrors(all);
  await Promise.all(all.map((p) => p.context.close()));
});
