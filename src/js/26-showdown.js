// ── SHOWDOWN ─────────────────────────────────────────────────────────────────
function doShowdown() {
  // Pay out each hand once. Payouts are computed from what everyone bet
  // (totalBet), not from G.pot, so a second call would pay the winners again
  // and create chips. Several paths can schedule it (all-in run-out, last
  // street, timers), so guard here.
  if (G.paidOutHand === G.handNumber) return;
  G.paidOutHand = G.handNumber;
  G.stage = 'showdown';
  G.actionIndex = -1;
  stopTurnTimer();

  const active = G.players.filter(p => !p.folded && !p.eliminated);
  const myPlayer = G.players.find(p => p.id === me.id);

  // ── FOLD WIN: everyone else folded ──
  if (active.length === 1) {
    const winner = active[0];
    const winAmt = G.pot;
    winner.chips += winAmt;
    G.pot = 0;

    // Stats tracking
    if (_statsThisHand) {
      _statsThisHand.pot_at_end = winAmt;
      if (winner.id === me.id) {
        _statsThisHand.won_hand = true;
        _statsThisHand.won_amount = winAmt;
        if (_statsThisHand.all_in_taken) _statsThisHand.won_all_in = true;
      } else {
        if (_statsThisHand.all_in_taken) _statsThisHand.won_all_in = false;
      }
    }

    let newElim = false;
    const isHomeGame = getFormatConfig().moneyMode;
    G.players.forEach(p => {
      if (!p.eliminated && p.chips <= 0) {
        const tournamentRebuyOpen = !isHomeGame && G.rebuysEnabled && !G.rebuyWindowClosed;
        // A player who quit (tournament step-away) can't answer a rebuy offer: they're out
        if ((isHomeGame || tournamentRebuyOpen) && !p.awayFromTable) {
          // Player can re-buy. Mark broke (not eliminated) so overlay offers rebuy.
          p.broke = true;
        } else {
          p.eliminated = true;
          G.finalPlacements.unshift({ name: p.name, emoji: p.emoji });
          newElim = true;
        }
      }
    });
    if (newElim) G.chopOffered = false;

    renderGame();
    const iWon = winner.id === me.id;
    if (iWon && myPlayer?.hand?.length) {
      showMuckOrShow(winner, winAmt);
    } else {
      // Non-winner overlay: show winner info, offer show-your-cards if I folded but still have hand
      const myFolded = myPlayer && myPlayer.folded && myPlayer.hand?.length;
      const overlay = document.getElementById('showdown-overlay');
      overlay.style.display = 'flex';
      overlay.innerHTML = `
        <div class="showdown-bar">
          <div class="avatar" style="font-size:1.4rem">${winner.emoji}</div>
          <div class="showdown-result ${iWon?'win':'lose'}">${winner.name} Wins</div>
          <div class="showdown-hand" style="color:var(--text-dim)">Everyone else folded</div>
          <div class="winner-pot">+${formatChipsCompact(winAmt)}${getFormatConfig().moneyMode?'':' chips'}</div>
          ${myFolded ? `<button class="btn btn-ghost btn-sm" onclick="showMyFoldedCards()" style="margin-top:6px">Show My Cards</button>` : ''}
          <button class="btn btn-primary btn-sm" onclick="dismissShowdown()"
            style="margin-top:8px;min-width:140px">Got It</button>
          <div style="font-size:0.7rem;color:var(--text-dim);margin-top:6px">Next hand in 6s…</div>
        </div>`;
    }
    syncGameState();
    // Auto-advance after 6 seconds (host schedules, guests follow via state)
    if (amHost) scheduleAutoDeal(6000);
    commitHandStats();
    return;
  }

  // ── TRUE SHOWDOWN with side pots ──
  // Build side pots from totalBet contributions
  const sidePots = buildSidePots(G.players);

  // Evaluate each active player's best hand
  const handMap = {};
  active.forEach(p => {
    if (p.hand.length) handMap[p.id] = evalBest(p.hand, G.community, G.variant);
  });

  // Results accumulator: how much each player wins
  const winnings = {};
  G.players.forEach(p => winnings[p.id] = 0);

  const potResults = []; // for display

  for (const pot of sidePots) {
    if (pot.amount <= 0) continue;
    const contenders = pot.eligible.filter(p => handMap[p.id]);
    if (!contenders.length) {
      // All eligible folded — give to the last remaining active player
      const fallback = active[0];
      if (fallback) { winnings[fallback.id] += pot.amount; }
      continue;
    }

    contenders.sort((a, b) => cmpScore(handMap[b.id], handMap[a.id]));
    const bestHand = handMap[contenders[0].id];
    const winners = contenders.filter(c => cmpScore(handMap[c.id], bestHand) === 0);

    const share = Math.floor(pot.amount / winners.length);
    const remainder = pot.amount - share * winners.length;
    winners.forEach((w, i) => { winnings[w.id] += share + (i === 0 ? remainder : 0); });

    potResults.push({
      amount: pot.amount,
      winners,
      bestHandName: bestHand.name,
      isSide: sidePots.indexOf(pot) > 0,
    });
  }

  // Apply winnings
  G.players.forEach(p => { p.chips += winnings[p.id]; });
  const totalPotAmt = sidePots.reduce((s, p) => s + p.amount, 0);
  G.pot = 0;

  // ── STATS at showdown ──
  if (_statsThisHand) {
    _statsThisHand.went_to_showdown = true;
    _statsThisHand.pot_at_end = totalPotAmt;
    const myWinning = winnings[me.id] || 0;
    if (myWinning > 0) {
      _statsThisHand.won_hand = true;
      _statsThisHand.won_at_showdown = true;
      _statsThisHand.won_amount = myWinning;
      if (_statsThisHand.all_in_taken) _statsThisHand.won_all_in = true;
    } else if (handMap[me.id]) {
      // I went to showdown but lost
      _statsThisHand.lost_amount = totalPotAmt;
      if (_statsThisHand.all_in_taken) _statsThisHand.won_all_in = false;
      // Bad beat: I held a strong hand (full house+) but lost
      const myHand = handMap[me.id];
      if (myHand && myHand.rank >= 7) {
        _statsThisHand.is_bad_beat_loser = true;
      }
    }
    // Best hand I made (whether I won or not)
    if (handMap[me.id]) {
      const r = handMap[me.id].rank;
      _statsThisHand.final_hand_rank = r;
      _statsThisHand.final_hand_label = HAND_RANK_LABELS[r] || handMap[me.id].name;
    }
  }

  // Mark busted players (home: broke + can re-buy; tournament: eliminated)
  let newElimSD = false;
  const isHomeGameSD = getFormatConfig().moneyMode;
  G.players.forEach(p => {
    if (!p.eliminated && p.chips <= 0) {
      const tournamentRebuyOpen = !isHomeGameSD && G.rebuysEnabled && !G.rebuyWindowClosed;
      if ((isHomeGameSD || tournamentRebuyOpen) && !p.awayFromTable) {
        p.broke = true;
      } else {
        p.eliminated = true;
        G.finalPlacements.unshift({ name: p.name, emoji: p.emoji });
        newElimSD = true;
      }
    }
  });
  if (newElimSD) G.chopOffered = false;

  renderGame();

  // ── Build showdown display ──
  // All players who went to showdown, sorted best hand first
  const showPlayers = active.filter(p => handMap[p.id])
    .sort((a, b) => cmpScore(handMap[b.id], handMap[a.id]));

  const totalWon = (id) => winnings[id] || 0;
  const isWinner = (p) => winnings[p.id] > 0;

  const overlay = document.getElementById('showdown-overlay');
  overlay.style.display = 'flex';

  const potSummary = sidePots.length > 1
    ? `<div style="font-size:0.7rem;color:var(--text-dim);margin-bottom:8px;text-align:center">
        ${sidePots.map((p, i) => `${i === 0 ? 'Main' : `Side ${i}`}: ${p.amount}`).join(' · ')}
       </div>`
    : '';

  overlay.innerHTML = `
    <div class="showdown-bar" style="max-width:90%;width:100%">
      <div style="font-size:0.78rem;letter-spacing:0.18em;text-transform:uppercase;color:var(--gold-pale);margin-bottom:6px">Showdown</div>
      ${potSummary}
      ${showPlayers.map(p => {
        const won = totalWon(p.id);
        const hand = handMap[p.id];
        const usedHole = new Set(hand?.usedHoleIdx || []);
        const usedComm = new Set(hand?.usedCommIdx || []);

        // Render hole cards: dim ones NOT used in the winning combination
        const holeCardEls = p.hand.map((c, i) => {
          const red = isRed(c);
          const used = usedHole.has(i);
          return `<div class="card showdown-card ${red?'red':'black'}" style="opacity:${used?'1':'0.3'};
            ${used && won>0?'box-shadow:0 0 0 1.5px var(--gold);':''}">
            <div class="card-top"><div class="card-rank">${c.rank}</div><div class="card-suit">${c.suit}</div></div>
            <div class="card-center">${c.suit}</div>
            <div class="card-bot"><div class="card-rank">${c.rank}</div><div class="card-suit">${c.suit}</div></div>
          </div>`;
        }).join('');

        // Render community cards used (dim un-used ones)
        const commCardEls = G.community.map((c, i) => {
          const red = isRed(c);
          const used = usedComm.has(i);
          return `<div class="card showdown-card ${red?'red':'black'}" style="opacity:${used?'1':'0.25'};
            ${used && won>0?'box-shadow:0 0 0 1.5px var(--gold);':''}">
            <div class="card-top"><div class="card-rank">${c.rank}</div><div class="card-suit">${c.suit}</div></div>
            <div class="card-center">${c.suit}</div>
            <div class="card-bot"><div class="card-rank">${c.rank}</div><div class="card-suit">${c.suit}</div></div>
          </div>`;
        }).join('');

        return `
        <div style="display:flex;flex-direction:column;gap:6px;padding:10px 12px;
          background:${won>0?'rgba(212,168,67,0.18)':'rgba(255,255,255,0.04)'};
          border:1.5px solid ${won>0?'var(--gold)':'transparent'};
          border-radius:10px;width:100%;max-width:340px;margin-bottom:6px">
          <div style="display:flex;align-items:center;gap:8px">
            <div class="avatar sm">${p.emoji||p.name[0]}</div>
            <div style="font-weight:600;font-size:0.88rem;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.name}</div>
            ${won > 0 ? `<div style="display:flex;flex-direction:column;align-items:flex-end;gap:1px">
              <span style="font-family:'Bebas Neue',sans-serif;color:var(--gold);font-size:1.25rem;line-height:1">+${formatChipsCompact(won)}</span>
              <span style="font-size:0.55rem;color:var(--gold-dim);letter-spacing:0.1em;text-transform:uppercase">chips</span>
            </div>` : ''}
          </div>
          <div style="font-family:'Bebas Neue',sans-serif;color:${won>0?'var(--gold-pale)':'var(--text)'};
            font-size:1rem;letter-spacing:0.08em">${hand.name}</div>
          <div>
            <div style="font-size:0.6rem;color:var(--text-dim);letter-spacing:0.1em;
              text-transform:uppercase;margin-bottom:3px">Hole</div>
            <div style="display:flex;gap:4px">${holeCardEls}</div>
          </div>
          <div>
            <div style="font-size:0.6rem;color:var(--text-dim);letter-spacing:0.1em;
              text-transform:uppercase;margin-bottom:3px">Board</div>
            <div style="display:flex;gap:4px">${commCardEls}</div>
          </div>
        </div>`;
      }).join('')}
      <button class="btn btn-primary btn-sm" onclick="dismissShowdown()"
        style="margin-top:8px;min-width:160px">Got It</button>
      <div style="font-size:0.72rem;color:var(--text-dim);margin-top:4px">Next hand in 6s…</div>
    </div>`;

  syncGameState();
  if (amHost) scheduleAutoDeal(6000);
  commitHandStats();
}

