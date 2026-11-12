// Unit tests for the pure poker logic (hand ranking, payouts, side pots).
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { read as readSrc } from '../scripts/build.mjs';
import * as cardsMod from '../supabase/functions/_shared/engine/cards.js';
import * as sidePotsMod from '../supabase/functions/_shared/engine/side-pots.js';
import * as payoutsMod from '../supabase/functions/_shared/engine/payouts.js';

// The app's JS is plain browser script (no modules), so load the engine files
// into a sandbox and pull the global functions out of it.
const ctx = vm.createContext({ console, G: null });
for (const f of ['01-engine.js', '25-side-pots.js']) {
  vm.runInContext(readSrc(`js/${f}`), ctx, { filename: f }); // as built into the app
}
const { evalBest, evalBest3Card, cmpScore, computePayouts, buildSidePots, makeDeck, getBlinds } = ctx;

// "As Kh 10d" → card objects
const cards = (s) =>
  s.trim().split(/\s+/).map((t) => ({ rank: t.slice(0, -1), suit: { s: '♠', h: '♥', d: '♦', c: '♣' }[t.slice(-1)] }));
const holdem = (hole, board) => evalBest(cards(hole), cards(board), 'holdem');

test('deck has 52 unique cards', () => {
  const d = makeDeck();
  assert.equal(d.length, 52);
  assert.equal(new Set(d.map((c) => c.rank + c.suit)).size, 52);
});

test('hold\'em hand categories', () => {
  const board = '2c 7d 9h Js Kd';
  assert.equal(holdem('As Ah', board).name, 'One Pair');
  assert.equal(holdem('Js 9s', board).name, 'Two Pair');
  assert.equal(holdem('Kh Kc', board).name, 'Three of a Kind');
  assert.equal(holdem('10c 8s', board).name, 'Straight');
  assert.equal(holdem('As 4c', board).name, 'High Card');
  assert.equal(holdem('Ad 3d', '2d 7d 9h Js Kd').name, 'Flush');
  assert.equal(holdem('Kh Kc', '2c 2d 9h Js Kd').name, 'Full House');
  assert.equal(holdem('Kh Kc', '2c Ks 9h Js Kd').name, 'Four of a Kind');
  assert.equal(holdem('10d Qd', '2c 9d 9h Jd Kd').name, 'Straight Flush');
});

test('wheel (A-2-3-4-5) is the lowest straight', () => {
  const board = '2c 3d 4h 9s Kd';
  const wheel = holdem('As 5c', board);
  const sixHigh = holdem('5s 6c', board);
  assert.equal(wheel.name, 'Straight');
  assert.equal(sixHigh.name, 'Straight');
  assert.ok(cmpScore(sixHigh, wheel) > 0, '6-high straight must beat the wheel');
});

test('steel wheel loses to a 6-high straight flush', () => {
  const board = '2h 3h 4h 5h Kd';
  assert.ok(cmpScore(holdem('6h 9c', board), holdem('Ah 9c', board)) > 0);
});

test('kickers break ties; identical hands chop', () => {
  const board = 'Ac 7d 9h 2s 3d';
  assert.ok(cmpScore(holdem('Ad Kc', board), holdem('Ah Qc', board)) > 0);
  assert.equal(cmpScore(holdem('Kd 4c', 'Ac Qd Jh 10s 9d'), holdem('Ks 4h', 'Ac Qd Jh 10s 9d')), 0);
});

test('omaha must use exactly two hole cards', () => {
  // Four hearts in hand + one on board is NOT a flush in Omaha.
  const r = evalBest(cards('Ah Kh Qh Jh'), cards('2h 7c 8d 9s 3c'), 'omaha');
  assert.notEqual(r.name, 'Flush');
  assert.equal(r.usedHoleIdx.length, 2);
  assert.equal(r.usedCommIdx.length, 3);
});

test('3-card guts rankings: trips > straight > flush > pair > high', () => {
  const order = ['Qs Qh Qd', '4c 5d 6h', '2s 9s Js', 'Kc Kd 3h', 'As 9c 4d'].map((h) => evalBest3Card(cards(h)));
  for (let i = 0; i < order.length - 1; i++) assert.ok(cmpScore(order[i], order[i + 1]) > 0, `${order[i].name} > ${order[i + 1].name}`);
  assert.equal(evalBest3Card(cards('As 2d 3c')).name, 'Straight');
});

test('payouts always add up to the pool', () => {
  for (let n = 2; n <= 10; n++) {
    for (const chop of [false, true]) {
      const pays = computePayouts(20, n, chop);
      const total = pays.reduce((s, p) => s + p.amount, 0);
      assert.equal(total, 20 * n, `${n} players, chop=${chop}`);
    }
  }
  assert.deepEqual([...computePayouts(20, 4, false).map((p) => p.amount)], [80]);
});

