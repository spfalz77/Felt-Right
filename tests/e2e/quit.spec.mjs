// Quitting mid-game (not the same as a disconnect):
//   Home game: the player leaves the table and takes their stack home. The
//     game carries on without them, and they're in the final ledger at the
//     amount they left with.
//   Tournament: the player "blinds out": they stay in, every turn of theirs is
//     checked (if allowed) or folded right away, and their blinds keep coming
//     out of their stack.
// Both are tested with the player quitting on their own turn (the hardest case).

import { test, expect, devices } from '@playwright/test';
import { setupHomeGame, runTable, cashOutAndCheckLedger, expectNoPageErrors, adminSelect, quitGame, tableView } from './helpers.mjs';

const PHONES = [devices['iPhone 13'], devices['Pixel 7'], devices['iPhone SE']];
const BETTING = ['preflop', 'flop', 'turn', 'river'];

// Seated stacks + pot + what quitters took home = everything bought in
function expectChipsAddUp(who, v, total, label) {
  const seated = Object.values(v.chips).reduce((a, b) => a + b, 0);
  const takenHome = Object.values(v.cashedOut).reduce((a, b) => a + (b || 0), 0);
  expect(seated + v.pot + takenHome, `chips add up on ${who}'s screen (${label})`).toBe(total);
}

test('home game: player quits on their turn, takes their stack home, game carries on', async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  const { all, host, gameId } = await test.step('sign up, friends, create, invite, join, start', () =>
    setupHomeGame(browser, ['Quinn', 'Max', 'Zed'], PHONES));
  const zed = all[2];
  const TOTAL = 3 * 2000;
  const seatedViews = (views) => views.filter((v, i) => v && !all[i].offline);
  const handStarted = (n) => (views) => {
    const lv = seatedViews(views);
    return lv.length > 0 && lv.every((v) => v.hand === n && v.stage === 'preflop' && v.pot === lv[0].pot);
  };

  let zedStack = null;
  await test.step('Zed taps Quit on their own turn', async () => {
    await runTable({ all, gameId, strategy: () => 'idle', done: handStarted(1) });
    await runTable({
      all, gameId,
      strategy: (p, v) => (p === zed || v.hand >= 2 ? 'idle' : 'checkcall'),
      onTick: async (views) => {
        const hv = views[0];
        if (zedStack === null && hv?.actorId === zed.id && BETTING.includes(hv.stage) && views[2]?.myTurn) {
          zedStack = hv.chips[zed.id];
          await quitGame(zed);
        }
      },
      done: (views) => zedStack !== null && handStarted(2)(views),
    });
    const hv = await tableView(host);
    expect(hv.eliminated[zed.id], 'Zed has left the table').toBe(true);
    expect(hv.cashedOut[zed.id], 'Zed took home the stack they had when they quit').toBe(zedStack);
    for (const p of all.filter((x) => !x.offline)) expectChipsAddUp(p.name, await tableView(p), TOTAL, 'start of hand 2');
    // Running ledger tally includes Zed (rows exist only if anyone is up or down)
    const rows = await adminSelect('payout_ledger', `game_id=eq.${gameId}&select=amount`);
    expect(Math.abs(rows.reduce((a, r) => a + Number(r.amount), 0)), 'running tally nets to zero').toBeLessThan(0.005);
  });

  await test.step('the other two play on; host cashes out; Zed is in the ledger at what they took home', async () => {
    await runTable({ all, gameId, done: handStarted(3), strategy: (p, v) => (v.hand >= 3 ? 'idle' : 'checkcall') });
    for (const p of all.filter((x) => !x.offline)) expectChipsAddUp(p.name, await tableView(p), TOTAL, 'start of hand 3');
    const { cashOuts } = await cashOutAndCheckLedger(host, gameId);
    expect(cashOuts.find((c) => c.id === zed.id)?.stackCents, "Zed's cash-out").toBe(zedStack);
  });

  expectNoPageErrors(all);
  await Promise.all(all.map((p) => p.context.close()));
});

test('tournament: player quits on their turn and blinds out (checked/folded right away)', async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  const { all, host, gameId } = await test.step('sign up, friends, create tournament, invite, join, start', () =>
    setupHomeGame(browser, ['Tess', 'Abe', 'Wes'], PHONES, { format: 'tournament' }));
  const wes = all[2];
  const TOTAL = 3 * 1500;
  const seatedViews = (views) => views.filter((v, i) => v && !all[i].offline);
  const handStarted = (n) => (views) => {
    const lv = seatedViews(views);
    return lv.length > 0 && lv.every((v) => v.hand === n && v.stage === 'preflop' && v.pot === lv[0].pot);
  };

  const awayTurns = [];
  let turnStartedAt = null;
  let quitAt = null;
  const blindsWhileAway = [];
  const checkedHands = new Set();

  await runTable({ all, gameId, strategy: () => 'idle', done: handStarted(1) });
  await test.step('Wes taps Quit on their own turn; plays continue for 3 hands', async () => {
    await runTable({
      all, gameId,
      strategy: (p, v) => (p === wes || v.hand >= 4 ? 'idle' : 'checkcall'),
      onTick: async (views) => {
        const hv = views[0];
        if (!hv) return;
        if (quitAt === null && hv.actorId === wes.id && BETTING.includes(hv.stage) && views[2]?.myTurn) {
          await quitGame(wes);
          quitAt = Date.now();
          turnStartedAt = quitAt; // this turn is timed from the tap
        }
        if (quitAt === null) return;
        // Time every turn of Wes's while away
        const wesUp = hv.actorId === wes.id && BETTING.includes(hv.stage);
        if (wesUp && turnStartedAt === null) { turnStartedAt = Date.now(); wes.owed = hv.owe[wes.id]; }
        if (!wesUp && turnStartedAt !== null) {
          awayTurns.push({ ms: Date.now() - turnStartedAt, type: hv.lastType[wes.id], folded: hv.folded[wes.id], owed: wes.owed });
          turnStartedAt = null;
        }
        // At each new hand: chips add up; if Wes is a blind, the blind came out of Wes's stack
        if (handStarted(hv.hand)(views) && !checkedHands.has(hv.hand)) {
          checkedHands.add(hv.hand);
          for (const v of seatedViews(views)) expectChipsAddUp('a player', v, TOTAL, `start of hand ${hv.hand}`);
          if (hv.hand > 1 && hv.sbId === wes.id) blindsWhileAway.push(hv.bets[wes.id]);
        }
      },
      done: (views) => quitAt !== null && handStarted(4)(views),
    });
    const hv = await tableView(host);
    expect(hv.away[wes.id], 'Wes is marked away').toBe(true);
    expect(hv.eliminated[wes.id], 'Wes is still in the tournament (blinding out)').toBe(false);
    expect(awayTurns.length, 'Wes had turns while away').toBeGreaterThan(1);
    for (const t of awayTurns) {
      expect(t.ms, 'host acted for Wes right away').toBeLessThan(3_000);
      expect({ type: t.type, folded: t.folded }, `Wes owed ${t.owed}`)
        .toEqual(t.owed > 0 ? { type: 'fold', folded: true } : { type: 'check', folded: false });
    }
    expect(blindsWhileAway.length, 'Wes was small blind once while away').toBeGreaterThan(0);
    for (const b of blindsWhileAway) expect(b, 'small blind taken from Wes').toBeGreaterThan(0);
  });

  expectNoPageErrors(all);
  await Promise.all(all.map((p) => p.context.close()));
});
