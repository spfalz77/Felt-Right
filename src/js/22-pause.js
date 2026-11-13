// ── PAUSE SYSTEM (manual host toggle) ─────────────────────────────────────────
// G.paused = true when host has paused the game
// G.pauseQueued = true when host tapped pause but hand in progress — will pause after hand
function pauseGame() {
  if (G && serverHostControl('pause')) return;
  if (!G || G.paused || !amHost) return;

  // If hand in progress, queue the pause for end-of-hand
  const handInProgress = G.stage && G.stage !== 'deal' && G.stage !== 'showdown' && G.stage !== 'finished';
  if (handInProgress) {
    G.pauseQueued = true;
    syncGameState();
    renderGame();
    toast('Pausing after this hand…');
    return;
  }

  // Otherwise pause immediately
  applyPause();
}

function applyPause() {
  if (!G || !amHost) return;
  G.paused = true;
  G.pauseQueued = false;
  syncGameState();
  showPauseOverlay();
  stopTurnTimer();
  stopHostTurnEnforcer();
  toast('Game paused');
}

function cancelQueuedPause() {
  if (G && serverHostControl('pause_cancel')) return;
  if (!G || !amHost || !G.pauseQueued) return;
  G.pauseQueued = false;
  syncGameState();
  renderGame();
  toast('Pause cancelled');
}

function resumeGame() {
  if (G && serverHostControl('resume')) return;
  if (!G || !G.paused || !amHost) return;

  // Start a fresh hand from current chip counts / seat positions
  // This avoids all mid-hand sync weirdness — cleanest to deal a new hand
  G.paused = false;
  G.pot = 0;
  G.community = [];
  G.currentBet = 0;
  G.actionIndex = -1;
  G.stage = 'deal';
  G.turnStartAt = null;

  // Reset all non-eliminated players for a fresh hand
  // CRITICAL: clear disconnected flags — trust presence will re-mark truly absent players
  G.players.forEach(p => {
    if (p.eliminated) return;
    p.hand = [];
    p.bet = 0;
    p.totalBet = 0;
    p.folded = false;
    p.allIn = false;
    p.lastAction = null;
    p.disconnected = false;
  });

  _blindLevelStartTime = Date.now();
  syncGameState();
  hidePauseOverlay();
  renderGame();
  toast('Game resumed — new hand');

  // Give presence a moment to catch up BEFORE dealing the new hand
  // This ensures guests who hit "I'm Back" are marked online before first action
  setTimeout(() => {
    // Force a presence re-sync: read current state and update local flags
    if (_presenceChannel) {
      const state = _presenceChannel.presenceState();
      G.players.forEach(p => {
        if (p.eliminated) return;
        const isOnline = (p.id === me.id) || (state[p.id] && state[p.id].length > 0);
        p.disconnected = !isOnline;
      });
    }
    dealNewHand();
  }, 1500); // 1.5s gives presence channel time to re-sync
}

async function guestSignalBack() {
  // Server game: "ready" is part of the table, so every phone (the host's too) shows it
  if (G && isServerGame()) {
    const { error } = await callTable(currentGameId, 'pause_ready');
    if (error) { toast(error); return; }
    sendHeartbeat(currentGameId);
    toast("You're marked ready — waiting for the host to resume");
    return;
  }
  // Guest tells host "I'm back" - force presence re-track to push a fresh join event
  if (!sb || !currentGameId || me.id === 'demo' || amHost) return;

  // Force presence channel to re-track NOW — this guarantees host gets a join/sync event
  if (_presenceChannel) {
    try {
      // Untrack then re-track — causes a fresh join event on the host side
      await _presenceChannel.untrack();
      await _presenceChannel.track({ online_at: new Date().toISOString(), back: true });
    } catch(e) { console.warn('signalBack track:', e); }
  } else {
    // Presence channel was closed — restart it
    startPresence(currentGameId);
  }

  // Also update our game_players row timestamp as belt & suspenders
  try {
    await sb.from('game_players')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('game_id', currentGameId).eq('user_id', me.id);
  } catch(e) { /* column may not exist, fine */ }

  toast("You're marked back — waiting for host to resume");
}

let _pauseOverlayRefresher = null;