test('side pots: short all-in, two callers, one fold', () => {
  const players = [
    { id: 'a', totalBet: 50, folded: false },  // all-in short
    { id: 'b', totalBet: 200, folded: false },
    { id: 'c', totalBet: 200, folded: false },
    { id: 'd', totalBet: 100, folded: true },  // folded after putting chips in
  ];
  const pots = buildSidePots(players);
  assert.equal(pots.reduce((s, p) => s + p.amount, 0), 550);
  assert.equal(pots[0].amount, 200); // 50 × 4
  assert.deepEqual([...pots[0].eligible.map((p) => p.id)], ['a', 'b', 'c']);
  assert.equal(pots[1].amount, 350); // rest, b & c only
  assert.deepEqual([...pots[1].eligible.map((p) => p.id)], ['b', 'c']);
});

test('blinds keep doubling past the defined structure', () => {
  const a = getBlinds(100), b = getBlinds(101);
  assert.equal(b.big, a.big * 2);
});

test('cash-out mid-hand voids the hand: bets go back, chips are conserved', () => {
  const cctx = vm.createContext({ console, G: null });
  vm.runInContext(readFileSync(new URL('../src/js/29-cashout.js', import.meta.url), 'utf8'), cctx, { filename: '29-cashout.js' });
  // Blinds posted (5 + 10), plus a 30¢ carry-over nobody can claim
  cctx.G = { pot: 45, players: [{ id: 'a', totalBet: 0 }, { id: 'b', totalBet: 5 }, { id: 'c', totalBet: 10 }] };
  const players = [
    { id: 'a', stackCents: 2000, leftTable: false },
    { id: 'b', stackCents: 1995, leftTable: false },
    { id: 'c', stackCents: 1990, leftTable: false },
  ];
  cctx.voidUnfinishedHandForCashOut(players);
  assert.deepEqual(players.map((p) => p.stackCents), [2010, 2010, 2010]);

  // A player who already left keeps their take-home amount untouched
  cctx.G = { pot: 15, players: [{ id: 'a', totalBet: 5 }, { id: 'b', totalBet: 10 }] };
  const withQuitter = [
    { id: 'a', stackCents: 1000, leftTable: false },
    { id: 'b', stackCents: 990, leftTable: false },
    { id: 'q', stackCents: 700, leftTable: true },
  ];
  cctx.voidUnfinishedHandForCashOut(withQuitter);
  assert.deepEqual(withQuitter.map((p) => p.stackCents), [1005, 1000, 700]);
});

test('side pots: chips bet by a player who quit this hand stay in the pot', () => {
  ctx.G = { handNumber: 7 };
  try {
    const players = [
      { id: 'a', totalBet: 10, folded: false, eliminated: false },
      { id: 'b', totalBet: 10, folded: false, eliminated: false },
      // quit during hand 7 after posting the big blind
      { id: 'q', totalBet: 10, folded: true, eliminated: true, quitHand: 7 },
      // left in an earlier hand: their old totalBet must not count again
      { id: 'old', totalBet: 50, folded: true, eliminated: true, quitHand: 3 },
    ];
    const pots = buildSidePots(players);
    assert.equal(pots.reduce((a, p) => a + p.amount, 0), 30);
    for (const pot of pots) assert.ok(!pot.eligible.some((p) => (p.id || p) === 'q'), 'quitter cannot win');
  } finally { ctx.G = null; }
});

test('3-card Guts hand names use card names, not numbers', () => {
  assert.equal(evalBest3Card(cards('As Ah 2c')).name, 'Pair of Aces');
  assert.equal(evalBest3Card(cards('6s 6h 6c')).name, 'Three Sixes');
  assert.equal(evalBest3Card(cards('Ks 7h 2c')).name, 'King high');
  assert.equal(evalBest3Card(cards('Qs Qh 9c')).name, 'Pair of Queens');
});

