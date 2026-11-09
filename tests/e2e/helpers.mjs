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

// Tests share one database: keep every sign-up unique
const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const indexPath = fileURLToPath(new URL('../../index.html', import.meta.url));

function appHtml() {
  return readFileSync(indexPath, 'utf8')
    .replace(/const SUPABASE_URL\s*=\s*'[^']*'/, `const SUPABASE_URL = '${SUPABASE_URL}'`)
    .replace(/const SUPABASE_ANON_KEY\s*=\s*'[^']*'/, `const SUPABASE_ANON_KEY = '${ANON_KEY}'`);
}

/** Taps Quit on this player's screen (the confirm prompt is accepted). */
export async function quitGame(p) {
  const under = await p.page.evaluate(() => {
    const b = document.getElementById('quit-game-btn');
    const r = b?.getBoundingClientRect();
    const el = r && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { visible: !!r && r.width > 0, top: el ? `${el.tagName}#${el.id}.${el.className}` : null, rect: r && [r.x, r.y, r.width, r.height] };
  });
  await p.page.locator('#quit-game-btn').click({ force: true });
  try {
    await expect(p.page.locator('#screen-home')).toHaveClass(/active/, { timeout: 15_000 });
  } catch (e) {
    const after = await p.page.evaluate(() => ({ screen: document.querySelector('.screen.active')?.id, toast: document.getElementById('toast')?.textContent, stage: G?.stage }));
    throw new Error(`Quit didn't reach the home screen. Under the button: ${JSON.stringify(under)}; now: ${JSON.stringify(after)}`);
  }
  p.offline = true; // bots leave this phone alone from now on
}

