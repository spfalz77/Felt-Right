// Unit tests for the server's table engine (supabase/functions/_shared/engine/table.js).
// Whole games are played here in memory: no browser, no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../supabase/functions/_shared/engine/table.js';
import * as payouts from '../supabase/functions/_shared/engine/payouts.js';

const cards = (s) => s.trim().split(/\s+/).map((t) => ({ rank: t.slice(0, -1), suit: { s: '♠', h: '♥', d: '♦', c: '♣' }[t.slice(-1)] }));
const BOARD = cards('2c 7d 9h 3s 4d');

// Small seeded generator so every run plays the same cards
function rngFrom(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

function table({ format = 'tournament', names = ['Ace', 'Bo', 'Cy'], seed = 1, rebuys = false, buyIn = 20 } = {}) {
  const ctx = { now: 1_000_000, rng: rngFrom(seed), hostId: names[0], allowTestHooks: true, effects: {} };
  const G = T.newGame({
    seats: names.map((n) => ({ id: n, name: n })), format, rebuysEnabled: rebuys, buyIn,
    blindLevels: format === 'home' ? [{ level: 1, small: 5, big: 10 }] : undefined, blindDuration: 600,
  }, ctx);
  if (format !== 'home') G.blindLevels = [{ level: 1, small: 10, big: 20 }, { level: 2, small: 15, big: 30 }];
  const api = {
    G, ctx,
    act: (who, action, amount) => T.applyAction(G, who, action, amount, ctx),
    must: (who, action, amount) => { const r = api.act(who, action, amount); assert.ok(r.ok, `${who} ${action}: ${r.error}`); },
    wait: (ms) => { ctx.now += ms; return T.tick(G, ctx); },
    actor: () => G.players[G.actionIndex]?.id,
    chips: () => Object.fromEntries(G.players.map((p) => [p.id, p.chips])),
    total: () => G.players.reduce((a, p) => a + p.chips + (p.cashedOutCents || 0), 0) + G.pot,
    // Everyone on action does `fn(player)` until the hand ends
    playHand: (fn) => { let guard = 0; while (T.isBetting(G) && guard++ < 200) { const who = api.actor(); const [a, amt] = [].concat(fn(who)); api.must(who, a, amt); } api.runout(); },
    // All-in: the board comes one card per RUNOUT_CARD_MS
    runout: () => { let guard = 0; while (G.stage === 'runout' && guard++ < 10) api.wait(T.RUNOUT_CARD_MS); },
    // Next hand: at the deal time (the result waits for everyone's OK, else RESULT_MAX_MS)
    deal: () => { api.runout(); api.wait(G.nextDealAt ? Math.max(G.nextDealAt - ctx.now, 0) : T.NEXT_HAND_MS); if (G.pendingDealerChoice) api.must(G.dealerId, 'pick_variant', 'holdem'); },
  };
  return api;
}
const checkCall = (t) => () => (t.G.currentBet > t.G.players[t.G.actionIndex].bet ? 'call' : 'check');

test('tournament: first hand is dealt on the clock, blinds posted, cards hidden from phones', () => {
  const t = table();
  assert.equal(t.G.handNumber, 0);
  assert.equal(t.wait(T.FIRST_DEAL_MS - 1), false);
  assert.equal(t.wait(1), true);
  assert.equal(t.G.stage, 'preflop');
  assert.equal(t.G.pot, 30);
  assert.equal(t.total(), 4500);
  const pub = T.redact(t.G);
  assert.equal(pub.deck, undefined);
  assert.ok(pub.players.every((p) => p.hand.length === 2 && p.hand.every((c) => c.hidden)));
  assert.equal(T.privateHands(t.G).length, 3);
});

test('turn order and legality: wrong player, check facing a bet, outsiders', () => {
  const t = table(); t.deal();
  const first = t.actor();
  const other = t.G.players.find((p) => p.id !== first).id;
  assert.equal(t.act(other, 'call').error, 'not your turn');
  assert.match(t.act(first, 'check').error, /cannot check/);
  assert.equal(t.act('Mallory', 'fold').error, 'not in this game');
  t.must(first, 'call');
  assert.notEqual(t.actor(), first);
});

test('check/call a hand to showdown: chips conserved, result recorded, next hand on the clock', () => {
  const t = table(); t.deal();
  t.playHand(checkCall(t));
  assert.equal(t.G.stage, 'showdown');
  assert.equal(t.G.community.length, 5);
  assert.equal(t.G.pot, 0);
  assert.equal(t.total(), 4500);
  assert.equal(Object.values(t.G.lastResult.winnings).reduce((a, b) => a + b, 0), 60);
  assert.ok(T.redact(t.G).players.every((p) => p.hand.every((c) => c.rank)), 'hands shown at showdown');
  assert.ok(t.G.players.every((p) => p.bet === 0), 'chips in front went to the pot (and the winner)');
  assert.equal(t.wait(T.RESULT_MAX_MS - 1), false, 'the result stays up while nobody has tapped OK');
  t.wait(1);
  assert.equal(t.G.handNumber, 2);
  assert.equal(t.G.stage, 'preflop');
});

test('the result stays up until everyone at the table taps OK, then the next hand comes', () => {
  const t = table(); t.deal();
  t.playHand(checkCall(t));
  assert.equal(t.G.stage, 'showdown');
  t.must('Ace', 'result_ok');
  t.must('Bo', 'result_ok');
  assert.equal(t.wait(T.RESULT_ACK_DEAL_MS), false, 'still waiting on Cy');
  t.must('Cy', 'result_ok');
  assert.equal(t.wait(T.RESULT_ACK_DEAL_MS - 1), false);
  t.wait(1);
  assert.equal(t.G.handNumber, 2);
  t.must('Ace', 'result_ok'); // a late tap mid-hand changes nothing
  assert.equal(t.G.stage, 'preflop');
  // A player whose app is gone isn't waited for
  t.playHand(checkCall(t));
  t.ctx.isGone = (id) => id === 'Cy';
  t.must('Ace', 'result_ok');
  t.must('Bo', 'result_ok');
  t.wait(T.RESULT_ACK_DEAL_MS);
  assert.equal(t.G.handNumber, 3);
  // ...nor one who goes after the others tapped
  t.ctx.isGone = () => false;
  t.playHand(checkCall(t));
  t.must('Ace', 'result_ok');
  t.must('Bo', 'result_ok');
  assert.equal(t.wait(1000), false);
  t.ctx.isGone = (id) => id === 'Cy';
  assert.equal(t.wait(1), true);
  t.wait(T.RESULT_ACK_DEAL_MS);
  assert.equal(t.G.handNumber, 4);
});

test('home game: a player who quits during the all-in runout leaves the pot to the other', () => {
  const t = table({ format: 'home', names: ['Ace', 'Bo'] });
  homeAtPicker(t);
  t.must(t.G.dealerId, 'pick_variant', 'holdem');
  t.must(t.actor(), 'allin');
  t.must(t.actor(), 'call');
  assert.equal(t.G.stage, 'runout');
  t.must('Bo', 'quit');
  assert.equal(t.G.stage, 'showdown');
  assert.equal(t.G.players.find((p) => p.id === 'Ace').chips, 4000);
});

test('all-in: hands face up, the board comes one card every RUNOUT_CARD_MS, then the showdown', () => {
  const t = table({ names: ['Ace', 'Bo'] });
  T.queueRig(t.G, { hands: { Ace: cards('As Ah'), Bo: cards('Kc Kd') }, board: BOARD }, t.ctx);
  t.deal();
  t.must(t.actor(), 'allin');
  t.must(t.actor(), 'call');
  assert.equal(t.G.stage, 'runout');
  assert.equal(t.G.community.length, 0);
  assert.ok(t.G.players.every((p) => p.bet === 0), 'bets pulled into the pot');
  assert.ok(T.redact(t.G).players.every((p) => p.hand.every((c) => c.rank)), 'hands face up during the runout');
  for (let n = 1; n <= 4; n++) {
    assert.equal(t.wait(T.RUNOUT_CARD_MS - 1), false);
    t.wait(1);
    assert.equal(t.G.community.length, n);
    assert.equal(t.G.stage, 'runout');
  }
  t.wait(T.RUNOUT_CARD_MS);
  assert.equal(t.G.community.length, 5);
  assert.equal(t.G.stage, 'showdown');
  assert.equal(t.total(), 3000);
  assert.ok(t.G.recentMoves.some((m) => m.label === 'All In'), 'moves logged for sounds');
});

test('everyone folds to one player: they win the pot and cards stay hidden', () => {
  const t = table(); t.deal();
  t.playHand(() => 'fold');
  assert.equal(t.G.stage, 'showdown');
  assert.equal(t.G.wonByFold, true);
  assert.equal(t.total(), 4500);
  assert.ok(T.redact(t.G).players.every((p) => p.hand.every((c) => c.hidden)));
});

test('side pots: three all-ins with different stacks pay out exactly', () => {
  const t = table();
  const [a, b, c] = ['Ace', 'Bo', 'Cy'].map((n) => t.G.players.find((p) => p.id === n));
  a.chips = 1000; b.chips = 1500; c.chips = 2000; // short stack has the best hand
  T.queueRig(t.G, { hands: { Ace: cards('As Ah'), Bo: cards('Kc Kd'), Cy: cards('Qc Qd') }, board: BOARD }, t.ctx);
  t.deal();
  t.playHand(() => 'allin');
  assert.deepEqual(t.chips(), { Ace: 3000, Bo: 1000, Cy: 500 });
  assert.equal(t.G.lastResult.pots.length, 2);
});

test('an all-in for less than the bet does not lower the bet to match', () => {
  const t = table();
  T.queueRig(t.G, { hands: { Ace: cards('As Ah'), Bo: cards('Kc Kd'), Cy: cards('Qc Qd') }, board: BOARD }, t.ctx);
  t.deal();
  const order = [t.actor()];
  t.must(order[0], 'raise', 400);
  const second = t.actor();
  t.G.players.find((p) => p.id === second).chips = 100 - t.G.players.find((p) => p.id === second).bet; // short stack
  t.must(second, 'allin');
  assert.equal(t.G.currentBet, 400);
  const third = t.actor();
  assert.notEqual(third, order[0], 'the raiser is not asked to act again by a short all-in');
  t.must(third, 'call');
  assert.equal(t.G.players.find((p) => p.id === third).totalBet, 400);
});

test('raise amounts: minimum raise enforced, capped at all-in', () => {
  const t = table(); t.deal();
  const who = t.actor();
  t.must(who, 'raise', 1); // below the minimum → bumped to 2× the bet
  assert.equal(t.G.currentBet, 40);
  const next = t.actor();
  t.must(next, 'raise', 999999);
  assert.equal(t.G.players.find((p) => p.id === next).chips, 0);
  assert.equal(t.G.currentBet, 1500);
});

test('tournament to the end: eliminations, placements, winner holds every chip', () => {
  const t = table();
  T.queueRig(t.G, { hands: { Ace: cards('As Ah'), Bo: cards('Qc Qd'), Cy: cards('Kc Kd') }, board: BOARD }, t.ctx);
  T.queueRig(t.G, { hands: { Ace: cards('As Ah'), Bo: cards('Kc Kd') }, board: BOARD }, t.ctx);
  t.deal();
  t.playHand((who) => (who === 'Bo' ? 'fold' : 'allin'));
  assert.equal(t.G.players.find((p) => p.id === 'Cy').eliminated, true);
  t.deal();
  t.playHand(() => 'allin');
  assert.equal(t.G.tournamentOver, undefined, 'the result shows first');
  t.wait(T.RESULT_MAX_MS);
  assert.equal(t.G.tournamentOver, true);
  assert.deepEqual(t.G.finalPlacements.map((p) => p.name), ['Ace', 'Bo', 'Cy']);
  assert.equal(t.G.players.find((p) => p.id === 'Ace').chips, 4500);
  assert.equal(t.act('Ace', 'fold').error, 'game is over');
});

test('tournament blinds go up on the clock', () => {
  const t = table(); t.deal();
  t.playHand(() => 'fold');
  t.ctx.now += 600_000;
  t.deal();
  assert.equal(t.G.blindLevel, 1);
  assert.equal(t.G.currentBet, 30);
});

test("home game: dealer's choice, auto Hold'em after 25s, only the dealer picks", () => {
  const t = table({ format: 'home' });
  t.wait(T.FIRST_DEAL_MS);
  assert.equal(t.G.pendingDealerChoice, true);
  assert.equal(t.G.handNumber, 1);
  const notDealer = t.G.players.find((p) => p.id !== t.G.dealerId).id;
  assert.equal(t.act(notDealer, 'pick_variant', 'omaha').error, 'only the dealer picks');
  assert.equal(t.wait(T.DEALER_CHOICE_MS - 1), false);
  assert.equal(t.wait(1), true);
  assert.equal(t.G.variant, 'holdem');
  assert.equal(t.G.stage, 'preflop');
  assert.equal(t.G.pot, 15);
  t.playHand(() => 'fold');
  t.wait(T.RESULT_MAX_MS);
  t.must(t.G.dealerId, 'pick_variant', 'omaha');
  assert.ok(t.G.players.every((p) => p.hand.length === 4));
});

test('home game: bust → re-buy or sit out; the table waits, then sits out after 60s', () => {
  const t = table({ format: 'home' });
  T.queueRig(t.G, { hands: { Ace: cards('As Ah'), Bo: cards('Kc Kd'), Cy: cards('Qc Qd') }, board: BOARD }, t.ctx);
  t.deal();
  t.playHand(() => 'allin');
  assert.deepEqual(t.chips(), { Ace: 6000, Bo: 0, Cy: 0 });
  assert.equal(t.wait(T.RESULT_MAX_MS), false, 'waits for the decisions');
  t.must('Bo', 'rebuy');
  assert.equal(t.G.players.find((p) => p.id === 'Bo').totalBuyInCents, 4000);
  assert.equal(t.wait(1000), false, 'still waiting on Cy');
  t.wait(T.REBUY_DECISION_MS);
  assert.equal(t.G.players.find((p) => p.id === 'Cy').eliminated, true);
  assert.equal(t.G.handNumber, 2);
  assert.equal(t.total(), 8000);
});

test('tournament with re-buys: half buy-in for half the starting chips', () => {
  const t = table({ rebuys: true });
  T.queueRig(t.G, { hands: { Ace: cards('As Ah'), Bo: cards('Qc Qd'), Cy: cards('Kc Kd') }, board: BOARD }, t.ctx);
  t.deal();
  t.playHand((who) => (who === 'Bo' ? 'fold' : 'allin'));
  const cy = t.G.players.find((p) => p.id === 'Cy');
  assert.equal(cy.broke, true);
  t.must('Cy', 'rebuy');
  assert.equal(cy.chips, 750);
  assert.equal(cy.totalBuyInCents, 3000);
});

test('home game: quitting on your turn takes your stack home; the bet stays in the pot', () => {
  const t = table({ format: 'home' }); t.deal();
  const bb = t.G.players[t.G.bbIdx];
  while (t.actor() !== bb.id) t.must(t.actor(), 'call');
  t.must(bb.id, 'quit');
  assert.equal(bb.cashedOutCents, 1990);
  assert.equal(bb.eliminated, true);
  assert.equal(t.ctx.effects.settle, true);
  assert.equal(t.total(), 6000);
  t.playHand(checkCall(t));
  assert.equal(t.total(), 6000);
  assert.equal(t.G.stage, 'showdown');
});

test('tournament: quitting blinds you out (checked or folded at once, still in)', () => {
  const t = table(); t.deal();
  const who = t.actor();
  t.must(who, 'quit');
  const p = t.G.players.find((x) => x.id === who);
  assert.equal(p.awayFromTable, true);
  assert.equal(p.folded, true, 'faced the big blind → folded');
  assert.equal(p.eliminated, false);
  t.playHand(checkCall(t));
  for (let i = 0; i < 3; i++) { t.deal(); assert.notEqual(t.actor(), who, 'never waits on the away player'); t.playHand(checkCall(t)); }
  assert.equal(t.total(), 4500);
  t.must(who, 'sit_back');
  assert.equal(p.awayFromTable, false);
});

test('home game: host ends the game mid-hand; the hand is voided and cash-outs add up', () => {
  const t = table({ format: 'home' }); t.deal();
  t.must(t.actor(), 'call');
  assert.equal(t.act('Bo', 'end_game').error, 'only the host can end the game');
  t.must('Ace', 'end_game');
  assert.equal(t.G.tournamentOver, true);
  assert.equal(t.G.cashOuts.reduce((a, c) => a + c.stackCents, 0), 6000);
  assert.ok(t.G.cashOuts.every((c) => c.netCents === 0));
  assert.equal(t.ctx.effects.settle, true);
});

test('500 random hands never create or lose a chip, and never stall', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const format = seed % 2 ? 'tournament' : 'home';
    const names = ['A', 'B', 'C', 'D', 'E'].slice(0, 2 + (seed % 4));
    const t = table({ format, names, seed });
    const start = names.length * (format === 'home' ? 2000 : 1500);
    const pick = rngFrom(seed * 7919);
    let bought = 0;
    for (let h = 0; h < 20 && !t.G.tournamentOver; h++) {
      t.deal();
      for (const p of t.G.players.filter((x) => x.broke && !x.eliminated)) { // home games: half re-buy, half sit out
        if (pick() < 0.5) { t.must(p.id, 'rebuy'); bought += 2000; } else t.must(p.id, 'sit_out');
      }
      if (!T.isBetting(t.G)) { t.deal(); }
      if (!T.isBetting(t.G)) break; // one stack left
      t.playHand(() => {
        const r = pick();
        const p = t.G.players[t.G.actionIndex];
        const owes = t.G.currentBet > p.bet;
        if (r < 0.12) return 'fold';
        if (r < 0.2) return 'allin';
        if (r < 0.35) return ['raise', Math.floor(pick() * 400)];
        if (r < 0.45) return 'pot';
        return owes ? 'call' : 'check';
      });
      assert.equal(t.G.stage, 'showdown', `seed ${seed} hand ${h} ended`);
      assert.equal(t.total(), start + bought, `seed ${seed} hand ${h}: chips conserved`);
      assert.ok(t.G.players.every((p) => p.chips >= 0), 'no negative stacks');
    }
  }
});

