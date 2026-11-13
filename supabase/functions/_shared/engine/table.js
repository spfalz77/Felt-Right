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

import { makeDeck, evalBest, evalBest3Card, cmpScore, autoDiscardIndex, bringInKey, showingScore, cmpShowing } from './cards.js';
import { FORMATS, VARIANTS, DISCARD_SECONDS, DRAW_SECONDS, RUNOUT_CARD_SECONDS, RESULT_MAX_SECONDS, blindsAt } from './config.js';
import { buildSidePots } from './side-pots.js';

export const FIRST_DEAL_MS = 2000;          // start → first hand
export const NEXT_HAND_MS = 6000;           // Guts result on screen → next roll/hand
export const RESULT_MAX_MS = RESULT_MAX_SECONDS * 1000; // a hand's result stays up until everyone taps OK, or this long
export const RESULT_ACK_DEAL_MS = 1500;     // everyone tapped OK → next hand
export const RUNOUT_CARD_MS = RUNOUT_CARD_SECONDS * 1000; // all-in runout: one card every 4s
export const DEALER_CHOICE_MS = 25000;      // dealer picks the variant, else Hold'em
export const REBUY_DECISION_MS = 60000;     // busted player: re-buy or sit out, else sat out
export const RESUME_DEAL_MS = 1500;         // pause/break over → next hand
export const BREAK_AFTER_LEVELS = 4;        // tournament with re-buys: first break, then re-buys close
export const TURN_MS = 32000;               // a turn: 30s on the player's screen + 2s grace, then check/fold
export const AWAY_GRACE_MS = 5000;          // a player who's gone (app closed/offline) is checked/folded after 5s
export const DISCARD_MS = DISCARD_SECONDS * 1000; // Pineapple: everyone picks a discard, else one is picked for them
export const DRAW_MS = DRAW_SECONDS * 1000;       // 5-card draw: everyone picks cards to draw, else stands pat

const BETTING = ['preflop', 'flop', 'turn', 'river'];
const RAISES = ['raise', 'twobet', 'twobb', 'threebb', 'pot', 'allin'];

