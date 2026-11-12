// The table: every rule that changes a game's state, as pure functions.
// The server (supabase/functions/table) is the only caller. It loads the full
// state, calls applyAction() or tick(), and saves the result; phones only
// render the redacted copy and send actions.
//
// G is the same state object the app has always rendered (players, pot,
// stage, actionIndex, ...), plus server-only fields: deck, rig, blind clock,
// and deadlines. redact() removes what phones must not see.
//
// ctx = { now: ms since epoch, rng: () => [0,1), hostId, allowTestHooks, effects: {},
//         isGone?: (playerId) => true if their app is closed/offline (from heartbeats) }
// Nothing here touches the network, the DOM or the clock.

import { makeDeck, evalBest, evalBest3Card, cmpScore } from './cards.js';
import { FORMATS, VARIANTS, blindsAt } from './config.js';
import { buildSidePots } from './side-pots.js';

export const FIRST_DEAL_MS = 2000;          // start → first hand
export const NEXT_HAND_MS = 6000;           // result on screen → next hand
export const DEALER_CHOICE_MS = 25000;      // dealer picks the variant, else Hold'em
export const REBUY_DECISION_MS = 60000;     // busted player: re-buy or sit out, else sat out
export const RESUME_DEAL_MS = 1500;         // pause/break over → next hand
export const BREAK_AFTER_LEVELS = 4;        // tournament with re-buys: first break, then re-buys close
export const TURN_MS = 32000;               // a turn: 30s on the player's screen + 2s grace, then check/fold
export const AWAY_GRACE_MS = 5000;          // a player who's gone (app closed/offline) is checked/folded after 5s

const BETTING = ['preflop', 'flop', 'turn', 'river'];
const RAISES = ['raise', 'twobet', 'twobb', 'threebb', 'pot', 'allin'];

export const isBetting = (G) => BETTING.includes(G.stage);
const fmt = (G) => FORMATS[G.format] || FORMATS.tournament;
const snapTo5 = (n) => Math.round(n / 5) * 5 || 5;
const fail = (error) => ({ ok: false, error });
const OK = { ok: true };

// ── New game ───────────────────────────────────────────────────────────────
// seats: [{ id, name, emoji }] in lobby order. Seating is shuffled.
export function newGame({ seats, format, variant, rebuysEnabled, blindLevels, blindDuration, buyIn }, ctx) {
  const f = FORMATS[format] ? format : 'tournament';
  const startingChips = FORMATS[f].startingChips;
  const players = seats.map((s) => ({
    id: s.id,
    name: s.name || 'Player',
    emoji: s.emoji || '🃏',
    chips: startingChips,
    totalBuyInCents: f === 'home' ? startingChips : 0,
    hand: [], bet: 0, totalBet: 0,
    folded: false, allIn: false, lastAction: null,
    seatIndex: 0, isDealer: false, eliminated: false, broke: false,
  }));
  for (let i = players.length - 1; i > 0; i--) {
    const j = Math.floor(ctx.rng() * (i + 1));
    [players[i], players[j]] = [players[j], players[i]];
  }
  players.forEach((p, i) => { p.seatIndex = i; });
  return {
    rules: 'server',
    players,
    handNumber: 0,
    stage: 'deal',
    community: [],
    pot: 0,
    deck: [],
    currentBet: 0,
    actionIndex: -1,
    dealerId: null, dealerPos: -1, sbIdx: -1, bbIdx: -1,
    finalPlacements: [],
    format: f,
    variant: f === 'tournament' && variant === 'omaha' ? 'omaha' : 'holdem',
    rebuysEnabled: f === 'home' ? true : !!rebuysEnabled,
    rebuyWindowClosed: false,
    breakActive: false,
    readyForBreakEnd: [],
    handHistory: [],
    // Server-only bookkeeping
    buyIn: buyIn || 0,
    blindLevels: (blindLevels && blindLevels.length ? blindLevels : [{ level: 1, small: 10, big: 20 }]).map((l) => ({ ...l })),
    blindDuration: blindDuration || 600,
    blindLevel: 0,
    levelStartedAt: ctx.now,
    startedAt: ctx.now,
    nextDealAt: ctx.now + FIRST_DEAL_MS,
    dealSeq: 0,
    rig: [],
  };
}

// ── What phones may see ────────────────────────────────────────────────────
// Hole cards are hidden (length kept so card backs can be drawn) unless the
// hand went to showdown. The deck and any rigged deals never leave the server.
export function redact(G) {
  const out = JSON.parse(JSON.stringify(G));
  delete out.deck;
  delete out.rig;
  const gutsShown = new Set(((G.gutsResults && G.gutsResults.handScores) || []).map((h) => h.id));
  const isGuts = (VARIANTS[G.variant] || {}).style === 'guts';
  out.players.forEach((p, i) => {
    const src = G.players[i];
    const show = G.stage === 'showdown' && (isGuts
      ? gutsShown.has(src.id)
      : !src.folded && !src.eliminated && !G.wonByFold);
    if (!show) p.hand = (p.hand || []).map(() => ({ hidden: true }));
  });
  return out;
}

// Each player's own cards for the current deal: [{ player_id, cards }]
export function privateHands(G) {
  return G.players
    .filter((p) => !p.folded && !p.eliminated && p.hand && p.hand.length)
    .map((p) => ({ player_id: p.id, cards: p.hand }));
}