// ── Phase 3: Guts, break + add-on, chop, pause, show/muck ──────────────────

function homeAtPicker(t) {
  t.wait(T.FIRST_DEAL_MS);
  assert.equal(t.G.pendingDealerChoice, true);
}

test('Guts progression: two in → match the pot; next round one in → takes it all', () => {
  const t = table({ format: 'home' });
  T.queueRig(t.G, { hands: { Ace: cards('As Ah 2c'), Bo: cards('Ks Kh 3c'), Cy: cards('4d 7s 9c') }, board: [] }, t.ctx);
  homeAtPicker(t);
  t.must(t.G.dealerId, 'pick_variant', 'guts3');
  assert.equal(t.G.stage, 'guts_decision');
  assert.equal(t.G.pot, 30);
  assert.ok(T.redact(t.G).players.every((p) => p.hand.length === 3 && p.hand.every((c) => c.hidden)));
  t.must('Ace', 'guts_in');
  assert.equal(t.act('Ace', 'guts_out').error, 'already decided');
  t.must('Bo', 'guts_in');
  assert.equal(t.G.stage, 'guts_decision', 'waits for everyone');
  t.must('Cy', 'guts_out');
  assert.equal(t.G.stage, 'showdown');
  assert.deepEqual(t.chips(), { Ace: 2020, Bo: 1960, Cy: 1990 });
  assert.equal(t.G.pot, 30, "Bo's match carries to the next round");
  const shown = T.redact(t.G).players;
  assert.ok(shown.find((p) => p.id === 'Cy').hand.every((c) => c.hidden), 'an out player keeps their cards hidden');
  assert.ok(shown.find((p) => p.id === 'Bo').hand.every((c) => c.rank));
  t.wait(T.RESULT_MAX_MS);
  assert.equal(t.G.pendingDealerChoice, false, 'same dealer, no new pick');
  assert.equal(t.G.stage, 'guts_decision');
  assert.equal(t.G.handNumber, 2);
  assert.equal(t.G.pot, 60);
  t.must('Ace', 'guts_in'); t.must('Bo', 'guts_out'); t.must('Cy', 'guts_out');
  assert.equal(t.G.gutsResults.progressionEnded, true);
  assert.deepEqual(t.chips(), { Ace: 2070, Bo: 1950, Cy: 1980 });
  t.wait(T.RESULT_MAX_MS);
  assert.equal(t.G.pendingDealerChoice, true, 'progression over → next dealer picks');
  assert.equal(t.G.handNumber, 3);
  assert.equal(t.total(), 6000);
});

