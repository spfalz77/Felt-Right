// ════════════════════════════════════════════════════════════════════════════
// GAME TABLE — MULTIPLAYER ENGINE
// ════════════════════════════════════════════════════════════════════════════

// Server games only (phase 6b-2): the table lives on the server, so there is
// no host heartbeat, host takeover or voided hand. Demo mode still plays
// locally on this phone with the old engine and saves nothing.
let _gamePaused = false;

// ── ENTER GAME ────────────────────────────────────────────────────────────────
function enterGame(gameId, state) {
  document.getElementById('invite-banner')?.remove();
  currentGameId = gameId;
  currentLobbyId = null; // critical: stop the lobby poller from re-firing
  G = JSON.parse(JSON.stringify(state));
  const serverRun = isServerState(G);
  if (serverRun) enterServerGame(gameId); // every phone follows the guest path

  // Close chat panel if open (so the guest isn't stuck on chat when the host starts the game)
  const chatPanel = document.getElementById('chat-panel');
  const chatBackdrop = document.getElementById('chat-backdrop');
  if (chatPanel) chatPanel.style.display = 'none';
  if (chatBackdrop) chatBackdrop.style.display = 'none';

  showScreen('game');
  screenStack = ['home', 'game'];
  startBlindTimer();
  _gamePaused = false;
  // Reset turn/timer tracking for fresh game
  _lastTurnKey = null;
  _timerForActionKey = null;
  _sliderTurnKey = null;
  _lastSoundState = null;
  _myPrivateHand = null;
  startPresence(gameId);
  subscribeToChatForGame(gameId);
  startNudgeListener(gameId);

  if (me.id === 'demo') {
    // Demo mode: plays locally, deals immediately
    dealNewHand();
  } else if (!serverRun) {
    // A table from before every game ran on the server: nothing can run it now
    toast('This game was started on an older version and can\'t continue');
    currentGameId = null;
    showScreen('home');
  } else {
    guestSubscribeToGame(gameId);
    if (G.handNumber > 0) fetchMyPrivateHand(gameId, G.handNumber).then(() => { applyMyPrivateHand(); renderGame(); });
    renderGame();
  }
}

function showInitializingOverlay() {
  let el = document.getElementById('initializing-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'initializing-overlay';
    el.style.cssText = `
      position: fixed; top:0; left:0; right:0; bottom:0; z-index:450;
      background: rgba(8,20,14,0.92); backdrop-filter: blur(6px);
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      color: var(--gold-pale); text-align: center; padding: 24px;
    `;
    el.innerHTML = `
      <div style="font-size:2.4rem;margin-bottom:16px">🃏</div>
      <div style="font-family:'Bebas Neue',sans-serif;font-size:1.6rem;letter-spacing:0.12em;color:var(--gold-pale);margin-bottom:8px">
        INITIALIZING GAME
      </div>
      <div style="font-size:0.82rem;color:var(--text-dim);max-width:280px;line-height:1.5">
        Waiting for everyone to connect…
      </div>`;
    document.body.appendChild(el);
  }
  el.style.display = 'flex';
}

function hideInitializingOverlay() {
  const el = document.getElementById('initializing-overlay');
  if (el) el.style.display = 'none';
}

// ── HOST: push full state after every action ──────────────────────────────────
// _lastTurnKey tracks hand:stage:actionIndex — unique per turn across hands
let _lastTurnKey = null;

// Demo mode plays locally and saves nothing; every real game is saved by the
// server. (Kept as a no-op because the local engine calls it after each move.)
function syncGameState() {}

let _myPrivateHand = null; // { handNumber, cards }
let _prevPaused = false;

async function fetchMyPrivateHand(gameId, handNumber) {
  if (!sb || !me?.id || me.id === 'demo') return;
  // (the table is saved together with the cards, so what this reads is at least this new)
  const dealSeq = G?.dealSeq ?? null;
  try {
    // Retry up to 5 times — the host may still be writing
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data } = await sb.from('private_hands')
        .select('cards')
        .eq('game_id', gameId)
        .eq('hand_number', handNumber)
        .eq('player_id', me.id)
        .maybeSingle();

      if (data?.cards) {
        _myPrivateHand = { handNumber, cards: data.cards, dealSeq };
        applyMyPrivateHand();
        renderGame();
        return;
      }
      await new Promise(r => setTimeout(r, 400));
    }
  } catch(e) { console.warn('fetchMyPrivateHand:', e); }
}