// ── Blind clock (tournaments) ──────────────────────────────────────────────
function advanceBlindClock(G, ctx) {
  if (!fmt(G).blindsEscalate || G.paused || G.breakActive || G.tournamentOver) return;
  const ms = G.blindDuration * 1000;
  while (ctx.now - G.levelStartedAt >= ms) {
    G.blindLevel++; G.levelStartedAt += ms;
    // Tournament with re-buys: first break after 4 levels; re-buys close when it ends
    if (G.blindLevel >= BREAK_AFTER_LEVELS && G.rebuysEnabled && !G.rebuyWindowClosed && !G.breakTaken) {
      startBreak(G, ctx);
      return;
    }
  }
}

function startBreak(G, ctx) {
  G.breakActive = true;
  G.breakTaken = true;
  G.breakReady = [];
  G.breakAddOns = [];
  G.breakStartedAt = ctx.now;
}

function endBreak(G, ctx) {
  G.breakActive = false;
  G.rebuyWindowClosed = true;
  G.breakReady = [];
  G.levelStartedAt = ctx.now;
  // Anyone still deciding on a re-buy can't any more: they're out
  G.players.filter((p) => p.broke && !p.eliminated).forEach((p) => sitOut(G, p));
  if (!isBetting(G) && G.stage !== 'guts_decision') G.nextDealAt = ctx.now + RESUME_DEAL_MS;
}
export const currentBlinds = (G) => blindsAt(G.blindLevels, fmt(G).blindsEscalate ? G.blindLevel : 0);

// ── Helpers ────────────────────────────────────────────────────────────────
function nextActive(G, fromIdx) {
  const n = G.players.length;
  for (let i = 1; i < n; i++) {
    const idx = (fromIdx + i) % n;
    const p = G.players[idx];
    if (!p.folded && !p.eliminated && p.chips > 0) return idx;
  }
  return fromIdx;
}

function postBlind(G, idx, amount) {
  const p = G.players[idx];
  const paid = Math.min(amount, p.chips);
  p.chips -= paid; p.bet += paid; p.totalBet += paid; G.pot += paid;
  if (p.chips === 0) p.allIn = true;
}

const rebuyOpen = (G) => fmt(G).moneyMode || (G.rebuysEnabled && !G.rebuyWindowClosed);
const deciding = (G) => (rebuyOpen(G) ? G.players.filter((p) => p.broke && !p.eliminated) : []);

function addPlacement(G, p) {
  if (!G.finalPlacements.some((fp) => fp.name === p.name)) G.finalPlacements.unshift({ name: p.name, emoji: p.emoji });
}

// ── Dealing ────────────────────────────────────────────────────────────────
function rotateDealer(G, ctx) {
  const eligible = G.players.filter((p) => !p.eliminated && p.chips > 0);
  G.players.forEach((p) => { p.isDealer = false; });
  let i;
  if (!G.dealerId) i = Math.floor(ctx.rng() * eligible.length);
  else i = (eligible.findIndex((p) => p.id === G.dealerId) + 1) % eligible.length; // -1 (busted) → 0
  eligible[i].isDealer = true;
  G.dealerId = eligible[i].id;
}

function dealNewHand(G, ctx) {
  G.nextDealAt = null;
  const active = G.players.filter((p) => !p.eliminated && p.chips > 0);
  if (active.length < 2) {
    if (!fmt(G).moneyMode) endTournament(G);
    // Home game with one stack left: nothing to deal; the host ends the game.
    return;
  }
  if (G.gutsResults && G.gutsResults.progressionEnded === false) { continueGuts(G, ctx); return; }
  G.gutsResults = null;
  G.gutsDecisions = {};
  G.gutsRollCount = 0;
  G.wonByFold = false;
  G.lastResult = null;
  G.stage = 'deal';
  G.pot = G.gutsCarryPot ? G.pot : 0;
  G.community = [];
  G.actionIndex = -1;
  G.players.forEach((p) => { p.bet = 0; p.totalBet = 0; p.lastAction = p.awayFromTable ? p.lastAction : null; });
  G.handNumber++;
  rotateDealer(G, ctx);
  if (fmt(G).dealerChoiceVariant) {
    G.pendingDealerChoice = true;
    G.dealerChoiceDeadline = ctx.now + DEALER_CHOICE_MS;
    const dealer = G.players.find((p) => p.id === G.dealerId);
    if (dealer && dealer.awayFromTable) pickVariant(G, 'holdem', ctx); // nobody there to choose
    return;
  }
  proceedToDeal(G, ctx);
}

function pickVariant(G, variant, ctx) {
  G.variant = VARIANTS[variant] ? variant : 'holdem';
  G.pendingDealerChoice = false;
  G.dealerChoiceDeadline = null;
  proceedToDeal(G, ctx);
}