test('Guts: nobody in → re-ante and new cards; 20s with no answer counts as out', () => {
  const t = table({ format: 'home' });
  homeAtPicker(t);
  t.must(t.G.dealerId, 'pick_variant', 'guts3');
  ['Ace', 'Bo', 'Cy'].forEach((n) => t.must(n, 'guts_out'));
  assert.equal(t.G.stage, 'guts_decision');
  assert.equal(t.G.pot, 60);
  assert.equal(t.G.handNumber, 2);
  t.must('Ace', 'guts_in');
  assert.equal(t.wait(19_999), false);
  assert.equal(t.wait(1), true);
  assert.equal(t.G.stage, 'showdown');
  assert.equal(t.G.gutsResults.uncontested, true);
  assert.equal(t.chips().Ace, 2040);
  assert.equal(t.total(), 6000);
});

test('Guts: 200 random rounds never create or lose a chip', () => {
  const pick = rngFrom(4242);
  const t = table({ format: 'home', names: ['A', 'B', 'C', 'D'], seed: 9 });
  let bought = 0;
  for (let r = 0; r < 200; r++) {
    t.wait(T.RESULT_MAX_MS);
    for (const p of t.G.players.filter((x) => x.broke && !x.eliminated)) { t.must(p.id, 'rebuy'); bought += 2000; }
    t.wait(T.RESULT_MAX_MS);
    if (t.G.pendingDealerChoice) t.must(t.G.dealerId, 'pick_variant', 'guts3');
    if (t.G.stage !== 'guts_decision') continue;
    for (const p of t.G.players) if (!t.G.gutsDecisions[p.id] && t.G.stage === 'guts_decision' && p.hand.length && !p.broke && !p.eliminated) t.act(p.id, pick() < 0.5 ? 'guts_in' : 'guts_out');
    assert.equal(t.total(), 8000 + bought, `round ${r}`);
    assert.ok(t.G.players.every((p) => p.chips >= 0));
  }
});

