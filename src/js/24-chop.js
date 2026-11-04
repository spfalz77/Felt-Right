// ── CHOP ─────────────────────────────────────────────────────────────────────
// Show the proposing player a "waiting" view, show the recipient an Accept/Decline view
function renderChopProposal() {
  if (!G || !G.chopOfferedBy) return;
  const overlay = document.getElementById('showdown-overlay');
  overlay.style.display = 'flex';

  const proposer = G.players.find(p => p.id === G.chopOfferedBy);
  const activePlayers = G.players.filter(p => !p.eliminated && p.chips > 0);
  const iAmProposer = G.chopOfferedBy === me.id;

  if (iAmProposer) {
    // Proposer waits
    overlay.innerHTML = `
      <div class="showdown-bar" style="gap:10px">
        <div style="font-size:2rem">🤝</div>
        <div class="showdown-result" style="font-size:1.3rem;color:var(--gold-pale)">Chop Offered</div>
        <div style="font-size:0.85rem;color:var(--text-dim);text-align:center;line-height:1.5;max-width:280px">
          Waiting for the other player to accept or decline…
        </div>
        <button class="btn btn-ghost" onclick="cancelChopOffer()" style="margin-top:8px">
          Cancel Offer
        </button>
      </div>`;
  } else {
    // Recipient sees decision UI
    overlay.innerHTML = `
      <div class="showdown-bar" style="gap:10px">
        <div style="font-size:2rem">🤝</div>
        <div class="showdown-result" style="font-size:1.3rem;color:var(--gold-pale)">Chop Offer</div>
        <div style="font-size:0.85rem;color:var(--text-dim);text-align:center;line-height:1.5">
          ${proposer?.emoji || '🃏'} ${proposer?.name || 'Opponent'} offered to chop and end the game.
        </div>
        <div style="width:90%;max-width:300px">
          ${activePlayers.map(p => `
            <div style="display:flex;justify-content:space-between;align-items:center;
              padding:8px 12px;background:rgba(255,255,255,0.05);border-radius:8px;margin-bottom:6px">
              <div style="display:flex;align-items:center;gap:8px">
                <div class="avatar sm">${p.emoji||p.name[0]}</div>
                <div style="font-weight:500">${p.name}</div>
              </div>
              <div style="font-family:'Bebas Neue',sans-serif;color:var(--gold);font-size:1rem;letter-spacing:0.05em">
                ${p.chips.toLocaleString()} chips
              </div>
            </div>`).join('')}
        </div>
        <div style="display:flex;gap:10px;margin-top:4px">
          <button class="btn btn-ghost" onclick="declineChop()">Decline</button>
          <button class="btn btn-primary" onclick="acceptChop()">Accept Chop</button>
        </div>
      </div>`;
  }
}

function acceptChop() {
  if (!amHost && me.id !== 'demo') {
    // Guest accepts — submit, host finalizes
    if (sb && currentGameId) {
      sb.from('player_actions').insert({
        game_id: currentGameId,
        player_id: me.id,
        action: 'chop_accept',
        amount: null,
        created_at: new Date().toISOString(),
      }).then(() => {});
    }
    // Optimistic UI update so user sees feedback immediately
    document.getElementById('showdown-overlay').innerHTML = `
      <div class="showdown-bar" style="gap:10px">
        <div style="font-size:2rem">🤝</div>
        <div style="font-size:1rem;color:var(--text-dim)">Accepting chop…</div>
      </div>`;
    return;
  }

  // Host (or demo): finalize the chop
  finalizeChop();
}

function finalizeChop() {
  const overlay = document.getElementById('showdown-overlay');
  const activePlayers = G.players.filter(p => !p.eliminated && p.chips > 0);

  // Final placements — chip leader gets 1st
  const sorted = [...activePlayers].sort((a, b) => b.chips - a.chips);
  G.finalPlacements = sorted.map(p => ({ name: p.name, emoji: p.emoji, chips: p.chips }));
  G.tournamentOver = true;
  G.chopOfferedBy = null;

  if (amHost && sb && currentGameId) {
    syncGameState();
    sb.from('games').update({ status: 'finished' }).eq('id', currentGameId).then(() => {});
    sb.from('private_hands').delete().eq('game_id', currentGameId).then(() => {});
    // Chat history is preserved across the game's lifetime
  }

  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="showdown-bar" style="gap:10px">
      <div style="font-size:2.5rem">🤝</div>
      <div class="showdown-result win" style="font-size:1.6rem">Chop!</div>
      <div style="font-size:0.85rem;color:var(--text-dim);margin-bottom:6px">Game ended by agreement</div>
      <div style="width:90%;max-width:300px">
        ${sorted.map((p, i) => `
          <div style="display:flex;justify-content:space-between;align-items:center;
            padding:8px 12px;background:rgba(255,255,255,0.05);border-radius:8px;margin-bottom:6px;
            border:1px solid ${i===0?'var(--gold-dim)':'transparent'}">
            <div style="display:flex;align-items:center;gap:8px">
              <span>${['🥇','🥈'][i]||''}</span>
              <div class="avatar sm">${p.emoji||p.name[0]}</div>
              <div style="font-weight:500">${p.name}</div>
            </div>
            <div style="font-family:'Bebas Neue',sans-serif;color:var(--gold);font-size:1rem">
              ${p.chips.toLocaleString()}
            </div>
          </div>`).join('')}
      </div>
      <button class="btn btn-primary" onclick="goHome()" style="margin-top:6px">Done</button>
    </div>`;
}

function declineChop() {
  if (!amHost && me.id !== 'demo') {
    // Guest declines - submit, host clears
    if (sb && currentGameId) {
      sb.from('player_actions').insert({
        game_id: currentGameId,
        player_id: me.id,
        action: 'chop_decline',
        amount: null,
        created_at: new Date().toISOString(),
      }).then(() => {});
    }
    document.getElementById('showdown-overlay').style.display = 'none';
    toast('Chop declined');
    return;
  }

  // Host or demo
  G.chopOfferedBy = null;
  G.chopDeclined = true;
  document.getElementById('showdown-overlay').style.display = 'none';
  if (amHost) syncGameState();
  toast('Chop declined — keep playing');
}

function cancelChopOffer() {
  if (!amHost && me.id !== 'demo') {
    if (sb && currentGameId) {
      sb.from('player_actions').insert({
        game_id: currentGameId,
        player_id: me.id,
        action: 'chop_cancel',
        amount: null,
        created_at: new Date().toISOString(),
      }).then(() => {});
    }
    document.getElementById('showdown-overlay').style.display = 'none';
    return;
  }

  G.chopOfferedBy = null;
  document.getElementById('showdown-overlay').style.display = 'none';
  if (amHost) syncGameState();
}

// Legacy entry point used elsewhere — wraps the new flow
function offerChop(activePlayers) {
  offerChopShortcut();
}