function proceedToDeal(G, ctx) {
  const vCfg = VARIANTS[G.variant] || VARIANTS.holdem;
  G.stage = 'preflop';
  G.community = [];
  G.pot = 0;
  G.currentBet = 0;
  G.revealedHands = {};
  G.winnerMucked = false;
  G.chopOfferedBy = null;
  G.paidOutHand = null;
  G.deck = makeDeck(ctx.rng);
  G.players.forEach((p) => {
    p.hand = []; p.bet = 0; p.totalBet = 0; p.folded = false; p.allIn = false;
    if (!p.awayFromTable) p.lastAction = null;
    if (p.eliminated || p.chips <= 0) p.folded = true;
  });
  const eligible = G.players.filter((p) => !p.eliminated && p.chips > 0);
  const dealerP = G.players.find((p) => p.id === G.dealerId);
  G.handHistory.push({ hand: G.handNumber, variant: G.variant, dealerName: dealerP ? dealerP.name : '?', dealerEmoji: dealerP ? dealerP.emoji : '🃏' });
  if (G.handHistory.length > 200) G.handHistory.shift();

  for (const p of G.players) {
    if (!p.folded) for (let i = 0; i < vCfg.holeCards; i++) p.hand.push(G.deck.pop());
  }
  applyRig(G, vCfg.holeCards, ctx);
  G.dealSeq++;

  const blinds = currentBlinds(G);
  if (vCfg.style === 'guts') { startGutsRound(G, blinds.big, ctx); return; }
  G.currentBet = blinds.big;
  const dealerPos = G.players.findIndex((p) => p.id === G.dealerId);
  let sbIdx, bbIdx;
  if (eligible.length === 2) { sbIdx = dealerPos; bbIdx = nextActive(G, dealerPos); } // heads-up: dealer is SB
  else { sbIdx = nextActive(G, dealerPos); bbIdx = nextActive(G, sbIdx); }
  G.dealerPos = dealerPos; G.sbIdx = sbIdx; G.bbIdx = bbIdx;
  postBlind(G, sbIdx, blinds.small);
  postBlind(G, bbIdx, blinds.big);
  G.players[sbIdx].lastAction = { type: 'bet', label: `SB ${blinds.small}` };
  setActor(G, eligible.length === 2 ? sbIdx : nextActive(G, bbIdx), ctx);
  // Blinds put everyone all-in (or left nobody able to act)
  const canAct = G.players.filter((p) => !p.folded && !p.eliminated && !p.allIn);
  if (isBetting(G) && canAct.length === 0) runOutToShowdown(G, ctx);
}

// Test hook: a queued deal replaces the shuffled cards. Only the local test
// stack can queue one (see queueRig).
function applyRig(G, numHoleCards, ctx) {
  if (!G.rig || !G.rig.length) return;
  const rig = G.rig.shift();
  const key = (c) => c.rank + c.suit;
  const forced = new Set([...Object.values(rig.hands || {}).flat(), ...(rig.board || [])].map(key));
  const rest = makeDeck(ctx.rng).filter((c) => !forced.has(key(c)));
  for (const p of G.players) {
    if (p.folded) continue;
    const h = rig.hands && rig.hands[p.name];
    p.hand = h ? h.map((c) => ({ ...c })) : Array.from({ length: numHoleCards }, () => rest.pop());
  }
  G.deck = [...rest, ...[...(rig.board || [])].reverse().map((c) => ({ ...c }))]; // board is popped from the end
}

export function queueRig(G, rig, ctx) {
  if (!ctx.allowTestHooks) return fail('test hooks are off');
  G.rig.push(rig);
  return OK;
}

// ── 3-Card Guts (home games) ───────────────────────────────────────────────
// Everyone antes the big blind and decides in or out at once (20s, else out).
//   nobody in → everyone antes again, new cards
//   one in    → takes the pot; the progression ends
//   two+ in   → best hand takes the pot; each other "in" player matches it
//               (up to their stack) into the next round's pot, same dealer
const gutsEligible = (G) => G.players.filter((p) => !p.eliminated && !p.broke && p.hand && p.hand.length);

function postAntes(G, amount, ctx) {
  G.currentBet = 0;
  G.players.forEach((p) => {
    if (p.folded || p.eliminated) return;
    const paid = Math.min(amount, p.chips);
    p.chips -= paid; p.totalBet += paid; G.pot += paid;
    if (p.chips === 0) { p.allIn = true; markBroke(G, p, ctx); }
  });
}

function markBroke(G, p, ctx) {
  if (rebuyOpen(G) && !p.awayFromTable) { p.broke = true; p.brokeAt = ctx.now; }
}

function startGutsRound(G, ante, ctx) {
  postAntes(G, ante, ctx);
  G.stage = 'guts_decision';
  G.gutsDecisions = {};
  G.gutsResults = null;
  G.gutsDeadlineMs = ctx.now + ((VARIANTS.guts3.decisionTimerSec || 20) * 1000);
  G.actionIndex = -1;
  G.turnStartAt = null;
}

// New cards for everyone still in (re-roll or next round of a progression)
function dealGutsCards(G, ctx) {
  G.deck = makeDeck(ctx.rng);
  G.players.forEach((p) => {
    p.hand = [];
    p.folded = p.eliminated || p.broke || p.chips <= 0;
    p.allIn = false;
    if (!p.folded) for (let i = 0; i < 3; i++) p.hand.push(G.deck.pop());
  });
  G.dealSeq++;
}

function continueGuts(G, ctx) {
  const can = G.players.filter((p) => !p.eliminated && !p.broke && p.chips > 0);
  if (can.length < 2) {
    // Nobody left to play the next round against: the carried pot goes to whoever is left
    if (can.length === 1) can[0].chips += G.pot;
    G.pot = 0;
    G.gutsResults = Object.assign({}, G.gutsResults, { progressionEnded: true });
    dealNewHand(G, ctx);
    return;
  }
  G.handNumber++;
  G.pendingDealerChoice = false;
  G.gutsRollCount = (G.gutsRollCount || 0) + 1;
  G.players.forEach((p) => { p.bet = 0; p.lastAction = null; });
  dealGutsCards(G, ctx);
  startGutsRound(G, currentBlinds(G).big, ctx);
}