test('tournament break after 4 levels: add-on once, everyone ready ends it, re-buys close', () => {
  const t = table({ rebuys: true });
  t.deal();
  for (let i = 0; i < 4; i++) { t.ctx.now += 600_000; T.tick(t.G, t.ctx); }
  assert.equal(t.G.breakActive, true);
  assert.equal(t.G.blindLevel, 4);
  const who = t.actor();
  assert.equal(t.act(who, 'call').error, 'on a break');
  t.ctx.now += 3_600_000;
  T.tick(t.G, t.ctx);
  assert.equal(t.G.blindLevel, 4, 'blind clock stopped during the break');
  t.must('Cy', 'add_on');
  assert.equal(t.act('Cy', 'add_on').error, 'add-on already used');
  assert.equal(t.G.players.find((p) => p.id === 'Cy').totalBuyInCents, 3000);
  assert.equal(t.total(), 4500 + 750);
  t.must('Ace', 'break_ready'); t.must('Bo', 'break_ready');
  assert.equal(t.G.breakActive, true);
  t.must('Cy', 'break_ready');
  assert.equal(t.G.breakActive, false);
  assert.equal(t.G.rebuyWindowClosed, true);
  t.must(t.actor(), 'call'); // the hand carries on
  t.playHand(() => 'allin');
  // With re-buys closed, a bust is a knockout
  assert.ok(t.G.players.every((p) => !p.broke));
});

test('host ends the break; nobody else can', () => {
  const t = table({ rebuys: true });
  t.deal();
  t.G.levelStartedAt -= 4 * 600_000;
  T.tick(t.G, t.ctx);
  assert.equal(t.G.breakActive, true);
  assert.equal(t.act('Bo', 'break_end').error, 'only the host can end the break');
  t.must('Ace', 'break_end');
  assert.equal(t.G.breakActive, false);
});

test('heads-up chop: offer, decline, offer again, accept → placements by chips, game over', () => {
  const t = table();
  T.queueRig(t.G, { hands: { Ace: cards('As Ah'), Bo: cards('Qc Qd'), Cy: cards('Kc Kd') }, board: BOARD }, t.ctx);
  t.deal();
  assert.equal(t.act('Bo', 'chop_offer').error, 'chop is for the last two players');
  t.playHand((who) => (who === 'Bo' ? 'fold' : 'allin'));
  t.deal();
  t.must('Bo', 'chop_offer');
  assert.equal(t.act('Bo', 'chop_accept').error, 'waiting for the other player');
  t.must('Ace', 'chop_decline');
  assert.equal(t.G.chopOfferedBy, null);
  t.must('Bo', 'chop_offer');
  t.must('Ace', 'chop_accept');
  assert.equal(t.G.tournamentOver, true);
  assert.deepEqual(t.G.finalPlacements.map((p) => p.name), ['Ace', 'Bo', 'Cy']);
  assert.equal(t.total(), 4500, 'the hand in progress was voided first');
});

