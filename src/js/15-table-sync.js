// ════════════════════════════════════════════════════════════════════════════
// GAME TABLE — MULTIPLAYER ENGINE
// ════════════════════════════════════════════════════════════════════════════

// ── HOST HEARTBEAT ────────────────────────────────────────────────────────────
const HEARTBEAT_INTERVAL  = 5000;  // host pings every 5s
const DISCONNECT_TIMEOUT  = 20000; // 20s without host ping = migrate (more generous)
const MIGRATION_COUNTDOWN = 5;     // brief 5s warning before migration
const DISCONNECT_GRACE_MS = 15000; // 15s grace after joining before checking

let _heartbeatInterval    = null;
let _disconnectWatchTimer = null;
let _migrationCountdown   = null;
let _gamePaused           = false;

function startHostHeartbeat(gameId) {
  stopHostHeartbeat();
  // Write immediately, then every 15s
  pingHostSeen(gameId);
  _heartbeatInterval = setInterval(() => pingHostSeen(gameId), HEARTBEAT_INTERVAL);
}

function stopHostHeartbeat() {
  clearInterval(_heartbeatInterval);
  _heartbeatInterval = null;
}

async function pingHostSeen(gameId) {
  if (!sb || !gameId) return;
  await sb.from('games')
    .update({ last_host_seen: new Date().toISOString() })
    .eq('id', gameId);
}

// ── GUEST DISCONNECT WATCHER ──────────────────────────────────────────────────
let _disconnectWatcherStartedAt = 0;

function startDisconnectWatcher(gameId) {
  stopDisconnectWatcher();
  _disconnectWatcherStartedAt = Date.now();
  _disconnectWatchTimer = setInterval(() => checkHostAlive(gameId), 5000);
}

function stopDisconnectWatcher() {
  clearInterval(_disconnectWatchTimer);
  _disconnectWatchTimer = null;
}

async function checkHostAlive(gameId) {
  // Stop if I somehow became host
  if (amHost) { stopDisconnectWatcher(); clearDisconnectBanner(); return; }
  if (!sb || !gameId) return;
  // Grace period after joining — don't migrate during initial sync
  if (Date.now() - _disconnectWatcherStartedAt < DISCONNECT_GRACE_MS) return;

  try {
    const { data } = await sb.from('games')
      .select('last_host_seen, host_id, status')
      .eq('id', gameId)
      .maybeSingle();

    if (!data) return;
    // Game finished — stop watching
    if (data.status === 'finished') { stopDisconnectWatcher(); return; }
    // If host changed (migration elsewhere), update local and stop
    if (data.host_id === me.id) {
      amHost = true;
      stopDisconnectWatcher();
      clearDisconnectBanner();
      return;
    }
    // No heartbeat ever written yet — be patient, don't migrate
    if (!data.last_host_seen) return;

    const age = Date.now() - new Date(data.last_host_seen).getTime();
    if (age > DISCONNECT_TIMEOUT && !_gamePaused) {
      showDisconnectPause(gameId, data.host_id);
    } else if (age < DISCONNECT_TIMEOUT && _gamePaused) {
      // Host came back — clear the banner
      _gamePaused = false;
      clearInterval(_migrationCountdown);
      _migrationCountdown = null;
      clearDisconnectBanner();
    }
  } catch(e) { /* silent */ }
}