function gutsDecide(G, p, choice, ctx) {
  if (G.stage !== 'guts_decision') return fail('no guts decision in progress');
  if (!gutsEligible(G).includes(p)) return fail('not in this round');
  if (G.gutsDecisions[p.id]) return fail('already decided');
  G.gutsDecisions[p.id] = choice;
  if (gutsEligible(G).every((x) => G.gutsDecisions[x.id])) resolveGuts(G, ctx);
  return OK;
}

function resolveGuts(G, ctx) {
  const eligible = gutsEligible(G);
  const ins = eligible.filter((p) => G.gutsDecisions[p.id] === 'in');
  if (ins.length === 0) {
    G.handNumber++;
    G.gutsRollCount = (G.gutsRollCount || 0) + 1;
    dealGutsCards(G, ctx);
    startGutsRound(G, currentBlinds(G).big, ctx);
    return;
  }
  const pot = G.pot;
  if (ins.length === 1) {
    const w = ins[0];
    w.chips += pot;
    G.pot = 0;
    G.gutsResults = { winnerId: w.id, winnerName: w.name, winnerEmoji: w.emoji, winAmount: pot, losers: [], uncontested: true, progressionEnded: true };
    G.lastResult = { hand: G.handNumber, winnings: { [w.id]: pot }, pots: [{ amount: pot, winners: [w.id], hand: null }] };
  } else {
    const scored = ins.map((p) => ({ p, score: evalBest3Card(p.hand) })).sort((a, b) => cmpScore(b.score, a.score));
    const w = scored[0].p;
    const match = Math.round(pot * (VARIANTS.guts3.matchPotFraction || 1));
    w.chips += pot;
    G.pot = 0;
    const losers = [];
    for (const { p } of scored.slice(1)) {
      const paid = Math.min(match, p.chips);
      p.chips -= paid; G.pot += paid;
      if (p.chips <= 0) markBroke(G, p, ctx);
      losers.push({ id: p.id, name: p.name, emoji: p.emoji, paid, owedFull: match });
    }
    G.gutsResults = {
      winnerId: w.id, winnerName: w.name, winnerEmoji: w.emoji, winAmount: pot, losers,
      handScores: scored.map(({ p, score }) => ({ id: p.id, name: p.name, emoji: p.emoji, hand: p.hand, score })),
      carryToNext: G.pot, uncontested: false, progressionEnded: false,
    };
    G.lastResult = { hand: G.handNumber, winnings: { [w.id]: pot }, pots: [{ amount: pot, winners: [w.id], hand: scored[0].score.name }] };
  }
  G.stage = 'showdown';
  G.paidOutHand = G.handNumber;
  afterHand(G, ctx);
}

// End of a hand (any variant): queue the next deal, or pause if one was asked for
function afterHand(G, ctx) {
  G.nextDealAt = ctx.now + NEXT_HAND_MS;
  if (G.pauseQueued) { G.pauseQueued = false; G.paused = true; G.nextDealAt = null; }
}

// ── Turn order ─────────────────────────────────────────────────────────────
// Puts a player on action. A player who has stepped away (quit a tournament:
// blinding out) is checked or folded on the spot, so the table never waits.
function setActor(G, idx, ctx) {
  G.actionIndex = idx;
  G.turnStartAt = new Date(ctx.now).toISOString();
  G.turnStartMs = ctx.now;
  G.turnDeadline = ctx.now + TURN_MS;
  const p = G.players[idx];
  if (p && p.awayFromTable && isBetting(G) && !p.folded && !p.eliminated && !p.allIn) {
    autoAct(G, p);
    advanceAction(G, ctx);
  }
}

function autoAct(G, p) {
  if (G.currentBet > p.bet) { p.folded = true; p.lastAction = { type: 'fold', label: 'Away' }; }
  else p.lastAction = { type: 'check', label: 'Away' };
}

function returnUncalledBets(G) {
  const inHand = G.players.filter((p) => !p.folded && !p.eliminated);
  if (inHand.length < 2) return;
  let highest = inHand[0];
  let second = 0;
  for (const p of inHand) {
    if (p.bet > highest.bet) { second = highest.bet; highest = p; }
    else if (p.bet > second && p.id !== highest.id) second = p.bet;
  }
  const overage = highest.bet - second;
  if (overage > 0) {
    highest.chips += overage; highest.bet = second; highest.totalBet -= overage; G.pot -= overage;
    if (highest.allIn && highest.chips > 0) highest.allIn = false;
  }
}

function advanceAction(G, ctx) {
  if (!isBetting(G)) return;
  const active = G.players.filter((p) => !p.folded && !p.eliminated);
  if (active.length === 1) { showdown(G, ctx); return; }
  const canAct = active.filter((p) => !p.allIn);
  if (canAct.length === 0 || (canAct.length === 1 && canAct[0].bet >= G.currentBet)) { runOutToShowdown(G, ctx); return; }
  if (canAct.every((p) => p.bet >= G.currentBet && p.lastAction !== null)) { advanceStage(G, ctx); return; }

  let idx = G.actionIndex;
  for (let i = 0; i < G.players.length; i++) {
    idx = (idx + 1) % G.players.length;
    const c = G.players[idx];
    if (!c || c.folded || c.eliminated || c.allIn) continue;
    if (c.bet < G.currentBet || c.lastAction === null) { setActor(G, idx, ctx); return; }
  }
  advanceStage(G, ctx); // nobody left to act
}

