// ════════════════════════════════════════════════════════════════════════════
// BLIND STRUCTURE EDITOR
// ════════════════════════════════════════════════════════════════════════════
// DEFAULT_BLIND_LEVELS comes from the shared engine (config.js)

function renderBlindEditor() {
  const tbody = document.getElementById('blind-editor-body');
  if (!tbody) return;
  tbody.innerHTML = BLIND_LEVELS.map((lvl, i) => `
    <tr>
      <td style="color:var(--text-dim);font-size:0.78rem;padding-left:6px">${i+1}</td>
      <td><input class="blind-input" type="number" min="5" step="5" value="${lvl.small}"
        oninput="BLIND_LEVELS[${i}].small=Math.max(5,parseInt(this.value)||5); BLIND_LEVELS[${i}].big=BLIND_LEVELS[${i}].small*2; this.closest('tr').cells[2].querySelector('input').value=BLIND_LEVELS[${i}].big"></td>
      <td><input class="blind-input" type="number" min="10" step="5" value="${lvl.big}"
        oninput="BLIND_LEVELS[${i}].big=Math.max(10,parseInt(this.value)||10)"></td>
      <td>${BLIND_LEVELS.length > 2 ? `<button class="blind-row-del" onclick="removeBlindLevel(${i})">×</button>` : ''}</td>
    </tr>`).join('');
}

function addBlindLevel() {
  const last = BLIND_LEVELS[BLIND_LEVELS.length - 1];
  BLIND_LEVELS.push({ level: BLIND_LEVELS.length + 1, small: last.small * 2, big: last.big * 2 });
  renderBlindEditor();
}

function removeBlindLevel(i) {
  if (BLIND_LEVELS.length <= 2) return;
  BLIND_LEVELS.splice(i, 1);
  BLIND_LEVELS.forEach((l, idx) => l.level = idx + 1);
  renderBlindEditor();
}

function resetBlinds() {
  BLIND_LEVELS = DEFAULT_BLIND_LEVELS.map(l => ({...l}));
  document.getElementById('blind-duration-input').value = 10;
  blindDurationSeconds = DEFAULT_BLIND_DURATION;
  renderBlindEditor();
  toast('Blind structure reset to default');
}

function updatePayoutPreview() {
  const el = document.getElementById('payout-preview');
  if (!el) return;
  const playerCount = (lobbyPlayers || []).length;
  if (gameBuyIn <= 0) {
    el.textContent = 'No buy-in (not counted in standings)';
    return;
  }
  // Home game: no fixed payout structure — players cash out at end with their stacks
  if (gameFormat === 'home') {
    el.textContent = `Everyone starts with ${chipAmt(gameBuyIn * 100)} chips`;
    return;
  }
  // Tournament: show fixed payout split
  if (playerCount < 2) {
    el.textContent = `${chipAmt(gameBuyIn * 100 * Math.max(playerCount, 1))} prize pool · need 2+ players`;
    return;
  }
  const pool = gameBuyIn * playerCount;
  const payouts = computePayouts(gameBuyIn, playerCount, false);
  const parts = payouts.map(p => `${['1st','2nd','3rd'][p.placement-1]} ${chipAmt(p.amount * 100)}`);
  el.textContent = `${chipAmt(pool * 100)} prize pool · ${parts.join(' · ')}`;
}

let _buyInSaveTimer = null;
function onBuyInChanged(value) {
  // The box is in chips; stored in hundreds (buy_in_amount)
  gameBuyIn = Math.max(0, Math.round((parseInt(value) || 0) / 100));
  updatePayoutPreview();
  // Debounced save to DB so guests see the same buy-in
  if (sb && currentLobbyId && me.id !== 'demo') {
    clearTimeout(_buyInSaveTimer);
    _buyInSaveTimer = setTimeout(() => {
      sb.from('games').update({ buy_in_amount: gameBuyIn }).eq('id', currentLobbyId).then(() => {});
    }, 600);
  }
}

// Toggle the tournament-style vs home-style blind editor based on selected format.
// Tournament shows multi-level + timer. Home shows just SB/BB (no escalation, no timer).
function toggleBlindEditorSection() {
  const tournamentEd = document.getElementById('tournament-blinds-section');
  const homeEd = document.getElementById('home-blinds-section');
  if (!tournamentEd || !homeEd) return;
  // Home games always start everyone on 2,000 chips (the stack is fixed by the
  // rules), so the buy-in isn't editable there.
  const buyInWrap = document.getElementById('buy-in-input-wrap');
  if (buyInWrap) buyInWrap.style.display = gameFormat === 'home' ? 'none' : 'flex';
  if (gameFormat === 'home' && gameBuyIn !== 20 && typeof amHost !== 'undefined' && amHost) onBuyInChanged(2000);
  if (gameFormat === 'home') {
    tournamentEd.style.display = 'none';
    homeEd.style.display = 'block';
    // Sync the inputs to current BLIND_LEVELS[0]
    const sbI = document.getElementById('home-sb-input');
    const bbI = document.getElementById('home-bb-input');
    if (sbI && BLIND_LEVELS[0]) sbI.value = BLIND_LEVELS[0].small;
    if (bbI && BLIND_LEVELS[0]) bbI.value = BLIND_LEVELS[0].big;
  } else {
    tournamentEd.style.display = 'block';
    homeEd.style.display = 'none';
  }
}

let _homeBlindSaveTimer = null;
function onHomeBlindChange() {
  const sbI = document.getElementById('home-sb-input');
  const bbI = document.getElementById('home-bb-input');
  const sb_val = Math.max(1, parseInt(sbI?.value) || 5);
  const bb_val = Math.max(sb_val, parseInt(bbI?.value) || 10);
  BLIND_LEVELS = [{ level: 1, small: sb_val, big: bb_val }];
  if (sb && currentLobbyId && me.id !== 'demo') {
    clearTimeout(_homeBlindSaveTimer);
    _homeBlindSaveTimer = setTimeout(() => {
      sb.from('games').update({
        blind_config: { levels: BLIND_LEVELS, duration: blindDurationSeconds },
      }).eq('id', currentLobbyId).then(() => {});
    }, 600);
  }
}

