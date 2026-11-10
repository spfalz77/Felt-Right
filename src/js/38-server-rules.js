// ════════════════════════════════════════════════════════════════════════════
// SERVER-RUN GAMES (migration plan phase 2)
// ════════════════════════════════════════════════════════════════════════════
// With SERVER_RULES on, a new game is run by the `table` Edge Function, not by
// the host's phone. Every phone, the host's included, then follows the
// existing guest code path: it renders games.state and sends its moves. The
// host keeps only the lobby-owner buttons (End game).
//
// A game's own state says which engine runs it (G.rules === 'server'), so a
// game started before the switch finishes on the engine it started with.
//
// Off on the live site until cutover (phase 6). The E2E tests turn it on.
const SERVER_RULES = false;

let gameHostId = null;          // the lobby owner of the current game
let _serverClockOffsetMs = 0;   // server clock − this phone's clock (from replies)
let _serverTicker = null;
let _heartbeat = null;
let _lastTickAt = 0;

// While this phone is in a server game, it says so every 4s. The server counts
// a player as gone (app closed, phone offline) after 12s without one.
function sendHeartbeat(gameId) {
  if (!sb || !me || me.id === 'demo') return;
  sb.from('game_presence').upsert({ game_id: gameId, user_id: me.id, last_seen_at: new Date().toISOString() })
    .then(() => {}, () => {});
}

function isServerState(state) { return !!state && state.rules === 'server'; }
function isServerGame() { return isServerState(G); }

// Who gets the host's buttons. In a server game that's the lobby owner; in a
// phone-run game it's whichever phone is running the table.
function isTableHost() {
  return isServerGame() ? (!!me && me.id === gameHostId) : amHost;
}

function serverNow() { return Date.now() + _serverClockOffsetMs; }

// One call to the table. Returns { data, error } (error is a message string).
async function callTable(gameId, action, amount, extra) {
  if (!sb || !gameId) return { data: null, error: 'not connected' };
  try {
    const { data, error } = await sb.functions.invoke('table', {
      body: { game_id: gameId, action, amount: amount ?? null, ...(extra || {}) },
    });
    if (data && typeof data.now === 'number') _serverClockOffsetMs = data.now - Date.now();
    if (error) {
      // Non-2xx: the reply body carries { error }
      let msg = error.message || 'Action failed';
      try { const b = await error.context?.json?.(); if (b?.error) msg = b.error; } catch (e) { /* keep msg */ }
      return { data: null, error: msg };
    }
    return { data, error: null };
  } catch (e) {
    return { data: null, error: e.message || 'Action failed' };
  }
}

// The app's moves were always rows in player_actions. In a server game the
// ones the server handles go to the table instead; everything else (nudges,
// and moves the server doesn't run yet) is still inserted as before.
// Same return shape as an insert: a promise of { error }.
const _variantByCode = { 1: 'holdem', 2: 'omaha', 3: 'guts3' };
function toServerAction(row) {
  const a = row.action;
  if (['fold', 'check', 'call', 'raise', 'twobet', 'twobb', 'threebb', 'pot', 'allin'].includes(a)) return [a, row.amount];
  if (a === 'pick_variant') return ['pick_variant', _variantByCode[row.amount] || 'holdem'];
  if (a === 'rebuy' || a === 'sit_out' || a === 'sit_back') return [a, null];
  if (a === 'step_away' || a === 'quit_cashout' || a === 'quit') return ['quit', null];
  if (['guts_in', 'guts_out', 'break_ready', 'add_on', 'chop_offer', 'chop_accept', 'chop_decline', 'chop_cancel', 'muck'].includes(a)) return [a, null];
  if (a === 'pause_request') return ['pause', null];
  if (a === 'reveal') return ['reveal', row.cardIndexes || null]; // which cards to show (all if none given)
  return null;
}

async function postAction(row) {
  if (isServerGame() && row.game_id === currentGameId) {
    // (cardIndexes is a server-only extra; player_actions has no such column)
    const mapped = toServerAction(row);
    if (mapped) {
      const { error } = await callTable(row.game_id, mapped[0], mapped[1]);
      if (error && error !== 'game is over') toast(error);
      return { error: error ? { message: error } : null };
    }
  }
  const { cardIndexes, ...insertRow } = row;
  return sb.from('player_actions').insert(insertRow);
}

