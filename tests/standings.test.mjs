// Standings: per-friend head-to-head totals from payout_ledger rows.
// computeStandings lives in src/js/34-ledger.js (a classic script), so load it
// into a sandbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = vm.createContext({ console });
vm.runInContext(readFileSync(new URL('../src/js/34-ledger.js', import.meta.url), 'utf8'), ctx);
const { computeStandings } = ctx;

const opp = (id, name) => ({ id, display_name: name, avatar_emoji: '🃏' });

test('amounts are shown as chips (stored in hundreds)', () => {
  const s = computeStandings([{ game_id: 'g1', opponent_id: 'a', amount: 12.5, kind: 'game', opponent: opp('a', 'Ann') }]);
  assert.equal(s.total, 1250);
  assert.equal(s.friends[0].net, 1250);
});

test('lifetime: settled game rows still count, old settle rows are ignored', () => {
  const s = computeStandings([
    { game_id: 'g1', opponent_id: 'a', amount: 20, kind: 'game', settled_at: '2026-11-01', opponent: opp('a', 'Ann') },
    { game_id: null, opponent_id: 'a', amount: -20, kind: 'settle', opponent: opp('a', 'Ann') },
    { game_id: 'g2', opponent_id: 'a', amount: -5, kind: 'game', opponent: opp('a', 'Ann') },
  ]);
  assert.equal(s.friends[0].net, 1500);
  assert.equal(s.friends[0].games, 2);
  assert.equal(s.friends[0].wins, 1);
  assert.equal(s.friends[0].losses, 1);
  assert.equal(s.games, 2);
});

test('sorted best result first; overall total and game count across friends', () => {
  const s = computeStandings([
    { game_id: 'g1', opponent_id: 'a', amount: -10, kind: 'game', opponent: opp('a', 'Ann') },
    { game_id: 'g1', opponent_id: 'b', amount: 30, kind: 'game', opponent: opp('b', 'Bo') },
    { game_id: 'g2', opponent_id: 'b', amount: 0, kind: 'game', opponent: opp('b', 'Bo') },
  ]);
  assert.equal(s.friends.map((f) => f.name).join(','), 'Bo,Ann');
  assert.equal(s.total, 2000);
  assert.equal(s.games, 2);
  assert.equal(s.friends[0].games, 2);
  assert.equal(s.friends[0].wins, 1);
  assert.equal(s.friends[0].losses, 0);
});

test('no rows: empty standings', () => {
  const s = computeStandings([]);
  assert.deepEqual({ total: s.total, games: s.games, n: s.friends.length }, { total: 0, games: 0, n: 0 });
});