function showDisconnectPause(gameId, oldHostId) {
  if (_gamePaused) return;
  _gamePaused = true;
  stopTurnTimer();

  let secsLeft = MIGRATION_COUNTDOWN;

  // Subtle top banner instead of full overlay — no UI flash
  let banner = document.getElementById('host-disconnect-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'host-disconnect-banner';
    banner.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; z-index: 400;
      background: rgba(212,168,67,0.15); border-bottom: 1px solid var(--gold-dim);
      color: var(--gold-pale); font-size: 0.8rem; text-align: center;
      padding: 6px 12px; backdrop-filter: blur(8px);
    `;
    document.body.appendChild(banner);
  }

  const render = () => {
    banner.textContent = `📡 Host offline — migrating in ${secsLeft}s…`;
  };
  render();

  _migrationCountdown = setInterval(async () => {
    secsLeft--;
    render();
    if (secsLeft <= 0) {
      clearInterval(_migrationCountdown);
      _migrationCountdown = null;
      await attemptHostMigration(gameId, oldHostId);
    }
  }, 1000);
}

function clearDisconnectBanner() {
  const banner = document.getElementById('host-disconnect-banner');
  if (banner) banner.remove();
}

async function attemptHostMigration(gameId, oldHostId) {
  // Determine who should become host: non-eliminated player with lowest seat index
  // All clients run this same logic independently — only the "winner" will succeed
  // because the DB update is conditional on host_id still being the old host
  if (!G) return;

  const candidates = G.players
    .filter(p => !p.eliminated && p.chips > 0 && p.id !== oldHostId)
    .sort((a, b) => a.seatIndex - b.seatIndex);

  if (!candidates.length) return;
  const newHostPlayer = candidates[0];

  // Only the designated new host does the migration
  if (newHostPlayer.id !== me.id) {
    // I'm not the designated new host — just wait and re-subscribe
    // The new host will update host_id and we'll continue as guest
    setTimeout(() => {
      _gamePaused = false;
      document.getElementById('showdown-overlay').style.display = 'none';
      guestSubscribeToGame(gameId);
    }, 3000);
    return;
  }

  // I AM the new host — take over
  try {
    const { error } = await sb.from('games')
      .update({
        host_id: me.id,
        last_host_seen: new Date().toISOString(),
      })
      .eq('id', gameId)
      .eq('host_id', oldHostId); // only succeeds if no one else already migrated

    if (error) {
      // Someone else won the migration race — become a guest
      _gamePaused = false;
      document.getElementById('showdown-overlay').style.display = 'none';
      amHost = false;
      guestSubscribeToGame(gameId);
      return;
    }

    // Migration successful — take over as host
    amHost = true;
    _gamePaused = false;
    stopDisconnectWatcher();
    clearDisconnectBanner();
    document.getElementById('showdown-overlay').style.display = 'none';
    toast('You are now the host');
    startHostHeartbeat(gameId);
    hostListenForActions(gameId);

    // Resume the game — if mid-hand, continue from current state
    // If we're waiting between hands, deal a new one
    renderGame();
    if (G.stage === 'deal' || G.stage === 'showdown') {
      setTimeout(dealNewHand, 1000);
    } else {
      resumeHostDuties(oldHostId);
      if (!isMyTurn()) setTimeout(runCpuTurn, 800);
    }

  } catch(e) {
    console.warn('Migration failed:', e);
    _gamePaused = false;
  }
}

// A phone that has just become host (took over, or rejoined as host) picks up
// the host's timers for whatever is in progress: the turn backstop for the
// player on action (so a player who's gone is checked/folded instead of the
// table waiting forever) and the dealer's-choice timeout. Who is connected is
// re-read from presence, and the host we took over from counts as gone.
function resumeHostDuties(oldHostId) {
  if (!amHost || !G?.players) return;
  G.players.forEach(p => {
    if (p.id === me.id || p.eliminated) return;
    if (oldHostId && p.id === oldHostId) { p.disconnected = true; return; }
    p.disconnected = !isPlayerOnline(p.id);
  });
  // Took over mid-hand: the other players' cards are private, so this phone
  // can't decide the hand fairly. Call it off, return the bets, deal again.
  const othersHidden = G.players.some(p => p.id !== me.id && !p.folded && !p.eliminated
    && (p.hand || []).some(c => !c || c.hidden));
  if (['preflop', 'flop', 'turn', 'river'].includes(G.stage) && othersHidden) {
    voidHandInProgress('Host changed mid-hand — hand called off, bets returned');
    return;
  }
  if (G.pendingDealerChoice) startDealerChoiceTimer();
  else if (['preflop', 'flop', 'turn', 'river'].includes(G.stage)) startHostTurnEnforcer();
}

// Host-only: cancel the hand in progress. Everyone still seated gets back what
// they put in this hand; any pot that can't be attributed (e.g. a Guts
// carry-over) is split evenly, remainder to the first seated player. Same rule
// as Cash Out mid-hand and cleanup_stale_games().
function voidHandInProgress(message) {
  if (!amHost || !G) return;
  stopHostTurnEnforcer();
  const seated = G.players.filter(p => !p.eliminated && !p.cashedOutCents);
  const pot = Math.max(G.pot || 0, 0);
  const refundable = seated.reduce((a, p) => a + Math.max(p.totalBet || 0, 0), 0);
  let leftover = 0;
  if (refundable > pot) {
    seated.forEach(p => { p.chips += Math.round(Math.max(p.totalBet || 0, 0) * pot / refundable); });
  } else {
    seated.forEach(p => { p.chips += Math.max(p.totalBet || 0, 0); });
    leftover = pot - refundable;
  }
  if (leftover > 0 && seated.length) {
    const share = Math.floor(leftover / seated.length);
    seated.forEach(p => { p.chips += share; });
    seated[0].chips += leftover - share * seated.length;
  }
  G.players.forEach(p => { p.bet = 0; p.totalBet = 0; p.folded = false; p.allIn = false; p.lastAction = null; });
  G.pot = 0;
  G.currentBet = 0;
  G.community = [];
  G.actionIndex = -1;
  G.stage = 'deal';
  if (message) toast(message);
  renderGame();
  syncGameState();
  setTimeout(dealNewHand, 1500);
}

// ── ENTER GAME ────────────────────────────────────────────────────────────────
function enterGame(gameId, state) {
  currentGameId = gameId;
  currentLobbyId = null; // critical: stop the lobby poller from re-firing
  G = JSON.parse(JSON.stringify(state));

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

  if (me.id === 'demo' || amHost) {
    if (amHost && sb) {
      hostListenForActions(gameId);
      startHostHeartbeat(gameId);
      // Wait 5 seconds so guests can fully sync their subscriptions before first deal
      showInitializingOverlay();
      setTimeout(() => {
        hideInitializingOverlay();
        dealNewHand();
      }, 5000);
    } else {
      // Demo mode: deal immediately
      dealNewHand();
    }
  } else {
    guestSubscribeToGame(gameId);
    startDisconnectWatcher(gameId);
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

function redactForSync(state) {
  // Copy state, strip hole cards from all players UNLESS showdown is public
  const redacted = JSON.parse(JSON.stringify(state));
  redacted.players = redacted.players.map(p => {
    // During showdown, reveal all non-folded players' cards (publicly shown)
    const showCards = state.stage === 'showdown' && !p.folded && !p.eliminated;
    if (!showCards) {
      // Keep the ARRAY LENGTH so UI can draw card backs, but hide card values
      p.hand = (p.hand || []).map(() => ({ hidden: true }));
    }
    return p;
  });
  return redacted;
}

function syncGameState() {
  if (!sb || !currentGameId || me.id === 'demo') return;
  // Stamp turn start time when the turn (hand:stage:actionIndex) changes
  if (G && G.actionIndex >= 0) {
    const turnKey = `${G.handNumber}:${G.stage}:${G.actionIndex}`;
    if (turnKey !== _lastTurnKey) {
      G.turnStartAt = new Date().toISOString();
      _lastTurnKey = turnKey;
    }
  }
  // One write at a time, latest state last. Callers often sync twice in a row
  // (e.g. dealer's choice → proceedToDeal); unawaited parallel PATCHes can land
  // out of order and leave an older state in the DB, freezing guests' screens.
  if (_syncInFlight) { _syncDirty = true; return _syncInFlight; }
  _syncInFlight = (async () => {
    do {
      _syncDirty = false;
      if (!G || !currentGameId) break;
      const gameId = currentGameId;
      const { error } = await sb.from('games')
        .update({ state: redactForSync(G), hand_number: G.handNumber, last_host_seen: new Date().toISOString() })
        .eq('id', gameId);
      if (error) console.warn('sync error:', error);
    } while (_syncDirty);
  })().finally(() => { _syncInFlight = null; });
  return _syncInFlight;
}
let _syncInFlight = null;
let _syncDirty = false;

let _myPrivateHand = null; // { handNumber, cards }
let _prevPaused = false;

async function fetchMyPrivateHand(gameId, handNumber) {
  if (!sb || !me?.id || me.id === 'demo') return;
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
        _myPrivateHand = { handNumber, cards: data.cards };
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
  if (myP.hand && myP.hand.length && myP.hand.every(c => c?.hidden)) {
    myP.hand = _myPrivateHand.cards;
  } else if (!myP.hand?.length) {
    myP.hand = _myPrivateHand.cards;
  }
}

// ── HOST: listen for actions submitted by non-host players ───────────────────
function hostListenForActions(gameId) {
  if (actionSubscription) actionSubscription.unsubscribe();
  actionSubscription = sb.channel(`actions:${gameId}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'player_actions',
      filter: `game_id=eq.${gameId}`,
    }, payload => {
      const { player_id, action, amount, target_id } = payload.new;
      // pick_variant is from the dealer during home-game dealer's choice — bypass turn check
      if (action === 'pick_variant') {
        if (G && G.dealerId === player_id && G.pendingDealerChoice) {
          // Variant is encoded in `amount`: 1=holdem, 2=omaha, 3=guts3
          const variantMap = { 1: 'holdem', 2: 'omaha', 3: 'guts3' };
          G.variant = variantMap[amount] || 'holdem';
          G.pendingDealerChoice = false;
          // Hide the dealer-choice overlay on the host (it was showing while waiting)
          const sd = document.getElementById('showdown-overlay');
          if (sd && sd.dataset.kind === 'dealer-choice') {
            sd.style.display = 'none';
            sd.dataset.kind = '';
          }
          syncGameState();
          proceedToDeal();
        }
        return;
      }
      // Guts decisions
      if (action === 'guts_in' || action === 'guts_out') {
        if (G && G.stage === 'guts_decision') {
          applyGutsDecision(player_id, action === 'guts_in' ? 'in' : 'out');
        }
        return;
      }
      // Re-buy: add chips, track buy-in cost, mark not broke
      if (action === 'rebuy') {
        if (G) {
          const isTournament = !getFormatConfig().moneyMode;
          // The guest sends the CHIP amount in `amount`. The cost varies by format.
          const chipAmount = amount || ((gameBuyIn || 0) * 100);
          const costCents = isTournament
            ? Math.floor((gameBuyIn || 0) * 100 / 2) // half the buy-in cost
            : chipAmount; // home: 1:1
          applyRebuy(player_id, chipAmount, costCents);
        }
        return;
      }
      // Sit out: player declined to re-buy. They're done, become spectator.
      if (action === 'sit_out') {
        if (G) {
          const p = G.players.find(pl => pl.id === player_id);
          if (p) {
            const isTournament = !getFormatConfig().moneyMode;
            p.eliminated = true;
            p.broke = false;
            // Tournament: add to placements if not already there
            if (isTournament && G.finalPlacements && !G.finalPlacements.some(fp => fp.name === p.name)) {
              G.finalPlacements.unshift({ name: p.name, emoji: p.emoji });
            }
            syncGameState();
            renderGame();
          }
        }
        return;
      }
      // Quit (home game): player cashes out at current stack and leaves
      if (action === 'quit_cashout') {
        if (G) {
          const p = G.players.find(pl => pl.id === player_id);
          if (p && p.cashedOutCents == null) {
            // Bank what they take home (host's own count, not the client's)
            const wasUp = G.players[G.actionIndex]?.id === player_id;
            p.cashedOutCents = p.chips || 0;
            p.chips = 0;
            p.eliminated = true;
            p.folded = true; // out of this hand; what they already bet stays in the pot
            p.broke = false;
            p.lastAction = { type: 'quit', label: 'Quit' };
            renderGame();
            Promise.resolve(syncGameState()).then(() => settleHomeGameLedger(currentGameId));
            // Keep the hand moving: they were on action, or only one player is left in it
            const inHand = G.players.filter(x => !x.folded && !x.eliminated);
            if (['preflop', 'flop', 'turn', 'river'].includes(G.stage) && (wasUp || inHand.length === 1)) {
              setTimeout(advanceAction, 300);
            }
          }
        }
        return;
      }
      // Tournament step-away: player has chips but stepped away from table
      if (action === 'step_away') {
        if (G) {
          const p = G.players.find(pl => pl.id === player_id);
          if (p) {
            p.awayFromTable = true;
            p.disconnected = true;
            p.lastAction = { type: 'away', label: 'Away' };
            syncGameState();
            renderGame();
            // If this player was up, auto-action so the table doesn't wait
            if (G.players[G.actionIndex]?.id === player_id) {
              autoActAway(player_id);
            }
          }
        }
        return;
      }
      // Tournament sit-back-down: clear away flag, rejoin play
      if (action === 'sit_back') {
        if (G) {
          const p = G.players.find(pl => pl.id === player_id);
          if (p) {
            p.awayFromTable = false;
            p.disconnected = false;
            p.lastAction = null;
            syncGameState();
            renderGame();
          }
        }
        return;
      }
      // Tournament break: player tapped Ready
      if (action === 'break_ready') {
        if (G && G.breakActive) applyBreakReady(player_id);
        return;
      }
      // Tournament break: player tapped Add-On
      if (action === 'add_on') {
        if (G && G.breakActive) {
          const tournamentStartingChips = (FORMATS.tournament).startingChips;
          const addOnCostCents = Math.floor((gameBuyIn || 0) * 100 / 2);
          const chipAmount = amount || Math.floor(tournamentStartingChips / 2);
          applyAddOn(player_id, chipAmount, addOnCostCents);
        }
        return;
      }
      // Social/non-turn actions bypass the turn filter
      const SOCIAL_ACTIONS = ['chop_offer', 'chop_accept', 'chop_decline', 'chop_cancel', 'nudge', 'pause_request'];
      if (SOCIAL_ACTIONS.includes(action)) {
        applyRemoteAction(player_id, action, amount);
        return;
      }
      // 'reveal' bypasses turn filter as well (can happen any time after fold)
      if (action === 'reveal') {
        applyRemoteAction(player_id, action, amount);
        return;
      }
      // Winner explicitly mucked their fold-win cards — sync the flag
      if (action === 'muck') {
        if (G) {
          G.winnerMucked = true;
          syncGameState();
        }
        return;
      }
      // Game actions require it to be the player's turn
      const acting = G?.players[G.actionIndex];
      if (!acting || acting.id !== player_id) return;
      applyRemoteAction(player_id, action, amount);
    })
    .subscribe();
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
    await sb.from('player_actions').insert({
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

function applyRemoteAction(playerId, action, amount) {
  // Nudges are handled by the universal nudge listener — ignore here
  if (action === 'nudge') return;

  // Chop offer/accept/decline/cancel
  if (action === 'chop_offer') {
    G.chopOfferedBy = playerId;
    G.chopOfferedAt = new Date().toISOString();
    renderGame();
    syncGameState();
    return;
  }
  if (action === 'chop_accept') {
    if (G.chopOfferedBy && G.chopOfferedBy !== playerId) {
      finalizeChop();
    }
    return;
  }
  if (action === 'chop_decline') {
    G.chopOfferedBy = null;
    G.chopDeclined = true;
    renderGame();
    syncGameState();
    return;
  }
  if (action === 'chop_cancel') {
    G.chopOfferedBy = null;
    renderGame();
    syncGameState();
    return;
  }

  // Guest-initiated pause request — host applies the pause
  if (action === 'pause_request') {
    if (!G.paused && amHost) {
      const requester = G.players.find(p => p.id === playerId);
      const name = requester?.name || 'Someone';
      toast(`${name} requested pause`);
      // Same logic as host tapping pause — queue if mid-hand, apply otherwise
      const handInProgress = G.stage && G.stage !== 'deal' && G.stage !== 'showdown' && G.stage !== 'finished';
      if (handInProgress) {
        G.pauseQueued = true;
        syncGameState();
        renderGame();
      } else {
        applyPause();
      }
    }
    return;
  }

  // Handle reveal specially — not a game action, just reveals folded cards
  if (action === 'reveal') {
    // Fetch the player's private hand and publish it
    if (sb && currentGameId) {
      sb.from('private_hands')
        .select('cards')
        .eq('game_id', currentGameId)
        .eq('hand_number', G.handNumber)
        .eq('player_id', playerId)
        .maybeSingle()
        .then(({ data }) => {
          if (data?.cards && G) {
            if (!G.revealedHands) G.revealedHands = {};
            G.revealedHands[playerId] = data.cards;
            renderGame();
            syncGameState();
          }
        });
    }
    return;
  }

  const p = G.players.find(pl => pl.id === playerId);
  if (!p || p.folded || p.eliminated) return;
  stopTurnTimer();
  stopHostTurnEnforcer();
  // Player responded — they're not away, clear the flag
  if (p.disconnected) { p.disconnected = false; }

  if (action === 'fold') {
    p.folded = true; p.lastAction = { type:'fold', label:'Fold' };
  } else if (action === 'check') {
    p.lastAction = { type:'check', label:'Check' };
  } else if (action === 'call') {
    const amt = Math.min(G.currentBet - p.bet, p.chips);
    p.chips -= amt; p.bet += amt; p.totalBet += amt; G.pot += amt;
    if (p.chips === 0) p.allIn = true;
    p.lastAction = { type:'bet', label:`Call ${amt}` };
  } else if (['raise','twobet','twobb','threebb','pot','allin'].includes(action)) {
    const raiseTotal = Math.min(amount || 0, p.chips + p.bet);
    const add = raiseTotal - p.bet;
    if (add > 0) { p.chips -= add; p.bet = raiseTotal; p.totalBet += add; G.pot += add; }
    if (p.chips === 0) p.allIn = true;
    G.currentBet = raiseTotal;
    const label = action === 'allin' ? 'All In' : `Raise ${raiseTotal}`;
    p.lastAction = { type:'bet', label };
    G.players.forEach(op => {
      if (op.id !== p.id && !op.folded && !op.eliminated && !op.allIn) op.lastAction = null;
    });
  }
  renderGame();
  setTimeout(advanceAction, 400);
}

// ── GUEST: receive state updates from host ────────────────────────────────────
let _guestStatePoller = null;

function guestSubscribeToGame(gameId) {
  if (gameSubscription) gameSubscription.unsubscribe();

  // Fallback poller: every 8 seconds, re-fetch state in case the realtime
  // subscription dropped events (common on mobile when screen sleeps).
  if (_guestStatePoller) clearInterval(_guestStatePoller);
  _guestStatePoller = setInterval(async () => {
    if (!sb || !currentGameId || amHost) {
      clearInterval(_guestStatePoller); _guestStatePoller = null; return;
    }
    try {
      const { data } = await sb.from('games').select('state, host_id').eq('id', currentGameId).maybeSingle();
      if (!data?.state) return;
      const srvHand = data.state.handNumber || 0;
      const myHand = G?.handNumber || 0;
      const srvStage = data.state.stage;
      const myStage = G?.stage;
      const srvPot = data.state.pot || 0;
      const myPot = G?.pot || 0;
      // Apply if anything material changed
      if (srvHand !== myHand || srvStage !== myStage || srvPot !== myPot) {
        G = data.state;
        applyMyPrivateHand();
        renderGame();
        if (G.stage === 'guts_decision' && G.variant === 'guts3') showGutsDecision();
        if (G.stage === 'showdown' && G.variant === 'guts3' && G.gutsResults) {
          const sd = document.getElementById('showdown-overlay');
          if (!sd || sd.dataset.kind !== 'guts-reveal') showGutsReveal();
        }
        if (G.pendingDealerChoice) showDealerChoice();
        if (G.breakActive) showBreakOverlay(); else hideBreakOverlay();
        if (G.handNumber > 0) fetchMyPrivateHand(currentGameId, G.handNumber);
      }
    } catch(e) { /* silent */ }
  }, 3000);

  gameSubscription = sb.channel(`game-state:${gameId}`)
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'games',
      filter: `id=eq.${gameId}`,
    }, payload => {
      const row = payload.new;
      if (!row.state) return;

      const prevHandNumber = G?.handNumber || 0;
      const prevActionIndex = G?.actionIndex;
      const prevMyChips = G?.players?.find(p => p.id === me.id)?.chips ?? null;
      const prevStage = G?.stage;

      // Host changed (migration happened) — update our role accordingly
      let justPromoted = false;
      if (row.host_id && row.host_id !== me.id && amHost) {
        // I used to be host but am not anymore — downgrade to guest cleanly
        amHost = false;
        stopHostHeartbeat();
        if (actionSubscription) { actionSubscription.unsubscribe(); actionSubscription = null; }
        toast('Someone else is host now');
      } else if (row.host_id === me.id && !amHost) {
        // We got promoted to host — upgrade
        amHost = true;
        hostListenForActions(gameId);
        startHostHeartbeat(gameId);
        clearDisconnectBanner();
        toast('You are now the host');
        justPromoted = true;
        setTimeout(() => resumeHostDuties(), 0); // after G is updated below
      }
      // The host's own G is the real table (it holds everyone's cards). Saved
      // state is redacted, so never let an echo of it overwrite the host's G.
      if (amHost && !justPromoted) return;

      if (_gamePaused) {
        _gamePaused = false;
        clearInterval(_migrationCountdown); _migrationCountdown = null;
        clearDisconnectBanner();
      }

      G = row.state;
      if (row.blind_config) {
        BLIND_LEVELS = row.blind_config.levels || BLIND_LEVELS;
        blindDurationSeconds = row.blind_config.duration || blindDurationSeconds;
      }
      if (row.buy_in_amount !== undefined && row.buy_in_amount !== null) {
        gameBuyIn = row.buy_in_amount;
      }

      // Tournament over — show end screen for everyone
      if (G.tournamentOver) {
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
        return;
      }

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

      // Detect "I won by everyone folding" for guests (host runs this in doShowdown directly).
      // Skip this for Guts — Guts has its own reveal overlay driven by G.gutsResults.
      if (!amHost && G.stage === 'showdown' && prevStage !== 'showdown' && G.variant !== 'guts3') {
        const stillIn = G.players.filter(p => !p.folded && !p.eliminated);
        if (stillIn.length === 1 && stillIn[0].id === me.id) {
          const myP = G.players.find(p => p.id === me.id);
          if (myP && myP.hand?.length && !myP.hand.some(c => c.hidden)) {
            const winAmt = (myP.chips || 0) - (prevMyChips || 0);
            if (winAmt > 0) {
              setTimeout(() => showMuckOrShow(myP, winAmt), 200);
            }
          }
        } else if (stillIn.length > 1) {
          setTimeout(() => guestShowShowdown(prevMyChips), 200);
        } else if (stillIn.length === 1 && stillIn[0].id !== me.id) {
          setTimeout(() => guestShowFoldWinOverlay(stillIn[0]), 200);
        }
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
      const isPlayStage = ['preflop', 'guts_decision'].includes(G.stage);
      const wasPlayStage = ['preflop', 'guts_decision'].includes(prevStage);
      if (isPlayStage && !wasPlayStage && G.handNumber > 0) {
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
    await sb.from('player_actions').insert({
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