/** Opens a new phone-sized player session with the app loaded. */
export async function newPlayer(browser, name, deviceOpts, { fakeClock = false } = {}) {
  const context = await browser.newContext({ ...deviceOpts, ignoreHTTPSErrors: true });
  // Fake clock: time still runs normally, but a test can jump it forward
  // (page.clock.fastForward) to fire turn timers without waiting.
  if (fakeClock) await context.clock.install();
  const html = appHtml();
  await context.route(`${APP_URL}**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/Felt-Right/' || url.pathname.endsWith('/index.html')) {
      return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  context.on('dialog', (d) => d.accept()); // confirm() prompts
  const p = { name, email: `${name.toLowerCase()}.${RUN}@e2e.test`, context, log: [] };
  await openApp(p);
  return p;
}

async function openApp(p) {
  const page = await p.context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning' || /^\[(void-hand|trace)\]/.test(m.text())) p.log.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => p.log.push(`[pageerror] ${e.message}`));
  await page.goto(APP_URL);
  p.page = page;
}

/** Closes the app on this phone (tab gone, like swiping the app away). */
export async function closeApp(p) {
  await p.page.close();
  p.page = null;
  p.offline = true; // bots skip this player
}

/**
 * Opens the app again on the same phone (still signed in), or reloads it, and
 * taps Rejoin on the game card, like a player coming back. Waits until they're
 * at the table.
 */
export async function reopenAndRejoin(p, gameName = 'E2E Home Game', { reload = false } = {}) {
  if (reload) await p.page.reload(); else await openApp(p);
  const { page } = p;
  await expect(page.locator('#screen-home')).toHaveClass(/active/, { timeout: 15_000 });
  const card = page.locator('.game-card').filter({ hasText: gameName });
  await expect(card).toContainText(/Rejoin|Sit Back Down/, { timeout: 15_000 });
  await card.click();
  await expect(page.locator('#screen-game')).toHaveClass(/active/, { timeout: 15_000 });
  p.offline = false;
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
  // Match by user id: names can repeat across runs sharing one database
  await rp.locator(`#friend-results-list button[onclick*="${addressee.id}"]`).click();

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
  if (!p.page) return Promise.resolve(null);
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
    sbId: (() => {
      const live = G.players.filter((x) => !x.eliminated);
      const d = live.findIndex((x) => x.id === G.dealerId);
      return d < 0 ? null : live[(d + 1) % live.length].id;
    })(),
    meId: me.id,
    gutsDecided: !!G.gutsDecisions?.[me.id],
    folded: Object.fromEntries(G.players.map((x) => [x.id, !!x.folded])),
    eliminated: Object.fromEntries(G.players.map((x) => [x.id, !!x.eliminated])),
    away: Object.fromEntries(G.players.map((x) => [x.id, !!x.awayFromTable])),
    cashedOut: Object.fromEntries(G.players.map((x) => [x.id, x.cashedOutCents ?? null])),
    bets: Object.fromEntries(G.players.map((x) => [x.id, x.bet || 0])),
    myCards: (G.players.find((x) => x.id === me.id)?.hand || []).filter((c) => c && c.rank).length,
    screen: document.querySelector('.screen.active')?.id || null,
    // What a finger would hit at the first action button (catches overlays covering the bar)
    barTop: (() => {
      const b = document.querySelector('#action-bar button');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return el === b || b.contains(el) ? 'button' : el ? `${el.tagName}#${el.id}.${String(el.className).slice(0, 40)}` : 'nothing';
    })(),
    overlays: ['showdown-overlay', 'elim-overlay', 'break-overlay', 'tourney-overlay']
      .filter((id) => document.getElementById(id)?.style.display === 'flex'),
    dbg: amHost ? {
      enforcer: typeof _hostTurnEnforcer !== 'undefined' && !!_hostTurnEnforcer,
      online: typeof _onlineIds !== 'undefined' ? [..._onlineIds].map((id) => G.players.find((x) => x.id === id)?.name || id) : null,
      disconnected: G.players.filter((x) => x.disconnected).map((x) => x.name),
      turnAgeMs: G.turnStartAt ? Date.now() - new Date(G.turnStartAt).getTime() : null,
      paused: !!G.paused,
    } : undefined,
    lastType: Object.fromEntries(G.players.map((x) => [x.id, x.lastAction?.type || null])),
    owe: Object.fromEntries(G.players.map((x) => [x.id, Math.max((G.currentBet || 0) - (x.bet || 0), 0)])),
    lastLabel: Object.fromEntries(G.players.map((x) => [x.id, x.lastAction?.label || x.lastAction?.type || null])),
    actorId: G.players[G.actionIndex]?.id || null,
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
 * buttons. `strategy(view)` returns 'allin', 'fold', 'idle' or 'checkcall' (default).
 * Dealer's choice always picks Hold'em (only for hand
 * p.pickHand, if the test set one). Returns what it did, or null.
 */
export async function botStep(p, strategy = () => 'checkcall') {
  const { page } = p;
  const v = await tableView(p);
  const pick = page.locator(`button[onclick="dealerPickedVariant('holdem')"]`);
  if (await pick.isVisible().catch(() => false)) {
    // A test can allow the pick only for one hand number, to set up the deal first
    if (p.pickHand != null && v?.hand !== p.pickHand) return null;
    // A test can choose the variant per hand (p.pickVariants = { 3: 'omaha' })
    const variant = p.pickVariants?.[v?.hand] || 'holdem';
    const btn = page.locator(`button[onclick="dealerPickedVariant('${variant}')"]`);
    await tap(btn.first()); return `picked ${variant}`;
  }
  // 3-Card Guts: everyone decides at once; strategy returns 'in' or 'out'
  if (v?.stage === 'guts_decision' && !v.gutsDecided) {
    const choice = strategy(v);
    if (choice !== 'in' && choice !== 'out') return null;
    const gkey = `${v.hand}:guts`;
    if (p.lastTurnKey === gkey && Date.now() - p.lastTapAt < 5_000) return null;
    p.lastTurnKey = gkey; p.lastTapAt = Date.now();
    const gbtn = page.locator(`button[onclick="gutsDecide('${choice}')"]`);
    return (await tap(gbtn.first())) && `guts ${choice}`;
  }
  if (!v || !v.myTurn || !['preflop', 'flop', 'turn', 'river'].includes(v.stage)) return null;
  const plan = strategy(v);
  if (plan === 'idle') return null; // leave the phone alone (timer tests)
  // One tap per turn: wait for the screen to move on before tapping again
  const turnKey = `${v.hand}:${v.stage}:${v.actionIndex}`;
  if (p.lastTurnKey === turnKey && Date.now() - p.lastTapAt < 5_000) return null;
  p.lastTurnKey = turnKey; p.lastTapAt = Date.now();

  const btn = (action) => page.locator(`#action-bar button[onclick="playerAction('${action}')"]:not([disabled])`);
  for (const action of plan === 'allin' ? ['allin', 'call', 'check'] : plan === 'fold' ? ['fold'] : ['check', 'call']) {
    if (await btn(action).count()) return (await tap(btn(action).first())) && action;
  }
  return null;
}

/**
 * Drives the table until done(views) is true. Every screen's bot plays per
 * strategy(player, view). onTick(views) runs each round (for test setup).
 * Fails with screens + database state if nothing changes for 30s.
 */
export async function runTable({ all, gameId, strategy, onTick, done, timeoutMs = 4 * 60_000, stallMs = 30_000 }) {
  const deadline = Date.now() + timeoutMs;
  let lastProgress = Date.now();
  let lastSig = '';
  while (Date.now() < deadline) {
    for (const p of all) if (!p.offline && p.page) await botStep(p, (v) => (strategy ? strategy(p, v) : 'checkcall'));
    const views = await Promise.all(all.map(tableView));
    if (onTick) await onTick(views);
    if (await done(views)) return views;
    const sig = JSON.stringify(views.map((v) => v && [v.hand, v.stage, v.pot, v.actionIndex]));
    if (sig !== lastSig) { lastSig = sig; lastProgress = Date.now(); }
    if (Date.now() - lastProgress > stallMs) await reportStall(all, gameId, views, `Table stalled for ${stallMs / 1000}s`);
    await new Promise((r) => setTimeout(r, 250));
  }
  await reportStall(all, gameId, await Promise.all(all.map(tableView)), 'Timed out');
}

async function reportStall(all, gameId, views, what = 'Table stalled') {
  const [db] = await adminSelect('games', `id=eq.${gameId}&select=status,hand_number,state`);
  const acts = await adminSelect('player_actions', `game_id=eq.${gameId}&select=player_id,action,amount&order=created_at`);
  const ids = Object.fromEntries(all.map((p) => [p.id, p.name]));
  const logs = all.map((p) => `--- ${p.name}\n${p.log.slice(-30).join('\n')}`).join('\n');
  throw new Error(`${what}.\nscreens: ${JSON.stringify(views.map((v, i) => ({ who: all[i].name, ...v })), null, 1)}`
    + `\ndb: ${JSON.stringify({ status: db.status, hand: db.state?.handNumber, stage: db.state?.stage, pot: db.state?.pot, actionIndex: db.state?.actionIndex, pending: db.state?.pendingDealerChoice, dealer: ids[db.state?.dealerId] })}`
    + `\nactions: ${JSON.stringify(acts.slice(-40).map((a) => [ids[a.player_id], a.action, a.amount]))}\nplayers: ${JSON.stringify(ids)}\n${logs}`);
}

/** Every screen agrees with the host's stacks, and stacks + pot = total. */
export function expectScreensAgree(all, views, total, label) {
  const hv = views[0];
  for (const [i, v] of views.entries()) {
    expect(v.chips, `${all[i].name}'s stacks match the host (${label})`).toEqual(hv.chips);
    const sum = Object.values(v.chips).reduce((a, b) => a + b, 0) + v.pot;
    expect(sum, `chips + pot add up to the buy-ins on ${all[i].name}'s screen (${label})`).toBe(total);
  }
}

/**
 * Three players sign up, become friends, and the first one hosts a home game
 * (or a tournament, with opts.format = 'tournament') the others join. Returns once every screen is at the table.
 */
export async function setupHomeGame(browser, names, phones, opts = {}) {
  const all = await Promise.all(names.map((n, i) => newPlayer(browser, n, phones[i % phones.length], opts)));
  const [host, ...guests] = all;
  for (const p of all) await signUp(p);
  for (const g of guests) await makeFriends(host, g);

  const hp = host.page;
  await hp.evaluate(() => navTo('home'));
  await hp.locator('#screen-home .fab').click();
  await hp.fill('#new-game-name', 'E2E Home Game');
  await hp.locator(opts.format === 'tournament' ? '#format-tournament' : '#format-home').click();
  await hp.getByRole('button', { name: 'Create Game' }).click();
  await expect(hp.locator('#screen-lobby')).toHaveClass(/active/, { timeout: 15_000 });
  const gameId = await hp.evaluate(() => currentLobbyId);
  for (const g of guests) {
    await hp.locator(`#lobby-friend-invite-list button[onclick*="${g.id}"]`).click();
  }
  for (const g of guests) {
    await expect(async () => {
      const banner = g.page.locator('#invite-banner').getByRole('button', { name: 'Join' });
      if (await banner.isVisible()) await banner.click();
      else await g.page.evaluate((id) => openLobby(id), gameId); // same as tapping the game card
      await expect(g.page.locator('#screen-lobby')).toHaveClass(/active/, { timeout: 3_000 });
    }).toPass({ timeout: 30_000 });
  }
  await expect(hp.locator('#lobby-player-count')).toContainText(String(all.length), { timeout: 15_000 });
  if (opts.beforeStart) await opts.beforeStart(host);
  await hp.locator('#lobby-start-btn').click();
  for (const p of all) await expect(p.page.locator('#screen-game')).toHaveClass(/active/, { timeout: 30_000 });
  return { all, host, guests, gameId };
}

/** Host taps End → Cash Out; checks the saved cash-outs and the ledger rows. */
export async function cashOutAndCheckLedger(host, gameId, { endButton = '#host-endgame-btn' } = {}) {
  const hp = host.page;
  await hp.locator(endButton).click({ force: true });
  // The sheet must actually slide up on screen (not just exist in the page)
  await expect(hp.locator('#modal-cashout')).toHaveClass(/open/);
  // Small phones scroll the sheet to reach the button, like a person would
  await hp.locator('#cashout-confirm-btn').scrollIntoViewIfNeeded();
  await expect(hp.locator('#cashout-confirm-btn')).toBeInViewport();
  await hp.locator('#cashout-confirm-btn').click({ timeout: 10_000 });

  let game = null;
  await expect.poll(async () => {
    const [g] = await adminSelect('games', `id=eq.${gameId}&select=status,state`);
    game = g?.status === 'finished' && Array.isArray(g.state?.cashOuts) ? g : null;
    return !!game;
  }, { timeout: 20_000, message: 'game saved as finished with cash-outs' }).toBe(true);

  const cashOuts = game.state.cashOuts;
  const stacks = cashOuts.reduce((a, c) => a + c.stackCents, 0);
  const buyIns = cashOuts.reduce((a, c) => a + c.buyInCents, 0);
  expect(stacks, 'final stacks add up to the buy-ins').toBe(buyIns);

  const rows = await adminSelect('payout_ledger', `game_id=eq.${gameId}&select=user_id,opponent_id,amount`);
  const total = rows.reduce((a, r) => a + Number(r.amount), 0);
  expect(Math.abs(total), 'ledger nets to zero').toBeLessThan(0.005);
  for (const r of rows) {
    const mirror = rows.find((m) => m.user_id === r.opponent_id && m.opponent_id === r.user_id);
    expect(mirror && Number(mirror.amount), 'every ledger row has its mirror').toBe(-Number(r.amount));
  }
  if (cashOuts.some((c) => c.netCents !== 0)) expect(rows.length, 'ledger rows written').toBeGreaterThan(0);
  return { cashOuts, rows };
}

export function expectNoPageErrors(all) {
  for (const p of all) {
    // WebKit reports requests cut off by a reload/close as "access control" errors
    const real = p.log.filter((l) => l.startsWith('[pageerror]') && !/due to access control checks/.test(l));
    expect(real, `${p.name} had no uncaught page errors`).toEqual([]);
  }
}

/** "As Kh 10d" → [{ rank, suit }, ...]. Ten is "10" (as in the app), never "T". */
export const cards = (str) => str.trim().split(/\s+/).map((t) => {
  const rank = t.slice(0, -1);
  const suit = { s: '♠', h: '♥', d: '♦', c: '♣' }[t.slice(-1)];
  if (!['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'].includes(rank) || !suit) throw new Error(`Bad card "${t}"`);
  return { rank, suit };
});

/** Queue a rigged deal on the host's screen (see applyRiggedHand in 16-deal.js). */
export function rigNextHand(host, rig) {
  return host.page.evaluate((r) => { (window.__feltRightRiggedHands ||= []).push(r); }, rig);
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