// ── GUEST-SIDE SHOWDOWN OVERLAY ──────────────────────────────────────────────
// When a guest receives a state update with stage='showdown' and multiple players
// still in, we rebuild the showdown overlay locally from the synced state.
// The host already pushed revealed cards in the state (redactForSync exposes
// all non-folded hands at showdown).
function guestShowShowdown(prevMyChips) {
  if (!G || G.stage !== 'showdown') return;
  const overlay = document.getElementById('showdown-overlay');
  if (!overlay) return;

  const sidePots = []; // we don't have side pot detail in state, just total pot delta
  const active = G.players.filter(p => !p.folded && !p.eliminated);
  // Evaluate everyone's best hand from the synced cards
  const handMap = {};
  active.forEach(p => {
    if (p.hand?.length && !p.hand.some(c => c.hidden)) {
      handMap[p.id] = evalBest(p.hand, G.community, G.variant);
    }
  });
  // Sort by hand strength
  const showPlayers = active.filter(p => handMap[p.id])
    .sort((a, b) => cmpScore(handMap[b.id], handMap[a.id]));

  // Determine winners (highest tied score)
  const bestScore = showPlayers.length ? handMap[showPlayers[0].id] : null;
  const isWinnerFn = (p) => bestScore && cmpScore(handMap[p.id], bestScore) === 0;

  overlay.style.display = 'flex';
  overlay.dataset.kind = 'showdown';

  overlay.innerHTML = `
    <div class="showdown-bar" style="max-width:90%;width:100%">
      <div style="font-size:0.78rem;letter-spacing:0.18em;text-transform:uppercase;
        color:var(--gold-pale);margin-bottom:6px">Showdown</div>
      ${showPlayers.map(p => {
        const hand = handMap[p.id];
        const isWin = isWinnerFn(p);
        const usedHole = new Set(hand?.usedHoleIdx || []);
        const usedComm = new Set(hand?.usedCommIdx || []);
        const holeCardEls = (p.hand || []).map((c, i) => {
          const red = isRed(c);
          const used = usedHole.has(i);
          return `<div class="card showdown-card ${red?'red':'black'}" style="opacity:${used?'1':'0.3'};
            ${used && isWin?'box-shadow:0 0 0 1.5px var(--gold);':''}">
            <div class="card-top"><div class="card-rank">${c.rank}</div><div class="card-suit">${c.suit}</div></div>
            <div class="card-center">${c.suit}</div>
            <div class="card-bot"><div class="card-rank">${c.rank}</div><div class="card-suit">${c.suit}</div></div>
          </div>`;
        }).join('');
        const commCardEls = (G.community || []).map((c, i) => {
          const red = isRed(c);
          const used = usedComm.has(i);
          return `<div class="card showdown-card ${red?'red':'black'}" style="opacity:${used?'1':'0.25'};
            ${used && isWin?'box-shadow:0 0 0 1.5px var(--gold);':''}">
            <div class="card-top"><div class="card-rank">${c.rank}</div><div class="card-suit">${c.suit}</div></div>
            <div class="card-center">${c.suit}</div>
            <div class="card-bot"><div class="card-rank">${c.rank}</div><div class="card-suit">${c.suit}</div></div>
          </div>`;
        }).join('');
        const isSplit = showPlayers.filter(isWinnerFn).length > 1;
        const myDelta = (p.id === me.id && prevMyChips != null) ? (p.chips || 0) - prevMyChips : null;
        const wonLabel = (isWin && myDelta != null && myDelta > 0)
          ? `<span style="font-family:'Bebas Neue',sans-serif;color:var(--gold);font-size:1.25rem">
              ${isSplit ? 'SPLIT ' : ''}+${formatChipsCompact(myDelta)}
            </span>`
          : (isWin ? `<span style="color:var(--gold);font-size:0.85rem">${isSplit ? 'SPLIT POT' : 'WINNER'}</span>` : '');
        return `
        <div style="display:flex;flex-direction:column;gap:6px;padding:10px 12px;
          background:${isWin?'rgba(212,168,67,0.18)':'rgba(255,255,255,0.04)'};
          border:1.5px solid ${isWin?'var(--gold)':'transparent'};
          border-radius:10px;width:100%;max-width:340px;margin-bottom:6px">
          <div style="display:flex;align-items:center;gap:8px">
            <div class="avatar sm">${p.emoji||p.name[0]}</div>
            <div style="font-weight:600;font-size:0.88rem;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.name}</div>
            ${wonLabel}
          </div>
          <div style="font-family:'Bebas Neue',sans-serif;color:${isWin?'var(--gold-pale)':'var(--text)'};
            font-size:1rem;letter-spacing:0.08em">${hand?.name || '—'}</div>
          <div>
            <div style="font-size:0.6rem;color:var(--text-dim);letter-spacing:0.1em;
              text-transform:uppercase;margin-bottom:3px">Hole</div>
            <div style="display:flex;gap:4px">${holeCardEls}</div>
          </div>
          <div>
            <div style="font-size:0.6rem;color:var(--text-dim);letter-spacing:0.1em;
              text-transform:uppercase;margin-bottom:3px">Board</div>
            <div style="display:flex;gap:4px">${commCardEls}</div>
          </div>
        </div>`;
      }).join('')}
      <button class="btn btn-primary btn-sm" onclick="dismissShowdown()"
        style="margin-top:8px;min-width:160px">Got It</button>
      <div style="font-size:0.72rem;color:var(--text-dim);margin-top:4px">Next hand in 6s…</div>
    </div>`;
}