function advanceStage(G, ctx) {
  returnUncalledBets(G);
  G.players.forEach((p) => { p.bet = 0; if (!p.folded && !p.eliminated) p.lastAction = null; });
  G.currentBet = 0;
  if (G.stage === 'preflop') { G.community = [G.deck.pop(), G.deck.pop(), G.deck.pop()]; G.stage = 'flop'; }
  else if (G.stage === 'flop') { G.community.push(G.deck.pop()); G.stage = 'turn'; }
  else if (G.stage === 'turn') { G.community.push(G.deck.pop()); G.stage = 'river'; }
  else { showdown(G, ctx); return; }
  // First to act after the flop: first player left of the dealer who can still bet
  const dealerIdx = G.players.findIndex((p) => p.isDealer);
  const n = G.players.length;
  for (let i = 1; i <= n; i++) {
    const idx = (dealerIdx + i) % n;
    const p = G.players[idx];
    if (!p.folded && !p.eliminated && !p.allIn) { setActor(G, idx, ctx); return; }
  }
  runOutToShowdown(G, ctx);
}

function runOutToShowdown(G, ctx) {
  returnUncalledBets(G);
  while (G.community.length < 5) G.community.push(G.deck.pop());
  showdown(G, ctx);
}

// ── Showdown ───────────────────────────────────────────────────────────────
function showdown(G, ctx) {
  if (G.paidOutHand === G.handNumber) return; // each hand pays out once
  G.paidOutHand = G.handNumber;
  G.stage = 'showdown';
  G.actionIndex = -1;
  G.turnStartAt = null;
  G.turnDeadline = null;
  const active = G.players.filter((p) => !p.folded && !p.eliminated);
  const winnings = {};
  G.players.forEach((p) => { winnings[p.id] = 0; });
  const pots = [];

  if (active.length === 1) {
    // Everyone else folded: cards stay hidden unless the winner shows them
    G.wonByFold = true;
    winnings[active[0].id] = G.pot;
    pots.push({ amount: G.pot, winners: [active[0].id], hand: null });
  } else {
    G.wonByFold = false;
    const hands = {};
    active.forEach((p) => { if (p.hand.length) hands[p.id] = evalBest(p.hand, G.community, G.variant); });
    const sidePots = buildSidePots(G.players, G.handNumber);
    for (const pot of sidePots) {
      if (pot.amount <= 0) continue;
      const contenders = pot.eligible.filter((p) => hands[p.id]);
      if (!contenders.length) { winnings[active[0].id] += pot.amount; continue; }
      contenders.sort((a, b) => cmpScore(hands[b.id], hands[a.id]));
      const best = hands[contenders[0].id];
      const winners = contenders.filter((c) => cmpScore(hands[c.id], best) === 0);
      const share = Math.floor(pot.amount / winners.length);
      const rem = pot.amount - share * winners.length;
      winners.forEach((w, i) => { winnings[w.id] += share + (i === 0 ? rem : 0); });
      pots.push({ amount: pot.amount, winners: winners.map((w) => w.id), hand: best.name });
    }
    // Chips the side pots didn't cover (shouldn't happen) go to the best hand, never vanish
    const paid = Object.values(winnings).reduce((a, b) => a + b, 0);
    if (paid < G.pot) {
      const best = [...active].filter((p) => hands[p.id]).sort((a, b) => cmpScore(hands[b.id], hands[a.id]))[0] || active[0];
      winnings[best.id] += G.pot - paid;
    }
  }
  G.players.forEach((p) => { p.chips += winnings[p.id]; });
  G.pot = 0;
  G.lastResult = { hand: G.handNumber, winnings, pots };

  // Out of chips: re-buy offer (home game, or tournament while re-buys are open) or knocked out
  G.players.forEach((p) => {
    if (p.eliminated || p.chips > 0) return;
    if (rebuyOpen(G) && !p.awayFromTable) { p.broke = true; p.brokeAt = ctx.now; }
    else { p.eliminated = true; addPlacement(G, p); }
  });
  afterHand(G, ctx);
}

function endTournament(G) {
  const winner = G.players.find((p) => !p.eliminated && p.chips > 0) || G.players[0];
  if (winner) addPlacement(G, winner);
  G.stage = 'finished';
  G.tournamentOver = true;
  G.nextDealAt = null;
}

// ── Chop (tournament, heads-up) ────────────────────────────────────────────
const chopPlayers = (G) => G.players.filter((p) => !p.eliminated && p.chips > 0);

function finalizeChop(G) {
  voidHand(G); // chips in a hand in progress go back first
  const sorted = [...chopPlayers(G)].sort((a, b) => b.chips - a.chips);
  const earlier = (G.finalPlacements || []).filter((fp) => !sorted.some((p) => p.name === fp.name));
  G.finalPlacements = [...sorted.map((p) => ({ name: p.name, emoji: p.emoji, chips: p.chips })), ...earlier];
  G.chopOfferedBy = null;
  G.chopped = true;
  G.tournamentOver = true;
  G.stage = 'finished';
  G.actionIndex = -1;
  G.nextDealAt = null;
}