test('pause: mid-hand it waits for the hand to end; only the host resumes', () => {
  const t = table(); t.deal();
  t.must('Bo', 'pause');
  assert.equal(t.G.pauseQueued, true);
  t.playHand(() => 'fold');
  assert.equal(t.G.paused, true);
  assert.equal(t.wait(60_000), false, 'nothing deals while paused');
  assert.equal(t.act('Bo', 'resume').error, 'only the host can do that');
  t.must('Ace', 'resume');
  t.wait(T.RESUME_DEAL_MS);
  assert.equal(t.G.stage, 'preflop');
  assert.equal(t.G.handNumber, 2);
});

test('show or muck: fold winner shows chosen cards; folded player reveals theirs', () => {
  const t = table(); t.deal();
  const order = [];
  t.playHand((who) => { order.push(who); return order.length < 3 ? 'fold' : 'check'; });
  const winner = t.G.players.find((p) => !p.folded);
  const folded = t.G.players.find((p) => p.folded);
  assert.equal(T.redact(t.G).players.find((p) => p.id === winner.id).hand[0].hidden, true);
  t.must(winner.id, 'reveal', [1]);
  assert.deepEqual(t.G.revealedHands[winner.id], [winner.hand[1]]);
  t.must(folded.id, 'reveal');
  assert.equal(t.G.revealedHands[folded.id].length, 2);
  t.must(winner.id, 'muck');
  assert.equal(t.G.winnerMucked, true);
});

// ── Phase 4: turn deadlines and gone players ──────────────────────────────

test('a turn runs out after 32s: check if allowed, else fold (shown Away)', () => {
  const t = table(); t.deal();
  const first = t.actor();
  assert.equal(t.wait(T.TURN_MS - 1), false);
  assert.equal(t.wait(1), true);
  const p = t.G.players.find((x) => x.id === first);
  assert.equal(p.folded, true, 'facing the big blind → fold');
  assert.equal(p.lastAction.label, 'Away');
  // Everyone left times out too: the big blind can check, so the hand goes on
  while (T.isBetting(t.G)) t.wait(T.TURN_MS);
  assert.equal(t.G.stage, 'showdown');
  assert.equal(t.total(), 4500);
});

test('a gone player on turn is checked/folded after 5s, a present one gets the full 32s', () => {
  const t = table(); t.deal();
  const first = t.actor();
  let away = new Set();
  t.ctx.isGone = (id) => away.has(id);
  assert.equal(t.wait(T.AWAY_GRACE_MS), false, 'present: still waiting');
  away = new Set([first]);
  assert.equal(t.wait(0), true, 'gone and already 5s in');
  assert.notEqual(t.actor(), first);
  const second = t.actor();
  away = new Set([first, second]);
  assert.equal(t.wait(T.AWAY_GRACE_MS - 1), false);
  assert.equal(t.wait(1), true);
  assert.notEqual(t.actor(), second);
});

test('gone dealer → Hold\'em after 5s; gone busted player → sat out at the next deal', () => {
  const t = table({ format: 'home' });
  t.wait(T.FIRST_DEAL_MS);
  const dealer = t.G.dealerId;
  t.ctx.isGone = (id) => id === dealer;
  assert.equal(t.wait(T.AWAY_GRACE_MS - 1), false);
  assert.equal(t.wait(1), true);
  assert.equal(t.G.variant, 'holdem');
  assert.equal(t.G.stage, 'preflop');

  const u = table({ format: 'home' });
  T.queueRig(u.G, { hands: { Ace: cards('As Ah'), Bo: cards('Kc Kd'), Cy: cards('Qc Qd') }, board: BOARD }, u.ctx);
  u.deal();
  u.playHand(() => 'allin');
  u.ctx.isGone = (id) => id === 'Cy';
  u.must('Bo', 'rebuy');
  u.wait(T.RESULT_MAX_MS);
  assert.equal(u.G.players.find((p) => p.id === 'Cy').eliminated, true);
  assert.equal(u.G.handNumber, 2);
});

test('tournament: when everyone still in has quit, it is called off; hand voided, nothing recorded', () => {
  const t = table(); t.deal();
  const ids = t.G.players.map((p) => p.id);
  t.must(ids[0], 'quit');
  t.must(ids[1], 'quit');
  assert.equal(t.G.tournamentOver, undefined, 'one player left at the table: the game goes on');
  t.must(ids[2], 'quit');
  assert.equal(t.G.tournamentOver, true);
  assert.equal(t.G.abandoned, true);
  assert.equal(t.G.stage, 'finished');
  assert.equal(t.G.pot, 0);
  assert.equal(t.total(), 4500, 'bets went back: no chip created or lost');
  assert.equal(t.wait(T.RESULT_MAX_MS * 10), false, 'no more hands are dealt');
  t.G.finalPlacements = [{ name: 'Ace' }, { name: 'Bo' }, { name: 'Cy' }];
  assert.deepEqual(payouts.tournamentLedger(t.G), [], 'nothing goes to the Friends Ledger');
});

test('tournament: the host can end it (called off); nobody else can', () => {
  const t = table(); t.deal();
  assert.equal(t.act('Bo', 'end_game').error, 'only the host can end the game');
  t.must('Ace', 'end_game');
  assert.equal(t.G.abandoned, true);
  assert.equal(t.G.tournamentOver, true);
  assert.equal(t.total(), 4500);
});

test("pause: players tap I'm back; the list clears when the game resumes", () => {
  const t = table(); t.deal();
  t.playHand(checkCall(t));
  assert.match(t.act('Bo', 'pause_ready').error, /not paused/);
  t.must('Bo', 'pause');
  assert.equal(t.G.paused, true);
  t.must('Bo', 'pause_ready');
  t.must('Cy', 'pause_ready');
  t.must('Cy', 'pause_ready'); // twice is fine
  assert.deepEqual(t.G.pauseReady, ['Bo', 'Cy']);
  t.must('Ace', 'resume');
  assert.deepEqual(t.G.pauseReady, []);
});

// ── Pineapple / Crazy Pineapple ────────────────────────────────────────────

// Every player still to discard throws away card `idx` (or lets the clock pick)
const discardAll = (t, idx = 0) => {
  for (const p of t.G.players.filter((x) => !x.folded && !x.eliminated && x.hand.length === 3)) t.must(p.id, 'discard', idx);
};

