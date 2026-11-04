// ════════════════════════════════════════════════════════════════════════════
// 3-CARD GUTS — DECISION + REVEAL
// ════════════════════════════════════════════════════════════════════════════
let _gutsTimerInterval = null;
let _gutsLastRenderKey = null;

function showGutsDecision() {
  if (!G || G.stage !== 'guts_decision') return;

  const eligible = G.players.filter(p => !p.eliminated && !p.broke);
  const decisions = G.gutsDecisions || {};
  const myDecision = decisions[me.id];
  const decidedCount = eligible.filter(p => decisions[p.id]).length;
  const totalCount = eligible.length;

  // Build a render key so we only fully re-render the action area when the
  // state changes (decisions, total, my choice). Timer just updates the seconds.
  const renderKey = `${myDecision||'_'}|${decidedCount}/${totalCount}|${G.gutsRollCount||0}`;
  const sliderRow = document.getElementById('bet-slider-row');
  const autoBar = document.getElementById('auto-action-bar');
  const actionBar = document.getElementById('action-bar');
  if (sliderRow) sliderRow.style.display = 'none';
  if (autoBar) autoBar.innerHTML = '';

  // Make sure any leftover overlay is hidden
  const overlay = document.getElementById('showdown-overlay');
  if (overlay && overlay.dataset.kind !== 'guts-reveal') overlay.style.display = 'none';

  if (!actionBar) return;

  if (_gutsLastRenderKey === renderKey) {
    // Just refresh the timer text without rebuilding
    updateGutsTimerOnly();
  } else {
    _gutsLastRenderKey = renderKey;
    const potStr = formatChipsCompact(G.pot || 0);
    const playerChips = eligible.map(p => {
      const choice = decisions[p.id];
      const isMe = p.id === me.id;
      const locked = !!choice;
      return `
        <div style="display:inline-flex;align-items:center;gap:4px;padding:3px 7px;
          background:${locked?'rgba(212,168,67,0.15)':'rgba(255,255,255,0.05)'};
          border-radius:10px;font-size:0.7rem;
          ${isMe?'outline:1px solid var(--gold)':''}">
          <span style="font-size:0.85rem">${p.emoji}</span>
          <span style="font-weight:${isMe?600:400}">${p.name}</span>
          ${locked ? '<span style="color:var(--gold);font-size:0.65rem">✓</span>' : ''}
        </div>`;
    }).join('');

    if (myDecision) {
      actionBar.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:8px">
          <div style="font-family:'Bebas Neue',sans-serif;font-size:1.1rem;
            color:${myDecision==='in'?'var(--gold)':'var(--text-dim)'};letter-spacing:0.1em">
            You chose: ${myDecision === 'in' ? '🔥 GUTS' : '👋 NO GUTS'}
          </div>
          <div style="font-size:0.72rem;color:var(--text-dim);margin-top:4px">
            Waiting for others… ${decidedCount}/${totalCount} decided
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;justify-content:center;margin-top:6px">${playerChips}</div>
          <div id="guts-timer-text" style="font-family:'Bebas Neue',sans-serif;
            color:var(--gold-pale);margin-top:6px;font-size:0.95rem">⏱ —</div>
        </div>`;
    } else {
      actionBar.innerHTML = `
        <div style="grid-column:1/-1;padding:6px 8px">
          <div style="text-align:center;font-size:0.7rem;color:var(--text-dim);margin-bottom:4px">
            POT: <strong style="color:var(--gold)">${potStr}</strong>
            ${G.gutsRollCount ? ' · Roll #' + (G.gutsRollCount+1) : ''}
            · In = match FULL pot on loss
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <button onclick="gutsDecide('out')" class="btn btn-ghost"
              style="padding:14px;font-family:'Bebas Neue',sans-serif;
                font-size:1rem;letter-spacing:0.1em">👋 No Guts</button>
            <button onclick="gutsDecide('in')" class="btn btn-primary"
              style="padding:14px;font-family:'Bebas Neue',sans-serif;
                font-size:1rem;letter-spacing:0.1em">🔥 Guts</button>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;justify-content:center;margin-top:6px">${playerChips}</div>
          <div id="guts-timer-text" style="font-family:'Bebas Neue',sans-serif;
            color:var(--gold-pale);text-align:center;margin-top:4px;font-size:0.9rem">⏱ —</div>
        </div>`;
    }
    updateGutsTimerOnly();
  }

  // Single tick interval — only manipulates the timer text element
  if (!_gutsTimerInterval) {
    _gutsTimerInterval = setInterval(() => {
      if (!G || G.stage !== 'guts_decision') {
        clearInterval(_gutsTimerInterval);
        _gutsTimerInterval = null;
        _gutsLastRenderKey = null;
        return;
      }
      // Apply auto-out for ME if expired
      const myD = G.gutsDecisions?.[me.id];
      if (!myD && Date.now() >= (G.gutsDeadlineMs || 0)) {
        gutsDecide('out');
        return;
      }
      updateGutsTimerOnly();
    }, 1000);
  }
}

function updateGutsTimerOnly() {
  const el = document.getElementById('guts-timer-text');
  if (!el || !G) return;
  const msLeft = Math.max(0, (G.gutsDeadlineMs || 0) - Date.now());
  const secLeft = Math.ceil(msLeft / 1000);
  el.style.color = secLeft < 5 ? 'var(--red-light)' : 'var(--gold-pale)';
  el.textContent = '⏱ ' + secLeft + 's';
}

function hideGutsDecision() {
  if (_gutsTimerInterval) { clearInterval(_gutsTimerInterval); _gutsTimerInterval = null; }
  _gutsLastRenderKey = null;
  // Don't blow away the whole action bar — renderGame will rebuild it
  const overlay = document.getElementById('showdown-overlay');
  if (overlay && overlay.dataset.kind === 'guts-decision') {
    overlay.style.display = 'none';
    overlay.dataset.kind = '';
  }
}

// Player declares "in" or "out"
function gutsDecide(choice) {
  if (!G || G.stage !== 'guts_decision') return;
  if (G.gutsDecisions?.[me.id]) return; // already chose, can't change
  const myPlayer = G.players.find(p => p.id === me.id);
  if (!myPlayer || myPlayer.eliminated || myPlayer.broke) return;

  if (amHost || me.id === 'demo') {
    applyGutsDecision(me.id, choice);
  } else {
    // Guest: submit via player_actions. action='guts_in' or 'guts_out'
    if (sb && currentGameId) {
      sb.from('player_actions').insert({
        game_id: currentGameId,
        player_id: me.id,
        action: choice === 'in' ? 'guts_in' : 'guts_out',
        amount: null,
        created_at: new Date().toISOString(),
      }).then(() => {});
    }
    // Optimistically update local UI
    if (!G.gutsDecisions) G.gutsDecisions = {};
    G.gutsDecisions[me.id] = choice;
    showGutsDecision();
  }
}

// Host-side: record a player's decision. When all eligible players have decided
// (or deadline passes), trigger reveal.
function applyGutsDecision(playerId, choice) {
  if (!G || G.stage !== 'guts_decision') return;
  if (!G.gutsDecisions) G.gutsDecisions = {};
  if (G.gutsDecisions[playerId]) return; // can't change
  G.gutsDecisions[playerId] = choice;

  const eligible = G.players.filter(p => !p.eliminated && !p.broke);
  const allDecided = eligible.every(p => G.gutsDecisions[p.id]);

  if (allDecided) {
    resolveGuts();
  } else {
    syncGameState();
    showGutsDecision();
  }
}

// Host-side: also schedule a deadline check so unanswered players auto-out
function gutsDeadlineCheck() {
  if (!G || G.stage !== 'guts_decision') return;
  if (Date.now() < (G.gutsDeadlineMs || 0)) return;
  const eligible = G.players.filter(p => !p.eliminated && !p.broke);
  let anyAutoOut = false;
  for (const p of eligible) {
    if (!G.gutsDecisions[p.id]) {
      G.gutsDecisions[p.id] = 'out';
      anyAutoOut = true;
    }
  }
  if (anyAutoOut) resolveGuts();
}

// Determine winner & apply scoring after everyone has decided.
function resolveGuts() {
  if (!G || G.stage !== 'guts_decision') return;
  const eligible = G.players.filter(p => !p.eliminated && !p.broke);
  const ins  = eligible.filter(p => G.gutsDecisions[p.id] === 'in');
  const vCfg = VARIANTS[G.variant];

  // Case A: NOBODY in — add another ante (= BB) from everyone, redeal, decide again
  if (ins.length === 0) {
    const blinds = getBlinds(getCurrentBlindLevel());
    postAntes(blinds.big);
    G.gutsDecisions = {};
    G.gutsRollCount = (G.gutsRollCount || 0) + 1;
    // Bump handNumber so all players' clients re-fetch their private cards
    G.handNumber = (G.handNumber || 0) + 1;
    G.deck = makeDeck();
    G.players.forEach(p => {
      if (!p.eliminated && !p.broke) {
        p.hand = [];
        for (let i = 0; i < 3; i++) p.hand.push(G.deck.pop());
      }
    });
    writeGutsPrivateHands();
    // Reload host's own private hand cache so own cards update visually
    const myP = G.players.find(p => p.id === me.id);
    if (myP && myP.hand?.length) {
      _myPrivateHand = { handNumber: G.handNumber, cards: myP.hand };
    }
    G.gutsDeadlineMs = Date.now() + ((vCfg.decisionTimerSec || 20) * 1000);
    syncGameState();
    renderGame();
    showGutsDecision();
    return;
  }

  // Case B: Exactly one IN — they win the pot uncontested. Progression ENDS.
  if (ins.length === 1) {
    const winner = ins[0];
    const winAmount = G.pot;
    winner.chips += winAmount;
    G.pot = 0;
    G.gutsResults = {
      winnerId: winner.id,
      winnerName: winner.name,
      winnerEmoji: winner.emoji,
      winAmount,
      losers: [],
      uncontested: true,
      progressionEnded: true,
    };
    G.stage = 'showdown';
    hideGutsDecision();
    syncGameState();
    showGutsReveal();
    return;
  }

  // Case C: Multiple INs — reveal, compare, best hand wins.
  // Losing INs each MATCH the FULL pot. Money goes into the NEXT round's pot.
  // Then the progression CONTINUES: everyone antes again, redeal, decide again.
  const handScores = ins.map(p => ({ p, score: evalBest3Card(p.hand) }));
  handScores.sort((a, b) => cmpScore(b.score, a.score));
  const winner = handScores[0].p;
  const losers = handScores.slice(1).map(h => h.p);

  const potBeforeMatch = G.pot;
  const matchFraction = vCfg.matchPotFraction || 1.0;
  const matchAmount = Math.round(potBeforeMatch * matchFraction);

  // Winner takes the current pot
  winner.chips += potBeforeMatch;
  G.pot = 0;

  // Losers each match — money goes into G.pot directly (seeds the NEXT round)
  let carryOver = 0;
  const loserPayments = [];
  for (const l of losers) {
    const owed = Math.min(matchAmount, l.chips);
    l.chips -= owed;
    if (l.chips <= 0) l.broke = true;
    carryOver += owed;
    loserPayments.push({ id: l.id, name: l.name, emoji: l.emoji, paid: owed, owedFull: matchAmount });
  }
  G.pot = carryOver; // carryover IS the new pot

  G.gutsResults = {
    winnerId: winner.id,
    winnerName: winner.name,
    winnerEmoji: winner.emoji,
    winAmount: potBeforeMatch,
    losers: loserPayments,
    handScores: handScores.map(h => ({
      id: h.p.id, name: h.p.name, emoji: h.p.emoji, hand: h.p.hand, score: h.score
    })),
    carryToNext: carryOver,
    uncontested: false,
    progressionEnded: false, // game continues with another round
  };
  G.stage = 'showdown';
  hideGutsDecision();
  syncGameState();
  showGutsReveal();
}

// Start the next round of the same progressive Guts hand:
// every eligible player antes again, dealer reshuffles + deals new cards,
// decision phase restarts. SAME DEALER stays — progression hasn't ended.
function continueGutsProgression() {
  if (!G || G.variant !== 'guts3') return;
  const vCfg = VARIANTS[G.variant];

  // Bump handNumber so guests treat this as a new deal and re-fetch private cards.
  // CRITICAL: do NOT set pendingDealerChoice — dealer stays as-is for the whole
  // progression. variant stays guts3.
  G.handNumber = (G.handNumber || 0) + 1;
  G.pendingDealerChoice = false;
  const blinds = getBlinds(getCurrentBlindLevel());
  postAntes(blinds.big); // ante always equals BB
  G.gutsDecisions = {};
  G.gutsRollCount = (G.gutsRollCount || 0) + 1;
  G.gutsResults = null;
  // Reshuffle and deal fresh hands
  G.deck = makeDeck();
  G.players.forEach(p => {
    if (!p.eliminated && !p.broke) {
      p.hand = [];
      for (let i = 0; i < 3; i++) p.hand.push(G.deck.pop());
    }
  });
  writeGutsPrivateHands();
  // Reload host's own private hand cache so own cards update visually
  const myP = G.players.find(p => p.id === me.id);
  if (myP && myP.hand?.length) {
    _myPrivateHand = { handNumber: G.handNumber, cards: myP.hand };
  }
  G.gutsDeadlineMs = Date.now() + ((vCfg.decisionTimerSec || 20) * 1000);
  G.stage = 'guts_decision';
  syncGameState();
  renderGame();
  showGutsDecision();

  // Reset the deadline checker
  if (window._gutsHostInterval) clearInterval(window._gutsHostInterval);
  if (amHost || me.id === 'demo') {
    window._gutsHostInterval = setInterval(() => {
      if (!G || G.stage !== 'guts_decision') {
        clearInterval(window._gutsHostInterval);
        window._gutsHostInterval = null;
        return;
      }
      gutsDeadlineCheck();
    }, 1000);
  }
}

function writeGutsPrivateHands() {
  if (!sb || !currentGameId || me.id === 'demo') return;
  const handNum = G.handNumber;
  const rows = G.players
    .filter(p => !p.eliminated && !p.broke && p.hand?.length)
    .map(p => ({ game_id: currentGameId, hand_number: handNum, player_id: p.id, cards: p.hand }));
  (async () => {
    try {
      await sb.from('private_hands').delete().eq('game_id', currentGameId).eq('hand_number', handNum);
      await sb.from('private_hands').insert(rows);
    } catch(e) { console.warn('guts private_hands:', e); }
  })();
}

function showGutsReveal() {
  const r = G.gutsResults;
  if (!r) return;
  const overlay = document.getElementById('showdown-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  overlay.dataset.kind = 'guts-reveal';

  const winnerLine = `
    <div style="font-family:'Bebas Neue',sans-serif;font-size:1.6rem;
      color:var(--gold);letter-spacing:0.1em;margin-bottom:4px">
      ${r.winnerEmoji} ${r.winnerName} WINS
    </div>
    <div style="color:var(--gold-pale);font-size:0.95rem;margin-bottom:14px">
      +${formatChipsCompact(r.winAmount)}
    </div>`;

  let bodyHtml = '';
  if (r.uncontested) {
    bodyHtml = `<div style="color:var(--text-dim);font-style:italic;font-size:0.85rem;margin-bottom:14px">
      Only player in — won uncontested
    </div>`;
  } else {
    const cardCols = (cards) => cards.map(c => {
      const red = isRed(c);
      return `<div class="card showdown-card ${red?'red':'black'}" style="display:inline-block;margin:0 2px">
        <div class="card-top"><div class="card-rank">${c.rank}</div><div class="card-suit">${c.suit}</div></div>
        <div class="card-center">${c.suit}</div>
        <div class="card-bot"><div class="card-rank">${c.rank}</div><div class="card-suit">${c.suit}</div></div>
      </div>`;
    }).join('');
    bodyHtml = (r.handScores || []).map(h => {
      const isWinner = h.id === r.winnerId;
      return `
        <div style="padding:8px 10px;margin-bottom:6px;border-radius:8px;
          background:${isWinner?'rgba(212,168,67,0.15)':'rgba(255,255,255,0.04)'};
          border:1px solid ${isWinner?'var(--gold)':'transparent'}">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
            <span>${h.emoji}</span>
            <span style="font-weight:600;font-size:0.85rem">${h.name}</span>
            <span style="margin-left:auto;font-family:'Bebas Neue',sans-serif;
              color:${isWinner?'var(--gold)':'var(--text-dim)'};font-size:0.85rem">${h.score?.name||'—'}</span>
          </div>
          <div>${cardCols(h.hand)}</div>
        </div>`;
    }).join('');

    if (r.losers && r.losers.length) {
      bodyHtml += `<div style="margin-top:8px;padding:8px 10px;background:rgba(231,76,60,0.08);
        border:1px solid rgba(231,76,60,0.3);border-radius:8px;font-size:0.78rem">
        <div style="color:var(--red-light);font-weight:600;margin-bottom:4px">Match full pot:</div>
        ${r.losers.map(l => `
          <div style="display:flex;justify-content:space-between;font-size:0.75rem;color:var(--text-dim)">
            <span>${l.emoji} ${l.name}</span>
            <span>−${formatChipsCompact(l.paid)}${l.paid < l.owedFull ? ' (short)' : ''}</span>
          </div>`).join('')}
      </div>`;
      if (r.carryToNext > 0) {
        bodyHtml += `<div style="margin-top:6px;font-size:0.75rem;color:var(--gold-pale);text-align:center">
          ${formatChipsCompact(r.carryToNext)} carries to next pot
        </div>`;
      }
    }
  }

  const nextLine = r.progressionEnded
    ? 'Progression complete · next hand in 6s'
    : 'Progression continues · ante up · next round in 6s';

  overlay.innerHTML = `
    <div class="showdown-bar" style="max-width:400px;max-height:80vh;overflow-y:auto">
      ${winnerLine}
      ${bodyHtml}
      <button class="btn btn-primary btn-sm" onclick="dismissShowdown()"
        style="margin-top:12px;min-width:140px">${r.progressionEnded ? 'Next Hand' : 'Continue'}</button>
      <div style="font-size:0.72rem;color:var(--text-dim);margin-top:4px">${nextLine}</div>
    </div>`;

  // Longer auto-deal window for Guts (9s) so guests have time to see reveal
  // before the next progression round starts. Anyone can hit "Got It" sooner.
  if (amHost || me.id === 'demo') scheduleAutoDeal(9000);
}

function postBlind(idx, amount) {
  const p = G.players[idx];
  const paid = Math.min(amount, p.chips);
  p.chips -= paid; p.bet += paid; p.totalBet += paid; G.pot += paid;
  if (p.chips === 0) p.allIn = true;
}

function nextActive(fromIdx) {
  const n = G.players.length;
  for (let i = 1; i < n; i++) {
    const idx = (fromIdx + i) % n;
    if (!G.players[idx].folded && !G.players[idx].eliminated && G.players[idx].chips > 0) return idx;
  }
  return fromIdx;
}

function isMyTurn() {
  if (G.actionIndex < 0) return false;
  const p = G.players[G.actionIndex];
  return p && p.id === me.id && !p.folded;
}

