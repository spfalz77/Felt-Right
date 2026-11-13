// ════════════════════════════════════════════════════════════════════════════
// UNIVERSAL QUIT
// ════════════════════════════════════════════════════════════════════════════
// Quit behavior:
//   Tournament: player set to auto check/fold + marked eliminated, goes to home
//   Home game: cash out at current stack, record ledger, leave
function confirmQuitGame() {
  if (!G) { goHome(); return; }
  const isTournament = !getFormatConfig().moneyMode;
  const myP = G.players.find(p => p.id === me.id);
  if (!myP) { goHome(); return; }
  const hasChips = (myP.chips || 0) > 0;
  const stackInfo = isTournament
    ? `${(myP.chips || 0).toLocaleString()} chips`
    : `$${((myP.chips || 0) / 100).toFixed(2)}`;

  let msg;
  if (isTournament && hasChips) {
    msg = `Leave the table? You'll auto check/fold while you're away, blinds will still be taken from your stack (${stackInfo}), and you'll need to tap Sit Back Down to rejoin.`;
  } else if (isTournament) {
    msg = `Leave the tournament? You're out at your current stack and can't rejoin.`;
  } else {
    msg = `Cash out and leave the table at your current stack (${stackInfo})? Your ledger will be updated.`;
  }
  if (!confirm(msg)) return;
  quitGame();
}

async function quitGame() {
  if (!G) { goHome(); return; }
  const isTournament = !getFormatConfig().moneyMode;
  const myP = G.players.find(p => p.id === me.id);
  if (!myP) { goHome(); return; }
  const hasChips = (myP.chips || 0) > 0;

  if (isTournament && hasChips) {
    // ── STEP AWAY: mark away, set auto check/fold, return to home but keep player active ──
    if (amHost || me.id === 'demo') {
      myP.awayFromTable = true;
      myP.disconnected = true; // shows as "📡 Away" in opponent badge
      myP.lastAction = { type: 'away', label: 'Away' };
      syncGameState();
    } else if (sb && currentGameId) {
      try {
        await postAction({
          game_id: currentGameId,
          player_id: me.id,
          action: 'step_away',
          amount: null,
          created_at: new Date().toISOString(),
        });
      } catch(e) { /* still leave */ }
    }
    // Mark this game in localStorage so we know to show the "Sit Back Down" prompt
    // and NOT to auto-rejoin on next launch.
    try {
      const awayKey = `fr_away_${currentGameId}`;
      localStorage.setItem(awayKey, '1');
    } catch(e) { /* ignore */ }
    goHome();
    return;
  }

  if (isTournament) {
    // No chips left — quit = eliminated permanently
    if (amHost || me.id === 'demo') {
      myP.eliminated = true;
      myP.broke = false;
      myP.lastAction = { type: 'quit', label: 'Quit' };
      if (G.finalPlacements && !G.finalPlacements.some(fp => fp.name === myP.name)) {
        G.finalPlacements.unshift({ name: myP.name, emoji: myP.emoji });
      }
      syncGameState();
    } else if (sb && currentGameId) {
      try {
        await postAction({
          game_id: currentGameId,
          player_id: me.id,
          action: 'sit_out',
          amount: null,
          created_at: new Date().toISOString(),
        });
      } catch(e) { /* still leave */ }
    }
    goHome();
    return;
  }

  // ── HOME GAME QUIT ──
  // The player takes their stack home. The host banks it on the player
  // (cashedOutCents), clears it from the table so it can't be counted twice,
  // and the server records the friends ledger for both sides of every pair
  // (settle_home_game_ledger). The game continues for everyone else.
  const stackCents = myP.chips || 0;
  if (amHost || me.id === 'demo') {
    if (myP.cashedOutCents == null) {
      myP.cashedOutCents = stackCents;
      myP.chips = 0;
    }
    myP.eliminated = true;
    myP.folded = true;
    myP.quitHand = G.handNumber;
    myP.broke = false;
    myP.lastAction = { type: 'quit', label: 'Quit' };
    if (me.id !== 'demo') {
      try { await syncGameState(); } catch(e) { /* still leave */ }
      await settleHomeGameLedger(currentGameId);
    }
  } else if (sb && currentGameId) {
    try {
      await postAction({
        game_id: currentGameId,
        player_id: me.id,
        action: 'quit_cashout',
        amount: stackCents,
        created_at: new Date().toISOString(),
      });
    } catch(e) { /* still leave */ }
  }
  goHome();
}

function openHandHistory() {
  const list = document.getElementById('hand-history-list');
  if (!list) return;
  const history = G?.handHistory || [];
  const events = G?.eventLog || [];

  if (!history.length && !events.length) {
    list.innerHTML = `<div style="color:var(--text-dim);font-style:italic;text-align:center;padding:20px 0">No hands played yet.</div>`;
  } else {
    // Build combined chronological view: hands + re-buy events
    const combined = [];
    history.forEach(h => combined.push({ type: 'hand', hand: h.hand, ...h }));
    events.forEach(e => combined.push({ type: 'event', ...e }));
    combined.sort((a, b) => (a.hand || 0) - (b.hand || 0));

    list.innerHTML = combined.reverse().map(item => {
      if (item.type === 'hand') {
        const variantName = (VARIANTS[item.variant] || VARIANTS.holdem).short;
        return `
          <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;
            background:var(--surface);border:1px solid var(--border);border-radius:6px;margin-bottom:4px">
            <div style="font-family:'Bebas Neue',sans-serif;color:var(--gold-pale);
              min-width:40px;text-align:center;letter-spacing:0.05em">#${item.hand}</div>
            <div style="flex:1;min-width:0">
              <div style="font-weight:600;font-size:0.85rem">${variantName}</div>
              <div style="font-size:0.7rem;color:var(--text-dim)">
                Dealer: ${item.dealerEmoji} ${item.dealerName}
              </div>
            </div>
          </div>`;
      } else if (item.kind === 'rebuy') {
        return `
          <div style="display:flex;align-items:center;gap:10px;padding:6px 12px;
            background:rgba(212,168,67,0.06);border-left:2px solid var(--gold);border-radius:4px;margin-bottom:4px">
            <div style="font-size:0.78rem;color:var(--gold-pale)">
              💵 ${item.playerName} re-bought $${(item.amount/100).toFixed(2)}${item.hand ? ' (after hand #' + item.hand + ')' : ''}
            </div>
          </div>`;
      }
      return '';
    }).join('');
  }

  document.getElementById('modal-hand-history').style.display = 'flex';
}