// ── Cash out (home game) ───────────────────────────────────────────────────
// Ending mid-hand voids the hand: everyone still seated gets back what they
// put in; a pot that can't be attributed is split evenly, remainder to the
// first seated player. Same rule as cleanup_stale_games().
function voidHand(G) {
  const seated = G.players.filter((p) => !p.eliminated && p.cashedOutCents == null);
  const pot = Math.max(G.pot || 0, 0);
  if (!pot || !seated.length) return;
  const bet = (p) => Math.max(p.totalBet || 0, 0);
  const refundable = seated.reduce((a, p) => a + bet(p), 0);
  let leftover = 0;
  if (refundable > pot) seated.forEach((p) => { p.chips += Math.round(bet(p) * pot / refundable); });
  else { seated.forEach((p) => { p.chips += bet(p); }); leftover = pot - refundable; }
  if (leftover > 0) {
    const share = Math.floor(leftover / seated.length);
    seated.forEach((p) => { p.chips += share; });
    seated[0].chips += leftover - share * seated.length;
  }
  G.players.forEach((p) => { p.bet = 0; p.totalBet = 0; });
  G.pot = 0;
}

function cashOut(G, ctx) {
  voidHand(G);
  const rows = G.players.map((p) => {
    const stackCents = p.cashedOutCents != null ? p.cashedOutCents : (p.chips || 0);
    const buyInCents = p.totalBuyInCents || G.buyIn * 100;
    return { id: p.id, name: p.name, emoji: p.emoji, stackCents, buyInCents, netCents: stackCents - buyInCents };
  }).sort((a, b) => b.netCents - a.netCents);
  G.cashOuts = rows.map((r, i) => ({ ...r, placement: i + 1 }));
  G.finalPlacements = G.cashOuts.map((r) => ({ name: r.name, emoji: r.emoji, netCents: r.netCents }));
  G.tournamentOver = true;
  G.stage = 'finished';
  G.actionIndex = -1;
  G.pendingDealerChoice = false;
  G.nextDealAt = null;
  ctx.effects.settle = true;
}

