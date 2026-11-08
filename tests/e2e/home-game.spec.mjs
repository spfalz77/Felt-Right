// Full multi-player run of a home game on phone-sized screens:
// sign up → friends → create game → invite → join → start → play hands →
// cash out → check the ledger the database wrote.
//
// At the start of every hand it checks that every player's screen agrees with
// the host (stacks) and that no chips were created or lost.

import { test, expect, devices } from '@playwright/test';
import { setupHomeGame, runTable, expectScreensAgree, cashOutAndCheckLedger, expectNoPageErrors } from './helpers.mjs';

const HANDS = Number(process.env.E2E_HANDS || 3);
const PHONES = [devices['iPhone 13'], devices['Pixel 7'], devices['iPhone SE']];

test('home game: 3 players, play hands, cash out, ledger balances', async ({ browser }) => {
  test.setTimeout(5 * 60_000);
  const { all, host, gameId } = await test.step('sign up, friends, create, invite, join, start', () =>
    setupHomeGame(browser, ['Hosty', 'Guesty', 'Pixie'], PHONES));

  const checked = new Set();
  await test.step(`play ${HANDS} hands (check/call down)`, () => runTable({
    all, gameId,
    done: (views) => {
      const hv = views[0];
      const synced = views.every((v) => v && v.hand === hv.hand && v.stage === 'preflop' && v.pot === hv.pot);
      if (hv?.hand > 0 && synced && !checked.has(hv.hand)) {
        expectScreensAgree(all, views, 3 * 2000, `start of hand ${hv.hand}`);
        checked.add(hv.hand);
      }
      return checked.size >= HANDS + 1; // HANDS completed, next one dealt
    },
  }));

  await test.step('host cashes out; database writes a balanced ledger', () => cashOutAndCheckLedger(host, gameId));
  expectNoPageErrors(all);
  await Promise.all(all.map((p) => p.context.close()));
});
