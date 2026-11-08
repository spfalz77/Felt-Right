// Disconnects and rejoins in a home game (not quitting: the player is still in
// the game, just gone).
//   1. A guest closes the app mid-hand. On their turns the host checks for them
//      if they can, folds them if they face a bet — within a few seconds, not
//      after the full 45s turn limit.
//   2. They open the app again and tap Rejoin: same hand, same stacks, their
//      own cards, and they play on normally.
//   3. They reload the app on their own turn and rejoin: the table carries on.
// Then cash out: they're in the ledger like everyone else.

import { test, expect, devices } from '@playwright/test';
import {
  setupHomeGame, runTable, expectScreensAgree, cashOutAndCheckLedger, expectNoPageErrors,
  adminSelect, closeApp, reopenAndRejoin, tableView,
} from './helpers.mjs';

const PHONES = [devices['iPhone 13'], devices['Pixel 7'], devices['iPhone SE']];
const TOTAL = 3 * 2000;
const AUTO_ACT_LIMIT_MS = 15_000; // grace + host check interval + sync, with room to spare

test('home game: disconnected player is checked/folded quickly, rejoins after closing and after reloading', async ({ browser }) => {
  test.setTimeout(7 * 60_000);
  const { all, host, gameId } = await test.step('sign up, friends, create, invite, join, start', () =>
    setupHomeGame(browser, ['Rae', 'Jon', 'Kit'], PHONES));
  const kit = all[2];
  const live = (views) => views.filter((v, i) => all[i].page && v);
  const handStarted = (n) => (views) => {
    const hv = views[0];
    return hv?.hand === n && hv.stage === 'preflop' && live(views).every((v) => v.hand === n && v.stage === 'preflop' && v.pot === hv.pot);
  };
  const actionsBy = async (p) => (await adminSelect('player_actions', `game_id=eq.${gameId}&player_id=eq.${p.id}&select=id`)).length;
  const screenChips = (p) => p.page.evaluate(() => ({ chips: Object.fromEntries(G.players.map((x) => [x.id, x.chips])), pot: G.pot }));

  // Watches the host's table: how long did each of Kit's turns take while Kit was away?
  const awayTurns = [];
  let turnStartedAt = null;
  const watchKitTurns = async (views) => {
    const hv = views[0];
    if (!hv) return;
    const kitUp = hv.actorId === kit.id && ['preflop', 'flop', 'turn', 'river'].includes(hv.stage);
    if (kitUp && !kit.page && turnStartedAt === null) { turnStartedAt = Date.now(); kit.owed = hv.owe[kit.id]; }
    if (!kitUp && turnStartedAt !== null) {
      awayTurns.push({ ms: Date.now() - turnStartedAt, owed: kit.owed, type: hv.lastType[kit.id], label: hv.lastLabel[kit.id], folded: hv.folded[kit.id] });
      turnStartedAt = null;
    }
  };

  await test.step('hand 1: Kit closes the app; host checks/folds for Kit on each turn, quickly', async () => {
    await runTable({ all, gameId, strategy: () => 'idle', done: handStarted(1) });
    await closeApp(kit);
    await runTable({ all, gameId, onTick: watchKitTurns, done: handStarted(2), strategy: (p, v) => (v.hand >= 2 ? 'idle' : 'checkcall') });
    expect(awayTurns.length, 'Kit had at least one turn while away').toBeGreaterThan(0);
    for (const t of awayTurns) {
      expect(t.ms, `host acted for away Kit within ${AUTO_ACT_LIMIT_MS / 1000}s`).toBeLessThan(AUTO_ACT_LIMIT_MS);
      // Check when checking is allowed; fold when facing a bet or raise
      expect(t.label, 'shown as Away').toBe('Away');
      expect({ type: t.type, folded: t.folded }, `Kit owed ${t.owed} to call`)
        .toEqual(t.owed > 0 ? { type: 'fold', folded: true } : { type: 'check', folded: false });
    }
  });

  await test.step('hand 2: Kit opens the app again and taps Rejoin', async () => {
    await reopenAndRejoin(kit);
    await expect.poll(async () => {
      const [h, k] = [await tableView(host), await tableView(kit)];
      return k && h && k.hand === h.hand && k.stage === h.stage && JSON.stringify(k.chips) === JSON.stringify(h.chips);
    }, { timeout: 15_000, message: "Kit's screen catches up with the host" }).toBe(true);
    const h = await tableView(host);
    if (h.hand === 2 && !h.folded[kit.id] && h.stage !== 'showdown') {
      await expect.poll(async () => (await tableView(kit)).myCards, { timeout: 10_000, message: 'Kit sees their own cards after rejoining' }).toBe(2);
    }
    const before = await actionsBy(kit);
    await runTable({ all, gameId, done: handStarted(3), strategy: (p, v) => (v.hand >= 3 ? 'idle' : 'checkcall') });
    // Kit may have been all checked/folded already in hand 2; hand 3 below makes sure Kit acts
    const views = await Promise.all(all.map(screenChips));
    expectScreensAgree(all, views, TOTAL, 'start of hand 3, after Kit rejoined');
    kit.actionsBeforeHand3 = before;
  });

  await test.step('hand 3: Kit plays normally; Kit reloads the app on their own turn and rejoins', async () => {
    let reloaded = false;
    await runTable({
      all, gameId,
      strategy: (p, v) => (v.hand >= 4 ? 'idle' : 'checkcall'),
      onTick: async (views) => {
        const hv = views[0];
        // Kit's first turn of hand 3: reload instead of acting
        if (!reloaded && hv?.hand === 3 && hv.actorId === kit.id && ['preflop', 'flop', 'turn', 'river'].includes(hv.stage)) {
          reloaded = true;
          await reopenAndRejoin(kit, 'E2E Home Game', { reload: true });
        }
      },
      done: handStarted(4),
    });
    expect(reloaded, 'Kit had a turn in hand 3 to reload on').toBe(true);
    expect(await actionsBy(kit), 'Kit sent moves after rejoining').toBeGreaterThan(kit.actionsBeforeHand3);
    const views = await Promise.all(all.map(screenChips));
    expectScreensAgree(all, views, TOTAL, 'start of hand 4');
    const hv = await tableView(host);
    expect(hv.lastLabel[kit.id], 'Kit is no longer shown as Away').not.toBe('Away');
  });

  await test.step('cash out; Kit is in the ledger like everyone else', async () => {
    const { cashOuts } = await cashOutAndCheckLedger(host, gameId);
    expect(cashOuts.map((c) => c.id).sort()).toEqual(all.map((p) => p.id).sort());
  });

  expectNoPageErrors(all);
  await Promise.all(all.map((p) => p.context.close()));
});
