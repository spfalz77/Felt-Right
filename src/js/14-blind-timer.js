// ════════════════════════════════════════════════════════════════════════════
// BLIND LEVEL TIMER (time-based, runs during the game)
// ════════════════════════════════════════════════════════════════════════════
let _blindTimerInterval = null;
let _blindLevelStartTime = null;
let _currentBlindLevel  = 0;

function startBlindTimer() {
  stopBlindTimer();
  // Skip the timer ONLY when we're explicitly in home format (blinds fixed there).
  // For tournaments or anything else, always run the interval.
  const format = G?.format || gameFormat || 'tournament';
  if (format === 'home') {
    updateBlindTimerDisplay();
    return;
  }
  _currentBlindLevel = 0;
  _blindLevelStartTime = Date.now();
  syncBlindClockFromServer();
  updateBlindTimerDisplay();
  _blindTimerInterval = setInterval(tickBlindTimer, 1000);
}

function stopBlindTimer() {
  clearInterval(_blindTimerInterval);
  _blindTimerInterval = null;
}

function tickBlindTimer() {
  if (!G) { stopBlindTimer(); return; }
  // Server game: the server keeps the blind clock; just show it
  if (syncBlindClockFromServer()) { updateBlindTimerDisplay(); return; }
  if (G.paused) return;
  if (G.breakActive) return;
  if (isAnyRebuyPending()) {
    // Freeze: advance the start time by 1s so elapsed stays put
    _blindLevelStartTime += 1000;
    updateBlindTimerDisplay();
    return;
  }

  const elapsed = Math.floor((Date.now() - _blindLevelStartTime) / 1000);
  const remaining = blindDurationSeconds - elapsed;

  if (remaining <= 0) {
    _currentBlindLevel++;
    _blindLevelStartTime = Date.now();
    const b = getBlinds(_currentBlindLevel);
    toast(`Blinds up! Now ${b.small} / ${b.big}`);
    const bi = document.getElementById('blind-info');
    if (bi) bi.innerHTML =
      `<span class="pos-badge sb" style="font-size:0.5rem;width:16px;height:16px">SB</span> ${b.small} &nbsp;` +
      `<span class="pos-badge bb" style="font-size:0.5rem;width:16px;height:16px">BB</span> ${b.big}`;

    // First break: trigger after 4 blind levels have completed (about to enter level 5)
    // Only relevant for tournaments with rebuys enabled
    if (_currentBlindLevel === 4 && G.rebuysEnabled && !G.rebuyWindowClosed && (amHost || me.id === 'demo')) {
      triggerFirstBreak();
    }
  }

  updateBlindTimerDisplay();
}

// Begin the tournament's first break (rebuys close after this break ends)
function triggerFirstBreak() {
  if (!G) return;
  G.breakActive = true;
  G.breakReady = [];
  G.breakStartedAt = Date.now();
  // Cancel any pending auto-deal so the break overlay shows immediately
  cancelAutoDeal();
  syncGameState();
  showBreakOverlay();
  toast('🛑 First break — players can add on');
}

