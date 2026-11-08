// ── ADVANCE ACTION ────────────────────────────────────────────────────────────
// G.lastRaiserIndex — index of the player who last raised/bet this street.
// The round ends when action gets back to that player with everyone else having called/folded.
// If no one has raised, round ends when everyone has acted once.

let _hostTurnEnforcer = null;
const TURN_ENFORCE_LIMIT_MS = 45000; // 45s from turn start before auto-fold
// A player whose app is closed / offline (no presence) doesn't get the full
// 45s: after this short grace the host checks for them, or folds them if they
// face a bet. They come back to normal turns as soon as they rejoin.
const DISCONNECTED_GRACE_MS = 5000;

function stopHostTurnEnforcer() {
  clearInterval(_hostTurnEnforcer);
  _hostTurnEnforcer = null;
}

function startHostTurnEnforcer() {
  stopHostTurnEnforcer();
  if (!amHost || !G || G.paused) return;
  if (G.actionIndex < 0) return;
  const p = G.players[G.actionIndex];
  if (!p || p.id === me.id) return; // host's own turn uses UI timer
  if (p.folded || p.eliminated) return;
  if (!p.id || p.id.length < 10) return; // CPU/demo

  const startedAt = G.turnStartAt ? new Date(G.turnStartAt).getTime() : Date.now();

  // Check every 2 seconds using wall-clock time — works even when tab was backgrounded
  _hostTurnEnforcer = setInterval(() => {
    if (!G || G.actionIndex < 0 || G.paused) { stopHostTurnEnforcer(); return; }
    const stillP = G.players[G.actionIndex];
    if (!stillP || stillP.id !== p.id) { stopHostTurnEnforcer(); return; }
    if (stillP.folded || stillP.eliminated) { stopHostTurnEnforcer(); return; }

    const elapsed = Date.now() - startedAt;
    const gone = !isPlayerOnline(stillP.id); // live presence, not the saved flag (state syncs can reset it)
    if (elapsed < (gone ? DISCONNECTED_GRACE_MS : TURN_ENFORCE_LIMIT_MS)) return;

    // Time's up — auto check/fold
    stopHostTurnEnforcer();
    const callAmt = Math.min(G.currentBet - stillP.bet, stillP.chips);
    if (callAmt > 0) {
      stillP.folded = true;
      stillP.lastAction = { type:'fold', label:'Away' };
    } else {
      stillP.lastAction = { type:'check', label:'Away' };
    }
    stillP.disconnected = true;
    renderGame();
    setTimeout(advanceAction, 500);
  }, 2000);
}

function advanceAction() {
  stopHostTurnEnforcer();
  const active = G.players.filter(p => !p.folded && !p.eliminated);

  // Only one player left → immediate win
  if (active.length === 1) { doShowdown(); return; }

  const canAct = active.filter(p => !p.allIn);

  // If nobody can act (everyone's all-in or one can't call more), run out to showdown
  if (canAct.length === 0 || (canAct.length === 1 && canAct[0].bet >= G.currentBet)) {
    runOutToShowdown();
    return;
  }

  const roundDone = canAct.every(p => p.bet >= G.currentBet && p.lastAction !== null);

  if (roundDone) {
    advanceStage();
    return;
  }

  let searchIdx = G.actionIndex;
  for (let i = 0; i < G.players.length; i++) {
    searchIdx = nextActive(searchIdx);
    const candidate = G.players[searchIdx];
    if (!candidate || candidate.folded || candidate.eliminated || candidate.allIn) continue;
    if (candidate.bet < G.currentBet || candidate.lastAction === null) {
      G.actionIndex = searchIdx;
      renderGame();
      syncGameState();
      // If the candidate is stepped away, auto check/fold instead of waiting
      if (candidate.awayFromTable && amHost) {
        setTimeout(() => autoActAway(candidate.id), 400);
        return;
      }
      if (amHost) startHostTurnEnforcer();
      if (!isMyTurn()) setTimeout(runCpuTurn, 700);
      return;
    }
  }

  advanceStage();
}

// ── ADVANCE STAGE ────────────────────────────────────────────────────────────
function runOutToShowdown() {
  // Return any uncalled bets first (e.g. one player all-in for less)
  returnUncalledBets();
  // All remaining active players are all-in (or can't bet more) — deal remaining community cards
  if (G.stage === 'preflop') {
    G.community = [G.deck.pop(), G.deck.pop(), G.deck.pop(), G.deck.pop(), G.deck.pop()];
  } else if (G.stage === 'flop') {
    G.community.push(G.deck.pop(), G.deck.pop());
  } else if (G.stage === 'turn') {
    G.community.push(G.deck.pop());
  }
  G.stage = 'showdown';
  G.actionIndex = -1;
  renderGame();
  syncGameState();
  setTimeout(doShowdown, 1200);
}

function advanceStage() {
  // Return uncalled bets BEFORE clearing per-street bets
  returnUncalledBets();
  // Reset bets AND lastAction for the new street
  G.players.forEach(p => { p.bet = 0; if (!p.folded && !p.eliminated) p.lastAction = null; });
  G.currentBet = 0;

  if (G.stage === 'preflop') {
    G.community = [G.deck.pop(), G.deck.pop(), G.deck.pop()];
    G.stage = 'flop';
  } else if (G.stage === 'flop') {
    G.community.push(G.deck.pop()); G.stage = 'turn';
  } else if (G.stage === 'turn') {
    G.community.push(G.deck.pop()); G.stage = 'river';
  } else if (G.stage === 'river') {
    G.stage = 'showdown';
    renderGame();
    syncGameState();
    setTimeout(doShowdown, 600);
    return;
  }

  // Action starts left of dealer
  const dealerIdx = G.players.findIndex(p => p.isDealer);
  G.actionIndex = nextActive(dealerIdx);

  renderGame();
  syncGameState(); // push new stage + community cards to guests
  if (amHost) startHostTurnEnforcer();
  if (!isMyTurn()) setTimeout(runCpuTurn, 800);
}

function offerChopShortcut() {
  // The current player proposes a chop — set state and sync
  if (!G) return;
  const activePlayers = G.players.filter(p => !p.eliminated && p.chips > 0);
  if (activePlayers.length !== 2) return;

  const myPlayer = G.players.find(p => p.id === me.id);
  if (!myPlayer || myPlayer.eliminated) return;

  G.chopOfferedBy = me.id;
  G.chopOfferedAt = new Date().toISOString();

  if (amHost) {
    syncGameState();
    renderGame(); // host triggers their own overlay via render
  } else if (sb && currentGameId) {
    // Guest: send via player_actions; host will set the flag
    sb.from('player_actions').insert({
      game_id: currentGameId,
      player_id: me.id,
      action: 'chop_offer',
      amount: null,
      created_at: new Date().toISOString(),
    }).then(({ error }) => {
      if (error) toast('Chop offer failed');
      else toast('Chop offered — waiting for response');
    });
  }
}