// Host-only controls in a server game go straight to the table.
// Returns true when it handled the call (the caller then stops).
function serverHostControl(action) {
  if (!isServerGame()) return false;
  if (!isTableHost()) return true;
  callTable(currentGameId, action).then(({ error }) => { if (error) toast(error); });
  return true;
}

// Host taps Start: the server seats everyone and runs the game from here.
async function serverStartGame() {
  const gameId = currentLobbyId;
  if (!gameId) return;
  stopLobbyWatchdog();
  const btn = document.getElementById('lobby-start-btn');
  if (btn) btn.disabled = true;
  const { error } = await callTable(gameId, 'start', null, {
    settings: {
      levels: BLIND_LEVELS,
      duration: blindDurationSeconds,
      rebuys: !!gameRebuysEnabled,
      buyIn: gameBuyIn,
      // Test-only scripted deals (the server ignores these outside the test stack)
      rigs: Array.isArray(window.__feltRightRiggedHands) ? window.__feltRightRiggedHands.splice(0) : [],
    },
  });
  if (error) {
    toast(error);
    if (btn) btn.disabled = false;
    return;
  }
  const { data } = await sb.from('games').select('state, host_id').eq('id', gameId).maybeSingle();
  if (!data?.state) { toast('Could not load the game'); return; }
  gameHostId = data.host_id;
  enterGame(gameId, data.state);
}

// Entering a server game (start, lobby, or rejoin): this phone never runs the table.
function enterServerGame(gameId) {
  amHost = false;
  startServerTicker(gameId);
  if (!gameHostId) {
    sb.from('games').select('host_id').eq('id', gameId).maybeSingle().then(({ data }) => {
      if (data) { gameHostId = data.host_id; if (G) renderGame(); }
    });
  }
}

// Deadlines (next deal, dealer's choice) are judged on the server's clock.
// When one has passed, any phone asks the server to apply it; a phone that
// asks early or twice just gets "nothing to do".
function startServerTicker(gameId) {
  stopServerTicker();
  sendHeartbeat(gameId);
  _heartbeat = setInterval(() => sendHeartbeat(gameId), 4000);
  _serverTicker = setInterval(() => {
    if (!G || currentGameId !== gameId || !isServerGame()) { stopServerTicker(); return; }
    if (G.tournamentOver || G.paused) return;
    const levelEndsAt = G.format === 'tournament' && !G.breakActive && G.levelStartedAt && G.blindDuration
      ? G.levelStartedAt + G.blindDuration * 1000 : null;
    // The player on turn (or the dealer choosing) looks gone on this phone:
    // ask the server to check after 5s; it decides from heartbeats
    const BETTING = ['preflop', 'flop', 'turn', 'river'];
    const actor = BETTING.includes(G.stage) ? G.players?.[G.actionIndex] : null;
    const awayTurnAt = actor && actor.id !== me.id && !isPlayerOnline(actor.id) && G.turnStartMs ? G.turnStartMs + 5000 : null;
    const awayDealerAt = G.pendingDealerChoice && G.dealerId !== me.id && !isPlayerOnline(G.dealerId) && G.dealerChoiceDeadline
      ? G.dealerChoiceDeadline - 25000 + 5000 : null;
    const due = [
      awayTurnAt, awayDealerAt,
      BETTING.includes(G.stage) ? G.turnDeadline : null,
      G.breakActive ? null : G.nextDealAt,
      G.pendingDealerChoice ? G.dealerChoiceDeadline : null,
      G.stage === 'guts_decision' ? G.gutsDeadlineMs : null,
      levelEndsAt,
    ].some((t) => t && serverNow() >= t);
    if (!due || Date.now() - _lastTickAt < 2000) return;
    _lastTickAt = Date.now();
    callTable(gameId, 'tick');
  }, 500);
}

function stopServerTicker() {
  clearInterval(_serverTicker);
  _serverTicker = null;
  clearInterval(_heartbeat);
  _heartbeat = null;
}

// Blind level and clock come from the server's state.
function syncBlindClockFromServer() {
  if (!isServerGame()) return false;
  _currentBlindLevel = G.blindLevel || 0;
  if (G.levelStartedAt) _blindLevelStartTime = G.levelStartedAt - _serverClockOffsetMs;
  return true;
}

// Test hook: queue a scripted deal (the E2E tests call this on the host's screen).
function queueRiggedDeal(rig) {
  if (isServerGame()) return callTable(currentGameId, 'rig', rig);
  (window.__feltRightRiggedHands ||= []).push(rig);
  return Promise.resolve({ error: null });
}
