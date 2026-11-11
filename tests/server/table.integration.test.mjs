// Integration tests for the `table` Edge Function against the local Supabase
// stack (CI: the "server" job in .github/workflows/e2e.yml). Three real
// signed-in users play through the HTTP API; no browser involved.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const URL_ = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !ANON || !SERVICE) throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are required');
if (/dcfsbtefwkcbdeqreiyx/.test(URL_)) throw new Error('Must not run against the live project');

const RUN = Date.now().toString(36);
const cards = (s) => s.trim().split(/\s+/).map((t) => ({ rank: t.slice(0, -1), suit: { s: '♠', h: '♥', d: '♦', c: '♣' }[t.slice(-1)] }));
const BOARD = cards('2c 7d 9h 3s 4d');

async function http(path, { token = ANON, key = ANON, method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${URL_}${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
const admin = (path, opts = {}) => http(path, { ...opts, token: SERVICE, key: SERVICE });

let seq = 0;
async function signUp(name) {
  const r = await http('/auth/v1/signup', { method: 'POST', body: { email: `${name.toLowerCase()}.${RUN}.${++seq}@srv.test`, password: 'srv-password-123', data: { display_name: name } } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { name, id: r.data.user.id, token: r.data.access_token };
}

async function lobby(format, names) {
  const players = [];
  for (const n of names) players.push(await signUp(n));
  const host = players[0];
  const g = await http('/rest/v1/games', {
    token: host.token, method: 'POST', headers: { Prefer: 'return=representation' },
    body: { name: `srv ${format}`, host_id: host.id, status: 'lobby', game_format: format, game_variant: 'holdem',
      blind_config: { levels: format === 'home' ? [{ level: 1, small: 5, big: 10 }] : [{ level: 1, small: 10, big: 20 }], duration: 600, rebuys_enabled: false } },
  });
  assert.equal(g.status, 201, JSON.stringify(g.data));
  const gameId = g.data[0].id;
  for (const [i, p] of players.entries()) {
    const r = await http('/rest/v1/game_players', { token: p.token, method: 'POST', body: { game_id: gameId, user_id: p.id, seat_index: i, status: 'joined' } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
  }
  // Heartbeats, as the app sends them, so nobody counts as gone (app closed)
  const beat = (who) => Promise.all(who.map((p) => http('/rest/v1/game_presence', {
    token: p.token, method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
    body: { game_id: gameId, user_id: p.id, last_seen_at: new Date().toISOString() },
  })));
  await beat(players);
  const t = {
    gameId, players, host, beat,
    call: (p, action, amount, extra = {}) => http('/functions/v1/table', { token: p.token, method: 'POST', body: { game_id: gameId, action, amount, ...extra } }),
    must: async (p, action, amount) => { const r = await t.call(p, action, amount); assert.equal(r.status, 200, `${p.name} ${action}: ${JSON.stringify(r.data)}`); return r.data; },
    state: async (p = host) => (await beat(players.filter((x) => !x.silent)), await http(`/rest/v1/games?id=eq.${gameId}&select=status,hand_number,state`, { token: p.token })).data[0],
    byId: (id) => players.find((p) => p.id === id),
    // Skip the server clock ahead and apply whatever came due
    skip: (ms) => t.must(host, 'clock_offset', ms),
    playHand: async (choose) => {
      for (let i = 0; i < 100; i++) {
        const { state } = await t.state();
        if (!['preflop', 'flop', 'turn', 'river'].includes(state.stage)) return state;
        const actor = state.players[state.actionIndex];
        const [a, amt] = [].concat(choose(t.byId(actor.id), state, actor));
        await t.must(t.byId(actor.id), a, amt);
      }
      throw new Error('hand did not end');
    },
  };
  return t;
}
const checkCall = (p, state, actor) => (state.currentBet > actor.bet ? 'call' : 'check');
const total = (state) => state.players.reduce((a, p) => a + p.chips + (p.cashedOutCents || 0), 0) + state.pot;

before(async () => {
  // Wait for the function to come up
  for (let i = 0; i < 60; i++) {
    const r = await http('/functions/v1/table', { method: 'POST', body: {} }).catch(() => ({ status: 0 }));
    if (r.status === 401 || r.status === 400) return;
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  throw new Error('table function did not start');
});

test('auth and access: signed-out calls, outsiders, non-host start, secrets unreadable', async () => {
  const t = await lobby('tournament', ['Ann', 'Ben', 'Cat']);
  const outsider = await signUp('Mallory');
  assert.equal((await http('/functions/v1/table', { method: 'POST', body: { game_id: t.gameId, action: 'tick' } })).status, 401);
  assert.equal((await t.call(t.players[1], 'start')).status, 403, 'only the host starts');
  assert.equal((await t.call(t.players[1], 'tick')).status, 409, 'not a server game yet');
  await t.must(t.host, 'start');
  assert.equal((await t.call(t.host, 'start')).status, 409, 'cannot start twice');
  assert.equal((await t.call(outsider, 'tick')).status, 403);
  assert.equal((await t.call(outsider, 'fold')).status, 409);
  // Phones cannot read or write the full state
  for (const who of [t.host, outsider]) {
    const r = await http(`/rest/v1/game_secrets?game_id=eq.${t.gameId}&select=state`, { token: who.token });
    assert.ok(r.status >= 400 || (Array.isArray(r.data) && r.data.length === 0), `game_secrets readable: ${JSON.stringify(r.data).slice(0, 80)}`);
  }
  const w = await http('/rest/v1/rpc/save_table', { token: t.host.token, method: 'POST', body: { p_game_id: t.gameId, p_expect_version: 1, p_state: {}, p_public: {} } });
  assert.ok(w.status >= 400, 'save_table is not callable by players');
  assert.ok((await admin(`/rest/v1/game_secrets?game_id=eq.${t.gameId}&select=version`)).data.length === 1);
});

test('tournament hand over HTTP: deal on the clock, private cards, turn checks, showdown, next hand', async () => {
  const t = await lobby('tournament', ['Ann', 'Ben', 'Cat']);
  await t.must(t.host, 'start');
  let s = await t.state();
  assert.equal(s.status, 'active');
  assert.equal(s.state.rules, 'server');
  assert.equal(s.state.handNumber, 0);
  assert.equal(s.state.deck, undefined, 'the deck never leaves the server');
  assert.equal((await t.must(t.host, 'tick')).changed, false, 'not time to deal yet');
  await t.skip(2000);
  s = await t.state();
  assert.equal(s.state.stage, 'preflop');
  assert.equal(s.state.pot, 30);
  assert.ok(s.state.players.every((p) => p.hand.length === 2 && p.hand.every((c) => c.hidden)));
  // Each player can read only their own cards
  for (const p of t.players) {
    const mine = await http(`/rest/v1/private_hands?game_id=eq.${t.gameId}&hand_number=eq.1&select=player_id,cards`, { token: p.token });
    assert.equal(mine.data.length, 1);
    assert.equal(mine.data[0].player_id, p.id);
    assert.equal(mine.data[0].cards.length, 2);
  }
  const actor = t.byId(s.state.players[s.state.actionIndex].id);
  const other = t.players.find((p) => p !== actor);
  const wrong = await t.call(other, 'call');
  assert.equal(wrong.status, 409);
  assert.equal(wrong.data.error, 'not your turn');
  const final = await t.playHand(checkCall);
  assert.equal(final.stage, 'showdown');
  assert.equal(total(final), 4500);
  assert.ok(final.players.every((p) => p.hand.every((c) => c.rank)), 'hands shown at showdown');
  await t.skip(6000);
  s = await t.state();
  assert.equal(s.state.handNumber, 2);
  assert.equal(s.hand_number, 2);
});

test('scripted tournament to the end: side pots, eliminations, game saved as finished', async () => {
  const t = await lobby('tournament', ['Ace', 'Bo', 'Cy']);
  await t.must(t.host, 'start');
  await t.must(t.host, 'rig', { hands: { Ace: cards('As Ah'), Bo: cards('Qc Qd'), Cy: cards('Kc Kd') }, board: BOARD });
  await t.must(t.host, 'rig', { hands: { Ace: cards('As Ah'), Bo: cards('Kc Kd') }, board: BOARD });
  await t.skip(2000);
  let s = await t.playHand((p) => (p.name === 'Bo' ? 'fold' : 'allin'));
  assert.equal(s.players.find((p) => p.name === 'Cy').eliminated, true);
  await t.skip(6000);
  s = await t.playHand(() => 'allin');
  await t.skip(6000);
  const g = await t.state();
  assert.equal(g.status, 'finished');
  assert.deepEqual(g.state.finalPlacements.map((p) => p.name), ['Ace', 'Bo', 'Cy']);
  assert.equal(g.state.players.find((p) => p.name === 'Ace').chips, 4500);
  assert.equal((await t.call(t.host, 'fold')).data.error, 'game is over');

  // The server wrote the Friends Ledger, both sides ($20 buy-in, winner takes all)
  assert.equal(g.state.ledgerRecorded, true);
  const rows = (await admin(`/rest/v1/payout_ledger?game_id=eq.${t.gameId}&select=user_id,opponent_id,amount,note`)).data;
  const net = (name) => rows.filter((r) => r.user_id === t.players.find((p) => p.name === name).id).reduce((a, r) => a + Number(r.amount), 0);
  assert.deepEqual([net('Ace'), net('Bo'), net('Cy')], [40, -20, -20]);
  assert.equal(rows.length, 4);
  for (const r of rows) {
    assert.ok(rows.some((m) => m.user_id === r.opponent_id && m.opponent_id === r.user_id && Number(m.amount) === -Number(r.amount)), 'every row has its mirror');
  }
  assert.ok(rows.every((r) => r.note.startsWith('Tournament')));
});

test('lock-down: phones cannot rewrite a server game; outsiders cannot touch any game', async () => {
  const t = await lobby('tournament', ['Lia', 'Max']);
  const outsider = await signUp('Oz');
  const patch = (who, id, body) => http(`/rest/v1/games?id=eq.${id}`, { token: who.token, method: 'PATCH', headers: { Prefer: 'return=representation' }, body });
  const del = (who, id) => http(`/rest/v1/games?id=eq.${id}`, { token: who.token, method: 'DELETE', headers: { Prefer: 'return=representation' } });

  // Still a lobby (a phone-run game until started): the host may change
  // settings, an outsider may not, and only the host may cancel it
  assert.equal((await patch(t.host, t.gameId, { buy_in_amount: 30 })).data.length, 1, 'host edits own lobby');
  assert.equal((await patch(outsider, t.gameId, { buy_in_amount: 99 })).data.length, 0, 'outsider edit ignored');
  assert.equal((await del(outsider, t.gameId)).data.length, 0, 'outsider delete ignored');
  assert.equal((await del(t.players[1], t.gameId)).data.length, 0, 'guest delete ignored');

  // Started on server rules: nobody's phone can change it, host included
  await t.must(t.host, 'start');
  for (const who of [t.host, t.players[1], outsider]) {
    const r = await patch(who, t.gameId, { state: { rules: 'server', players: [] }, status: 'finished' });
    assert.ok(r.status >= 400 || r.data.length === 0, `${who.name}'s update rejected: ${JSON.stringify(r.data)}`);
  }
  // nor can a phone switch it back to phone rules to get around that
  const sneak = await patch(t.host, t.gameId, { state: { rules: 'phone' } });
  assert.ok(sneak.status >= 400 || sneak.data.length === 0, 'cannot switch a server game to phone rules');
  assert.equal((await del(t.host, t.gameId)).data.length, 0, 'a started game cannot be deleted');

  const g = await t.state();
  assert.equal(g.status, 'active');
  assert.equal(g.state.rules, 'server');
  assert.equal(g.state.players.length, 2);
});

test("home game: dealer's choice, quit takes the stack home, host cash-out writes a balanced ledger", async () => {
  const t = await lobby('home', ['Hal', 'Ivy', 'Jon']);
  await t.must(t.host, 'start');
  await t.must(t.host, 'rig', { hands: { Hal: cards('As Ah'), Ivy: cards('Kc Kd'), Jon: cards('Qc Qd') }, board: BOARD });
  await t.skip(2000);
  let s = (await t.state()).state;
  assert.equal(s.pendingDealerChoice, true);
  const dealer = t.byId(s.dealerId);
  const notDealer = t.players.find((p) => p !== dealer);
  assert.equal((await t.call(notDealer, 'pick_variant', 'holdem')).data.error, 'only the dealer picks');
  await t.must(dealer, 'pick_variant', 'holdem');
  s = await t.playHand(checkCall); // Hal's aces win 30
  assert.equal(s.players.find((p) => p.name === 'Hal').chips, 2020);
  // Jon quits between hands and takes 1990 home
  const jon = t.players[2];
  await t.must(jon, 'quit');
  s = (await t.state()).state;
  assert.equal(s.players.find((p) => p.name === 'Jon').cashedOutCents, 1990);
  assert.equal(total(s), 6000);
  assert.equal((await t.call(t.players[1], 'end_game')).data.error, 'only the host can end the game');
  await t.must(t.host, 'end_game');
  const g = await t.state();
  assert.equal(g.status, 'finished');
  assert.deepEqual(Object.fromEntries(g.state.cashOuts.map((c) => [c.name, c.netCents])), { Hal: 20, Ivy: -10, Jon: -10 });
  const rows = (await admin(`/rest/v1/payout_ledger?game_id=eq.${t.gameId}&select=user_id,amount`)).data;
  const net = (p) => Math.round(rows.filter((r) => r.user_id === p.id).reduce((a, r) => a + Number(r.amount), 0) * 100);
  assert.deepEqual([net(t.players[0]), net(t.players[1]), net(t.players[2])], [20, -10, -10]);
});

test('two moves at once: exactly one is applied (no lost or doubled action)', async () => {
  const t = await lobby('tournament', ['Ann', 'Ben', 'Cat']);
  await t.must(t.host, 'start');
  await t.skip(2000);
  const s = (await t.state()).state;
  const actor = t.byId(s.players[s.actionIndex].id);
  const results = await Promise.all([t.call(actor, 'call'), t.call(actor, 'call'), t.call(actor, 'call')]);
  assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => [r.status, r.data])));
  const after = (await t.state()).state;
  assert.equal(after.pot, 50);
  assert.equal(total(after), 4500);
});

test('turns time out on the server clock; the minute backstop moves tables nobody touches', async () => {
  const t = await lobby('tournament', ['Ann', 'Ben', 'Cat']);
  await t.must(t.host, 'start');
  await t.skip(2000);
  let s = (await t.state()).state;
  const first = s.players[s.actionIndex];
  await t.skip(32_000); // nobody acts
  s = (await t.state()).state;
  const p = s.players.find((x) => x.id === first.id);
  assert.equal(p.folded, true);
  assert.equal(p.lastAction.label, 'Away');
  // Backstop: the service-role tick_all applies the next timeout without any phone asking
  const before = (await t.state()).state.actionIndex;
  const g = await admin(`/rest/v1/game_secrets?game_id=eq.${t.gameId}&select=state`);
  const st = g.data[0].state;
  st.turnDeadline = 1; // already due (0 would mean no deadline)
  await admin(`/rest/v1/game_secrets?game_id=eq.${t.gameId}`, { method: 'PATCH', body: { state: st } });
  const r = await http('/functions/v1/table', { token: SERVICE, key: SERVICE, method: 'POST', body: { action: 'tick_all' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.ticked >= 1);
  assert.notEqual((await t.state()).state.actionIndex, before);
});

test('heartbeats: a player with no heartbeat for 12s is checked/folded 5s into their turn', async () => {
  const t = await lobby('tournament', ['Ann', 'Ben', 'Cat']);
  await t.must(t.host, 'start');
  for (const p of t.players) {
    // (the helpers already send heartbeats, so this is an upsert)
    const r = await http('/rest/v1/game_presence', { token: p.token, method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: { game_id: t.gameId, user_id: p.id } });
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.data));
  }
  // Players can't write someone else's heartbeat
  const forged = await http('/rest/v1/game_presence', { token: t.players[0].token, method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' }, body: { game_id: t.gameId, user_id: t.players[1].id } });
  assert.ok(forged.status >= 400);
  await t.skip(2000);
  let s = (await t.state()).state;
  const actor = t.byId(s.players[s.actionIndex].id);
  actor.silent = true; // their app "closes": no more heartbeats
  // Make the actor's last heartbeat 20s old; skip 5s on the turn
  await admin(`/rest/v1/game_presence?game_id=eq.${t.gameId}&user_id=eq.${actor.id}`, { method: 'PATCH', body: { last_seen_at: new Date(Date.now() - 20_000).toISOString() } });
  await t.skip(5_000);
  s = (await t.state()).state;
  assert.notEqual(s.players[s.actionIndex]?.id, actor.id, 'moved on after 5s');
  assert.equal(s.players.find((p) => p.id === actor.id).lastAction.label, 'Away');
});

test('backstop auth: tick_all needs the shared tick secret (or the service key)', async () => {
  // Generated in Vault by the migration; only the service role can read it
  const got = await admin('/rest/v1/rpc/table_tick_secret', { method: 'POST', body: {} });
  const SECRET = got.data;
  assert.ok(typeof SECRET === 'string' && SECRET.length >= 32, JSON.stringify(got.data));
  const denied = await http('/rest/v1/rpc/table_tick_secret', { method: 'POST', body: {} });
  assert.ok(denied.status >= 400, 'phones cannot read the tick secret');
  const call = (headers) => http('/functions/v1/table', { method: 'POST', headers, body: { action: 'tick_all' } });
  const ok = await call({ 'x-tick-secret': SECRET });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(typeof ok.data.ticked, 'number');
  const wrong = await call({ 'x-tick-secret': SECRET.slice(0, -1) + 'x' });
  assert.equal(wrong.status, 401, 'a wrong secret is just an unsigned-in caller');
  const none = await call({});
  assert.equal(none.status, 401);
});