test('Pineapple: 3 cards, everyone discards 1 before any betting, then plays as Hold\'em', () => {
  const t = table({ format: 'home' });
  homeAtPicker(t);
  t.G.rig.push({ hands: { Ace: cards('As Ah 2d'), Bo: cards('Ks Kh 3d'), Cy: cards('Qs Qh 4d') }, board: cards('7c 8d 9h Jc 2s') });
  t.must(t.G.dealerId, 'pick_variant', 'pineapple');
  assert.equal(t.G.stage, 'discard');
  assert.ok(t.G.players.every((p) => p.hand.length === 3));
  assert.equal(t.G.pot, 15, 'blinds are in');
  assert.equal(t.G.actionIndex, -1);
  assert.equal(t.act('Ace', 'call').error, 'no betting round in progress');
  assert.equal(t.act('Ace', 'discard', 3).error, 'pick a card to discard');
  const seq = t.G.dealSeq;
  t.must('Ace', 'discard', 2);
  assert.equal(t.G.dealSeq, seq + 1, 'phones re-read their cards');
  assert.equal(t.act('Ace', 'discard', 0).error, 'nothing to discard');
  assert.equal(T.redact(t.G).players.find((p) => p.id === 'Ace').hand.length, 2);
  t.must('Bo', 'discard', 2);
  assert.equal(t.G.stage, 'discard', 'waits for everyone');
  t.must('Cy', 'discard', 2);
  assert.equal(t.G.stage, 'preflop');
  assert.ok(t.actor());
  t.playHand(checkCall(t));
  assert.equal(t.G.stage, 'showdown');
  assert.ok(t.G.players.every((p) => p.hand.length === 2));
  assert.deepEqual(Object.keys(t.G.lastResult.winnings).filter((id) => t.G.lastResult.winnings[id] > 0), ['Ace']);
  assert.equal(t.total(), 6000);
});

test('Pineapple: no pick in 20s → the engine discards (keeps the pair); gone players after 5s', () => {
  const t = table({ format: 'home' });
  homeAtPicker(t);
  t.G.rig.push({ hands: { Ace: cards('As Ah Kd'), Bo: cards('2s 7h 7d'), Cy: cards('Qs Jh 3d') } });
  t.must(t.G.dealerId, 'pick_variant', 'pineapple');
  // A gone player is picked for after 5s, the others keep waiting
  t.ctx.isGone = (id) => id === 'Cy';
  assert.equal(t.wait(T.AWAY_GRACE_MS - 1), false);
  assert.equal(t.wait(1), true);
  assert.deepEqual(t.G.players.find((p) => p.id === 'Cy').hand.map((c) => c.rank), ['Q', 'J']);
  assert.equal(t.G.stage, 'discard');
  t.ctx.isGone = null;
  t.wait(T.DISCARD_MS - T.AWAY_GRACE_MS);
  assert.equal(t.G.stage, 'preflop');
  assert.deepEqual(t.G.players.find((p) => p.id === 'Ace').hand.map((c) => c.rank), ['A', 'A']);
  assert.deepEqual(t.G.players.find((p) => p.id === 'Bo').hand.map((c) => c.rank), ['7', '7']);
  assert.equal(t.G.discards.Ace, 'auto');
});

test('Crazy Pineapple: bet with 3 cards, discard after the flop, flop betting starts left of the dealer', () => {
  const t = table({ format: 'home' });
  homeAtPicker(t);
  t.must(t.G.dealerId, 'pick_variant', 'crazy_pineapple');
  assert.equal(t.G.stage, 'preflop');
  assert.ok(t.G.players.every((p) => p.hand.length === 3));
  assert.equal(t.act(t.actor(), 'discard', 0).error, 'no discard in progress');
  t.playHand(checkCall(t)); // stops when betting stops: at the discard
  assert.equal(t.G.stage, 'discard');
  assert.equal(t.G.community.length, 3);
  discardAll(t, 1);
  assert.equal(t.G.stage, 'flop');
  const dealerIdx = t.G.players.findIndex((p) => p.isDealer);
  assert.equal(t.G.actionIndex, (dealerIdx + 1) % 3);
  t.playHand(checkCall(t));
  assert.equal(t.G.stage, 'showdown');
  assert.ok(t.G.players.every((p) => p.hand.length === 2));
  assert.equal(t.total(), 6000);
});

test('Crazy Pineapple: all-in preflop → flop, discard, then run it out', () => {
  const t = table({ format: 'home', names: ['Ace', 'Bo'] });
  homeAtPicker(t);
  t.must(t.G.dealerId, 'pick_variant', 'crazy_pineapple');
  t.must(t.actor(), 'allin');
  t.must(t.actor(), 'call');
  assert.equal(t.G.stage, 'discard');
  assert.equal(t.G.community.length, 3);
  discardAll(t, 0);
  assert.equal(t.G.stage, 'runout');
  t.runout();
  assert.equal(t.G.stage, 'showdown');
  assert.equal(t.G.community.length, 5);
  assert.equal(t.total(), 4000);
});

test('Crazy Pineapple: a fold win before the flop needs no discard', () => {
  const t = table({ format: 'home' });
  homeAtPicker(t);
  t.must(t.G.dealerId, 'pick_variant', 'crazy_pineapple');
  t.playHand(() => 'fold');
  assert.equal(t.G.stage, 'showdown');
  assert.equal(t.G.wonByFold, true);
});

test('Pineapple: quitting during the discard (home) — last one left wins; tournament quitter is auto-discarded', () => {
  const t = table({ format: 'home', names: ['Ace', 'Bo'] });
  homeAtPicker(t);
  t.must(t.G.dealerId, 'pick_variant', 'pineapple');
  t.must('Ace', 'quit');
  assert.equal(t.G.stage, 'showdown');
  assert.equal(t.total(), 4000);

  const u = table({ names: ['Ace', 'Bo', 'Cy'] });
  u.G.variant = 'pineapple';
  u.wait(T.FIRST_DEAL_MS);
  assert.equal(u.G.stage, 'discard');
  u.must('Bo', 'quit');
  assert.equal(u.G.players.find((p) => p.id === 'Bo').hand.length, 2);
  u.must('Ace', 'discard', 0); u.must('Cy', 'discard', 0);
  assert.equal(u.G.stage, 'preflop');
});

test('tournament can be Pineapple or Crazy Pineapple; Guts stays home-only', () => {
  const ctx = { now: 0, rng: rngFrom(3), effects: {} };
  const seats = [{ id: 'a' }, { id: 'b' }];
  assert.equal(T.newGame({ seats, format: 'tournament', variant: 'crazy_pineapple' }, ctx).variant, 'crazy_pineapple');
  assert.equal(T.newGame({ seats, format: 'tournament', variant: 'pineapple' }, ctx).variant, 'pineapple');
  assert.equal(T.newGame({ seats, format: 'tournament', variant: 'guts3' }, ctx).variant, 'holdem');
});