function applyMyPrivateHand() {
  if (!G || !_myPrivateHand) return;
  if (_myPrivateHand.handNumber !== G.handNumber) return;
  const myP = G.players.find(p => p.id === me.id);
  if (!myP) return;
  // Replace redacted hidden cards with real ones
  // Server games: cards fetched before the latest deal/draw/discard are stale
  if (isServerGame() && _myPrivateHand.dealSeq != null && G.dealSeq != null && _myPrivateHand.dealSeq < G.dealSeq) return;
  if (myP.hand && myP.hand.some(c => c?.hidden) && myP.hand.some(c => c && c.rank)) {
    // 5-card stud: the upcards come with the table; fill in the hidden ones from my own copy
    myP.hand = myP.hand.map((c, i) => (c?.hidden && _myPrivateHand.cards[i] ? _myPrivateHand.cards[i] : c));
  } else if (myP.hand && myP.hand.length && myP.hand.every(c => c?.hidden)) {
    if (myP.hand.length !== _myPrivateHand.cards.length) return; // a discard: newer cards are on the way
    myP.hand = _myPrivateHand.cards;
  } else if (!myP.hand?.length) {
    myP.hand = _myPrivateHand.cards;
  }
}

// ── NUDGE ─────────────────────────────────────────────────────────────────────
let _nudgeSubscription = null;
let _lastNudgeAt = 0;

