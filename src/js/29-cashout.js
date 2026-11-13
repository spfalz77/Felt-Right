// ════════════════════════════════════════════════════════════════════════════
// HOME GAME — CASH OUT FLOW
// ════════════════════════════════════════════════════════════════════════════
// At end of a home game each player's net = final stack − total buy-ins (all in
// chips). Pairwise rows are recorded so Standings update.

let _cashOutState = null;

function openCashOutModal() {
  if (!G || !isTableHost()) return;
  if (!getFormatConfig().moneyMode) {
    toast('Only home games are ended this way');
    return;
  }
  // Build participants from current G.players. Each player's effective buy-in is the
  // sum of their original buy-in plus any re-buys (tracked in p.totalBuyInCents).
  const defaultBuyInCents = (gameBuyIn || 0) * 100;
  _cashOutState = {
    players: G.players.map(p => ({
      id: p.id,
      name: p.name,
      emoji: p.emoji,
      stackCents: p.cashedOutCents != null ? p.cashedOutCents : (p.chips || 0),
      buyInCents: p.totalBuyInCents || defaultBuyInCents,
      leftTable: p.cashedOutCents != null,
    })),
  };
  voidUnfinishedHandForCashOut(_cashOutState.players);
  renderCashOutModal();
  openModal('modal-cashout');
}

// Ending mid-hand: void the unfinished hand so chips in the pot aren't lost.
// Same rule as the database's cleanup_stale_games(): everyone still seated gets
// back what they put in this hand; any pot that can't be attributed (e.g. a
// Guts carry-over) is split evenly, remainder to the first seated player.
function voidUnfinishedHandForCashOut(players) {
  const pot = Math.max(G?.pot || 0, 0);
  if (!pot) return;
  const seated = players.filter(p => !p.leftTable);
  if (!seated.length) return;
  const betOf = (p) => Math.max(G.players.find(x => x.id === p.id)?.totalBet || 0, 0);
  const refundable = seated.reduce((a, p) => a + betOf(p), 0);
  let leftover = 0;
  if (refundable > pot) {
    seated.forEach(p => { p.stackCents += Math.round(betOf(p) * pot / refundable); });
  } else {
    seated.forEach(p => { p.stackCents += betOf(p); });
    leftover = pot - refundable;
  }
  if (leftover > 0) {
    const share = Math.floor(leftover / seated.length);
    seated.forEach(p => { p.stackCents += share; });
    seated[0].stackCents += leftover - share * seated.length;
  }
}

function renderCashOutModal() {
  const list = document.getElementById('cashout-list');
  if (!list || !_cashOutState) return;
  list.innerHTML = _cashOutState.players.map((p, i) => `
    <div style="display:flex;align-items:center;gap:10px;padding:10px;
      background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:6px">
      <div class="avatar sm">${p.emoji}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:0.88rem">${p.name}</div>
        <div style="font-size:0.7rem;color:var(--text-dim)">Bought in: ${chipAmt(p.buyInCents)}${p.leftTable ? ' · left early' : ''}</div>
      </div>
      <div style="display:flex;align-items:center;gap:4px">
        <input type="number" min="0" step="5" value="${Math.round(p.stackCents)}" aria-label="Final chips"
          oninput="updateCashOut(${i}, this.value)"
          style="width:72px;background:var(--surface2);border:1px solid var(--border);
            color:var(--gold);border-radius:6px;padding:6px 6px;font-size:0.9rem;
            font-family:'Bebas Neue',sans-serif;letter-spacing:0.04em;text-align:right">
      </div>
    </div>`).join('');
  updateCashOutTotals();
}

function updateCashOut(idx, value) {
  if (!_cashOutState) return;
  _cashOutState.players[idx].stackCents = Math.max(0, Math.round(parseFloat(value) || 0));
  updateCashOutTotals();
}

function updateCashOutTotals() {
  const players = _cashOutState?.players || [];
  const poolCents = players.reduce((s, p) => s + p.buyInCents, 0);
  const sumCents  = players.reduce((s, p) => s + p.stackCents, 0);
  document.getElementById('cashout-pool').textContent = chipAmt(poolCents);
  document.getElementById('cashout-sum').textContent  = chipAmt(sumCents);
  const msg = document.getElementById('cashout-balance-msg');
  const btn = document.getElementById('cashout-confirm-btn');
  if (poolCents === sumCents) {
    msg.textContent = '✓ Final stacks match the chips bought in';
    msg.style.color = 'var(--gold)';
    if (btn) btn.disabled = false;
  } else {
    const diff = sumCents - poolCents;
    msg.textContent = diff > 0 ? `⚠ Final stacks are ${chipAmt(diff)} more than bought in` : `⚠ Final stacks are ${chipAmt(-diff)} short of what was bought in`;
    msg.style.color = 'var(--red-light)';
    if (btn) btn.disabled = false; // Still allow — host may have a reason
  }
}

