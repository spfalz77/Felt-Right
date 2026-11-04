// ── TURN TIMER ────────────────────────────────────────────────────────────────
const TURN_SECONDS = 30;
const CIRCUMFERENCE = 2 * Math.PI * 15;
let _timerInterval = null;
let _timerLeft = TURN_SECONDS;
let _timerForActionKey = null; // tracks which specific turn the timer belongs to
let _autoAction = null; // pre-selected action: 'check_fold' | 'check' | 'call' | 'fold'
let _sliderTurnKey = null; // tracks which turn the slider is initialized for

let _timerStartedAt = 0; // wall-clock time when this turn's timer began

// Returns true if any non-eliminated player is broke and rebuys are still possible —
// in that case the game should pause until they decide rebuy/sit-out.
function isAnyRebuyPending() {
  if (!G || !G.players) return false;
  const rebuyAvailable = getFormatConfig().moneyMode || (G.rebuysEnabled && !G.rebuyWindowClosed);
  if (!rebuyAvailable) return false;
  return G.players.some(p => p.broke && !p.eliminated);
}

function startTurnTimer(seconds) {
  stopTurnTimer();
  const total = seconds || TURN_SECONDS;
  const timerEl = document.getElementById('turn-timer');
  const numEl   = document.getElementById('timer-num');
  const arcEl   = document.getElementById('timer-arc');
  if (!timerEl) return;

  _timerStartedAt = Date.now();
  _timerLeft = total;

  timerEl.style.display = 'flex';
  updateTimerDisplay(_timerLeft, total, numEl, arcEl);

  _timerInterval = setInterval(() => {
    // Freeze timer while someone is deciding rebuy/sit-out
    if (isAnyRebuyPending() || G?.breakActive) {
      // Slide the start time forward so when un-frozen, we resume from same point
      _timerStartedAt = Date.now() - ((total - _timerLeft) * 1000);
      return;
    }
    const elapsed = Math.floor((Date.now() - _timerStartedAt) / 1000);
    _timerLeft = Math.max(0, total - elapsed);
    updateTimerDisplay(_timerLeft, total, numEl, arcEl);
    if (_timerLeft <= 0) {
      stopTurnTimer();
      fireAutoAction();
    }
  }, 1000);
}

function fireAutoAction() {
  const myPlayer = G.players.find(p => p.id === me.id);
  if (!myPlayer) return;
  const canCheck = G.currentBet === myPlayer.bet;

  // Mark me as away so host sees it and future turns skip me
  myPlayer.disconnected = true;

  // If a check/fold preselection is on (long-press toggle), use it
  if (_autoAction === 'check_fold') { playerAction(canCheck ? 'check' : 'fold'); return; }
  if (_autoAction === 'fold') { playerAction('fold'); return; }
  if (_autoAction === 'check' && canCheck) { playerAction('check'); return; }
  if (_autoAction === 'call') { playerAction(canCheck ? 'check' : 'call'); return; }

  // Default: check if possible, otherwise fold (player went away with no preselection)
  playerAction(canCheck ? 'check' : 'fold');
}

// Host-side: auto check/fold for a player who's stepped away. Used when an away
// player is on action and we don't want the table to wait on them.
function autoActAway(playerId) {
  if (!G || !amHost) return;
  const p = G.players.find(pl => pl.id === playerId);
  if (!p) return;
  const canCheck = G.currentBet === p.bet;
  const action = canCheck ? 'check' : 'fold';
  applyRemoteAction(playerId, action, 0);
}

function setAutoAction(action) {
  _autoAction = _autoAction === action ? null : action; // toggle off if tapped again
  // Re-render just the auto-action buttons to show selection state
  renderAutoActionBar();
}

function renderAutoActionBar() {
  const el = document.getElementById('auto-action-bar');
  if (!el) return;
  const isAway = _autoAction === 'check_fold';

  // Single Away toggle button. Long-press to enable, tap to disable when active.
  el.innerHTML = `
    <button id="away-toggle-btn"
      style="padding:5px 12px;font-size:0.72rem;border-radius:4px;cursor:pointer;
        background:${isAway?'rgba(231,76,60,0.2)':'var(--surface2)'};
        border:1px solid ${isAway?'var(--red-light)':'var(--border)'};
        color:${isAway?'var(--red-light)':'var(--text-dim)'};
        font-weight:${isAway?'700':'400'};
        user-select:none;-webkit-user-select:none">
      ${isAway ? '⏸ AWAY (auto check/fold) — tap to cancel' : 'Hold to set Away mode'}
    </button>`;

  const btn = document.getElementById('away-toggle-btn');
  if (!btn) return;

  if (isAway) {
    // Single tap to disable when already away
    btn.onclick = () => {
      _autoAction = null;
      renderAutoActionBar();
      toast('Away cancelled');
    };
  } else {
    // Long-press to enable (mobile + desktop)
    let pressTimer = null;
    let pressed = false;

    const startPress = (e) => {
      e.preventDefault();
      pressed = true;
      pressTimer = setTimeout(() => {
        if (!pressed) return;
        // Long-press fired — confirm
        if (confirm('Set yourself to Away mode? You will auto check or fold for the rest of this hand.')) {
          _autoAction = 'check_fold';
          if (navigator.vibrate) navigator.vibrate(40);
          renderAutoActionBar();
          toast('Away mode on — will auto check/fold');
        }
      }, 700); // 700ms long-press
    };
    const cancelPress = () => {
      pressed = false;
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    };

    btn.addEventListener('mousedown', startPress);
    btn.addEventListener('touchstart', startPress);
    btn.addEventListener('mouseup', cancelPress);
    btn.addEventListener('mouseleave', cancelPress);
    btn.addEventListener('touchend', cancelPress);
    btn.addEventListener('touchcancel', cancelPress);
  }
}

// Clear away mode at the end of every hand (item 8: persist only until end of hand)
function clearAwayMode() {
  _autoAction = null;
}

function setAutoAction(action) {
  // Backward compat — direct toggle (used internally)
  _autoAction = _autoAction === action ? null : action;
  renderAutoActionBar();
}

function stopTurnTimer() {
  clearInterval(_timerInterval);
  _timerInterval = null;
  _timerForActionKey = null;
  const timerEl = document.getElementById('turn-timer');
  if (timerEl) timerEl.style.display = 'none';
}

function updateTimerDisplay(left, total, numEl, arcEl) {
  if (!numEl || !arcEl) return;
  numEl.textContent = left;
  const pct = left / total;
  const offset = CIRCUMFERENCE * (1 - pct);
  arcEl.style.strokeDashoffset = offset;
  arcEl.style.stroke = left > 15 ? 'var(--gold)' : left > 8 ? '#e67e22' : 'var(--red-light)';
}

