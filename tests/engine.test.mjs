// Unit tests for the pure poker logic (hand ranking, payouts, side pots).
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The app's JS is plain browser script (no modules), so load the engine files
// into a sandbox and pull the global functions out of it.
const ctx = vm.createContext({ console, G: null });
for (const f of ['01-engine.js', '25-side-pots.js']) {
  vm.runInContext(readFileSync(new URL(`../src/js/${f}`, import.meta.url), 'utf8'), ctx, { filename: f });
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