async function confirmCashOut() {
  if (!_cashOutState || !isTableHost()) return;
  if (isServerGame()) {
    // The server voids any hand in progress, cashes everyone out and writes the
    // ledger; the end screen appears when the finished state arrives.
    closeModal('modal-cashout');
    const { error } = await callTable(currentGameId, 'end_game');
    if (error) toast(error);
    return;
  }
  const players = _cashOutState.players;
  // Build a placements-like array sorted by net P/L (highest = 1st place)
  const withNet = players.map(p => ({
    ...p,
    netCents: p.stackCents - p.buyInCents,
  })).sort((a, b) => b.netCents - a.netCents);

  // Save net P/L into G state so guests can also record their own ledger entries
  G.cashOuts = withNet.map((p, i) => ({
    id: p.id, name: p.name, emoji: p.emoji,
    stackCents: p.stackCents, buyInCents: p.buyInCents, netCents: p.netCents,
    placement: i + 1,
  }));
  G.finalPlacements = G.cashOuts.map(p => ({ name: p.name, emoji: p.emoji, netCents: p.netCents }));
  G.tournamentOver = true;
  G.stage = 'finished';
  closeModal('modal-cashout');

  showHomeGameEnd();
}

function showHomeGameEnd() {
  const overlay = document.getElementById('tourney-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  const cashOuts = G.cashOuts || [];
  const ledgerKey = `fr_ledger_recorded_${currentGameId}`;
  // A server game's ledger is written by the server as part of cashing out
  const alreadyRecorded = isServerGame() || sessionStorage.getItem(ledgerKey);
  const ledgerBtnHtml = (gameBuyIn > 0 && me.id !== 'demo' && !alreadyRecorded) ? `
    <button id="record-ledger-btn" onclick="onRecordHomeGameLedger()" style="background:none;
      border:1px solid var(--gold-dim);color:var(--gold);
      font-size:0.85rem;padding:10px 18px;border-radius:8px;cursor:pointer;margin-top:10px;font-weight:600">
      📒 Record to Standings
    </button>` : (alreadyRecorded ? `
    <div style="font-size:0.78rem;color:var(--gold-pale);margin-top:8px;font-style:italic">
      ✓ Recorded to Standings
    </div>` : '');

  overlay.innerHTML = `
    <div class="tourney-result">
      <div class="trophy">🪙</div>
      <div class="tourney-title">Game Over</div>
      <div class="tourney-sub" style="margin-bottom:14px">Home Game · Final standings</div>
      <div class="final-places">
        ${cashOuts.map((p, i) => {
          const net = p.netCents;
          const netStr = chipNet(net);
          const color = net > 0 ? 'var(--gold)' : net < 0 ? 'var(--red-light)' : 'var(--text-dim)';
          return `<div class="place-row">
            <div class="place-medal">${i+1}.</div>
            <div class="place-name">${p.emoji} ${p.name}</div>
            <div style="font-family:'Bebas Neue',sans-serif;color:${color};font-size:1.1rem;margin-left:auto">
              ${netStr}
            </div>
          </div>`;
        }).join('')}
      </div>
      ${ledgerBtnHtml}
      <button class="btn btn-primary" onclick="goHome()" style="margin-top:14px">Back to Home</button>
    </div>`;
}

// Records the home game to the friends ledger for every player (both sides),
// computed on the server from the saved cash-outs. Safe to press more than once.
async function onRecordHomeGameLedger() {
  const btn = document.getElementById('record-ledger-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Recording…'; }
  const res = await settleHomeGameLedger(currentGameId);
  if (!res || res.error) {
    toast('Could not record to Standings');
    if (btn) { btn.disabled = false; btn.textContent = '📒 Record to Standings'; }
    return;
  }
  sessionStorage.setItem(`fr_ledger_recorded_${currentGameId}`, '1');
  const msg = res.ledger_rows ? '✓ Recorded to Standings' : '✓ Nothing to record (everyone broke even)';
  if (btn) btn.outerHTML = `<div style="font-size:0.78rem;color:var(--gold-pale);margin-top:8px;font-style:italic">${msg}</div>`;
  if (res.ledger_rows) toast('Recorded to Standings');
}

let _autoDealTimer = null;

function scheduleAutoDeal(delayMs = 4000) {
  if (_autoDealTimer) return;
  if (!amHost && me.id !== 'demo') return; // only host schedules
  const tick = () => {
    _autoDealTimer = null;
    // Wait while a busted player decides re-buy / sit out. Keep checking until
    // they do (this used to give up after one retry and deal anyway). A busted
    // player whose app is gone, or who doesn't answer in time, is sat out.
    const rebuyAvailable = getFormatConfig().moneyMode || (G?.rebuysEnabled && !G?.rebuyWindowClosed);
    const deciding = rebuyAvailable ? (G?.players || []).filter(p => p.broke && !p.eliminated) : [];
    if (deciding.length) {
      const now = Date.now();
      let satOut = false;
      deciding.forEach(p => {
        _brokeSince[p.id] = _brokeSince[p.id] || now;
        const gone = p.id !== me.id && typeof isPlayerOnline === 'function' && !isPlayerOnline(p.id);
        if (gone || now - _brokeSince[p.id] > REBUY_DECISION_MS) { autoSitOut(p); satOut = true; }
      });
      if (!satOut) { _autoDealTimer = setTimeout(tick, 2000); return; }
    }
    _brokeSince = {};
    nextHand();
  };
  _autoDealTimer = setTimeout(tick, delayMs);
}

const REBUY_DECISION_MS = 60000;
let _brokeSince = {};

// Host-side: sit out a busted player who didn't (or can't) decide.
function autoSitOut(p) {
  p.eliminated = true;
  p.broke = false;
  if (!getFormatConfig().moneyMode && G.finalPlacements && !G.finalPlacements.some(fp => fp.name === p.name)) {
    G.finalPlacements.unshift({ name: p.name, emoji: p.emoji });
  }
  delete _brokeSince[p.id];
  toast(`${p.name} sat out (no re-buy)`);
  syncGameState();
  renderGame();
}

function cancelAutoDeal() {
  if (_autoDealTimer) { clearTimeout(_autoDealTimer); _autoDealTimer = null; }
}

// "Got it" button on the showdown overlay.
// Host: cancel auto-deal and advance to next hand immediately.
// Guest: hide my own overlay; the host will sync the next hand state when ready.
function dismissShowdown() {
  const overlay = document.getElementById('showdown-overlay');
  if (overlay) overlay.style.display = 'none';
  ackHandResult(); // server game: the next hand waits for everyone's Got It

  // If I'm broke and rebuys are available, show rebuy overlay BEFORE advancing
  const myP = G?.players?.find(p => p.id === me.id);
  const rebuyAvailable = myP && myP.broke && !myP.eliminated &&
    (getFormatConfig().moneyMode || (G?.rebuysEnabled && !G?.rebuyWindowClosed));
  if (rebuyAvailable) {
    showRebuyOverlay();
    // Host: pause auto-deal until rebuy decision is made
    if (amHost || me.id === 'demo') cancelAutoDeal();
    return;
  }

  if (amHost || me.id === 'demo') {
    cancelAutoDeal();
    // Guts progression: if there's more to come, continue instead of starting a new hand
    if (G?.variant === 'guts3' && G?.gutsResults && G.gutsResults.progressionEnded === false) {
      continueGutsProgression();
      return;
    }
    nextHand();
  }
}

function nextHand() {
  cancelAutoDeal();
  document.getElementById('showdown-overlay').style.display = 'none';
  document.getElementById('elim-overlay').style.display = 'none';

  // Guts progression: if we're not done, continue same dealer/hand
  if (G?.variant === 'guts3' && G?.gutsResults && G.gutsResults.progressionEnded === false) {
    if (amHost || me.id === 'demo') continueGutsProgression();
    return;
  }

  // Only host (or demo mode acting as host) can deal a new hand. Guests must wait
  // for the host's state push. Calling dealNewHand on a guest would corrupt local state
  // (resetting deck, hand counter, etc.) without ever syncing to the server.
  if (!amHost && me.id !== 'demo') return;

  const remaining = G.players.filter(p => !p.eliminated && p.chips > 0);
  // Tournament-style only: auto-end when 1 player left. Home games run until host calls End.
  if (!getFormatConfig().moneyMode && remaining.length <= 1) { endTournament(); return; }
  // Home game: if only 1 player has chips, just skip the deal but don't end
  if (getFormatConfig().moneyMode && remaining.length < 2) {
    toast('Not enough players with chips. Host: tap End to finish the game.');
    return;
  }

  // Check if I'm eliminated (tournament only)
  const myPlayer = G.players.find(p => p.id === me.id);
  if (myPlayer?.eliminated && !getFormatConfig().moneyMode) {
    showEliminated();
    return;
  }

  // If host queued a pause, apply it now instead of dealing next hand
  if (amHost && G.pauseQueued) {
    applyPause();
    return;
  }

  setTimeout(dealNewHand, 400);
}

// Tournament: tell this player they're out, once per game. The host reaches
// showEliminated() from nextHand(); guests only learn it from a state update,
// so renderGame() calls this on every screen.
let _elimShownFor = null;
function maybeShowMyElimination() {
  if (!G || !currentGameId || me?.id === 'demo' || getFormatConfig().moneyMode || G.tournamentOver) return;
  const myP = G.players?.find(p => p.id === me.id);
  if (!myP?.eliminated || myP.awayFromTable) return;
  if (_elimShownFor === currentGameId) return;
  showEliminated();
}

function showEliminated() {
  _elimShownFor = currentGameId;
  const remaining = G.players.filter(p => !p.eliminated).length;
  const myPlace = remaining + 1;
  const overlay = document.getElementById('elim-overlay');
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="elim-banner">
      <div class="elim-title">ELIMINATED</div>
      <div class="elim-place">You finished ${ordinal(myPlace)} of ${G.players.length}</div>
      <button class="btn btn-surface" onclick="goHome()" style="margin-top:8px">Back to Lobby</button>
    </div>`;
}

function endTournament() {
  const winner = G.players.find(p => !p.eliminated && p.chips > 0) || G.players[0];
  if (winner && !G.finalPlacements.find(p => p.name === winner.name)) {
    G.finalPlacements.unshift({ name: winner.name, emoji: winner.emoji });
  }
  G.stage = 'finished';
  G.tournamentOver = true;


  // ── STATS: record tournament finish ──
  // Each client computes their own placement based on finalPlacements (1 = winner)
  if (G.finalPlacements && me?.id !== 'demo') {
    // finalPlacements[0] is the winner (most recent unshift), so order represents finish
    // Find my position. If I'm not in finalPlacements, I'm the winner (still standing)
    const myPlayer = G.players.find(p => p.id === me.id);
    if (myPlayer) {
      let myPlacement = null;
      // The current winner (still has chips) is placement #1
      if (winner?.id === me.id) {
        myPlacement = 1;
      } else {
        // My placement = my index in finalPlacements where 0 = winner, etc.
        const idx = G.finalPlacements.findIndex(p => p.name === myPlayer.name);
        if (idx >= 0) myPlacement = idx + 1;
      }
      const myChips = myPlayer.chips || 0;
      commitTournamentStats(myPlacement, myChips);
    }
  }

  showTournamentOverlay(winner);
}

// A tournament that was called off has no winner and records nothing: say so
// and go back Home (once per game).
let _calledOffShownFor = null;
function showCalledOff() {
  if (!currentGameId || _calledOffShownFor === currentGameId) return;
  _calledOffShownFor = currentGameId;
  const sd = document.getElementById('showdown-overlay');
  if (sd) sd.style.display = 'none';
  hidePauseOverlay();
  toast('Tournament called off — nothing recorded');
  setTimeout(goHome, 2500);
}

function showTournamentOverlay(winner) {
  if (G?.abandoned) { showCalledOff(); return; }
  const overlay = document.getElementById('tourney-overlay');
  overlay.style.display = 'flex';
  const iWon = winner?.id === me.id;
  // Detect chop: multiple players with chips remaining
  const stillIn = G.players.filter(p => !p.eliminated && p.chips > 0);
  const isChop = stillIn.length > 1;

  // Calculate payouts. With rebuys enabled, the pool grows beyond buy-in × players.
  const totalPlayers = G.players?.length || 0;
  const actualPool = G.rebuysEnabled ? actualPrizePool() : null;
  const payouts = computePayouts(gameBuyIn, totalPlayers, isChop, actualPool);
  const payoutByPlace = {};
  payouts.forEach(p => payoutByPlace[p.placement] = p.amount);

  // The server writes everyone's Friends Ledger rows when the tournament ends
  const ledgerBtnHtml = G.ledgerRecorded ? `
    <div style="font-size:0.78rem;color:var(--gold-pale);margin-top:8px;font-style:italic">
      ✓ Recorded to Standings
    </div>` : '';

  if (isChop) {
    overlay.innerHTML = `
      <div class="tourney-result">
        <div class="trophy">🤝</div>
        <div class="tourney-title">Chop!</div>
        <div class="tourney-sub" style="margin-bottom:14px">Game ended by agreement</div>
        ${gameBuyIn > 0 ? `<div style="font-size:0.78rem;color:var(--gold-pale);text-align:center;margin-bottom:14px;
          padding:8px 14px;background:rgba(212,168,67,0.08);border:1px solid var(--gold-dim);border-radius:8px">
          ${chipAmt((actualPool ?? gameBuyIn * totalPlayers) * 100)} prize pool · split equally
        </div>` : ''}
        <div class="final-places">
          ${G.finalPlacements.map((p,i) => `
            <div class="place-row">
              <div class="place-medal">${['🥇','🥈','🥉'][i]||`${i+1}.`}</div>
              <div class="place-name">${p.emoji} ${p.name}</div>
              ${payoutByPlace[i+1] ? `<div style="font-family:'Bebas Neue',sans-serif;color:var(--gold);font-size:1.1rem;margin-left:auto">
                ${chipAmt(payoutByPlace[i+1] * 100)}
              </div>` : ''}
            </div>`).join('')}
        </div>
        ${ledgerBtnHtml}
        <button class="btn btn-primary" onclick="goHome()" style="margin-top:14px">Back to Home</button>
      </div>`;
    return;
  }

  overlay.innerHTML = `
    <div class="tourney-result">
      <div class="trophy">${iWon ? '🏆' : '🃏'}</div>
      <div class="tourney-title">${iWon ? 'You Won!' : winner?.name + ' Wins!'}</div>
      <div class="tourney-sub" style="margin-bottom:14px">Tournament Complete</div>
      ${gameBuyIn > 0 ? `<div style="font-size:0.78rem;color:var(--gold-pale);text-align:center;margin-bottom:14px;
        padding:8px 14px;background:rgba(212,168,67,0.08);border:1px solid var(--gold-dim);border-radius:8px">
        ${chipAmt((actualPool ?? gameBuyIn * totalPlayers) * 100)} prize pool · ${totalPlayers} buy-ins of ${chipAmt(gameBuyIn * 100)}
      </div>` : ''}
      <div class="final-places">
        ${G.finalPlacements.map((p,i) => `
          <div class="place-row">
            <div class="place-medal">${['🥇','🥈','🥉'][i]||`${i+1}.`}</div>
            <div class="place-name">${p.emoji} ${p.name}</div>
            ${payoutByPlace[i+1] ? `<div style="font-family:'Bebas Neue',sans-serif;color:var(--gold);font-size:1.1rem;margin-left:auto">
              ${chipAmt(payoutByPlace[i+1] * 100)}
            </div>` : ''}
          </div>`).join('')}
      </div>
      ${ledgerBtnHtml}
      <button class="btn btn-primary" onclick="goHome()" style="margin-top:14px">Back to Home</button>
    </div>`;
}

function goHome() {
  G = null; currentGameId = null; currentLobbyId = null; amHost = false;
  stopServerTicker(); gameHostId = null;
  _gamePaused = false;
  stopBlindTimer();
  stopTurnTimer();
  stopPresence();
  unsubscribeFromChat();
  stopNudgeListener();
  clearInterval(_lobbyStatusPoller); _lobbyStatusPoller = null;
  clearInterval(_guestStatePoller); _guestStatePoller = null;
  // Close chat panel if open and clear badge
  const panel = document.getElementById('chat-panel');
  const backdrop = document.getElementById('chat-backdrop');
  if (panel) panel.style.display = 'none';
  if (backdrop) backdrop.style.display = 'none';
  updateChatBadge();
  // Keep listening for invites on Home (this used to stop the 10s invite poll
  // for good, leaving only the realtime feed)
  if (me && me.id !== 'demo' && sb) subscribeToInvites();
  if (gameSubscription)   { gameSubscription.unsubscribe();   gameSubscription = null; }
  if (lobbySubscription)  { lobbySubscription.unsubscribe();  lobbySubscription = null; }
  if (actionSubscription) { actionSubscription.unsubscribe(); actionSubscription = null; }
  navTo('home');
}

