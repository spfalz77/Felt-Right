// Turn timers, with a fake clock so nobody waits 30+ seconds:
//   1. A player whose phone is on but who doesn't act: their own 30s timer
//      folds them, and the hand carries on.
//   2. A player whose phone drops off the network on their turn: after 45s the
//      host folds them ("Away") and the table keeps going. When they come back
//      online their screen catches up and they play the next hand normally.

import { test, expect, devices } from '@playwright/test';
import {
  setupHomeGame, runTable, expectScreensAgree, cashOutAndCheckLedger, expectNoPageErrors, movesBy, skipTime,
} from './helpers.mjs';

const PHONES = [devices['iPhone 13'], devices['Pixel 7'], devices['iPhone SE']];
const TOTAL = 3 * 2000;

test('turn timer: idle player auto-folds; dropped player is folded by host, then rejoins', async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  const { all, host, gameId } = await test.step('sign up, friends, create, invite, join, start', () =>
    setupHomeGame(browser, ['Tina', 'Otto', 'Ivy'], PHONES, { fakeClock: true }));
  const byId = (id) => all.find((p) => p.id === id);
  const synced = (views) => views.every((v) => v && v.hand === views[0].hand && v.stage === views[0].stage
    && v.actionIndex === views[0].actionIndex);

  await test.step('hand 1: first player to act does nothing; their own 30s timer folds them', async () => {
    let idler = null;
    let folded = false;
    await runTable({
      all, gameId,
      // Nobody acts pre-flop until the idle player has been timed out
      strategy: (p, v) => (v.hand >= 2 || (v.stage === 'preflop' && !folded) ? 'idle' : 'checkcall'),
      onTick: async (views) => {
        const hv = views[0];
        if (!idler && hv?.hand === 1 && hv.stage === 'preflop' && synced(views)) {
          idler = byId(hv.actorId);
          const iv = views[all.indexOf(idler)];
          if (!iv.myTurn) { idler = null; return; } // their screen hasn't shown the turn yet
          await idler.page.clock.fastForward(31_000);
        }
        if (idler && !folded && hv.folded[idler.id]) folded = true;
      },
      done: (views) => folded && views.every((v) => v && v.hand === 2 && v.stage === 'preflop' && v.pot === views[0].pot),
    });
    const views = await Promise.all(all.map((p) => p.page.evaluate(() => ({ chips: Object.fromEntries(G.players.map((x) => [x.id, x.chips])), pot: G.pot }))));
    expectScreensAgree(all, views, TOTAL, 'start of hand 2');
  });

  let dropped = null;
  await test.step('hand 2: a guest\'s phone drops off on their turn; host folds them after 45s', async () => {
    let awaySeen = false;
    await runTable({
      all, gameId,
      // Guests wait pre-flop until one of them has been taken offline
      strategy: (p, v) => (v.hand >= 3 || (v.stage === 'preflop' && !dropped && p !== host) ? 'idle' : 'checkcall'),
      onTick: async (views) => {
        const hv = views[0];
        if (!dropped && hv?.hand === 2 && hv.stage === 'preflop' && synced(views) && hv.actorId && hv.actorId !== host.id) {
          dropped = byId(hv.actorId);
          dropped.offline = true;
          await dropped.context.setOffline(true);
          await skipTime(host, 46_000);
        }
        if (dropped && !awaySeen && hv.folded[dropped.id]) {
          awaySeen = true;
          expect(hv.lastLabel[dropped.id], 'host marks the dropped player Away').toBe('Away');
          // Bring the phone back before the next hand (they might be the next dealer)
          await dropped.context.setOffline(false);
          dropped.offline = false;
        }
      },
      // Hand 2 finished without the dropped player; hand 3 dealt on every screen
      done: (views) => awaySeen && views.every((v) => v && v.hand === 3 && v.stage === 'preflop' && v.pot === views[0].pot),
    });
    const views = await Promise.all(all.map((p) => p.page.evaluate(() => ({ chips: Object.fromEntries(G.players.map((x) => [x.id, x.chips])), pot: G.pot }))));
    expectScreensAgree(all, views, TOTAL, 'start of hand 3, after the dropped phone came back');
  });

  await test.step('hand 3: the player who dropped plays normally', async () => {
    const before = await movesBy(gameId, dropped);
    await runTable({
      all, gameId,
      strategy: (p, v) => (v.hand >= 4 ? 'idle' : 'checkcall'),
      done: (views) => views.every((v) => v && v.hand === 4 && v.stage === 'preflop' && v.pot === views[0].pot),
    });
    const after = await movesBy(gameId, dropped);
    expect(after, `${dropped.name} sent moves again after reconnecting`).toBeGreaterThan(before);
    const views = await Promise.all(all.map((p) => p.page.evaluate(() => ({ chips: Object.fromEntries(G.players.map((x) => [x.id, x.chips])), pot: G.pot }))));
    expectScreensAgree(all, views, TOTAL, 'start of hand 4');
  });

  await test.step('cash out; ledger balances', () => cashOutAndCheckLedger(host, gameId));
  expectNoPageErrors(all);
  await Promise.all(all.map((p) => p.context.close()));
});