// ── Actions ────────────────────────────────────────────────────────────────
export function applyAction(G, playerId, action, amount, ctx) {
  ctx.effects = ctx.effects || {};
  if (G.tournamentOver) return fail('game is over');
  advanceBlindClock(G, ctx);
  const p = G.players.find((x) => x.id === playerId);
  const isHost = ctx.hostId === playerId;
  if (!p && !isHost) return fail('not in this game');

  if (action === 'end_game') {
    if (!isHost) return fail('only the host can end the game');
    // Home game: cash out. Tournament: called off, nothing recorded.
    if (fmt(G).moneyMode) cashOut(G, ctx); else abandonGame(G);
    return OK;
  }
  if (!p) return fail('not in this game');

  if (action === 'pick_variant') {
    if (!G.pendingDealerChoice) return fail('no variant to pick');
    if (G.dealerId !== playerId) return fail('only the dealer picks');
    pickVariant(G, amount, ctx);
    return OK;
  }

  if (action === 'rebuy') {
    if (!p.broke || p.eliminated) return fail('not out of chips');
    if (!rebuyOpen(G)) return fail('re-buys are closed');
    const money = fmt(G).moneyMode;
    const chips = money ? G.buyIn * 100 : Math.floor(FORMATS.tournament.startingChips / 2);
    const cost = money ? G.buyIn * 100 : Math.floor(G.buyIn * 100 / 2);
    if (!cost) return fail('no buy-in amount set');
    p.chips += chips;
    p.totalBuyInCents = (p.totalBuyInCents || G.buyIn * 100) + cost;
    p.broke = false; p.brokeAt = null;
    (G.eventLog = G.eventLog || []).push({ kind: 'rebuy', playerId, playerName: p.name, amount: cost, chipsAdded: chips, hand: G.handNumber });
    return OK;
  }

  if (action === 'sit_out') {
    if (!p.broke || p.eliminated) return fail('not out of chips');
    sitOut(G, p);
    return OK;
  }

  if (action === 'quit') return quit(G, p, ctx);

  if (action === 'sit_back') {
    if (!p.awayFromTable) return OK;
    p.awayFromTable = false; p.disconnected = false; p.lastAction = null;
    return OK;
  }

  if (action === 'guts_in' || action === 'guts_out') return gutsDecide(G, p, action === 'guts_in' ? 'in' : 'out', ctx);

  if (action === 'pause') { // anyone may ask; mid-hand it waits for the hand to end
    if (G.paused) return OK;
    G.pauseReady = [];
    if (isBetting(G) || G.stage === 'guts_decision') G.pauseQueued = true;
    else { G.paused = true; G.pauseQueued = false; G.nextDealAt = null; }
    return OK;
  }
  if (action === 'pause_ready') { // "I'm back": everyone's pause screen shows it
    if (!G.paused && !G.pauseQueued) return fail('the game is not paused');
    G.pauseReady = G.pauseReady || [];
    if (!G.pauseReady.includes(p.id)) G.pauseReady.push(p.id);
    return OK;
  }
  if (action === 'pause_cancel' || action === 'resume') {
    if (!isHost) return fail('only the host can do that');
    if (action === 'pause_cancel') { G.pauseQueued = false; return OK; }
    if (!G.paused) return OK;
    G.paused = false;
    G.pauseReady = [];
    G.levelStartedAt = ctx.now;
    G.nextDealAt = ctx.now + RESUME_DEAL_MS;
    return OK;
  }

  if (action === 'break_ready' || action === 'break_end' || action === 'add_on') {
    if (!G.breakActive) return fail('not on a break');
    if (action === 'break_end') { if (!isHost) return fail('only the host can end the break'); endBreak(G, ctx); return OK; }
    if (p.eliminated) return fail('out of the tournament');
    if (action === 'add_on') {
      if (p.broke) return fail('re-buy instead');
      if (G.breakAddOns.includes(p.id)) return fail('add-on already used');
      const chips = Math.floor(FORMATS.tournament.startingChips / 2);
      const cost = Math.floor(G.buyIn * 100 / 2);
      p.chips += chips;
      p.totalBuyInCents = (p.totalBuyInCents || G.buyIn * 100) + cost;
      G.breakAddOns.push(p.id);
      (G.eventLog = G.eventLog || []).push({ kind: 'addon', playerId, playerName: p.name, amount: cost, chipsAdded: chips, hand: G.handNumber });
      return OK;
    }
    if (!G.breakReady.includes(p.id)) G.breakReady.push(p.id);
    if (G.players.filter((x) => !x.eliminated).every((x) => G.breakReady.includes(x.id))) endBreak(G, ctx);
    return OK;
  }

  if (action.startsWith('chop_')) {
    if (fmt(G).moneyMode) return fail('chop is for tournaments');
    const two = chopPlayers(G);
    if (two.length !== 2 || !two.includes(p)) return fail('chop is for the last two players');
    if (action === 'chop_offer') { if (!G.chopOfferedBy) { G.chopOfferedBy = p.id; G.chopOfferedAt = new Date(ctx.now).toISOString(); G.chopDeclined = false; } return OK; }
    if (!G.chopOfferedBy) return fail('no chop offer');
    if (action === 'chop_cancel') { if (G.chopOfferedBy === p.id) G.chopOfferedBy = null; return OK; }
    if (G.chopOfferedBy === p.id) return fail('waiting for the other player');
    if (action === 'chop_accept') { finalizeChop(G); return OK; }
    if (action === 'chop_decline') { G.chopOfferedBy = null; G.chopDeclined = true; return OK; }
    return fail(`unknown action: ${action}`);
  }

  if (action === 'reveal' || action === 'muck') {
    if (action === 'muck') { G.winnerMucked = true; return OK; }
    if (!p.hand || !p.hand.length) return fail('no cards to show');
    if (!(p.folded || G.stage === 'showdown')) return fail('finish the hand first');
    const idx = Array.isArray(amount) ? amount.filter((i) => Number.isInteger(i) && i >= 0 && i < p.hand.length) : null;
    G.revealedHands = G.revealedHands || {};
    G.revealedHands[p.id] = idx && idx.length ? idx.map((i) => p.hand[i]) : p.hand;
    G.winnerMucked = false;
    return OK;
  }

  if (action === 'fold' || action === 'check' || action === 'call' || RAISES.includes(action)) {
    if (G.breakActive) return fail('on a break');
    if (G.paused) return fail('the game is paused');
    if (!isBetting(G)) return fail('no betting round in progress');
    if (G.players[G.actionIndex] !== p) return fail('not your turn');
    const r = bet(G, p, action, amount);
    if (!r.ok) return r;
    advanceAction(G, ctx);
    return OK;
  }
  return fail(`unknown action: ${action}`);
}

function sitOut(G, p) {
  p.eliminated = true; p.broke = false; p.brokeAt = null;
  if (!fmt(G).moneyMode) addPlacement(G, p);
}

function bet(G, p, action, amount) {
  const owed = Math.max(G.currentBet - p.bet, 0);
  if (action === 'fold') { p.folded = true; p.lastAction = { type: 'fold', label: 'Fold' }; return OK; }
  if (action === 'check') {
    if (owed > 0) return fail('cannot check: there is a bet to call');
    p.lastAction = { type: 'check', label: 'Check' };
    return OK;
  }
  if (action === 'call') {
    const amt = Math.min(owed, p.chips);
    p.chips -= amt; p.bet += amt; p.totalBet += amt; G.pot += amt;
    if (p.chips === 0) p.allIn = true;
    p.lastAction = { type: 'bet', label: `Call ${amt}` };
    return OK;
  }
  const blinds = currentBlinds(G);
  const max = p.chips + p.bet;
  const minRaise = G.currentBet === 0 ? blinds.big : G.currentBet * 2;
  let total;
  if (action === 'allin') total = max;
  else {
    if (action === 'raise') total = Math.floor(Number(amount));
    else if (action === 'twobet') total = G.currentBet * 2;
    else if (action === 'twobb') total = blinds.big * 2;
    else if (action === 'threebb') total = blinds.big * 3;
    else total = snapTo5(G.pot + Math.min(owed, p.chips) + p.bet); // pot
    if (!Number.isFinite(total)) return fail('bad amount');
    total = Math.min(Math.max(total, minRaise), max); // at least the minimum raise, at most all-in
  }
  const add = total - p.bet;
  if (add <= 0) return fail('bad amount');
  p.chips -= add; p.bet = total; p.totalBet += add; G.pot += add;
  if (p.chips === 0) p.allIn = true;
  if (total > G.currentBet) {
    // A real raise: everyone else gets to act again
    G.currentBet = total;
    G.players.forEach((o) => { if (o !== p && !o.folded && !o.eliminated && !o.allIn) o.lastAction = null; });
  }
  // (An all-in for less than the bet is a call for what they have; the bet to match doesn't drop.)
  p.lastAction = { type: 'bet', label: p.allIn ? 'All In' : `Raise ${total}` };
  return OK;
}