test('pause asked during a discard waits for the hand to end', () => {
  const t = table({ format: 'home' });
  homeAtPicker(t);
  t.must(t.G.dealerId, 'pick_variant', 'pineapple');
  t.must('Bo', 'pause');
  assert.equal(t.G.pauseQueued, true);
  assert.equal(t.G.paused, undefined);
});

test('Pineapple variants: 300 random hands never create or lose a chip, and never stall', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const names = ['A', 'B', 'C', 'D', 'E', 'F'].slice(0, 2 + (seed % 5));
    const t = table({ format: 'home', names, seed });
    const pick = rngFrom(seed * 104729);
    let bought = 0;
    for (let h = 0; h < 15; h++) {
      t.wait(T.RESULT_MAX_MS);
      for (const p of t.G.players.filter((x) => x.broke && !x.eliminated)) { t.must(p.id, 'rebuy'); bought += 2000; }
      if (!t.G.pendingDealerChoice) t.wait(T.RESULT_MAX_MS);
      if (!t.G.pendingDealerChoice) break;
      t.must(t.G.dealerId, 'pick_variant', seed % 2 ? 'pineapple' : 'crazy_pineapple');
      let guard = 0;
      while ((T.isBetting(t.G) || t.G.stage === 'discard') && guard++ < 300) {
        if (t.G.stage === 'discard') {
          if (pick() < 0.3) t.wait(T.DISCARD_MS); else discardAll(t, Math.floor(pick() * 3));
          continue;
        }
        const who = t.actor();
        const p = t.G.players[t.G.actionIndex];
        const r = pick();
        const a = r < 0.12 ? 'fold' : r < 0.2 ? 'allin' : r < 0.35 ? ['raise', Math.floor(pick() * 400)] : (t.G.currentBet > p.bet ? 'call' : 'check');
        t.must(who, ...[].concat(a));
      }
      t.runout();
      assert.equal(t.G.stage, 'showdown', `seed ${seed} hand ${h} ended`);
      assert.equal(t.total(), names.length * 2000 + bought, `seed ${seed} hand ${h}: chips conserved`);
      if (!t.G.wonByFold) assert.ok(t.G.players.filter((p) => !p.folded && !p.eliminated).every((p) => p.hand.length === 2), 'everyone at showdown kept 2');
    }
  }
});

// ── 5-card draw ────────────────────────────────────────────────────────────

test('5-card draw: bet, everyone draws at once, bet again left of the dealer, best 5 wins', () => {
  const t = table({ format: 'home' });
  homeAtPicker(t);
  t.G.rig.push({
    hands: { Ace: cards('As Ah Kd 7c 2s'), Bo: cards('Qs Qh Qd 4c 3s'), Cy: cards('9s 8s 7s 6s 2h') },
    board: cards('Ad Ac 5h 5d Jh Jc 2d'), // replacement cards, in the order they're drawn
  });
  t.must(t.G.dealerId, 'pick_variant', 'draw5');
  assert.equal(t.G.stage, 'preflop');
  assert.equal(t.G.pot, 15);
  assert.ok(t.G.players.every((p) => p.hand.length === 5));
  assert.equal(t.G.community.length, 0);
  t.playHand(checkCall(t));
  assert.equal(t.G.stage, 'draw');
  assert.equal(t.G.community.length, 0, 'no board');
  assert.equal(t.act('Ace', 'draw', [0, 1, 2, 3]).error, 'draw at most 3');
  assert.equal(t.act('Ace', 'draw', [7]).error, 'pick cards to draw');
  t.must('Ace', 'draw', [2, 3, 4]); // keeps A-A, draws Ad Ac 5h → four aces
  assert.deepEqual(t.G.players.find((p) => p.id === 'Ace').hand.map((c) => c.rank), ['A', 'A', 'A', 'A', '5']);
  assert.equal(t.act('Ace', 'draw', []).error, 'already drew');
  t.must('Bo', 'draw', [3, 4]);     // trips + 5d Jh
  assert.equal(t.G.players.find((p) => p.id === 'Bo').lastAction.label, 'Drew 2');
  assert.equal(t.G.stage, 'draw', 'waits for everyone');
  t.must('Cy', 'draw', []);         // stands pat
  assert.equal(t.G.stage, 'river');
  const dealerIdx = t.G.players.findIndex((p) => p.isDealer);
  assert.equal(t.G.actionIndex, (dealerIdx + 1) % 3);
  t.playHand(checkCall(t));
  assert.equal(t.G.stage, 'showdown');
  assert.equal(t.G.lastResult.pots[0].hand, 'Four of a Kind');
  assert.equal(t.G.lastResult.winnings.Ace, 30);
  assert.equal(t.total(), 6000);
});

test('5-card draw: no answer in 25s → stand pat; gone after 5s; all-in → draw, then showdown', () => {
  const t = table({ format: 'home', names: ['Ace', 'Bo'] });
  homeAtPicker(t);
  t.must(t.G.dealerId, 'pick_variant', 'draw5');
  t.must(t.actor(), 'allin');
  t.must(t.actor(), 'call');
  assert.equal(t.G.stage, 'draw');
  const before = t.G.players.find((p) => p.id === 'Bo').hand.map((c) => c.rank + c.suit);
  t.ctx.isGone = (id) => id === 'Bo';
  t.wait(T.AWAY_GRACE_MS);
  assert.equal(t.G.draws.Bo, 0, 'gone player stands pat after 5s');
  assert.deepEqual(t.G.players.find((p) => p.id === 'Bo').hand.map((c) => c.rank + c.suit), before);
  t.ctx.isGone = null;
  assert.equal(t.wait(T.DRAW_MS - T.AWAY_GRACE_MS - 1), false);
  t.wait(1);
  assert.equal(t.G.stage, 'showdown');
  assert.equal(t.total(), 4000);
});

test('5-card draw with 9 players: the deck is topped up from the discards', () => {
  const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
  const t = table({ format: 'home', names });
  homeAtPicker(t);
  t.must(t.G.dealerId, 'pick_variant', 'draw5');
  t.playHand(checkCall(t));
  assert.equal(t.G.deck.length, 7);
  for (const n of names) t.must(n, 'draw', [0, 1, 2]);
  const all = t.G.players.flatMap((p) => p.hand).map((c) => c.rank + c.suit);
  assert.equal(new Set(all).size, 45, 'no card dealt twice');
  assert.ok(t.G.players.every((p) => p.hand.length === 5));
  assert.equal(T.redact(t.G).mucked, undefined, 'discards stay on the server');
});

