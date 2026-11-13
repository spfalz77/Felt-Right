// Which players to notify after a table change: "your turn" and "you've been
// set Away". (Game starting is sent by the table function's start.)
// Pure: compares a small snapshot taken before the change with the state after.
// Server only (not inlined into the app).
import { isBetting, discardPending, drawPending, gutsEligible } from './table.js';

const live = (p) => p && !p.eliminated && !p.awayFromTable;

// Who the table is waiting on, and a key for that wait (a new key = a new
// decision, so a notification). { [userId]: key }
export function waitingOn(G) {
  const out = {};
  if (!G || G.paused || G.tournamentOver || G.stage === 'finished') return out;
  const h = G.handNumber;
  if (G.pendingDealerChoice) {
    const d = G.players.find((p) => p.id === G.dealerId);
    if (live(d)) out[d.id] = `choose:${h}`;
    return out;
  }
  if (isBetting(G)) {
    const p = G.players[G.actionIndex];
    if (live(p) && !p.folded && !p.allIn) out[p.id] = `bet:${h}:${G.stage}:${G.turnStartMs}`;
  } else if (G.stage === 'discard') {
    for (const p of discardPending(G)) if (live(p) && !(G.discards && G.discards[p.id] != null)) out[p.id] = `discard:${h}`;
  } else if (G.stage === 'draw') {
    for (const p of drawPending(G)) if (live(p)) out[p.id] = `draw:${h}`;
  } else if (G.stage === 'guts_decision') {
    for (const p of gutsEligible(G)) if (live(p) && !(G.gutsDecisions && G.gutsDecisions[p.id])) out[p.id] = `guts:${h}:${G.gutsDeadlineMs}`;
  }
  return out;
}

export function notifySnapshot(G) {
  return {
    waiting: waitingOn(G),
    away: Object.fromEntries((G?.players || []).map((p) => [p.id, !!p.awayFromTable])),
  };
}

// actorId: the player whose own action caused the change (null for the clock).
// Returns [{ userId, kind: 'your_turn' | 'set_away', key }]
/** @param {any} before @param {any} G @param {string | null} [actorId] */
export function notifyEvents(before, G, actorId = null) {
  const events = [];
  const now = waitingOn(G);
  for (const [id, key] of Object.entries(now)) {
    if (before.waiting[id] !== key && id !== actorId) events.push({ userId: id, kind: 'your_turn', key });
  }
  for (const p of G?.players || []) {
    // Set Away by the table (timed out / phone gone), not by their own choice
    if (p.awayFromTable && !before.away[p.id] && p.id !== actorId && !p.leftTable && !p.eliminated) {
      events.push({ userId: p.id, kind: 'set_away', key: `away:${G.handNumber}` });
    }
  }
  return events;
}

// The words on the notification
export function notifyText(kind, G) {
  const home = G?.format === 'home';
  if (kind === 'game_start') return { title: 'Your game is starting', body: 'Take your seat at Felt Right.' };
  if (kind === 'set_away') {
    return {
      title: "You've been set Away",
      body: home ? "You won't be dealt in until you tap I'm back." : "Your turns are checked or folded until you tap I'm back.",
    };
  }
  const what = G?.pendingDealerChoice ? 'Pick the game for this hand.'
    : G?.stage === 'discard' ? 'Pick a card to discard.'
    : G?.stage === 'draw' ? 'Pick cards to draw.'
    : G?.stage === 'guts_decision' ? 'In or out?'
    : 'The table is waiting on you.';
  return { title: 'Your turn', body: what };
}