test('every function called from an onclick handler exists', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const defined = new Set([...html.matchAll(/(?:^|[\s;])(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]));
  const called = new Set([...html.matchAll(/onclick=\\?["'](?:event\.stopPropagation\(\);\s*)?([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]));
  const builtins = new Set(['alert', 'confirm', 'navigator', 'window', 'document', 'this', 'location', 'history']);
  const missing = [...called].filter((n) => !defined.has(n) && !builtins.has(n));
  assert.deepEqual(missing, [], `onclick handlers call undefined functions: ${missing.join(', ')}`);
});

test('tournament prize pool counts every buy-in plus re-buys', () => {
  ctx.gameBuyIn = 20;
  ctx.G = { players: [{ totalBuyInCents: 0 }, { totalBuyInCents: 0 }, { totalBuyInCents: 3000 }] };
  try {
    assert.equal(vm.runInContext('actualPrizePool()', ctx), 70);
  } finally { ctx.G = null; delete ctx.gameBuyIn; }
});

test('shared engine modules (as the server imports them) match the app build', () => {
  const board = cards('2c 7d 9h Js Kd');
  for (const hole of ['As Ah', 'Js 9s', 'Qc 10d', '3h 4h']) {
    assert.deepEqual(cardsMod.evalBest(cards(hole), board, 'holdem'), JSON.parse(JSON.stringify(evalBest(cards(hole), board, 'holdem'))));
  }
  assert.equal(cardsMod.evalBest3Card(cards('As Ah 2c')).name, 'Pair of Aces');
  assert.deepEqual(payoutsMod.computePayouts(20, 6, false), JSON.parse(JSON.stringify(computePayouts(20, 6, false))));
  const players = [
    { id: 'a', totalBet: 100, folded: false }, { id: 'b', totalBet: 300, folded: false }, { id: 'c', totalBet: 300, folded: true },
    { id: 'q', totalBet: 10, folded: true, eliminated: true, quitHand: 4 },
  ];
  const pots = sidePotsMod.buildSidePots(players, 4);
  assert.equal(pots.reduce((a, p) => a + p.amount, 0), 710);
  assert.equal(new cardsMod.makeDeck().length, 52);
});

test('the built app parses (no duplicate declarations or syntax errors)', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(m[1]);
});

// ── Tournament ledger (written by the server since phase 5) ──
const netOf = (pairs, id) => pairs.reduce((a, r) => a + (r.winner === id ? r.dollars : 0) - (r.loser === id ? r.dollars : 0), 0);
const tp = (id, extra = {}) => ({ id, name: id, emoji: '🃏', chips: 0, ...extra });

test('tournament ledger: winner takes all with 3 players', () => {
  const G = { format: 'tournament', tournamentOver: true, buyIn: 20, players: [tp('a'), tp('b'), tp('c')],
    finalPlacements: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] };
  const pairs = payoutsMod.tournamentLedger(G);
  assert.deepEqual([netOf(pairs, 'a'), netOf(pairs, 'b'), netOf(pairs, 'c')], [40, -20, -20]);
});

test('tournament ledger: a chop splits the pool between the last two', () => {
  const G = { format: 'tournament', tournamentOver: true, chopped: true, buyIn: 20, players: [tp('a'), tp('b'), tp('c')],
    finalPlacements: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] };
  const pairs = payoutsMod.tournamentLedger(G);
  assert.deepEqual([netOf(pairs, 'a'), netOf(pairs, 'b'), netOf(pairs, 'c')], [10, 10, -20]);
});

test('tournament ledger: re-buys go into the pool and into what each player paid', () => {
  const G = { format: 'tournament', tournamentOver: true, rebuysEnabled: true, buyIn: 20,
    players: [tp('kai'), tp('lux'), tp('moe', { totalBuyInCents: 3000 })],
    finalPlacements: [{ name: 'kai' }, { name: 'moe' }, { name: 'lux' }] };
  const pairs = payoutsMod.tournamentLedger(G);
  assert.deepEqual([netOf(pairs, 'kai'), netOf(pairs, 'lux'), netOf(pairs, 'moe')], [50, -20, -30]);
});

test('tournament ledger: nothing for home games, unfinished games or free games', () => {
  const base = { tournamentOver: true, buyIn: 20, players: [tp('a'), tp('b')], finalPlacements: [{ name: 'a' }, { name: 'b' }] };
  assert.deepEqual(payoutsMod.tournamentLedger({ ...base, format: 'home' }), []);
  assert.deepEqual(payoutsMod.tournamentLedger({ ...base, format: 'tournament', tournamentOver: false }), []);
  assert.deepEqual(payoutsMod.tournamentLedger({ ...base, format: 'tournament', buyIn: 0 }), []);
});

test('Pineapple auto-discard: keeps a pair preflop, the best hand with a flop out', () => {
  const pick = (hole, board) => cardsMod.autoDiscardIndex(cards(hole), board ? cards(board) : []);
  assert.equal(pick('7s Ah 7d'), 1);            // keep 77
  assert.equal(pick('2c Ks Qs'), 0);            // keep KQs
  assert.equal(pick('As 2c Kd', '2d 2h 9s'), 2); // A-2 makes trips; K kicker doesn't matter more than the third 2
  assert.equal(pick('Ah 5h Kc', '2h 9h Jh'), 2); // flush with both hearts
});

test('5-card stud: bring-in is the lowest upcard (suits break ties); showing hands rank pairs over high cards', () => {
  const k = (s) => cardsMod.bringInKey(cards(s)[0]);
  assert.ok(k('2s') < k('3c'));
  assert.ok(k('3c') < k('3d') && k('3d') < k('3h') && k('3h') < k('3s'));
  assert.ok(k('Kc') < k('As'));
  const sh = (s) => cardsMod.showingScore(cards(s));
  assert.ok(cardsMod.cmpShowing(sh('2c 2d'), sh('As Kd')) > 0);
  assert.ok(cardsMod.cmpShowing(sh('9c 9d 3s'), sh('9h 9s 2c')) > 0);
  assert.ok(cardsMod.cmpShowing(sh('5c 5d 5s'), sh('Ac Ad Ks Kd')) > 0);
  assert.ok(cardsMod.cmpShowing(sh('Ac Kd'), sh('Ad Qd')) > 0);
  assert.equal(cardsMod.cmpShowing(sh('Ac Kd'), sh('Ad Ks')), 0);
});
