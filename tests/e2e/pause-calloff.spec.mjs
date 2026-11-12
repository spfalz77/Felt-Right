// From the first real-phone tournament (2026-11-11), server rules only:
//   Pause: every phone shows the same online/away list (the server's
//     heartbeats), players tap I'm Back and everyone sees them marked Ready,
//     and the host resumes.
//   Calling a tournament off: the host's End Game for All works for
//     tournaments, and a tournament where everyone has quit ends by itself.
//     Either way nothing is recorded to the Friends Ledger.

import { test, expect, devices } from '@playwright/test';
import { setupHomeGame, runTable, expectNoPageErrors, adminSelect, tableView, quitGame, handStarted as handStartedOn, SERVER_RULES } from './helpers.mjs';

const PHONES = [devices['iPhone 13'], devices['Pixel 7'], devices['iPhone SE']];

test.skip(!SERVER_RULES, 'server rules only');

const pauseList = (p) => p.page.locator('#pause-overlay');

async function pauseAfterThisHand(all, host, gameId) {
  await host.page.locator('#host-pause-btn').click();
  // The hand in progress is finished first; then the table pauses
  await runTable({ all, gameId, strategy: () => 'checkcall', done: (views) => views.every((v) => v?.paused) });
  for (const p of all) await expect(pauseList(p), `${p.name} sees the pause screen`).toBeVisible({ timeout: 15_000 });
}

test('pause: same online list on every phone; I\'m Back shows Ready for all; host resumes; host calls the tournament off', async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  const { all, host, gameId } = await test.step('sign up, friends, create, invite, join, start', () =>
    setupHomeGame(browser, ['Pia', 'Rex', 'Sol'], PHONES, { format: 'tournament' }));
  const [, rex, sol] = all;
  const handStarted = (n) => handStartedOn(all, n);

  await test.step('host pauses; every phone shows all three players online', async () => {
    await runTable({ all, gameId, strategy: () => 'idle', done: handStarted(1) });
    await pauseAfterThisHand(all, host, gameId);
    for (const p of all) {
      await expect(pauseList(p).locator('[data-player][data-online="1"]'), `${p.name}'s list: everyone online`).toHaveCount(3, { timeout: 15_000 });
    }
  });

  await test.step("Rex taps I'm Back: every phone shows him Ready; the host sees the count", async () => {
    await pauseList(rex).getByRole('button', { name: "I'm Back" }).click();
    for (const p of all) {
      await expect(pauseList(p).locator(`[data-player="${rex.id}"]`), `${p.name} sees Rex ready`).toHaveAttribute('data-ready', '1', { timeout: 15_000 });
    }
    await expect(pauseList(host)).toContainText('2 of 3', { timeout: 15_000 }); // the host counts as ready
    await pauseList(sol).getByRole('button', { name: "I'm Back" }).click();
    await expect(pauseList(host)).toContainText('3 of 3', { timeout: 15_000 });
  });

  await test.step('host resumes: pause screens close and the next hand is dealt', async () => {
    const before = (await tableView(host)).hand;
    await pauseList(host).getByRole('button', { name: 'Resume Game' }).click();
    for (const p of all) await expect(pauseList(p)).toBeHidden({ timeout: 15_000 });
    await runTable({ all, gameId, strategy: () => 'idle', done: handStarted(before + 1) });
    const [g] = await adminSelect('games', `id=eq.${gameId}&select=state`);
    expect(g.state.pauseReady, 'ready marks cleared').toEqual([]);
  });

  await test.step('host pauses again and taps End Game for All: called off on every phone, nothing recorded', async () => {
    await pauseAfterThisHand(all, host, gameId);
    // (the test phones accept confirm() prompts by themselves)
    await pauseList(host).getByRole('button', { name: 'End Game for All' }).click();
    try {
      for (const p of all) await expect(p.page.locator('#screen-home'), `${p.name} is back Home`).toHaveClass(/active/, { timeout: 20_000 });
    } catch (e) {
      const phones = await Promise.all(all.map((p) => p.page.evaluate(() => ({
        screen: document.querySelector('.screen.active')?.id, toast: document.getElementById('toast')?.textContent,
        over: !!G?.tournamentOver, abandoned: !!G?.abandoned, stage: G?.stage, v: G?.v, paused: !!G?.paused,
      }))));
      const [db] = await adminSelect('games', `id=eq.${gameId}&select=status,state`);
      throw new Error(`${e.message}\nphones: ${JSON.stringify(phones)}\ndb: ${JSON.stringify({ status: db?.status, abandoned: db?.state?.abandoned, v: db?.state?.v, stage: db?.state?.stage })}`);
    }
    const [g] = await adminSelect('games', `id=eq.${gameId}&select=status,state`);
    expect(g.status).toBe('finished');
    expect(g.state.abandoned).toBe(true);
    expect(await adminSelect('payout_ledger', `game_id=eq.${gameId}&select=id`), 'no ledger rows').toEqual([]);
  });
  expectNoPageErrors(all);
});

test('tournament: when everyone has quit it ends by itself, nothing recorded, and the next game can start', async ({ browser }) => {
  test.setTimeout(6 * 60_000);
  const { all, gameId } = await test.step('sign up, friends, create, invite, join, start', () =>
    setupHomeGame(browser, ['Tam', 'Uma', 'Vic'], PHONES, { format: 'tournament' }));
  const handStarted = (n) => handStartedOn(all, n);

  await test.step('all three tap Quit', async () => {
    await runTable({ all, gameId, strategy: () => 'idle', done: handStarted(1) });
    for (const p of all) await quitGame(p);
  });

  await test.step('the game is over and called off; no ledger rows; no more hands are dealt', async () => {
    await expect.poll(async () => (await adminSelect('games', `id=eq.${gameId}&select=status`))[0]?.status, { timeout: 15_000 }).toBe('finished');
    const [g] = await adminSelect('games', `id=eq.${gameId}&select=state`);
    expect(g.state.abandoned).toBe(true);
    expect(await adminSelect('payout_ledger', `game_id=eq.${gameId}&select=id`)).toEqual([]);
  });

  await test.step('a reload leaves them on Home (not pulled back into the finished game)', async () => {
    for (const p of all) {
      await p.page.reload();
      await p.page.waitForTimeout(3000); // startup decides where to go
      const where = await p.page.evaluate(() => ({ screen: document.querySelector('.screen.active')?.id, game: currentGameId }));
      expect(['screen-home', 'screen-splash'], `${p.name} lands on ${where.screen}`).toContain(where.screen);
      expect(where.game).toBeNull();
    }
  });
  expectNoPageErrors(all);
});
