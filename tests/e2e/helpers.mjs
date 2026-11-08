// Shared helpers for the multi-player end-to-end tests.
//
// Each "player" is its own browser context (separate login, storage and
// realtime connection), sized like a phone. The app is served straight from the
// built ./index.html with the Supabase URL/key swapped for the local test stack,
// so nothing in src/ needs to know about tests.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';

export const APP_URL = 'http://felt-right.test/Felt-Right/';

const SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!ANON_KEY) throw new Error('SUPABASE_ANON_KEY is not set (run: supabase status -o env)');

// Refuse to run against the live project.
if (/dcfsbtefwkcbdeqreiyx/.test(SUPABASE_URL)) throw new Error('E2E tests must not run against the live project');

const indexPath = fileURLToPath(new URL('../../index.html', import.meta.url));

function appHtml() {
  return readFileSync(indexPath, 'utf8')
    .replace(/const SUPABASE_URL\s*=\s*'[^']*'/, `const SUPABASE_URL = '${SUPABASE_URL}'`)
    .replace(/const SUPABASE_ANON_KEY\s*=\s*'[^']*'/, `const SUPABASE_ANON_KEY = '${ANON_KEY}'`);
}

/** Opens a new phone-sized player session with the app loaded. */
export async function newPlayer(browser, name, deviceOpts) {
  const context = await browser.newContext({ ...deviceOpts, ignoreHTTPSErrors: true });
  const html = appHtml();
  await context.route(`${APP_URL}**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/Felt-Right/' || url.pathname.endsWith('/index.html')) {
      return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  context.on('dialog', (d) => d.accept()); // confirm() prompts
  const page = await context.newPage();
  const log = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') log.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => log.push(`[pageerror] ${e.message}`));
  await page.goto(APP_URL);
  return { name, email: `${name.toLowerCase()}@e2e.test`, context, page, log };
}

export async function signUp(p) {
  const { page } = p;
  await page.evaluate(() => switchTab('signup'));
  await page.fill('#signup-name', p.name);
  await page.fill('#signup-email', p.email);
  await page.fill('#signup-pass', 'e2e-password-123');
  await page.fill('#signup-pass-confirm', 'e2e-password-123');
  await page.locator('#tab-signup button[type=submit]').click();
  await expect(page.locator('#screen-home')).toHaveClass(/active/, { timeout: 15_000 });
  p.id = await page.evaluate(() => me.id);
}

/** requester searches for addressee by name and taps Add; addressee taps Accept. */
export async function makeFriends(requester, addressee) {
  const rp = requester.page;
  await rp.evaluate(() => navTo('friends'));
  await rp.fill('#friend-search', addressee.name);
  const row = rp.locator('#friend-results-list .list-row').filter({ hasText: addressee.name });
  await row.getByRole('button', { name: 'Add' }).click();

  const ap = addressee.page;
  await expect(async () => {
    await ap.evaluate(() => navTo('friends'));
    await expect(ap.locator('#friend-requests-list').getByRole('button', { name: 'Accept' }).first()).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await ap.locator('#friend-requests-list').getByRole('button', { name: 'Accept' }).first().click();
  await expect(ap.locator('#friends-list')).toContainText(requester.name, { timeout: 10_000 });
}

/** Snapshot of the table as one player's screen sees it. */
export function tableView(p) {
  return p.page.evaluate(() => (typeof G === 'undefined' || !G ? null : {
    hand: G.handNumber,
    stage: G.stage,
    variant: G.variant,
    pot: G.pot,
    chips: Object.fromEntries(G.players.map((x) => [x.id, x.chips])),
    myTurn: typeof isMyTurn === 'function' ? isMyTurn() : false,
    actionIndex: G.actionIndex,
    dealerId: G.dealerId,
    pendingDealerChoice: !!G.pendingDealerChoice,
    amHost: typeof amHost !== 'undefined' && amHost,
    overlay: document.getElementById('showdown-overlay')?.dataset.kind || '',
    finished: !!G.tournamentOver,
  }));
}

// The table re-renders the action bar on every timer tick, so buttons never
// count as "stable". Tap without waiting for that, and let the caller retry.
async function tap(locator) {
  try { await locator.click({ force: true, timeout: 2_000 }); return true; } catch { return false; }
}

/**
 * Plays one move on this player's screen if it's their turn, by tapping real
 * buttons: dealer's-choice picks Hold'em, otherwise Check, else Call.
 * Returns a short description of what it did, or null.
 */
export async function botStep(p) {
  const { page } = p;
  const pick = page.locator(`button[onclick="dealerPickedVariant('holdem')"]`);
  if (await pick.isVisible().catch(() => false)) { await tap(pick.first()); return 'picked holdem'; }
  const v = await tableView(p);
  if (!v || !v.myTurn) return null;
  const bar = page.locator('#action-bar');
  const check = bar.locator('button:not([disabled])', { hasText: /^Check$/ });
  if (await check.count()) return (await tap(check.first())) && 'check';
  const call = bar.locator('button:not([disabled])', { hasText: /^Call/ });
  if (await call.count()) return (await tap(call.first())) && 'call';
  return null;
}

/** Service-role REST query against the local stack (bypasses RLS). */
export async function adminSelect(table, query) {
  if (!SERVICE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
  return res.json();
}