function showPauseOverlay() {
  let el = document.getElementById('pause-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pause-overlay';
    el.style.cssText = `
      position: fixed; top:0; left:0; right:0; bottom:0; z-index:500;
      background: rgba(8,20,14,0.92); backdrop-filter: blur(8px);
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      padding: 24px; text-align: center; overflow-y: auto;
    `;
    document.body.appendChild(el);
  }

  renderPauseOverlayContent();
  el.style.display = 'flex';

  // Refresh every 1s on every phone, so nobody is left looking at the list as
  // it was when the game paused. Server games re-read the heartbeats every 2s.
  clearInterval(_pauseOverlayRefresher);
  let ticks = 0;
  const refresh = () => {
    if (G && isServerGame() && ticks++ % 2 === 0) fetchServerPresence(currentGameId).then(renderPauseOverlayContent);
    else renderPauseOverlayContent();
  };
  refresh();
  _pauseOverlayRefresher = setInterval(refresh, 1000);
}

function renderPauseOverlayContent() {
  const el = document.getElementById('pause-overlay');
  if (!el || el.style.display === 'none') return;
  if (!G) return;

  // Determine which players are online (from presence state)
  const onlineIds = _onlineIds || new Set();
  const activePlayers = G.players.filter(p => !p.eliminated);

  const server = isServerGame();
  const ready = new Set(G.pauseReady || []);
  const playerStatusHTML = activePlayers.map(p => {
    const isOnline = server ? isOnlineOnServer(p.id) : (p.id === me.id || onlineIds.has(p.id));
    const isReady = server && (ready.has(p.id) || p.id === gameHostId);
    const isHostP = p.id === (G.hostPlayerId || G.players[0]?.id);
    return `
      <div data-player="${p.id}" data-online="${isOnline ? 1 : 0}" data-ready="${isReady ? 1 : 0}" style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
        <div class="avatar sm" style="${!isOnline ? 'opacity:0.4' : ''}">${p.emoji || '🃏'}</div>
        <div style="flex:1;text-align:left">
          <div style="font-size:0.88rem;${!isOnline ? 'color:var(--text-dim)' : ''}">${p.name}</div>
          <div style="font-size:0.7rem;color:${isOnline ? 'var(--green)' : 'var(--text-dim)'}">
            ${isOnline ? '● Online' : '○ Away'}${isReady ? ' · <span style="color:var(--gold)">✓ Ready</span>' : ''}
          </div>
        </div>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div style="font-size:3rem;margin-bottom:12px">⏸️</div>
    <div style="font-family:'Bebas Neue',sans-serif;font-size:2rem;color:var(--gold-pale);letter-spacing:0.1em;margin-bottom:8px">
      GAME PAUSED
    </div>
    <div style="color:var(--text-dim);font-size:0.85rem;margin-bottom:16px;max-width:320px;line-height:1.5">
      ${isTableHost()
        ? (server
            ? `Resume when everyone is ready (${activePlayers.filter(p => ready.has(p.id) || p.id === gameHostId).length} of ${activePlayers.length}).`
            : 'Resume when everyone is ready.')
        : `Host paused the game. Tap I'm Back so they know you're ready.`}
    </div>

    <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r-sm);
         padding:10px 14px;margin-bottom:20px;min-width:280px;max-width:320px">
      <div style="font-size:0.72rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:8px">
        Players
      </div>
      ${playerStatusHTML}
    </div>

    ${isTableHost()
      ? `<button class="btn btn-primary" onclick="resumeGame()" style="min-width:240px;margin-bottom:12px">
          Resume Game
        </button>
        <button onclick="endGameForAll()" style="min-width:240px;background:none;
          border:1px solid rgba(192,57,43,0.5);color:var(--red-light);
          font-family:'DM Sans',sans-serif;font-weight:600;font-size:0.85rem;
          padding:10px 20px;border-radius:var(--r-sm);cursor:pointer">
          End Game for All
        </button>`
      : `<button class="btn btn-primary" onclick="guestSignalBack()" style="min-width:240px;margin-bottom:12px">
          I'm Back
        </button>
        <button onclick="leaveGameSitOut()" style="min-width:240px;background:none;
          border:1px solid rgba(192,57,43,0.5);color:var(--red-light);
          font-family:'DM Sans',sans-serif;font-weight:600;font-size:0.85rem;
          padding:10px 20px;border-radius:var(--r-sm);cursor:pointer">
          Leave Game
        </button>`
    }`;
}

function hidePauseOverlay() {
  const el = document.getElementById('pause-overlay');
  if (el) el.style.display = 'none';
  clearInterval(_pauseOverlayRefresher);
  _pauseOverlayRefresher = null;
}

async function endGameForAll() {
  if (G && isServerGame()) {
    const msg = getFormatConfig().moneyMode
      ? 'End the game for everyone? This cannot be undone.'
      : 'End the tournament for everyone? It will be called off and nothing is recorded to Standings.';
    if (!isTableHost() || !confirm(msg)) return;
    serverHostControl('end_game');
    return;
  }
  if (!amHost || !G) return; // demo mode
  if (!confirm('End the game for everyone? This cannot be undone.')) return;
  toast('Game ended');

  sessionStorage.setItem('fr_auto_restore', '1');
  setTimeout(() => { window.location.href = window.location.pathname; }, 300);
}

function stopPresence() {
  clearInterval(_presencePingInterval);
  _presencePingInterval = null;
  if (_presenceChannel) { _presenceChannel.unsubscribe(); _presenceChannel = null; }
}

let _presencePingInterval = null;
let _onlineIds = new Set();

function runCpuTurn() {
  const p = G.players[G.actionIndex];
  if (!p || p.folded || p.eliminated) { advanceAction(); return; }

  // If it's the human player's turn but they're disconnected, auto check/fold
  if (p.id === me.id) {
    if (!amHost) return; // guest handles their own turn
    // Host running for a disconnected human player
  }

  const blinds = getBlinds(getCurrentBlindLevel());

  // If it's a human player's turn (disconnected or not), do not auto-act from host.
  // The turn timer will auto-fold them after 30s if they don't respond.
  if (p.id !== me.id) {
    // This is a CPU/demo player OR was a real player that's since been removed — continue below
  } else if (!amHost) {
    return; // guest's own turn handled via UI
  } else {
    // It's my (host) turn — let my UI handle it
    return;
  }

  // If this isn't a CPU/demo player and it's a human who's connected or away,
  // skip CPU logic — they'll time out on their own turn timer if needed
  if (p.id && p.id.length > 10) {
    // Real user ID (UUID-ish length) — don't run CPU for them
    return;
  }

  const hand = evalBest(p.hand, G.community, G.variant);
  const strength = hand ? hand.rank : 0;
  const callAmt = Math.min(G.currentBet - p.bet, p.chips);
  const r = Math.random();

  if (p.chips <= 0 || p.allIn) { G.actionIndex = nextActive(G.actionIndex); renderGame(); if(!isMyTurn()) setTimeout(runCpuTurn,600); return; }

  if (strength >= 5 || (strength >= 3 && r < 0.6)) {
    const raiseAmt = Math.min(snapTo5(G.currentBet + (blinds.big + strength * 10)), p.chips);
    const add = raiseAmt - p.bet;
    if (add > 0 && r < 0.4 && raiseAmt > G.currentBet) {
      p.chips -= add; G.pot += add; p.bet = raiseAmt; p.totalBet += add;
      G.currentBet = raiseAmt;
      p.lastAction = { type:'bet', label:`Raise ${raiseAmt}` };
      // Re-open everyone else
      G.players.forEach(op => {
        if (op.id !== p.id && !op.folded && !op.eliminated && !op.allIn) op.lastAction = null;
      });
    } else {
      p.chips -= callAmt; G.pot += callAmt; p.bet += callAmt; p.totalBet += callAmt;
      if (p.chips === 0) p.allIn = true;
      p.lastAction = callAmt > 0 ? { type:'bet', label:`Call ${callAmt}` } : { type:'check', label:'Check' };
    }
  } else if (strength >= 1 || r < 0.45) {
    // call/check
    p.chips -= callAmt; G.pot += callAmt; p.bet += callAmt; p.totalBet += callAmt;
    if (p.chips === 0) p.allIn = true;
    p.lastAction = callAmt > 0 ? { type:'bet', label:`Call ${callAmt}` } : { type:'check', label:'Check' };
  } else {
    // fold (only if there's a bet to call)
    if (callAmt > 0) {
      p.folded = true;
      p.lastAction = { type:'fold', label:'Fold' };
    } else {
      p.lastAction = { type:'check', label:'Check' };
    }
  }

  renderGame();
  setTimeout(advanceAction, 600);
}