// Quit. Home game: take your stack home; chips already bet stay in the pot.
// Tournament: blind out (stay in, checked/folded every turn) — or, with no
// chips, out for good.
function quit(G, p, ctx) {
  if (p.eliminated) return OK;
  if (fmt(G).moneyMode) {
    const wasUp = G.players[G.actionIndex] === p;
    p.cashedOutCents = p.chips || 0;
    p.chips = 0;
    p.eliminated = true; p.folded = true; p.broke = false;
    p.quitHand = G.handNumber;
    p.lastAction = { type: 'quit', label: 'Quit' };
    ctx.effects.settle = true;
    if (isBetting(G)) {
      const inHand = G.players.filter((x) => !x.folded && !x.eliminated);
      if (wasUp || inHand.length === 1) advanceAction(G, ctx);
    } else if (G.stage === 'guts_decision') {
      if (gutsEligible(G).every((x) => G.gutsDecisions[x.id])) resolveGuts(G, ctx);
    } else if (G.pendingDealerChoice && G.dealerId === p.id) {
      // The dealer left before choosing: deal again with the next dealer
      G.pendingDealerChoice = false;
      G.handNumber--;
      dealNewHand(G, ctx);
    }
    return OK;
  }
  if ((p.chips || 0) <= 0) { sitOut(G, p); p.lastAction = { type: 'quit', label: 'Quit' }; return OK; }
  p.awayFromTable = true; p.disconnected = true;
  p.lastAction = { type: 'away', label: 'Away' };
  // Everyone still in has quit: nobody is left to play it out, so it's called off
  if (G.players.filter((x) => !x.eliminated).every((x) => x.awayFromTable)) { abandonGame(G); return OK; }
  if (isBetting(G) && G.players[G.actionIndex] === p && !p.folded) { autoAct(G, p); advanceAction(G, ctx); }
  return OK;
}

// Tournament called off (the host ended it, or everyone quit): the hand in
// progress is voided and nothing is recorded to the Friends Ledger.
function abandonGame(G) {
  voidHand(G);
  G.abandoned = true;
  G.tournamentOver = true;
  G.stage = 'finished';
  G.actionIndex = -1;
  G.turnDeadline = null;
  G.pendingDealerChoice = false;
  G.paused = false;
  G.pauseQueued = false;
  G.nextDealAt = null;
}

// ── Clock ──────────────────────────────────────────────────────────────────
// Applies whatever is due at ctx.now. Returns true if the state changed.
// Any phone may call this; time is always the server's.
export function tick(G, ctx) {
  ctx.effects = ctx.effects || {};
  if (G.tournamentOver || G.paused) return false;
  const level = G.blindLevel;
  advanceBlindClock(G, ctx);
  let changed = level !== G.blindLevel;

  if (G.breakActive) return changed;
  const gone = (id) => !!(ctx.isGone && ctx.isGone(id));

  // A turn ran out, or the player on turn is gone: check if allowed, else fold
  if (isBetting(G)) {
    const actor = G.players[G.actionIndex];
    if (actor && !actor.folded && !actor.eliminated && !actor.allIn) {
      const timedOut = G.turnDeadline && ctx.now >= G.turnDeadline;
      const awayTooLong = gone(actor.id) && ctx.now - (G.turnStartMs || ctx.now) >= AWAY_GRACE_MS;
      if (timedOut || awayTooLong) { autoAct(G, actor); advanceAction(G, ctx); return true; }
    }
    return changed;
  }
  // A gone dealer doesn't hold up dealer's choice
  if (G.pendingDealerChoice && gone(G.dealerId) && ctx.now - (G.dealerChoiceDeadline - DEALER_CHOICE_MS) >= AWAY_GRACE_MS) {
    pickVariant(G, 'holdem', ctx);
    G.autoPicked = G.handNumber;
    return true;
  }
  if (G.stage === 'guts_decision' && G.gutsDeadlineMs && ctx.now >= G.gutsDeadlineMs) {
    gutsEligible(G).forEach((p) => { if (!G.gutsDecisions[p.id]) G.gutsDecisions[p.id] = 'out'; });
    resolveGuts(G, ctx);
    return true;
  }
  if (G.pendingDealerChoice && G.dealerChoiceDeadline && ctx.now >= G.dealerChoiceDeadline) {
    pickVariant(G, 'holdem', ctx);
    G.autoPicked = G.handNumber;
    return true;
  }
  if (G.nextDealAt && ctx.now >= G.nextDealAt) {
    // Wait for busted players to decide; sit out anyone who took too long
    for (const p of deciding(G)) {
      // Busted and gone (or no answer in 60s): sat out
      if (gone(p.id) || ctx.now - (p.brokeAt || ctx.now) >= REBUY_DECISION_MS) { sitOut(G, p); changed = true; }
    }
    if (deciding(G).length) return changed;
    dealNewHand(G, ctx);
    return true;
  }
  return changed;
}
