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

// The host's phone runs the table. If the host closes the app, another player
// takes over after ~25s and the game carries on; when the old host comes back
// they rejoin as a regular player. The new host ends the game.
test('home game: host closes the app, a guest takes over, old host rejoins as a player', async ({ browser }) => {
  test.setTimeout(7 * 60_000);
  const { all, host, gameId } = await test.step('sign up, friends, create, invite, join, start', () =>
    setupHomeGame(browser, ['Hal', 'Gus', 'Liv'], PHONES));
  const live = (views) => views.filter((v, i) => all[i].page && v);
  const handStarted = (n) => (views) => {
    const lv = live(views);
    return lv.length > 0 && lv.every((v) => v.hand === n && v.stage === 'preflop' && v.pot === lv[0].pot);
  };
  const actionsBy = async (p) => (await adminSelect('player_actions', `game_id=eq.${gameId}&player_id=eq.${p.id}&select=id`)).length;
  const screenChips = (p) => p.page.evaluate(() => ({ chips: Object.fromEntries(G.players.map((x) => [x.id, x.chips])), pot: G.pot }));

  await runTable({ all, gameId, strategy: () => 'idle', done: handStarted(1) });

  let newHost;
  await test.step('host closes the app; a guest becomes host and the hand carries on', async () => {
    // Trace host-side calls on the guests' phones (diagnostics for failures)
    for (const g of all.slice(1)) {
      await g.page.evaluate(() => {
        for (const fn of ['dealNewHand', 'voidHandInProgress', 'resumeHostDuties', 'attemptHostMigration', 'nextHand']) {
          const orig = window[fn];
          if (typeof orig !== 'function') continue;
          window[fn] = function (...args) {
            console.info(`[trace] ${fn} amHost=${amHost} stage=${G?.stage} hand=${G?.handNumber} ${(new Error().stack || '').split('\n').slice(1, 4).join(' < ')}`);
            return orig.apply(this, args);
          };
        }
      });
    }
    await closeApp(host);
    await expect.poll(async () => (await adminSelect('games', `id=eq.${gameId}&select=host_id`))[0].host_id,
      { timeout: 60_000, message: 'another player takes over as host' }).not.toBe(host.id);
    const [{ host_id }] = await adminSelect('games', `id=eq.${gameId}&select=host_id`);
    newHost = all.find((p) => p.id === host_id);
    const snap = () => newHost.page.evaluate(() => JSON.stringify({ amHost, stage: G.stage, hand: G.handNumber, pot: G.pot,
      p: G.players.map((x) => [x.name, x.chips, x.totalBet, x.folded, (x.hand || []).map((c) => (c.hidden ? '?' : c.rank)).join('')]) }));
    const snaps = [await snap()];
    for (let i = 0; i < 6; i++) { await new Promise((r) => setTimeout(r, 1000)); snaps.push(await snap()); }
    newHost.snaps = snaps;
    await expect.poll(() => newHost.page.evaluate(() => amHost), { timeout: 15_000, message: `${newHost.name}'s phone runs the table` }).toBe(true);
    await expect(newHost.page.locator('#host-endgame-btn')).toBeVisible({ timeout: 10_000 });
    await runTable({ all, gameId, stallMs: 45_000, done: handStarted(2), strategy: (p, v) => (v.hand >= 2 ? 'idle' : 'checkcall') });
    const order = [newHost, ...all.filter((p) => p !== newHost && p.page)];
    const views = await Promise.all(order.map(screenChips));
    const last = await newHost.page.evaluate(() => (G.handHistory || []).slice(-1)[0]);
    expectScreensAgree(order, views, TOTAL, `start of hand 2, after the takeover hand.\nsnaps:\n${newHost.snaps.join('\n')}\nlogs:\n${all.map((p) => p.name + ': ' + p.log.filter((l) => /void|trace/.test(l)).join(' | ')).join('\n')}`);
  });

  await test.step('old host opens the app again and rejoins as a player', async () => {
    await reopenAndRejoin(host);
    expect(await host.page.evaluate(() => amHost), 'old host is now a regular player').toBe(false);
    await expect.poll(async () => {
      const [h, o] = [await tableView(newHost), await tableView(host)];
      return o && h && o.hand === h.hand && o.stage === h.stage && JSON.stringify(o.chips) === JSON.stringify(h.chips);
    }, { timeout: 15_000, message: "old host's screen catches up" }).toBe(true);
    const before = await actionsBy(host);
    await runTable({ all, gameId, done: handStarted(4), strategy: (p, v) => (v.hand >= 4 ? 'idle' : 'checkcall') });
    expect(await actionsBy(host), 'old host sent moves after rejoining').toBeGreaterThan(before);
    const order = [newHost, ...all.filter((p) => p !== newHost)];
    const views = await Promise.all(order.map(screenChips));
    expectScreensAgree(order, views, TOTAL, 'start of hand 4');
  });

  await test.step('new host cashes out; everyone is in the ledger', async () => {
    const { cashOuts } = await cashOutAndCheckLedger(newHost, gameId);
    expect(cashOuts.map((c) => c.id).sort()).toEqual(all.map((p) => p.id).sort());
  });

  expectNoPageErrors(all);
  await Promise.all(all.map((p) => p.context.close()));
});
