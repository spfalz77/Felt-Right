// ════════════════════════════════════════════════════════════════════════════
// HOME GAME — RE-BUY FLOW
// ════════════════════════════════════════════════════════════════════════════
// When a player runs out of chips in a home game, they can buy more chips.
// Each re-buy increases their total buy-in (tracked in p.totalBuyInCents) which
// matters at cash-out time: net P/L = (final stack) − (total buy-ins).

// Track whether we've already submitted a rebuy/sit-out for the current "broke" episode.
// Cleared when the player is no longer broke.
let _rebuyActionPending = false;
let _rebuyOverlayShown = false;

function showRebuyOverlay(opts = {}) {
  if (!G) return;
  const myPlayer = G.players.find(p => p.id === me.id);
  if (!myPlayer) return;
  if (!myPlayer.broke) {
    // No longer broke — host applied the rebuy or sit-out. Clean up state.
    _rebuyActionPending = false;
    if (_rebuyOverlayShown) closeRebuyOverlay();
    return;
  }
  if (myPlayer.eliminated) {
    _rebuyActionPending = false;
    if (_rebuyOverlayShown) closeRebuyOverlay();
    return;
  }
  // If we're waiting on the host to apply our submitted action, don't redraw the overlay
  if (_rebuyActionPending) return;
  if (_rebuyOverlayShown) return; // don't keep re-rendering, just keep it shown

  const isTournament = !getFormatConfig().moneyMode;
  const totalBuyInCents = myPlayer.totalBuyInCents || ((gameBuyIn || 0) * 100);

  // Rebuy cost + chips:
  // - Tournament: half the buy-in cost for half the starting chips
  // - Home: a full buy-in for a full stack
  const tournamentStartingChips = (FORMATS.tournament).startingChips;
  const rebuyCostChips = isTournament ? Math.floor((gameBuyIn || 0) * 100 / 2) : (gameBuyIn || 0) * 100;
  const rebuyChipsAmount = isTournament
    ? Math.floor(tournamentStartingChips / 2)
    : gameBuyIn * 100;

  // For tournaments, check if rebuys are still allowed (before first break)
  const rebuyAllowed = isTournament
    ? (G.rebuysEnabled && !G.rebuyWindowClosed)
    : true;

  const overlay = document.getElementById('elim-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  _rebuyOverlayShown = true;

  const rebuyDescription = isTournament
    ? `Re-buy costs <strong style="color:var(--gold)">${chipAmt(rebuyCostChips)}</strong> and gives you <strong style="color:var(--gold)">${rebuyChipsAmount.toLocaleString()}</strong> tournament chips`
    : `Re-buy: <strong style="color:var(--gold)">${chipAmt(rebuyCostChips)}</strong> chips`;
  const totalSoFarLine = `Bought in so far: <strong>${chipAmt(totalBuyInCents)}</strong>`;

  let rebuyBtnHtml;
  if (rebuyAllowed) {
    rebuyBtnHtml = `
      <button class="btn btn-primary" id="rebuy-btn" onclick="requestRebuy()">
        Re-Buy
      </button>`;
  } else {
    rebuyBtnHtml = `
      <button class="btn btn-primary" disabled style="opacity:0.4">
        Re-Buys Closed
      </button>`;
  }

  overlay.innerHTML = `
    <div class="elim-banner" style="text-align:center">
      <div style="font-family:'Bebas Neue',sans-serif;font-size:2rem;color:var(--gold);
        letter-spacing:0.1em;margin-bottom:6px">OUT OF CHIPS</div>
      <div style="font-size:0.9rem;color:var(--text-dim);margin-bottom:14px;line-height:1.4">
        ${isTournament && !rebuyAllowed
          ? "First break has passed — re-buys are closed. You can sit out and watch."
          : "You're out of chips. Want to re-buy and keep playing?"}
      </div>
      <div style="background:rgba(212,168,67,0.08);border:1px solid var(--gold-dim);
        border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:0.78rem;line-height:1.4">
        ${rebuyAllowed ? rebuyDescription + '<br>' : ''}
        ${totalSoFarLine}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <button class="btn btn-ghost" id="sit-out-btn" onclick="declineRebuy()">Sit Out</button>
        ${rebuyBtnHtml}
      </div>
    </div>`;
}

function disableRebuyButtons(label) {
  const r = document.getElementById('rebuy-btn');
  const s = document.getElementById('sit-out-btn');
  if (r) { r.disabled = true; r.textContent = label || 'Processing…'; }
  if (s) { s.disabled = true; }
}

function requestRebuy() {
  if (_rebuyActionPending) return;
  const myPlayer = G?.players.find(p => p.id === me.id);
  if (!myPlayer || !myPlayer.broke) return;

  const isTournament = !getFormatConfig().moneyMode;
  if (isTournament && (!G.rebuysEnabled || G.rebuyWindowClosed)) {
    toast('Re-buys are closed');
    return;
  }

  const tournamentStartingChips = (FORMATS.tournament).startingChips;
  const rebuyCostCents = isTournament ? Math.floor((gameBuyIn || 0) * 100 / 2) : (gameBuyIn || 0) * 100;
  const rebuyChips = isTournament ? Math.floor(tournamentStartingChips / 2) : (gameBuyIn || 0) * 100;
  if (!rebuyCostCents) { toast('No buy-in amount set'); return; }

  _rebuyActionPending = true;
  disableRebuyButtons('Re-buying…');

  if (amHost || me.id === 'demo') {
    applyRebuy(me.id, rebuyChips, rebuyCostCents);
    closeRebuyOverlay();
  } else if (sb && currentGameId) {
    // Encode rebuy: amount field carries the chip amount, target_id is unused
    postAction({
      game_id: currentGameId,
      player_id: me.id,
      action: 'rebuy',
      amount: rebuyChips,
      created_at: new Date().toISOString(),
    }).then(({ error }) => {
      if (error) {
        toast('Re-buy failed — try again');
        _rebuyActionPending = false;
        showRebuyOverlay();
      }
      // Otherwise wait for the host to sync the new state; overlay will close
      // when our broke flag clears.
    });
  }
}

function declineRebuy() {
  if (_rebuyActionPending) return;
  const myPlayer = G?.players.find(p => p.id === me.id);
  if (!myPlayer) return;

  _rebuyActionPending = true;
  disableRebuyButtons();

  if (amHost || me.id === 'demo') {
    myPlayer.eliminated = true;
    myPlayer.broke = false;
    if (!getFormatConfig().moneyMode && G.finalPlacements &&
        !G.finalPlacements.some(fp => fp.name === myPlayer.name)) {
      G.finalPlacements.unshift({ name: myPlayer.name, emoji: myPlayer.emoji });
    }
    syncGameState();
    closeRebuyOverlay();
    renderGame();
  } else if (sb && currentGameId) {
    postAction({
      game_id: currentGameId,
      player_id: me.id,
      action: 'sit_out',
      amount: null,
      created_at: new Date().toISOString(),
    }).then(({ error }) => {
      if (error) {
        toast('Sit-out failed — try again');
        _rebuyActionPending = false;
        showRebuyOverlay();
      }
    });
  }
}

function closeRebuyOverlay() {
  const o = document.getElementById('elim-overlay');
  if (o) { o.style.display = 'none'; o.innerHTML = ''; }
  _rebuyOverlayShown = false;
}

// Host-side: apply a rebuy. Adds chips and tracks cost. Marks player not-broke.
// `addChips` is the chip amount to add. `costCents` is the dollar cost in cents
// for ledger tracking (defaults to addChips for backward compatibility).
function applyRebuy(playerId, addChips, costCents) {
  const p = G?.players.find(pl => pl.id === playerId);
  if (!p) return;
  // Defensive: don't double-apply if player is already not broke
  if (!p.broke && p.chips > 0) return;
  const cost = costCents != null ? costCents : addChips;
  p.chips = (p.chips || 0) + addChips;
  p.totalBuyInCents = (p.totalBuyInCents || ((gameBuyIn || 0) * 100)) + cost;
  p.broke = false;
  p.eliminated = false;
  if (!G.eventLog) G.eventLog = [];
  G.eventLog.push({
    kind: 'rebuy',
    playerId,
    playerName: p.name,
    amount: cost,        // cost in cents
    chipsAdded: addChips,
    hand: G.handNumber,
  });
  syncGameState();
  renderGame();
  toast(`${p.name} re-bought (+${addChips.toLocaleString()} chips)`);
}


// Guest: if I'm busted and a re-buy is available, clear the result screen and
// show Re-Buy / Sit Out (dismissShowdown does that when I'm broke).
function offerRebuyIfBroke() {
  const myP = G?.players?.find(p => p.id === me.id);
  if (!myP?.broke || myP.eliminated) return;
  if (!(getFormatConfig().moneyMode || (G.rebuysEnabled && !G.rebuyWindowClosed))) return;
  if (document.getElementById('elim-overlay')?.style.display === 'flex') return;
  dismissShowdown();
}