// Show the break overlay to all players.
// Shows: title, "ready" button (per player), add-on button if not yet used,
// host's "Resume" button (forces end), chat is still accessible behind.
function showBreakOverlay() {
  if (!G || !G.breakActive) return;
  const overlay = document.getElementById('break-overlay');
  if (!overlay) return;

  const eligible = G.players.filter(p => !p.eliminated);
  const ready = G.breakReady || [];
  const readyCount = ready.length;
  const totalCount = eligible.length;
  const meReady = ready.includes(me.id);
  const myP = G.players.find(p => p.id === me.id);

  // Add-on rules: each player can add on once per break, and only if they have
  // chips already (not currently broke — broke players already get rebuy overlay)
  const addedOn = (G.breakAddOns || []).includes(me.id);
  const canAddOn = myP && !myP.eliminated && !myP.broke && !addedOn;

  const tournamentStartingChips = (FORMATS.tournament).startingChips;
  const addOnCost = Math.floor((gameBuyIn || 0) / 2);
  const addOnChips = Math.floor(tournamentStartingChips / 2);

  // Player chip rows: emoji + name + ready check
  const playerRows = eligible.map(p => {
    const isReady = ready.includes(p.id);
    const isMe = p.id === me.id;
    return `
      <div style="display:flex;align-items:center;gap:6px;padding:5px 10px;
        background:${isReady ? 'rgba(212,168,67,0.15)' : 'rgba(255,255,255,0.05)'};
        border-radius:12px;font-size:0.75rem;
        ${isMe ? 'outline:1px solid var(--gold)' : ''}">
        <span style="font-size:0.9rem">${p.emoji}</span>
        <span style="font-weight:${isMe ? 600 : 400}">${p.name}</span>
        ${isReady ? '<span style="color:var(--gold);font-size:0.7rem">✓ Ready</span>' : '<span style="color:var(--text-dim);font-size:0.65rem">…</span>'}
      </div>`;
  }).join('');

  overlay.style.cssText = 'display:flex;position:fixed;inset:0;background:rgba(0,0,0,0.85);' +
    'z-index:200;justify-content:center;align-items:center;padding:16px';
  overlay.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--gold);border-radius:14px;
      padding:20px 18px;max-width:400px;width:100%;max-height:85vh;overflow-y:auto;text-align:center">
      <div style="font-family:'Bebas Neue',sans-serif;font-size:2rem;letter-spacing:0.1em;
        color:var(--gold);margin-bottom:4px">⏸ BREAK</div>
      <div style="font-size:0.85rem;color:var(--text-dim);margin-bottom:16px;line-height:1.4">
        Take a moment. ${G.rebuysEnabled ? 'Rebuys close when this break ends.' : ''}<br>
        Chat is open below. Tap Ready when you're set.
      </div>

      ${canAddOn ? `
        <div style="background:rgba(212,168,67,0.08);border:1px solid var(--gold-dim);
          border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:0.78rem;line-height:1.5">
          <strong style="color:var(--gold)">Add-On Available</strong><br>
          One-time top-up: $${addOnCost} for ${addOnChips.toLocaleString()} chips<br>
          <button class="btn btn-primary" id="break-addon-btn" onclick="requestAddOn()"
            style="margin-top:8px">Add-On $${addOnCost}</button>
        </div>` : addedOn ? `
        <div style="color:var(--gold-pale);font-size:0.75rem;margin-bottom:14px;font-style:italic">
          ✓ Add-on used this break
        </div>` : ''}

      <div style="margin-bottom:14px">
        ${meReady
          ? `<div style="font-family:'Bebas Neue',sans-serif;font-size:1.2rem;color:var(--gold);
              letter-spacing:0.1em">✓ YOU'RE READY</div>`
          : myP && !myP.eliminated
            ? `<button class="btn btn-primary btn-full" id="break-ready-btn" onclick="markReadyForBreakEnd()">
                I'm Ready
              </button>`
            : `<div style="color:var(--text-dim);font-style:italic;font-size:0.8rem">
                You're out — waiting for break to end
              </div>`}
      </div>

      <div style="font-size:0.72rem;color:var(--text-dim);margin-bottom:6px">
        ${readyCount}/${totalCount} ready
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;justify-content:center;margin-bottom:14px">
        ${playerRows}
      </div>

      ${(amHost || me.id === 'demo') ? `
        <button class="btn btn-ghost btn-sm" onclick="endBreak()" style="margin-top:8px">
          Resume Game (Host)
        </button>` : ''}
    </div>`;
}

function hideBreakOverlay() {
  const overlay = document.getElementById('break-overlay');
  if (overlay) overlay.style.display = 'none';
}

// Player taps "I'm Ready". Host: apply directly. Guest: submit action.
function markReadyForBreakEnd() {
  if (!G || !G.breakActive) return;
  if (G.breakReady?.includes(me.id)) return;

  if (amHost || me.id === 'demo') {
    applyBreakReady(me.id);
  } else if (sb && currentGameId) {
    postAction({
      game_id: currentGameId,
      player_id: me.id,
      action: 'break_ready',
      amount: null,
      created_at: new Date().toISOString(),
    }).then(({ error }) => {
      if (error) toast('Could not mark ready');
    });
    // Optimistic local update
    if (!G.breakReady) G.breakReady = [];
    G.breakReady.push(me.id);
    showBreakOverlay();
  }
}

// Host-side: record a player's ready state. Auto-end break if all ready.
function applyBreakReady(playerId) {
  if (!G || !G.breakActive) return;
  if (!G.breakReady) G.breakReady = [];
  if (G.breakReady.includes(playerId)) return;
  G.breakReady.push(playerId);
  syncGameState();
  showBreakOverlay();
  // If all non-eliminated players are ready, host can auto-end
  const eligible = G.players.filter(p => !p.eliminated);
  if (G.breakReady.length >= eligible.length) {
    setTimeout(() => endBreak(), 600);
  }
}

// End the break, close the rebuy window, and resume play.
function endBreak() {
  if (!G || !G.breakActive) return;
  if (!amHost && me.id !== 'demo') {
    toast('Only the host can resume');
    return;
  }
  G.breakActive = false;
  G.rebuyWindowClosed = true;
  G.breakReady = [];
  G.breakAddOns = G.breakAddOns || [];
  // Restart blind timer at current level (paused while breakActive was true)
  _blindLevelStartTime = Date.now();
  syncGameState();
  hideBreakOverlay();
  renderGame();
  toast('▶ Game resumed · Rebuys closed');
  // If we're between hands, deal the next one
  if (G.stage === 'showdown' || G.stage === 'finished' || G.stage === 'deal') {
    setTimeout(() => nextHand(), 800);
  }
}

// Player taps Add-On during break. Same chip/cost as rebuy: half buy-in for half chips.
function requestAddOn() {
  if (!G || !G.breakActive) return;
  const myP = G?.players.find(p => p.id === me.id);
  if (!myP || myP.eliminated || myP.broke) return;
  if ((G.breakAddOns || []).includes(me.id)) return;

  const tournamentStartingChips = (FORMATS.tournament).startingChips;
  const addOnCostCents = Math.floor((gameBuyIn || 0) * 100 / 2);
  const addOnChips = Math.floor(tournamentStartingChips / 2);

  // Disable button immediately
  const btn = document.getElementById('break-addon-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }

  if (amHost || me.id === 'demo') {
    applyAddOn(me.id, addOnChips, addOnCostCents);
  } else if (sb && currentGameId) {
    postAction({
      game_id: currentGameId,
      player_id: me.id,
      action: 'add_on',
      amount: addOnChips,
      created_at: new Date().toISOString(),
    }).then(({ error }) => {
      if (error) {
        toast('Add-on failed');
        if (btn) { btn.disabled = false; btn.textContent = `Add-On $${addOnCostCents/100}`; }
      }
    });
  }
}

// Host-side: apply an add-on. Adds chips, tracks the cost, marks player as used.
function applyAddOn(playerId, addChips, costCents) {
  const p = G?.players.find(pl => pl.id === playerId);
  if (!p) return;
  if (!G.breakAddOns) G.breakAddOns = [];
  if (G.breakAddOns.includes(playerId)) return; // already used
  p.chips = (p.chips || 0) + addChips;
  p.totalBuyInCents = (p.totalBuyInCents || ((gameBuyIn || 0) * 100)) + costCents;
  G.breakAddOns.push(playerId);
  if (!G.eventLog) G.eventLog = [];
  G.eventLog.push({
    kind: 'addon', playerId, playerName: p.name,
    amount: costCents, chipsAdded: addChips,
    hand: G.handNumber,
  });
  syncGameState();
  showBreakOverlay();
  renderGame();
  toast(`${p.name} added on (+${addChips.toLocaleString()} chips)`);
}

function getCurrentBlindLevel() {
  return _currentBlindLevel;
}

function updateBlindTimerDisplay() {
  const elapsed = Math.floor((Date.now() - (_blindLevelStartTime || Date.now())) / 1000);
  const remaining = Math.max(0, blindDurationSeconds - elapsed);
  const pct = remaining / blindDurationSeconds;

  const fill = document.getElementById('blind-timer-fill');
  const countdown = document.getElementById('blind-timer-countdown');
  const label = document.getElementById('blind-level-label');

  if (fill) {
    fill.style.width = (pct * 100) + '%';
    fill.style.background = pct > 0.4 ? 'var(--gold)' : pct > 0.15 ? '#e67e22' : 'var(--red-light)';
  }
  if (countdown) {
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    countdown.textContent = `${m}:${s.toString().padStart(2,'0')}`;
    countdown.style.color = pct > 0.4 ? 'var(--gold)' : pct > 0.15 ? '#e67e22' : 'var(--red-light)';
  }
  if (label) {
    const pastStructure = _currentBlindLevel >= BLIND_LEVELS.length;
    label.textContent = `Lvl ${_currentBlindLevel + 1}${pastStructure ? ' ×2' : ' →'}`;
  }
}