// When everyone folded leaving a single winner who isn't me, show the result overlay.
// The winner's cards display state depends on what they chose:
//   - Not yet decided: "Waiting for winner to decide…" with face-down cards
//   - Showed cards: real card visuals from G.revealedHands
//   - Mucked (cleared from revealedHands or chose to muck): face-down "mucked" placeholder
function guestShowFoldWinOverlay(winner) {
  if (!G) return;
  const overlay = document.getElementById('showdown-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  overlay.dataset.kind = 'showdown';

  const revealed = G.revealedHands?.[winner.id] || null;
  const winnerHand = winner.hand || [];
  const isHoldEmStyle = (G.variant || 'holdem') !== 'guts3';
  const numCards = isHoldEmStyle ? (winnerHand.length || 2) : 3;

  // Build card visuals
  let cardsHtml = '';
  let statusMsg = '';
  if (revealed && revealed.length) {
    // Winner chose to show — render real cards
    cardsHtml = revealed.map(c => {
      const red = isRed(c);
      return `<div class="card showdown-card ${red?'red':'black'}" style="display:inline-block;margin:0 3px">
        <div class="card-top"><div class="card-rank">${c.rank}</div><div class="card-suit">${c.suit}</div></div>
        <div class="card-center">${c.suit}</div>
        <div class="card-bot"><div class="card-rank">${c.rank}</div><div class="card-suit">${c.suit}</div></div>
      </div>`;
    }).join('');
    statusMsg = '🎴 Cards revealed';
  } else if (G.winnerMucked) {
    // Winner explicitly mucked — face-down with mucked label
    for (let i = 0; i < numCards; i++) {
      cardsHtml += `<div class="card showdown-card" style="display:inline-block;margin:0 3px;
        background:linear-gradient(135deg,#2a1f0d,#1a1306);border:1px solid var(--gold-dim);
        opacity:0.5"></div>`;
    }
    statusMsg = '🙊 Mucked';
  } else {
    // Still waiting on winner's decision
    for (let i = 0; i < numCards; i++) {
      cardsHtml += `<div class="card showdown-card" style="display:inline-block;margin:0 3px;
        background:linear-gradient(135deg,#2a1f0d,#1a1306);border:1px solid var(--gold-dim)"></div>`;
    }
    statusMsg = 'Waiting on winner…';
  }

  const myP = G.players.find(p => p.id === me.id);
  const myFolded = myP && myP.folded && myP.hand?.length && !myP.hand.some(c => c.hidden);

  overlay.innerHTML = `
    <div class="showdown-bar">
      <div class="avatar" style="font-size:1.4rem">${winner.emoji}</div>
      <div class="showdown-result lose">${winner.name} Wins</div>
      <div class="showdown-hand" style="color:var(--text-dim)">Everyone else folded</div>
      <div style="margin:8px 0">${cardsHtml}</div>
      <div style="font-size:0.78rem;color:var(--gold-pale);margin-bottom:6px">${statusMsg}</div>
      ${myFolded ? `<button class="btn btn-ghost btn-sm" onclick="showMyFoldedCards()" style="margin-top:6px">Show My Cards</button>` : ''}
      <button class="btn btn-primary btn-sm" onclick="dismissShowdown()"
        style="margin-top:8px;min-width:140px">Got It</button>
      <div style="font-size:0.7rem;color:var(--text-dim);margin-top:6px">Next hand in 6s…</div>
    </div>`;
}

// ── MUCK OR SHOW ─────────────────────────────────────────────────────────────
function showMyFoldedCards() {
  if (!G) return;
  const myPlayer = G.players.find(p => p.id === me.id);
  if (!myPlayer?.hand?.length) return;
  if (!myPlayer.folded) return;

  // Mark cards revealed in shared state for everyone to see
  if (!G.revealedHands) G.revealedHands = {};
  G.revealedHands[me.id] = myPlayer.hand;

  toast('Cards revealed');

  if (amHost) {
    renderGame();
    syncGameState();
  } else if (sb && currentGameId) {
    // Guest: submit special reveal action so host picks it up
    sb.from('player_actions').insert({
      game_id: currentGameId,
      player_id: me.id,
      action: 'reveal',
      amount: null,
      created_at: new Date().toISOString(),
    }).then(() => {});
  }
  const btn = event?.target;
  if (btn) btn.style.display = 'none';
}

function showMuckOrShow(winner, winAmt) {
  const myPlayer = G.players.find(p => p.id === me.id);
  const handCards = myPlayer.hand || [];
  const variant = G.variant || 'holdem';
  const isOmaha = variant === 'omaha';

  const overlay = document.getElementById('showdown-overlay');
  overlay.style.display = 'flex';

  // Build large playing-card visuals for each hole card
  const cardEls = handCards.map((c, i) => {
    const red = isRed(c);
    return `
      <div onclick="toggleShowCard(${i})" id="show-card-${i}"
        class="card lg ${red?'red':'black'}"
        style="cursor:pointer;transition:all 0.18s;user-select:none;
          border:3px solid var(--border);box-sizing:content-box">
        <div class="card-top"><div class="card-rank">${c.rank}</div><div class="card-suit">${c.suit}</div></div>
        <div class="card-center">${c.suit}</div>
        <div class="card-bot"><div class="card-rank">${c.rank}</div><div class="card-suit">${c.suit}</div></div>
      </div>`;
  }).join('');

  overlay.innerHTML = `
    <div class="showdown-bar">
      <div class="showdown-result win" style="font-size:1.6rem">You Win!</div>
      <div class="winner-pot" style="margin-bottom:4px">+${formatChipsCompact(winAmt)}${getFormatConfig().moneyMode?'':' chips'} — everyone folded</div>
      <div style="font-size:0.85rem;color:var(--text-dim);margin-bottom:14px;text-align:center;line-height:1.4">
        Tap cards to ${isOmaha ? 'select which to reveal' : 'select which to show'}
      </div>
      <div style="display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap;justify-content:center;max-width:100%">
        ${cardEls}
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center">
        <button class="btn btn-primary btn-sm" onclick="showSelectedCards()" style="min-width:140px">Show Selected</button>
        <button class="btn btn-ghost btn-sm" onclick="muckFoldWin()" style="min-width:120px">Muck (Hide)</button>
      </div>
      <div style="font-size:0.72rem;color:var(--text-dim);margin-top:14px">Auto-deal in 6s</div>
    </div>`;

  // Track which cards are selected to show
  window._showCardSelection = handCards.map(() => false);
  scheduleAutoDeal(6000);
}

function toggleShowCard(idx) {
  if (!window._showCardSelection) return;
  window._showCardSelection[idx] = !window._showCardSelection[idx];
  const el = document.getElementById(`show-card-${idx}`);
  if (el) {
    const selected = window._showCardSelection[idx];
    el.style.borderColor = selected ? 'var(--gold)' : 'var(--border)';
    el.style.boxShadow = selected ? '0 0 0 3px rgba(212,168,67,0.35), 0 4px 14px rgba(0,0,0,0.4)' : '0 3px 10px rgba(0,0,0,0.5)';
    el.style.transform = selected ? 'translateY(-4px)' : 'none';
  }
}

// Winner explicitly chose to muck (not show cards). Sets a state flag so guests
// can update their fold-win overlay to show face-down "mucked" placeholders.
function muckFoldWin() {
  if (G) {
    G.winnerMucked = true;
    if (amHost) {
      syncGameState();
    } else if (sb && currentGameId && me.id !== 'demo') {
      // Guest winner: tell host via action so they can mark it in state
      sb.from('player_actions').insert({
        game_id: currentGameId,
        player_id: me.id,
        action: 'muck',
        amount: null,
        created_at: new Date().toISOString(),
      }).then(() => {});
    }
  }
  dismissShowdown();
}

function showSelectedCards() {
  const myPlayer = G.players.find(p => p.id === me.id);
  const sel = window._showCardSelection || [];
  const shown = (myPlayer?.hand || []).filter((_, i) => sel[i]);

  // Nothing selected = same as Muck. Just dismiss locally.
  if (!shown.length) {
    muckFoldWin();
    return;
  }

  // Publish reveal so all players see the chosen cards.
  if (!G.revealedHands) G.revealedHands = {};
  G.revealedHands[me.id] = shown;
  // Explicit show — clear any "mucked" flag that might be set
  G.winnerMucked = false;

  if (amHost) {
    renderGame();
    syncGameState();
  } else if (sb && currentGameId && me.id !== 'demo') {
    sb.from('player_actions').insert({
      game_id: currentGameId,
      player_id: me.id,
      action: 'reveal',
      amount: null,
      created_at: new Date().toISOString(),
    }).then(() => {});
  }

  // Update the muck/show overlay UI to confirm what was shown
  const overlay = document.getElementById('showdown-overlay');
  const bar = overlay?.querySelector('.showdown-bar');
  if (bar) {
    const cardPips = shown.map(c =>
      `<span style="font-size:1.4rem;font-weight:700;color:${isRed(c)?'var(--red)':'#eee'}">${c.rank}${c.suit}</span>`
    ).join('  ');
    bar.innerHTML = `
      <div class="showdown-result win" style="font-size:1.5rem">You Win!</div>
      <div style="font-size:1.4rem;margin:8px 0;letter-spacing:0.1em">${cardPips}</div>
      <div style="font-size:0.78rem;color:var(--text-dim);font-style:italic;margin-bottom:14px">
        Showing ${shown.length === 1 ? 'one card' : `${shown.length} cards`}
      </div>
      <button class="btn btn-primary btn-sm" onclick="dismissShowdown()" style="min-width:140px">Got It</button>
      <div style="font-size:0.72rem;color:var(--text-dim);margin-top:6px">Auto-deal in 6s…</div>`;
  }
}