export const isBetting = (G) => BETTING.includes(G.stage);
const fmt = (G) => FORMATS[G.format] || FORMATS.tournament;
const styleOf = (G) => (VARIANTS[G.variant] || VARIANTS.holdem).style;
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
    variant: f === 'tournament' && VARIANTS[variant] && !VARIANTS[variant].homeOnly ? variant : 'holdem',
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
  delete out.mucked;
  const gutsShown = new Set(((G.gutsResults && G.gutsResults.handScores) || []).map((h) => h.id));
  const isGuts = (VARIANTS[G.variant] || {}).style === 'guts';
  out.players.forEach((p, i) => {
    const src = G.players[i];
    const show = (G.stage === 'showdown' || G.stage === 'runout') && (isGuts
      ? gutsShown.has(src.id)
      : !src.folded && !src.eliminated && !G.wonByFold);
    // (5-card stud: face-up cards stay visible while the player is in the hand)
    if (!show) p.hand = (p.hand || []).map((c) => (c && c.up && !src.folded ? c : { hidden: true }));
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
  if (!isBetting(G) && !['guts_decision', 'discard', 'draw'].includes(G.stage)) G.nextDealAt = ctx.now + RESUME_DEAL_MS;
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

// Home game: a player who's away isn't dealt in until they're back
const sitsOutDeal = (G, p) => fmt(G).moneyMode && !!p.awayFromTable;
const dealable = (G) => G.players.filter((p) => !p.eliminated && p.chips > 0 && !sitsOutDeal(G, p));

const rebuyOpen = (G) => fmt(G).moneyMode || (G.rebuysEnabled && !G.rebuyWindowClosed);
const deciding = (G) => (rebuyOpen(G) ? G.players.filter((p) => p.broke && !p.eliminated) : []);

function addPlacement(G, p) {
  if (!G.finalPlacements.some((fp) => fp.name === p.name)) G.finalPlacements.unshift({ name: p.name, emoji: p.emoji });
}

// ── Dealing ────────────────────────────────────────────────────────────────
function rotateDealer(G, ctx) {
  const eligible = dealable(G);
  G.players.forEach((p) => { p.isDealer = false; });
  let i;
  if (!G.dealerId) i = Math.floor(ctx.rng() * eligible.length);
  else i = (eligible.findIndex((p) => p.id === G.dealerId) + 1) % eligible.length; // -1 (busted) → 0
  eligible[i].isDealer = true;
  G.dealerId = eligible[i].id;
}

function dealNewHand(G, ctx) {
  G.nextDealAt = null;
  G.resultAcks = {};
  const active = G.players.filter((p) => !p.eliminated && p.chips > 0);
  if (active.length < 2) {
    if (!fmt(G).moneyMode) endTournament(G);
    // Home game with one stack left: nothing to deal; the host ends the game.
    return;
  }
  // Wait for players to come back (the first one back deals, see sit_back):
  // home game with fewer than two at the table, or a tournament where
  // everyone left is Away (it would otherwise play itself out)
  G.waitingForPlayers = dealable(G).length < 2 || active.every((p) => p.awayFromTable);
  if (G.waitingForPlayers) return;
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
  G.discards = {}; G.discardThen = null; G.discardDeadline = null;
  G.draws = {}; G.drawThen = null; G.drawDeadline = null; G.drawDone = null; G.mucked = [];
  G.bringInIdx = -1;
  G.deck = makeDeck(ctx.rng);
  G.players.forEach((p) => {
    p.hand = []; p.bet = 0; p.totalBet = 0; p.folded = false; p.allIn = false;
    if (!p.awayFromTable) p.lastAction = null;
    if (p.eliminated || p.chips <= 0 || sitsOutDeal(G, p)) p.folded = true; // (home game: away = not dealt in)
  });
  const eligible = G.players.filter((p) => !p.folded);
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
  if (vCfg.style === 'stud') { startStud(G, blinds, ctx); return; }
  G.currentBet = blinds.big;
  const dealerPos = G.players.findIndex((p) => p.id === G.dealerId);
  let sbIdx, bbIdx;
  if (eligible.length === 2) { sbIdx = dealerPos; bbIdx = nextActive(G, dealerPos); } // heads-up: dealer is SB
  else { sbIdx = nextActive(G, dealerPos); bbIdx = nextActive(G, sbIdx); }
  G.dealerPos = dealerPos; G.sbIdx = sbIdx; G.bbIdx = bbIdx;
  postBlind(G, sbIdx, blinds.small);
  postBlind(G, bbIdx, blinds.big);
  G.players[sbIdx].lastAction = { type: 'bet', label: `SB ${blinds.small}` };
  const firstToAct = eligible.length === 2 ? sbIdx : nextActive(G, bbIdx);
  if (vCfg.discardAt === 'preflop') { startDiscard(G, 'preflop', firstToAct, ctx); return; }
  startPreflopBetting(G, firstToAct, ctx);
}

function startPreflopBetting(G, idx, ctx) {
  G.stage = 'preflop';
  setActor(G, idx, ctx);
  // Blinds put everyone all-in (or left nobody able to act)
  const canAct = G.players.filter((p) => !p.folded && !p.eliminated && !p.allIn);
  if (isBetting(G) && canAct.length === 0) runOutToShowdown(G, ctx);
}

// ── Pineapple discards ─────────────────────────────────────────────────────
// Everyone still in the hand throws away one hole card at once (like Guts
// in/out): 20s, else the engine picks for them. A player who's away is picked
// for at once; a gone one after 5s. Then the hand carries on as Hold'em.
//   then = 'preflop' (Pineapple), 'flop' (Crazy Pineapple), or 'runout'
//   (everyone all-in before the Crazy Pineapple discard: discard, then run it out)
const keepCards = (G) => (VARIANTS[G.variant] || {}).keepCards || 0;
const discardPending = (G) => G.players.filter((p) => !p.folded && !p.eliminated && p.hand && keepCards(G) && p.hand.length > keepCards(G));
const needsDiscard = (G) => !!(VARIANTS[G.variant] || {}).discardAt && discardPending(G).length > 0;

function startDiscard(G, then, nextIdx, ctx) {
  G.stage = 'discard';
  G.discardThen = then;
  G.discardNext = nextIdx;
  G.discards = {};
  G.discardStartMs = ctx.now;
  G.discardDeadline = ctx.now + DISCARD_MS;
  G.actionIndex = -1;
  G.turnStartAt = null;
  G.turnDeadline = null;
  discardPending(G).filter((p) => p.awayFromTable).forEach((p) => discardCard(G, p, null));
  maybeEndDiscard(G, ctx);
}

// idx null = the engine picks
function discardCard(G, p, idx) {
  const i = idx == null ? autoDiscardIndex(p.hand, G.community) : idx;
  p.hand.splice(i, 1);
  G.discards[p.id] = idx == null ? 'auto' : 'picked';
  G.dealSeq++; // phones re-read their own cards
}

function maybeEndDiscard(G, ctx) {
  if (G.stage !== 'discard' || discardPending(G).length) return;
  const then = G.discardThen;
  G.discardDeadline = null;
  if (then === 'preflop') { startPreflopBetting(G, G.discardNext, ctx); return; }
  G.stage = 'flop';
  if (then === 'runout') { runOutToShowdown(G, ctx); return; }
  firstToActAfterDealer(G, ctx);
}

function discardAction(G, p, amount, ctx) {
  if (G.stage !== 'discard') return fail('no discard in progress');
  if (!discardPending(G).includes(p)) return fail('nothing to discard');
  const idx = Number(amount);
  if (!Number.isInteger(idx) || idx < 0 || idx >= p.hand.length) return fail('pick a card to discard');
  discardCard(G, p, idx);
  maybeEndDiscard(G, ctx);
  return OK;
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
  // Guts rolls on quickly; any other hand's result waits for everyone's OK
  G.resultAcks = {};
  G.nextDealAt = ctx.now + (styleOf(G) === 'guts' ? NEXT_HAND_MS : RESULT_MAX_MS);
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

function goAway(G, p) {
  p.awayFromTable = true;
}

// Back at the table (I'm back, Ready at the break, or rejoining)
function comeBack(G, p, ctx) {
  if (!p.awayFromTable) return;
  p.awayFromTable = false; p.disconnected = false; p.leftTable = false;
  if (!isBetting(G)) p.lastAction = null;
  // A table that was waiting for players: deal
  if (G.waitingForPlayers && !G.paused && !G.breakActive && dealable(G).length >= 2) { G.waitingForPlayers = false; G.nextDealAt = ctx.now + RESUME_DEAL_MS; }
}

function autoAct(G, p) {
  if (G.currentBet > p.bet) { p.folded = true; p.lastAction = { type: 'fold', label: 'Away' }; }
  else p.lastAction = { type: 'check', label: 'Away' };
  recordMove(G, p);
}

// The last few bets/checks/folds, numbered, so every phone can play the right
// sound for each one even when a street closes (and lastAction resets) in the
// same save as the move that closed it.
function recordMove(G, p) {
  G.moveSeq = (G.moveSeq || 0) + 1;
  const m = { seq: G.moveSeq, id: p.id, type: p.lastAction ? p.lastAction.type : null, label: p.lastAction ? p.lastAction.label : '' };
  G.recentMoves = [...(G.recentMoves || []), m].slice(-8);
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
  const style = styleOf(G);
  if (style === 'stud') {
    if (G.stage === 'river') { showdown(G, ctx); return; }
    dealStudStreet(G);
    G.stage = STUD_NEXT[G.stage];
    studFirstToAct(G, ctx);
    return;
  }
  if (style === 'draw') {
    if (G.stage === 'preflop') { startDraw(G, 'river', ctx); return; }
    showdown(G, ctx);
    return;
  }
  if (G.stage === 'preflop') {
    G.community = [G.deck.pop(), G.deck.pop(), G.deck.pop()]; G.stage = 'flop';
    if ((VARIANTS[G.variant] || {}).discardAt === 'flop' && needsDiscard(G)) { startDiscard(G, 'flop', -1, ctx); return; }
  }
  else if (G.stage === 'flop') { G.community.push(G.deck.pop()); G.stage = 'turn'; }
  else if (G.stage === 'turn') { G.community.push(G.deck.pop()); G.stage = 'river'; }
  else { showdown(G, ctx); return; }
  firstToActAfterDealer(G, ctx);
}

// First to act after the flop: first player left of the dealer who can still bet
function firstToActAfterDealer(G, ctx) {
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
  const style = styleOf(G);
  if (style === 'stud') { startRunout(G, ctx); return; } // one upcard street at a time
  if (style === 'draw') {
    if (G.drawDone !== G.handNumber) { G.players.forEach((p) => { p.bet = 0; }); G.currentBet = 0; startDraw(G, 'runout', ctx); return; }
    showdown(G, ctx);
    return;
  }
  // Crazy Pineapple all-in before the discard: deal the flop, everyone discards, then run it out
  if (needsDiscard(G)) {
    if ((VARIANTS[G.variant] || {}).discardAt === 'flop' && G.community.length < 3) {
      G.players.forEach((p) => { p.bet = 0; });
      G.currentBet = 0;
      while (G.community.length < 3) G.community.push(G.deck.pop());
    }
    startDiscard(G, 'runout', -1, ctx);
    return;
  }
  startRunout(G, ctx);
}

// Everyone's all-in: hands go face up and the rest of the board comes one card
// at a time (tick() deals each when it's due), so people watch it land.
function startRunout(G, ctx) {
  G.players.forEach((p) => { p.bet = 0; });
  G.currentBet = 0;
  G.actionIndex = -1;
  G.turnStartAt = null;
  G.turnDeadline = null;
  if (runoutDone(G)) { showdown(G, ctx); return; }
  G.stage = 'runout';
  G.runoutNextAt = ctx.now + RUNOUT_CARD_MS;
}

// Board games: five community cards. Stud: everyone in the hand has five.
function runoutDone(G) {
  if (styleOf(G) === 'stud') return !G.players.some((p) => !p.folded && !p.eliminated && p.hand.length < 5);
  return G.community.length >= 5;
}

function dealRunoutCard(G, ctx) {
  if (styleOf(G) === 'stud') { dealStudStreet(G); G.dealSeq++; } // (phones re-read their own cards)
  else G.community.push(G.deck.pop());
  if (runoutDone(G)) { G.runoutNextAt = null; showdown(G, ctx); return; }
  G.runoutNextAt = ctx.now + RUNOUT_CARD_MS;
}

// ── 5-card stud ────────────────────────────────────────────────────────────
// Everyone in the hand antes the small blind. Card 1 is down, card 2 up. The
// lowest upcard brings it in for the small blind (min raise = the big blind)
// and doesn't get an option if everyone just calls. Each later street deals
// one more upcard; the best showing hand acts first.
const STUD_NEXT = { preflop: 'flop', flop: 'turn', turn: 'river' };
const upCards = (p) => (p.hand || []).filter((c) => c && c.up);

function startStud(G, blinds, ctx) {
  const inHand = G.players.filter((p) => !p.folded && !p.eliminated);
  inHand.forEach((p) => {
    p.hand.forEach((c, i) => { c.up = i >= 1; });
    const paid = Math.min(blinds.small, p.chips);
    p.chips -= paid; p.totalBet += paid; G.pot += paid;
    if (p.chips === 0) p.allIn = true;
  });
  G.dealerPos = G.players.findIndex((p) => p.id === G.dealerId);
  G.sbIdx = -1; G.bbIdx = -1;
  G.stage = 'preflop';
  const canPay = inHand.filter((p) => p.chips > 0);
  if (canPay.length === 0) { runOutToShowdown(G, ctx); return; }
  const low = canPay.reduce((a, b) => (bringInKey(b.hand[1]) < bringInKey(a.hand[1]) ? b : a));
  const idx = G.players.indexOf(low);
  postBlind(G, idx, blinds.small);
  G.currentBet = low.bet;
  low.lastAction = { type: 'bet', label: `Bring-in ${low.bet}` };
  G.bringInIdx = idx;
  startPreflopBetting(G, nextActive(G, idx), ctx);
}

// One upcard to everyone still in the hand, starting left of the dealer
function dealStudStreet(G) {
  const n = G.players.length;
  const dealerIdx = Math.max(G.players.findIndex((p) => p.isDealer), 0);
  for (let i = 1; i <= n; i++) {
    const p = G.players[(dealerIdx + i) % n];
    if (!p.folded && !p.eliminated && p.hand.length < 5) p.hand.push({ ...G.deck.pop(), up: true });
  }
}

function studFirstToAct(G, ctx) {
  const n = G.players.length;
  const dealerIdx = Math.max(G.players.findIndex((p) => p.isDealer), 0);
  let best = -1, bestScore = null;
  for (let i = 1; i <= n; i++) {
    const idx = (dealerIdx + i) % n;
    const p = G.players[idx];
    if (p.folded || p.eliminated || p.allIn) continue;
    const sc = showingScore(upCards(p));
    if (best < 0 || cmpShowing(sc, bestScore) > 0) { best = idx; bestScore = sc; }
  }
  if (best < 0) { runOutToShowdown(G, ctx); return; }
  setActor(G, best, ctx);
}

// ── 5-card draw ────────────────────────────────────────────────────────────
// After the first betting round everyone in the hand picks 0–3 cards to
// throw away at once (25s, else they stand pat; away at once, gone after 5s)
// and gets replacements. Then a second betting round ('river'), first to act
// left of the dealer. A deck that runs short is topped up with the shuffled
// discards.
//   then = 'river' (bet again) or 'runout' (everyone all-in: straight to showdown)
const drawPending = (G) => G.players.filter((p) => !p.folded && !p.eliminated && G.draws && G.draws[p.id] == null);

function startDraw(G, then, ctx) {
  G.stage = 'draw';
  G.drawThen = then;
  G.draws = {};
  G.drawStartMs = ctx.now;
  G.drawDeadline = ctx.now + DRAW_MS;
  G.actionIndex = -1;
  G.turnStartAt = null;
  G.turnDeadline = null;
  drawPending(G).filter((p) => p.awayFromTable).forEach((p) => drawCards(G, p, [], ctx));
  maybeEndDraw(G, ctx);
}

function drawFromDeck(G, ctx) {
  if (!G.deck.length) {
    const pile = G.mucked || [];
    for (let i = pile.length - 1; i > 0; i--) { const j = Math.floor(ctx.rng() * (i + 1)); [pile[i], pile[j]] = [pile[j], pile[i]]; }
    G.deck = pile; G.mucked = [];
  }
  return G.deck.pop();
}

function drawCards(G, p, idxs, ctx) {
  const thrown = idxs.map((i) => p.hand[i]);
  const kept = p.hand.filter((_, i) => !idxs.includes(i));
  const fresh = idxs.map(() => drawFromDeck(G, ctx)).filter(Boolean);
  p.hand = [...kept, ...fresh];
  (G.mucked = G.mucked || []).push(...thrown);
  G.draws[p.id] = idxs.length;
  p.lastAction = { type: 'check', label: idxs.length ? `Drew ${idxs.length}` : 'Stood pat' };
  G.dealSeq++; // phones re-read their cards
}

function maybeEndDraw(G, ctx) {
  if (G.stage !== 'draw' || drawPending(G).length) return;
  G.drawDeadline = null;
  G.drawDone = G.handNumber;
  G.stage = 'river';
  if (G.drawThen === 'runout') { showdown(G, ctx); return; }
  // Everyone who can still bet gets to act again (this clears the 'Drew 2' labels)
  G.players.forEach((p) => { if (!p.folded && !p.eliminated && !p.allIn) p.lastAction = null; });
  firstToActAfterDealer(G, ctx);
}

function drawAction(G, p, amount, ctx) {
  if (G.stage !== 'draw') return fail('no draw in progress');
  if (!drawPending(G).includes(p)) return fail('already drew');
  const list = amount == null ? [] : Array.isArray(amount) ? amount : [amount];
  const idxs = [...new Set(list.map(Number))];
  if (idxs.some((i) => !Number.isInteger(i) || i < 0 || i >= p.hand.length)) return fail('pick cards to draw');
  if (idxs.length > (VARIANTS[G.variant].maxDraw || 3)) return fail(`draw at most ${VARIANTS[G.variant].maxDraw || 3}`);
  drawCards(G, p, idxs, ctx);
  maybeEndDraw(G, ctx);
  return OK;
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
  G.players.forEach((p) => { p.chips += winnings[p.id]; p.bet = 0; }); // the chips in front went into the pot
  G.pot = 0;
  G.runoutNextAt = null;
  G.lastResult = { hand: G.handNumber, winnings, pots };
  // Every hand's payout, with each stack before (start of hand) and after,
  // so a disputed pot can be checked afterwards
  G.resultLog = [...(G.resultLog || []), {
    hand: G.handNumber, at: ctx.now, variant: G.variant, pots, wonByFold: G.wonByFold,
    community: (G.community || []).map((c) => `${c.rank}${c.suit}`),
    stacks: G.players.filter((p) => (p.totalBet || 0) > 0 || winnings[p.id]).map((p) => ({
      id: p.id, name: p.name, before: p.chips - winnings[p.id] + (p.totalBet || 0), after: p.chips, folded: !!p.folded,
      cards: !p.folded && !G.wonByFold ? (p.hand || []).map((c) => `${c.rank}${c.suit}`) : null,
    })),
  }].slice(-100);

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

// Everyone who's still at the table (not busted, away or gone) has tapped OK
// on the hand's result
function resultAcked(G, ctx) {
  const acks = G.resultAcks || {};
  const gone = (id) => !!(ctx.isGone && ctx.isGone(id));
  return G.players
    .filter((p) => !p.eliminated && !p.broke && !p.awayFromTable && p.cashedOutCents == null && !gone(p.id))
    .every((p) => acks[p.id]);
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

  if (action === 'away') { // "Away" from the table screen: stay seated, auto check/fold
    if (p.eliminated) return OK;
    goAway(G, p);
    if (isBetting(G) && G.players[G.actionIndex] === p && !p.folded && !p.allIn) { autoAct(G, p); advanceAction(G, ctx); }
    if (G.stage === 'discard' && discardPending(G).includes(p)) { discardCard(G, p, null); maybeEndDiscard(G, ctx); }
    if (G.stage === 'draw' && drawPending(G).includes(p)) { drawCards(G, p, [], ctx); maybeEndDraw(G, ctx); }
    return OK;
  }

  if (action === 'sit_back') { comeBack(G, p, ctx); return OK; }

  if (action === 'discard') return discardAction(G, p, amount, ctx);
  if (action === 'draw') return drawAction(G, p, amount, ctx);

  if (action === 'guts_in' || action === 'guts_out') return gutsDecide(G, p, action === 'guts_in' ? 'in' : 'out', ctx);

  if (action === 'pause') { // anyone may ask; mid-hand it waits for the hand to end
    if (G.paused) return OK;
    G.pauseReady = [];
    if (isBetting(G) || ['guts_decision', 'discard', 'draw', 'runout'].includes(G.stage)) G.pauseQueued = true;
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
    comeBack(G, p, ctx); // tapping Ready says they're here
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

  if (action === 'result_ok') { // "Got it" on the hand's result
    if (G.stage !== 'showdown' || !G.nextDealAt || styleOf(G) === 'guts') return OK;
    G.resultAcks = { ...(G.resultAcks || {}), [p.id]: true };
    if (resultAcked(G, ctx)) G.nextDealAt = Math.min(G.nextDealAt, ctx.now + RESULT_ACK_DEAL_MS);
    return OK;
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
  if (action === 'fold') { p.folded = true; p.lastAction = { type: 'fold', label: 'Fold' }; recordMove(G, p); return OK; }
  if (action === 'check') {
    if (owed > 0) return fail('cannot check: there is a bet to call');
    p.lastAction = { type: 'check', label: 'Check' };
    recordMove(G, p);
    return OK;
  }
  if (action === 'call') {
    const amt = Math.min(owed, p.chips);
    p.chips -= amt; p.bet += amt; p.totalBet += amt; G.pot += amt;
    if (p.chips === 0) p.allIn = true;
    p.lastAction = { type: 'bet', label: `Call ${amt}` };
    recordMove(G, p);
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
  recordMove(G, p);
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
    } else if (G.stage === 'runout') {
      if (G.players.filter((x) => !x.folded && !x.eliminated).length === 1) showdown(G, ctx);
    } else if (G.stage === 'discard' || G.stage === 'draw') {
      const inHand = G.players.filter((x) => !x.folded && !x.eliminated);
      if (inHand.length === 1) showdown(G, ctx);
      else if (G.stage === 'discard') maybeEndDiscard(G, ctx);
      else maybeEndDraw(G, ctx);
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
  p.awayFromTable = true; p.disconnected = true; p.leftTable = true; // (left on purpose: no auto-rejoin)
  p.lastAction = { type: 'away', label: 'Away' };
  // Everyone still in has quit: nobody is left to play it out, so it's called off
  if (G.players.filter((x) => !x.eliminated).every((x) => x.awayFromTable)) { abandonGame(G); return OK; }
  if (isBetting(G) && G.players[G.actionIndex] === p && !p.folded) { autoAct(G, p); advanceAction(G, ctx); }
  if (G.stage === 'discard' && discardPending(G).includes(p)) { discardCard(G, p, null); maybeEndDiscard(G, ctx); }
  if (G.stage === 'draw' && drawPending(G).includes(p)) { drawCards(G, p, [], ctx); maybeEndDraw(G, ctx); }
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
      // From now on they're Away: every later turn is checked/folded at once
      // (tournament), or they sit out the deal (home game), until they're back
      if (timedOut || awayTooLong) { goAway(G, actor); autoAct(G, actor); advanceAction(G, ctx); return true; }
    }
    return changed;
  }
  // All-in runout: the next card is due
  if (G.stage === 'runout') {
    if (!G.runoutNextAt || ctx.now < G.runoutNextAt) return changed;
    dealRunoutCard(G, ctx);
    return true;
  }
  // Discards: time's up (or a gone player waited out the grace): the engine picks
  if (G.stage === 'discard') {
    const timedOut = G.discardDeadline && ctx.now >= G.discardDeadline;
    const due = discardPending(G).filter((p) => timedOut || (gone(p.id) && ctx.now - (G.discardStartMs || ctx.now) >= AWAY_GRACE_MS));
    if (!due.length) return changed;
    due.forEach((p) => discardCard(G, p, null));
    maybeEndDiscard(G, ctx);
    return true;
  }
  // Draw: time's up (or a gone player waited out the grace): they stand pat
  if (G.stage === 'draw') {
    const timedOut = G.drawDeadline && ctx.now >= G.drawDeadline;
    const due = drawPending(G).filter((p) => timedOut || (gone(p.id) && ctx.now - (G.drawStartMs || ctx.now) >= AWAY_GRACE_MS));
    if (!due.length) return changed;
    due.forEach((p) => drawCards(G, p, [], ctx));
    maybeEndDraw(G, ctx);
    return true;
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
  // Everyone else tapped OK and the one holding it up has gone: deal soon
  if (G.stage === 'showdown' && G.nextDealAt && G.nextDealAt > ctx.now + RESULT_ACK_DEAL_MS
      && Object.keys(G.resultAcks || {}).length && resultAcked(G, ctx)) {
    G.nextDealAt = ctx.now + RESULT_ACK_DEAL_MS;
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