// ── 5-card stud ────────────────────────────────────────────────────────────

test('5-card stud: antes, lowest upcard brings in, upcards visible, best showing hand acts first', () => {
  const t = table({ format: 'home' });
  homeAtPicker(t);
  t.G.rig.push({
    hands: { Ace: cards('As 3c'), Bo: cards('Ks 3d'), Cy: cards('Qs 9h') }, // 3c brings in (clubs lowest)
    board: cards('Kh 2c Qh 7d 4s 8c 5h 6s Jd'),
  });
  t.must(t.G.dealerId, 'pick_variant', 'stud5');
  assert.equal(t.G.stage, 'preflop');
  assert.equal(t.G.pot, 15 + 5, 'three 5¢ antes + 5¢ bring-in');
  const ace = t.G.players.find((p) => p.id === 'Ace');
  assert.equal(ace.bet, 5);
  assert.equal(ace.lastAction.label, 'Bring-in 5');
  assert.equal(t.G.players[t.G.bringInIdx].id, 'Ace');
  // Phones see everyone's upcard, never the down card
  const pub = T.redact(t.G);
  for (const p of pub.players) { assert.equal(p.hand[0].hidden, true); assert.ok(p.hand[1].rank && p.hand[1].up); }
  // Everyone calls the bring-in; the bring-in has no option
  assert.notEqual(t.actor(), 'Ace');
  t.must(t.actor(), 'call'); t.must(t.actor(), 'call');
  assert.equal(t.G.stage, 'flop', '3rd street');
  assert.ok(t.G.players.every((p) => p.hand.length === 3));
  // Who shows a pair acts first
  const best = t.G.players.find((p) => p.hand.filter((c) => c.up).map((c) => c.rank).filter((r, i, a) => a.indexOf(r) !== i).length);
  if (best) assert.equal(t.actor(), best.id);
  t.playHand(checkCall(t));
  assert.equal(t.G.stage, 'showdown');
  assert.ok(t.G.players.every((p) => p.hand.length === 5));
  assert.equal(t.G.community.length, 0);
  assert.equal(t.total(), 6000);
  assert.equal(Object.values(t.G.lastResult.winnings).reduce((a, b) => a + b, 0), 30);
});

test('5-card stud: showing scores rank pairs over high cards; folded upcards are hidden', () => {
  const t = table({ format: 'home' });
  homeAtPicker(t);
  t.must(t.G.dealerId, 'pick_variant', 'stud5');
  const first = t.actor();
  t.must(first, 'fold');
  const pub = T.redact(t.G).players.find((p) => p.id === first);
  assert.ok(pub.hand.every((c) => c.hidden));
});

test('5-card stud: all-in on 2nd street runs out one street at a time, to five cards each', () => {
  const t = table({ format: 'home', names: ['Ace', 'Bo'] });
  homeAtPicker(t);
  t.must(t.G.dealerId, 'pick_variant', 'stud5');
  t.must(t.actor(), 'allin');
  t.must(t.actor(), 'call');
  assert.equal(t.G.stage, 'runout');
  assert.ok(T.redact(t.G).players.every((p) => p.hand.every((c) => c.rank)), 'hands face up');
  for (const n of [3, 4]) {
    t.wait(T.RUNOUT_CARD_MS);
    assert.ok(t.G.players.every((p) => p.hand.length === n), `street ${n}`);
    assert.equal(t.G.stage, 'runout');
  }
  t.wait(T.RUNOUT_CARD_MS);
  assert.equal(t.G.stage, 'showdown');
  assert.ok(t.G.players.every((p) => p.hand.length === 5));
  assert.equal(t.total(), 4000);
});

test('tournament can be 5-card draw or stud', () => {
  const ctx = { now: 0, rng: rngFrom(3), effects: {} };
  const seats = [{ id: 'a' }, { id: 'b' }];
  assert.equal(T.newGame({ seats, format: 'tournament', variant: 'draw5' }, ctx).variant, 'draw5');
  assert.equal(T.newGame({ seats, format: 'tournament', variant: 'stud5' }, ctx).variant, 'stud5');
});

test('draw and stud: 400 random hands never create or lose a chip, and never stall', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'].slice(0, 2 + (seed % 8));
    const t = table({ format: 'home', names, seed });
    const pick = rngFrom(seed * 15485863);
    let bought = 0;
    for (let h = 0; h < 20; h++) {
      t.wait(T.RESULT_MAX_MS);
      for (const p of t.G.players.filter((x) => x.broke && !x.eliminated)) { t.must(p.id, 'rebuy'); bought += 2000; }
      if (!t.G.pendingDealerChoice) t.wait(T.RESULT_MAX_MS);
      if (!t.G.pendingDealerChoice) break;
      t.must(t.G.dealerId, 'pick_variant', h % 2 ? 'draw5' : 'stud5');
      let guard = 0;
      while ((T.isBetting(t.G) || t.G.stage === 'draw') && guard++ < 300) {
        if (t.G.stage === 'draw') {
          if (pick() < 0.3) { t.wait(T.DRAW_MS); continue; }
          for (const p of t.G.players.filter((x) => !x.folded && !x.eliminated && t.G.draws[x.id] == null)) {
            t.must(p.id, 'draw', [0, 1, 2, 3, 4].filter(() => pick() < 0.4).slice(0, 3));
          }
          continue;
        }
        const who = t.actor();
        const p = t.G.players[t.G.actionIndex];
        const r = pick();
        const a = r < 0.12 ? 'fold' : r < 0.2 ? 'allin' : r < 0.35 ? ['raise', Math.floor(pick() * 400)] : (t.G.currentBet > p.bet ? 'call' : 'check');
        t.must(who, ...[].concat(a));
      }
      t.runout();
      assert.equal(t.G.stage, 'showdown', `seed ${seed} hand ${h} ended`);
      assert.equal(t.total(), names.length * 2000 + bought, `seed ${seed} hand ${h}: chips conserved`);
      if (!t.G.wonByFold) assert.ok(t.G.players.filter((p) => !p.folded && !p.eliminated).every((p) => p.hand.length === 5), 'five cards at showdown');
      const seen = t.G.players.flatMap((p) => p.hand).map((c) => c.rank + c.suit);
      assert.equal(new Set(seen).size, seen.length, 'no card dealt twice');
    }
  }
});