function startNudgeListener(gameId) {
  if (!sb || !gameId || me.id === 'demo') return;
  if (_nudgeSubscription) _nudgeSubscription.unsubscribe();
  _nudgeSubscription = sb.channel(`nudges:${gameId}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'player_actions',
      filter: `game_id=eq.${gameId}`,
    }, payload => {
      const row = payload.new;
      if (row.action !== 'nudge') return;
      // Only react if I'm the target
      if (row.target_id !== me.id) return;
      if (row.player_id === me.id) return;
      // Find sender name — try game state first, then lobby players
      let fromName = 'A player';
      if (G?.players) {
        const fromPlayer = G.players.find(p => p.id === row.player_id);
        if (fromPlayer) fromName = fromPlayer.name;
      }
      if (fromName === 'A player' && Array.isArray(lobbyPlayers)) {
        const lp = lobbyPlayers.find(p => p.user?.id === row.player_id);
        if (lp) fromName = lp.user.display_name || fromName;
      }
      receiveNudge(row.player_id, fromName);
    })
    .subscribe();
}

function stopNudgeListener() {
  if (_nudgeSubscription) { _nudgeSubscription.unsubscribe(); _nudgeSubscription = null; }
}

async function nudgePlayer(targetId, targetName) {
  const gameId = currentGameId || currentLobbyId;
  if (!sb || !gameId || me.id === 'demo') return;
  if (targetId === me.id) return;

  const now = Date.now();
  if (now - _lastNudgeAt < 3000) {
    toast('Slow down — wait a moment');
    return;
  }
  _lastNudgeAt = now;

  if (navigator.vibrate) navigator.vibrate(20);
  toast(`Nudged ${targetName}`);

  try {
    await postAction({
      game_id: gameId,
      player_id: me.id,
      action: 'nudge',
      amount: null,
      target_id: targetId,
      created_at: new Date().toISOString(),
    });
  } catch(e) {
    console.warn('nudge insert:', e);
  }
}

function receiveNudge(fromId, fromName) {
  // Show toast + vibrate + browser notification
  if (navigator.vibrate) navigator.vibrate([100, 60, 100, 60, 100]);

  // In-app toast
  showNudgeToast(fromName, fromId);

  // Browser notification when app backgrounded
  if (_notificationsEnabled && 'Notification' in window && Notification.permission === 'granted' &&
      document.visibilityState !== 'visible') {
    new Notification('Felt Right — Nudged!', {
      body: `${fromName} is waiting on you`,
      tag: 'nudge-' + currentGameId,
      requireInteraction: false,
    });
  }
}

function showNudgeToast(name, fromId) {
  let el = document.getElementById('nudge-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'nudge-toast';
    el.style.cssText = `
      position: fixed; top: calc(var(--safe-top) + 60px); left: 50%;
      transform: translateX(-50%) translateY(-20px) scale(0.95);
      background: var(--gold); color: #0d1a0d;
      border-radius: 14px; padding: 12px 18px; z-index: 460;
      font-weight: 700; font-size: 0.95rem; line-height: 1.2;
      box-shadow: 0 8px 28px rgba(212,168,67,0.4), 0 0 0 1px var(--gold);
      opacity: 0; transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
      display: flex; align-items: center; gap: 10px;
    `;
    document.body.appendChild(el);
  }
  // Find the from player to get their emoji - check G first, then lobby
  let emoji = '👋';
  if (G?.players) {
    const fromPlayer = G.players.find(p => p.id === fromId);
    if (fromPlayer?.emoji) emoji = fromPlayer.emoji;
  }
  if (emoji === '👋' && Array.isArray(lobbyPlayers)) {
    const lp = lobbyPlayers.find(p => p.user?.id === fromId);
    if (lp?.user?.avatar_emoji) emoji = lp.user.avatar_emoji;
  }
  el.innerHTML = `<span style="font-size:1.4rem">${emoji}</span><span>${name} nudged you!</span>`;

  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translateX(-50%) translateY(0) scale(1)';
  });

  clearTimeout(_nudgeToastTimer);
  _nudgeToastTimer = setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(-50%) translateY(-20px) scale(0.95)';
  }, 2800);
}
let _nudgeToastTimer = null;

// ── GUEST: receive state updates from host ────────────────────────────────────
let _guestStatePoller = null;

// Each saved table carries a sequence number (server games: v; phone-run: syncSeq)
function stateSeq(state) { return state ? (state.v ?? state.syncSeq ?? null) : null; }
function isOlderState(incoming, current) {
  const a = stateSeq(incoming), b = stateSeq(current);
  return a != null && b != null && a < b;
}

function tableSignature(state) {
  if (!state || !Array.isArray(state.players)) return '';
  return JSON.stringify({ ...state, players: state.players.map(({ hand, ...rest }) => rest) });
}

// Game over: the end screen, for every phone (live update or the backup poller)
function guestShowGameOver() {
  // Clear any chop proposal/showdown overlay so it doesn't sit on top
  const sd = document.getElementById('showdown-overlay');
  if (sd) sd.style.display = 'none';
  const winner = G.players.find(p => !p.eliminated && p.chips > 0) || G.players[0];
  // Commit tournament stats for guests (host already did theirs in endTournament)
  if (!amHost && me.id !== 'demo') {
    const myPlayer = G.players.find(p => p.id === me.id);
    if (myPlayer) {
      let myPlacement = null;
      if (winner?.id === me.id) {
        myPlacement = 1;
      } else {
        const idx = G.finalPlacements?.findIndex(p => p.name === myPlayer.name) ?? -1;
        if (idx >= 0) myPlacement = idx + 1;
      }
      // Only commit once — guard via sessionStorage
      const key = `fr_tourney_done_${currentGameId}`;
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, '1');
        commitTournamentStats(myPlacement, myPlayer.chips || 0);
      }
    }
  }
  // Show appropriate end overlay based on format
  if (G.cashOuts && getFormatConfig().moneyMode) {
    showHomeGameEnd();
  } else {
    showTournamentOverlay(winner);
  }
}

// The hand's result, once per hand, whichever way the new table arrived (live
// update or the backup poller). Stays up until the player taps Got It; on a
// server game the next hand waits for everyone's OK (or 30s).
// (Guts has its own reveal overlay driven by G.gutsResults; the host of a
// phone-run game shows its own from doShowdown.)
let _resultShownFor = null;
function maybeShowHandResult(prevMyChips) {
  if (amHost || !G || G.stage !== 'showdown' || G.variant === 'guts3' || G.tournamentOver) return;
  // Phone-run games keep stage 'showdown' while the next dealer picks the
  // variant: that's the picker's screen, not a result
  if (G.pendingDealerChoice || G.breakActive || G.paused) return;
  if (isServerGame() && !(G.lastResult && G.lastResult.hand === G.handNumber)) return;
  const key = `${currentGameId}:${G.handNumber}`;
  if (_resultShownFor === key) return;
  _resultShownFor = key;
  const myP = G.players.find(p => p.id === me.id);
  // What I won this hand: the server's result when there is one
  const won = G.lastResult && G.lastResult.hand === G.handNumber ? (G.lastResult.winnings?.[me.id] || 0) : null;
  const before = won != null && myP ? (myP.chips || 0) - won : prevMyChips;
  const stillIn = G.players.filter(p => !p.folded && !p.eliminated);
  // (drawn a beat later; by then the table may have moved on: draw nothing)
  const hand = G.handNumber;
  const later = (fn) => setTimeout(() => {
    if (G && G.stage === 'showdown' && G.handNumber === hand && !G.pendingDealerChoice && !G.tournamentOver) fn();
  }, 200);
  if (stillIn.length === 1 && stillIn[0].id === me.id) {
    if (myP && myP.hand?.length && !myP.hand.some(c => c.hidden)) {
      const winAmt = (myP.chips || 0) - (before || 0);
      if (winAmt > 0) later(() => showMuckOrShow(myP, winAmt));
      else ackHandResult();
    }
  } else if (stillIn.length > 1) {
    later(() => guestShowShowdown(before));
  } else if (stillIn.length === 1) {
    later(() => guestShowFoldWinOverlay(stillIn[0]));
  }
}

// "Got it" on a server game: the table deals the next hand once everyone has
// (only once per hand)
let _resultAckedFor = null;
function ackHandResult() {
  if (!G || !isServerGame() || G.stage !== 'showdown' || !currentGameId) return;
  const key = `${currentGameId}:${G.handNumber}`;
  if (_resultAckedFor === key) return;
  _resultAckedFor = key;
  callTable(currentGameId, 'result_ok');
}

// Re-reads the saved table and shows it if it differs from what's on screen
// (cards aside: this phone's own cards come from private_hands). Comparing the
// whole table means a stale or locally changed copy can't stick.
async function refreshGuestState() {
  if (!sb || !currentGameId || amHost) return;
  try {
    const { data } = await sb.from('games').select('state, host_id').eq('id', currentGameId).maybeSingle();
    if (!data?.state || !Array.isArray(data.state.players)) return;
    if (isOlderState(data.state, G)) return; // fetched before a newer update arrived
    if (tableSignature(data.state) === tableSignature(G)) return;
    const prevMyChips = G?.players?.find(p => p.id === me.id)?.chips ?? null;
    G = data.state;
    if (isServerState(G)) gameHostId = data.host_id;
    if (G.tournamentOver && G.abandoned) { showCalledOff(); return; }
    // (the live update can be missed: the poller must do everything it would)
    if (G.tournamentOver) { guestShowGameOver(); return; }
    applyMyPrivateHand();
    renderGame();
    maybeShowHandResult(prevMyChips);
    if (G.stage === 'guts_decision' && G.variant === 'guts3') showGutsDecision();
    if (G.stage === 'showdown' && G.variant === 'guts3' && G.gutsResults) {
      const sd = document.getElementById('showdown-overlay');
      if (!sd || sd.dataset.kind !== 'guts-reveal') showGutsReveal();
    }
    if (G.pendingDealerChoice) showDealerChoice();
    else {
      // the pick is made: take the picker down (the live update would have)
      const sd = document.getElementById('showdown-overlay');
      if (sd && sd.dataset.kind === 'dealer-choice') { sd.style.display = 'none'; sd.dataset.kind = ''; }
    }
    if (G.breakActive) showBreakOverlay(); else hideBreakOverlay();
    if (G.handNumber > 0) fetchMyPrivateHand(currentGameId, G.handNumber);
    if (G.stage === 'showdown') setTimeout(offerRebuyIfBroke, 4500);
  } catch(e) { /* silent */ }
}

function guestSubscribeToGame(gameId) {
  if (gameSubscription) gameSubscription.unsubscribe();

  // Fallback poller: every 8 seconds, re-fetch state in case the realtime
  // subscription dropped events (common on mobile when screen sleeps).
  if (_guestStatePoller) clearInterval(_guestStatePoller);
  _guestStatePoller = setInterval(async () => {
    if (!sb || !currentGameId || amHost) {
      clearInterval(_guestStatePoller); _guestStatePoller = null; return;
    }
    await refreshGuestState();
  }, 3000);

  gameSubscription = sb.channel(`game-state:${gameId}`)
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'games',
      filter: `id=eq.${gameId}`,
    }, payload => {
      const row = payload.new;
      // Ignore updates without a table (e.g. settings saved before the first deal)
      if (!row.state || !Array.isArray(row.state.players)) return;
      if (isOlderState(row.state, G)) return; // arrived after a newer copy

      const prevHandNumber = G?.handNumber || 0;
      const prevActionIndex = G?.actionIndex;
      const prevMyChips = G?.players?.find(p => p.id === me.id)?.chips ?? null;
      const prevStage = G?.stage;
      const prevDealSeq = G?.dealSeq;

      // Only server-run tables are followed (an old phone-run table can't change any more)
      if (!isServerState(row.state)) return;
      gameHostId = row.host_id; // the lobby owner keeps the host's buttons
      _gamePaused = false;

      G = row.state;
      // Called off: leave before anything else tries to draw a table that has ended
      if (G.tournamentOver && G.abandoned) { showCalledOff(); return; }
      if (row.blind_config) {
        BLIND_LEVELS = row.blind_config.levels || BLIND_LEVELS;
        blindDurationSeconds = row.blind_config.duration || blindDurationSeconds;
      }
      if (row.buy_in_amount !== undefined && row.buy_in_amount !== null) {
        gameBuyIn = row.buy_in_amount;
      }

      // Tournament over — show end screen for everyone
      if (G.tournamentOver) { guestShowGameOver(); return; }

      const pauseJustEnded = _prevPaused === true && !G.paused;
      _prevPaused = G.paused === true;

      // ── GUEST STATS tracking ──
      // Detect end of hand by stage entering showdown OR hand number incrementing
      const enteredShowdown = prevStage !== 'showdown' && G.stage === 'showdown';
      const newHand = G.handNumber !== prevHandNumber && prevHandNumber > 0;
      const myCurrentChips = G.players?.find(p => p.id === me.id)?.chips ?? null;

      if ((enteredShowdown || newHand) && !amHost && _statsThisHand && _statsThisHand.hand_played) {
        // Compute won/lost from chip delta
        if (prevMyChips !== null && myCurrentChips !== null) {
          const delta = myCurrentChips - prevMyChips;
          if (delta > 0) {
            _statsThisHand.won_hand = true;
            _statsThisHand.won_amount = delta;
            if (_statsThisHand.all_in_taken) _statsThisHand.won_all_in = true;
          } else if (delta < 0) {
            _statsThisHand.lost_amount = -delta;
            if (_statsThisHand.all_in_taken) _statsThisHand.won_all_in = false;
          }
        }
        // If we went to showdown, mark it
        if (enteredShowdown) {
          const myP = G.players?.find(p => p.id === me.id);
          if (myP && !myP.folded && !myP.eliminated) {
            _statsThisHand.went_to_showdown = true;
            if (_statsThisHand.won_hand) _statsThisHand.won_at_showdown = true;
          }
        }
        commitHandStats();
      }

      // The hand's result: the showdown breakdown, or who won when everyone folded
      maybeShowHandResult(prevMyChips);

      // Busted this hand? After a moment to see the result, offer the re-buy.
      // (The host pauses for this decision, so no further update would prompt it.)
      if (!amHost && G.stage === 'showdown' && prevStage !== 'showdown') {
        setTimeout(offerRebuyIfBroke, 4500);
      }

      // While the fold-win overlay is open and we're still in showdown stage,
      // re-render it on each state update so winner's reveal/muck choice appears
      if (!amHost && G.stage === 'showdown' && G.variant !== 'guts3') {
        const sd = document.getElementById('showdown-overlay');
        if (sd && sd.dataset.kind === 'showdown' && sd.style.display !== 'none') {
          const stillIn = G.players.filter(p => !p.folded && !p.eliminated);
          // Only re-render fold-win overlay (single non-me winner)
          if (stillIn.length === 1 && stillIn[0].id !== me.id) {
            guestShowFoldWinOverlay(stillIn[0]);
          }
        }
      }

      if (G.handNumber !== prevHandNumber) {
        _autoAction = null;
        const autoBar = document.getElementById('auto-action-bar');
        if (autoBar) autoBar.innerHTML = '';
        fetchMyPrivateHand(gameId, G.handNumber);
        // Start fresh stat tracking for this hand
        if (!amHost) {
          resetHandStats();
          const myP = G.players?.find(p => p.id === me.id);
          if (myP && !myP.eliminated && myP.chips > 0) {
            _statsThisHand.hand_played = true;
          }
        }
      }

      // Also re-fetch private hand if we entered a play stage (preflop/guts_decision)
      // from a non-play stage (dealer pick) — handNumber may not have changed but
      // the host just dealt cards and wrote new private_hands rows.
      const isPlayStage = ['preflop', 'guts_decision', 'discard'].includes(G.stage);
      const wasPlayStage = ['preflop', 'guts_decision', 'discard'].includes(prevStage);
      if (isPlayStage && !wasPlayStage && G.handNumber > 0) {
        fetchMyPrivateHand(gameId, G.handNumber);
      } else if (isServerGame() && G.dealSeq !== prevDealSeq && G.handNumber === prevHandNumber && G.handNumber > 0) {
        // Same hand, new cards (a Pineapple discard)
        fetchMyPrivateHand(gameId, G.handNumber);
      }

      applyMyPrivateHand();
      renderGame();

      // Tournament first break: show or hide break overlay
      if (G.breakActive) {
        showBreakOverlay();
      } else {
        hideBreakOverlay();
      }

      // Dealer's choice (home game): show picker overlay if waiting on a dealer pick,
      // hide it once the dealer has chosen
      if (G.pendingDealerChoice) {
        showDealerChoice();
      } else {
        const sd = document.getElementById('showdown-overlay');
        if (sd && sd.dataset.kind === 'dealer-choice') {
          sd.style.display = 'none';
          sd.dataset.kind = '';
        }
      }

      // Guts decision stage
      if (G.stage === 'guts_decision' && G.variant === 'guts3') {
        showGutsDecision();
      } else {
        hideGutsDecision();
      }

      // Guts reveal — driven by G.gutsResults being present
      if (G.stage === 'showdown' && G.variant === 'guts3' && G.gutsResults) {
        const sd = document.getElementById('showdown-overlay');
        if (!sd || sd.dataset.kind !== 'guts-reveal') {
          showGutsReveal();
        }
      } else {
        // Hide leftover guts-reveal overlay when state has moved on
        const sd = document.getElementById('showdown-overlay');
        if (sd && sd.dataset.kind === 'guts-reveal') {
          sd.style.display = 'none';
          sd.dataset.kind = '';
        }
      }

      // Re-buy prompt: am I broke and rebuys are available?
      const me_player = G.players?.find(p => p.id === me.id);
      if (me_player && me_player.broke && !me_player.eliminated &&
          (getFormatConfig().moneyMode || (G.rebuysEnabled && !G.rebuyWindowClosed))) {
        const showdownOverlay = document.getElementById('showdown-overlay');
        const showdownVisible = showdownOverlay && showdownOverlay.style.display !== 'none';
        if (!showdownVisible) showRebuyOverlay();
      }

      if (G.paused) {
        showPauseOverlay();
      } else {
        hidePauseOverlay();
        if (pauseJustEnded) {
          toast('Game resumed');
          if (G.handNumber > 0) fetchMyPrivateHand(gameId, G.handNumber);
        }
      }

      if (isMyTurn() && !G.paused) {
        const thisTurnKey = `${G.handNumber || 0}:${G.actionIndex}:${G.stage}`;
        if (_timerForActionKey !== thisTurnKey && G.actionIndex !== prevActionIndex) {
          pushTurnNotification();
        }
      }
      // Timer lifecycle is managed in renderGame via _timerForActionKey guard
    })
    .subscribe();
}

// ── GUEST: submit action to DB ────────────────────────────────────────────────
async function submitAction(action, amount) {
  if (!sb || !currentGameId || amHost || me.id === 'demo') return;
  try {
    await postAction({
      game_id: currentGameId,
      player_id: me.id,
      action,
      amount: amount || null,
    });
  } catch(e) { toast('Action failed — try again'); }
}

// ── NOTIFICATIONS ─────────────────────────────────────────────────────────────
function pushTurnNotification() {
  if (!_notificationsEnabled) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return;
  new Notification('Felt Right — Your Turn', {
    body: "It's your turn! 30 seconds to act.",
    tag: 'your-turn',
    renotify: true,
  });
}


