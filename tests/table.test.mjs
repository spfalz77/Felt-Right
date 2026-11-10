// Unit tests for the server's table engine (supabase/functions/_shared/engine/table.js).
// Whole games are played here in memory: no browser, no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../supabase/functions/_shared/engine/table.js';

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
    playHand: (fn) => { let guard = 0; while (T.isBetting(G) && guard++ < 200) { const who = api.actor(); const [a, amt] = [].concat(fn(who)); api.must(who, a, amt); } },
    deal: () => { api.wait(T.NEXT_HAND_MS); if (G.pendingDealerChoice) api.must(G.dealerId, 'pick_variant', 'holdem'); },
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
  assert.equal(t.wait(T.NEXT_HAND_MS - 1), false);
  t.wait(1);
  assert.equal(t.G.handNumber, 2);
  assert.equal(t.G.stage, 'preflop');
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
  t.wait(T.NEXT_HAND_MS);
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
  t.wait(T.NEXT_HAND_MS);
  t.must(t.G.dealerId, 'pick_variant', 'omaha');
  assert.ok(t.G.players.every((p) => p.hand.length === 4));
});

test('home game: bust → re-buy or sit out; the table waits, then sits out after 60s', () => {
  const t = table({ format: 'home' });
  T.queueRig(t.G, { hands: { Ace: cards('As Ah'), Bo: cards('Kc Kd'), Cy: cards('Qc Qd') }, board: BOARD }, t.ctx);
  t.deal();
  t.playHand(() => 'allin');
  assert.deepEqual(t.chips(), { Ace: 6000, Bo: 0, Cy: 0 });
  assert.equal(t.wait(T.NEXT_HAND_MS), false, 'waits for the decisions');
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
