// ── SOUNDS: each one tied to what just appeared on screen ─────────────────────
// Compares the table now with the last one drawn:
//   new hand → shuffle, then a card for each of my hole cards
//   each bet/call/raise (mine or anyone's) → chips; each check → knock knock
//   (not for a player checked automatically because they're away)
//   each new board card → one card flip; hands turned over → a flip
//   the pot pushed to the winner → chips
// Server games number their moves (G.recentMoves), so a check that closes a
// street still knocks even though the next street clears everyone's label.
const SOUND_MOVE_GAP_MS = 180;
function playTableSounds() {
  const prev = _lastSoundState;
  _lastSoundState = G ? {
    pot: G.pot,
    community: G.community.length,
    handNumber: G.handNumber,
    stage: G.stage,
    moveSeq: G.moveSeq || 0,
    labels: Object.fromEntries((G.players || []).map((p) => [p.id, p.lastAction ? `${p.lastAction.type}:${p.lastAction.label}` : ''])),
  } : null;
  if (!G || !prev) return; // first look at this table: nothing "just happened"

  const newHand = G.handNumber !== prev.handNumber;
  let delay = 0;
  if (newHand) {
    playCardShuffleSound();
    const mine = (G.players.find((p) => p.id === me?.id)?.hand || []).length;
    setTimeout(() => playCardFlips(Math.min(mine || 2, 5), 160), 750);
    delay = 750;
  }

  // Bets and checks
  const soundFor = (type, label) => {
    if (type === 'check') return label === 'Away' ? null : playKnockSound;
    if (type === 'bet' || type === 'call' || type === 'raise' || type === 'allin') return playChipSound;
    return null;
  };
  if (Array.isArray(G.recentMoves) && G.moveSeq != null) {
    const fresh = G.recentMoves.filter((m) => m.seq > prev.moveSeq).slice(-3);
    fresh.forEach((m, i) => {
      const fn = soundFor(m.type, m.label);
      if (fn) setTimeout(fn, delay + i * SOUND_MOVE_GAP_MS);
    });
    if (fresh.length) delay += fresh.length * SOUND_MOVE_GAP_MS;
  } else if (!newHand) {
    // Phone-run games: go by each player's label
    let i = 0;
    for (const p of G.players) {
      const was = prev.labels[p.id] || '';
      const now = p.lastAction ? `${p.lastAction.type}:${p.lastAction.label}` : '';
      if (!now || now === was) continue;
      const fn = soundFor(p.lastAction.type, p.lastAction.label);
      if (fn) setTimeout(fn, delay + (i++) * SOUND_MOVE_GAP_MS);
    }
    if (G.pot > prev.pot && i === 0) playChipSound();
  }

  // New board cards: one flip per card
  const added = newHand ? G.community.length : G.community.length - prev.community;
  if (added > 0) setTimeout(() => playCardFlips(added), delay + 120);

  // All-in: hands turned face up
  if (G.stage === 'runout' && prev.stage !== 'runout') setTimeout(() => playCardFlips(2, 120), delay);

  // Showdown: hands turned over (unless everyone else folded), then the pot goes to the winner
  if (G.stage === 'showdown' && prev.stage !== 'showdown' && !newHand) {
    let at = delay + 250;
    if (!G.wonByFold && prev.stage !== 'runout') { setTimeout(playCardDealSound, at); at += 350; }
    setTimeout(playChipSound, at);
  }
}

// ── RENDER ───────────────────────────────────────────────────────────────────
function renderGame() {
  playTableSounds();

  // Handle pause state
  if (G?.paused) showPauseOverlay();
  else hidePauseOverlay();

  // Show chop proposal overlay if one is active
  if (G?.chopOfferedBy && !G.tournamentOver) {
    renderChopProposal();
  }

  // Show/hide host pause button (host only)
  const pauseBtn = document.getElementById('host-pause-btn');
  if (pauseBtn) {
    if (isTableHost() && !G?.paused) {
      pauseBtn.style.display = 'inline-block';
      if (G?.pauseQueued) {
        pauseBtn.textContent = '⏸ Pausing…';
        pauseBtn.onclick = cancelQueuedPause;
        pauseBtn.style.color = 'var(--gold-pale)';
        pauseBtn.style.borderColor = 'var(--gold)';
      } else {
        pauseBtn.textContent = '⏸ Pause';
        pauseBtn.onclick = pauseGame;
        pauseBtn.style.color = 'var(--gold)';
        pauseBtn.style.borderColor = 'var(--gold-dim)';
      }
    } else {
      pauseBtn.style.display = 'none';
    }
  }

  // Show/hide host End Home Game button (host only, home game format only)
  const endBtn = document.getElementById('host-endgame-btn');
  if (endBtn) {
    endBtn.style.display = (isTableHost() && !G?.paused && !G?.tournamentOver && getFormatConfig().moneyMode) ? 'inline-block' : 'none';
  }

  // History button is available to all players in home games
  const histBtn = document.getElementById('hand-history-btn');
  if (histBtn) {
    histBtn.style.display = (getFormatConfig().moneyMode && !G?.tournamentOver) ? 'inline-block' : 'none';
  }

  // Hide blind level timer in home games (blinds are fixed, no escalation)
  const blindRow = document.getElementById('blind-timer-row');
  if (blindRow) {
    blindRow.style.display = getFormatConfig().blindsEscalate ? 'flex' : 'none';
  }

  // Re-buy prompt: in any money game with a broke player, offer rebuy.
  // BUT suppress while a showdown overlay or other modal is showing so the player
  // can ack the result first. The rebuy will appear after they dismiss the result.
  const meBroke = G?.players?.find(p => p.id === me.id);
  // Re-buy applied (or I'm out): close the Out of Chips screen so it doesn't
  // cover my buttons on my next turn
  if (_rebuyOverlayShown && !(meBroke?.broke && !meBroke?.eliminated)) {
    _rebuyActionPending = false;
    closeRebuyOverlay();
  }
  if (meBroke && meBroke.broke && !meBroke.eliminated &&
      (getFormatConfig().moneyMode || (G?.rebuysEnabled && !G?.rebuyWindowClosed))) {
    const elimOverlay = document.getElementById('elim-overlay');
    const showdownOverlay = document.getElementById('showdown-overlay');
    const showdownVisible = showdownOverlay && showdownOverlay.style.display !== 'none';
    if (elimOverlay && elimOverlay.style.display !== 'flex' && !showdownVisible) {
      showRebuyOverlay();
    } else if (showdownVisible && !_rebuyAutoDismissTimer) {
      // Give them a moment to see the result, then offer the re-buy (the host
      // is waiting on this decision; nothing else would prompt them)
      _rebuyAutoDismissTimer = setTimeout(() => {
        _rebuyAutoDismissTimer = null;
        const still = G?.players?.find(p => p.id === me.id);
        if (still?.broke && !still.eliminated) dismissShowdown();
      }, 4000);
    }
  }

  const blinds = getBlinds(getCurrentBlindLevel());
  document.getElementById('blind-info').innerHTML =
    `<span class="pos-badge sb" style="font-size:0.5rem;width:16px;height:16px">SB</span> ${formatChipsCompact(blinds.small)} &nbsp;` +
    `<span class="pos-badge bb" style="font-size:0.5rem;width:16px;height:16px">BB</span> ${formatChipsCompact(blinds.big)}`;
  document.getElementById('hand-num').textContent = `Hand #${G.handNumber}`;
  // Pot display — show side pots if any player is all-in
  const allInPlayers = G.players.filter(p => p.allIn && !p.eliminated);
  const result = G.stage === 'showdown' && G.lastResult && G.lastResult.hand === G.handNumber ? G.lastResult : null;
  if (result) {
    // The pot went to the winner(s): say so where the pot was
    const won = Object.entries(result.winnings || {}).filter(([, amt]) => amt > 0);
    const names = won.map(([id, amt]) => `${G.players.find((p) => p.id === id)?.name || '?'} +${formatChipsCompact(amt)}`);
    document.getElementById('pot-display').textContent = names.length ? `🏆 ${names.join(' · ')}` : 'POT: 0';
  } else if (allInPlayers.length > 0 && G.stage !== 'showdown') {
    const previewPots = buildSidePots(G.players);
    const potText = previewPots.length > 1
      ? previewPots.map((p, i) => `${i===0?'Main':'Side'}: ${formatChipsCompact(p.amount)}`).join(' · ')
      : `POT: ${formatChips(G.pot)}`;
    document.getElementById('pot-display').textContent = potText;
  } else {
    document.getElementById('pot-display').textContent = `POT: ${formatChips(G.pot)}`;
  }

  const vStyle = (VARIANTS[G.variant] || VARIANTS.holdem).style;
  const stages = vStyle === 'stud' ? { preflop:'2ND STREET', flop:'3RD STREET', turn:'4TH STREET', river:'5TH STREET', showdown:'SHOWDOWN' }
    : vStyle === 'draw' ? { preflop:'BEFORE THE DRAW', draw:'DRAW', river:'AFTER THE DRAW', showdown:'SHOWDOWN' }
    : { preflop:'PRE-FLOP', flop:'FLOP', turn:'TURN', river:'RIVER', showdown:'SHOWDOWN', discard:'DISCARD', runout:'ALL IN · RUNNING IT OUT' };
  const variantTag = ['omaha', 'pineapple', 'crazy_pineapple', 'draw5', 'stud5'].includes(G.variant) ? ' · ' + VARIANTS[G.variant].short : '';
  document.getElementById('stage-label').textContent = (stages[G.stage]||G.stage.toUpperCase()) + variantTag;

  // My hand
  const myPlayer = G.players.find(p => p.id === me.id);
  const myCards = document.getElementById('my-cards');
  myCards.innerHTML = '';
  // Apply variant class so 4-card Omaha gets compact cards
  myCards.className = 'my-cards' + (G.variant === 'omaha' ? ' omaha' : '') + ((myPlayer?.hand?.length || 0) >= 5 ? ' five' : '');
  if (myPlayer && myPlayer.hand.length) {
    myPlayer.hand.forEach((c,i) => {
      const el = makeCardEl(c, false, true, cardKey(c, 'hole'));
      myCards.appendChild(el);
    });
  }
  if (myPlayer) {
    document.getElementById('my-chips').textContent = formatChips(myPlayer.chips);
    const myBetChip = document.getElementById('my-bet-chip');
    if (myBetChip) {
      if (myPlayer.bet > 0) {
        myBetChip.style.display = 'inline-flex';
        document.getElementById('my-bet-amt').textContent = formatChipsCompact(myPlayer.bet);
      } else {
        myBetChip.style.display = 'none';
      }
    }
  }

  // Community cards
  const commEl = document.getElementById('community-cards');
  commEl.innerHTML = '';
  G.community.forEach((c,i) => {
    const el = makeCardEl(c, false, false, cardKey(c, 'comm'));
    commEl.appendChild(el);
  });

  // Show burn stack once flop is on the table (post-flop streets)
  const burnEl = document.getElementById('burn-stack');
  if (burnEl) {
    burnEl.style.display = G.community.length >= 3 ? 'flex' : 'none';
  }

  // Opponents ring
  const ring = document.getElementById('opponents-ring');
  ring.innerHTML = '';
  G.players.filter(p => p.id !== me.id).forEach(p => {
    const pIdx = G.players.indexOf(p);
    const isActive = G.actionIndex >= 0 && G.players[G.actionIndex]?.id === p.id;
    const div = document.createElement('div');
    div.className = 'player-seat' + (p.folded||p.eliminated?' folded':'') + (isActive?' active-turn':'');

    const revealedCards = G.revealedHands?.[p.id];
    const cardsHtml = (revealedCards || p.hand).length ? (revealedCards || p.hand).map(c => {
      const revealAtShowdown = (G.stage === 'showdown' || G.stage === 'runout') && !p.folded;
      const revealFromReveal = !!revealedCards; // folded player chose to show
      const faceUp = !!(c && c.up && !p.folded); // 5-card stud upcards
      const reveal = revealAtShowdown || revealFromReveal || faceUp;
      if (faceUp && !revealAtShowdown && !revealFromReveal && c.rank) {
        // Compact face-up card (a seat can show four of them)
        return `<div class="card sm stud-up ${isRed(c)?'red':'black'}"><div class="card-center">${c.rank}${c.suit}</div></div>`;
      }
      if (reveal && c && c.rank) {
        const red = isRed(c);
        // For player-chose-to-show reveals, render full card visual at showdown size
        // (38x54 instead of tiny 28x42 text-only)
        return `<div class="card showdown-card ${red?'red':'black'}">
          <div class="card-top"><div class="card-rank">${c.rank}</div><div class="card-suit">${c.suit}</div></div>
          <div class="card-center">${c.suit}</div>
          <div class="card-bot"><div class="card-rank">${c.rank}</div><div class="card-suit">${c.suit}</div></div>
        </div>`;
      } else {
        return `<div class="card sm back"></div>`;
      }
    }).join('') : '';

    const badges = positionBadges(pIdx);

    div.innerHTML = `
      <div class="hole-cards">${cardsHtml}</div>
      <div style="position:relative;display:inline-block">
        <div class="avatar sm nudge-avatar" data-player-id="${p.id}" data-player-name="${p.name}"
          style="cursor:pointer" title="Tap to nudge ${p.name}">${p.emoji||p.name[0]}</div>
        ${badges ? `<div style="position:absolute;bottom:-6px;right:-6px;display:flex;gap:2px">${badges}</div>` : ''}
      </div>
      <div class="name">${p.name}</div>
      <div class="chips-count">${formatChipsCompact(p.chips)}</div>
      ${p.bet > 0 ? `<div class="bet-chip-front" title="In front: ${p.bet}">
        <span class="chip-icon">●</span> ${formatChipsCompact(p.bet)}
      </div>` : ''}
      ${p.disconnected ? `<div class="action-bubble" style="color:var(--text-dim);font-size:0.6rem">📡 Away</div>`
        : p.allIn ? `<div class="action-bubble bet" style="background:rgba(231,76,60,0.25);color:#e74c3c;border:1px solid rgba(231,76,60,0.3)">All-In</div>`
        : p.lastAction ? `<div class="action-bubble ${p.lastAction.type}">${p.lastAction.label}</div>` : ''}
    `;
    // Wire the nudge handler
    const av = div.querySelector('.nudge-avatar');
    if (av) av.onclick = (e) => { e.stopPropagation(); nudgePlayer(p.id, p.name); };
    ring.appendChild(div);
  });

  // My position badges
  const myIdx = G.players.findIndex(p => p.id === me.id);
  const myBadgeEl = document.getElementById('my-pos-badges');
  if (myBadgeEl) myBadgeEl.innerHTML = positionBadges(myIdx);

  // A new betting round is on screen: clear any leftover result overlay from the
  // last hand (on guests it could stay up and cover the action buttons on
  // their turn, e.g. after a hand won by everyone else folding)
  // Server games: a result belongs to the showdown it came from. Once the
  // table has moved on (next deal, the dealer's pick) it must not sit on top
  // of the picker or the buttons, whether or not this player tapped Got It.
  const staleSd = document.getElementById('showdown-overlay');
  if (staleSd && staleSd.style.display !== 'none' && staleSd.dataset.kind === 'showdown'
      && (['preflop', 'flop', 'turn', 'river'].includes(G?.stage) || (isServerGame() && G?.stage !== 'showdown'))) {
    staleSd.style.display = 'none';
    staleSd.dataset.kind = '';
  }

  maybeShowMyElimination();

  // Action bar
  renderActionBar();

  // Timer lifecycle — runs for host and guest alike, gated by turn key
  if (G && !G.paused && canActNow()) {
    const thisTurnKey = `${G.handNumber || 0}:${G.actionIndex}:${G.stage}`;
    if (_timerForActionKey !== thisTurnKey) {
      startTurnTimer(30);
      _timerForActionKey = thisTurnKey;
      // Haptic feedback: it's my turn
      if (navigator.vibrate) {
        navigator.vibrate([60, 40, 60]); // short-pause-short pattern
      }
      // Browser notification if app is backgrounded
      pushTurnNotification();
      // Stats: detect 3-bet faced (preflop, currentBet exceeds BB)
      if (G.stage === 'preflop' && _statsThisHand) {
        const blinds = getBlinds(getCurrentBlindLevel());
        if (G.currentBet > blinds.big) _statsThisHand.three_bet_faced = true;
      }
      // Stats: track that we saw the river
      if (G.stage === 'river' && _statsThisHand) {
        _statsThisHand.saw_river = true;
      }
    }
  } else {
    if (_timerForActionKey !== null) {
      stopTurnTimer();
    }
  }
}

// ── POSITION BADGES ───────────────────────────────────────────────────────────
function positionBadges(playerIdx) {
  if (!G || G.dealerPos === undefined) return '';
  let badges = '';
  if (playerIdx === G.dealerPos) badges += `<span class="pos-badge dealer">D</span>`;
  if (playerIdx === G.sbIdx)     badges += `<span class="pos-badge sb">SB</span>`;
  if (playerIdx === G.bbIdx)     badges += `<span class="pos-badge bb">BB</span>`;
  return badges;
}

// Track which card keys have already been animated so we don't re-animate on every render
const _animatedCards = new Set();

function cardKey(card, context) { return `${context}:${card.rank}${card.suit}`; }

function makeCardEl(card, hidden, lg, animKey) {
  const el = document.createElement('div');
  // Card may be a redacted placeholder {hidden:true} with no rank/suit
  const isRedacted = !card || card.hidden || !card.rank;
  const red = isRedacted ? false : isRed(card);
  const shouldAnim = animKey && !_animatedCards.has(animKey);
  if (shouldAnim) _animatedCards.add(animKey);
  const showBack = hidden || isRedacted;
  el.className = `card ${shouldAnim ? 'deal-anim' : ''} ${showBack ? 'back' : (red ? 'red' : 'black')} ${lg ? 'lg' : ''}`;
  if (!showBack) {
    el.innerHTML = `
      <div class="card-top"><div class="card-rank">${card.rank}</div><div class="card-suit">${card.suit}</div></div>
      <div class="card-center">${card.suit}</div>
      <div class="card-bot"><div class="card-rank">${card.rank}</div><div class="card-suit">${card.suit}</div></div>`;
  }
  return el;
}

function renderActionBar() {
  const bar = document.getElementById('action-bar');
  const slider = document.getElementById('bet-slider-row');

  // 5-card draw: pick cards to throw away (managed by showDrawPicker)
  if (G.stage === 'draw') {
    if (slider) slider.style.display = 'none';
    showDrawPicker();
    return;
  }

  // Pineapple discard: pick a card (managed by showDiscardPicker)
  if (G.stage === 'discard') {
    if (slider) slider.style.display = 'none';
    showDiscardPicker();
    return;
  }

  // Guts decision stage uses its own action-bar content (managed by showGutsDecision)
  if (G.stage === 'guts_decision') {
    if (slider) slider.style.display = 'none';
    showGutsDecision();
    return;
  }

  const myPlayer = G.players.find(p => p.id === me.id);
  if (!myPlayer || myPlayer.eliminated) {
    bar.innerHTML = `<div class="waiting-msg" style="width:100%;padding:8px 0">Eliminated</div>`;
    slider.style.display = 'none';
    return;
  }

  const callAmt = Math.min(G.currentBet - myPlayer.bet, myPlayer.chips);
  const canCheck = G.currentBet === myPlayer.bet;
  const blinds = getBlinds(getCurrentBlindLevel());

  // Min raise: BB if no bet on the street, else 2x current bet
  let minRaiseTotal;
  if (G.currentBet === 0) {
    minRaiseTotal = blinds.big;
  } else {
    minRaiseTotal = G.currentBet * 2;
  }
  const minRaise = Math.min(snapTo5(minRaiseTotal), myPlayer.chips + myPlayer.bet);
  const maxBet = myPlayer.chips + myPlayer.bet;
  const canRaise = myPlayer.chips > 0 && (myPlayer.chips + myPlayer.bet) >= minRaise;

  // Quick buttons
  const twoBB     = Math.min(blinds.big * 2, maxBet);
  const threeBB   = Math.min(blinds.big * 3, maxBet);
  const potBet    = Math.min(snapTo5(G.pot + callAmt + myPlayer.bet), maxBet);
  const allInBet  = maxBet;

  // Quick buttons require the value to meet the legal minimum (2x current bet)
  // EXCEPT All In, which is always available
  const twoBBOk   = canRaise && twoBB   >= minRaise;
  const threeBBOk = canRaise && threeBB >= minRaise;
  const potOk     = canRaise && potBet  >= minRaise;
  const allInOk   = myPlayer.chips > 0; // always selectable

  const myTurn = canActNow();

  // ── SLIDER LOGIC ──
  // Slider is ALWAYS active so any player can prep a bet during others' turns.
  // - At the start of a NEW turn (or when minRaise increases due to a raise from
  //   someone else), reset the slider to minRaise — the lowest legal bet.
  // - Otherwise preserve player's previous slider position.
  const prevSlider = document.getElementById('bet-slider');
  const prevValue = prevSlider ? parseInt(prevSlider.value) : null;
  const turnKey = `${G.handNumber}:${G.stage}:${G.actionIndex}`;
  const newTurn = _sliderTurnKey !== turnKey;
  _sliderTurnKey = turnKey;

  let nextValue;
  if (prevValue === null || isNaN(prevValue)) {
    nextValue = minRaise;
  } else if (newTurn) {
    // New turn: reset to minRaise (the lowest legal bet)
    nextValue = minRaise;
  } else if (prevValue < minRaise) {
    // Auto-bump up to legal minimum (someone bet/raised in front of us)
    nextValue = minRaise;
  } else if (prevValue > maxBet) {
    nextValue = maxBet;
  } else {
    nextValue = prevValue;
  }

  if (canRaise) {
    slider.style.display = 'flex';
    const sl = document.getElementById('bet-slider');
    sl.min = minRaise;
    sl.max = maxBet;
    // Step depends on format: both tournament and home use 5-unit increments.
    // Home games are in cents, smallest chip denomination is 5¢.
    sl.step = 5;
    sl.value = nextValue;
    sl.disabled = false;
    updateBetLabel();
  } else {
    slider.style.display = 'none';
  }

  const activePlayers = G.players.filter(p => !p.folded && !p.eliminated && p.chips > 0);
  const isHeadsUp = activePlayers.length === 2;

  // Build the action bar.
  // ITEM 5: "Place Bet" button. Only enabled on my turn.
  const disabledAttr = myTurn ? '' : 'disabled';
  bar.innerHTML = `
    <button class="btn btn-danger" onclick="playerAction('fold')" ${disabledAttr}>Fold</button>
    ${canCheck
      ? `<button class="btn btn-surface" onclick="playerAction('check')" ${disabledAttr}>Check</button>`
      : `<button class="btn btn-surface" onclick="playerAction('call')" ${disabledAttr}>Call<br><span style="font-size:0.72rem;opacity:0.8">${formatChipsCompact(callAmt)}</span></button>`}
    <button class="btn btn-surface" onclick="playerAction('twobb')" ${twoBBOk && myTurn?'':'disabled'}
      style="color:var(--gold)">2× BB<br><span style="font-size:0.72rem;opacity:0.8">${formatChipsCompact(twoBB)}</span></button>
    <button class="btn btn-surface" onclick="playerAction('threebb')" ${threeBBOk && myTurn?'':'disabled'}
      style="color:var(--gold)">3× BB<br><span style="font-size:0.72rem;opacity:0.8">${formatChipsCompact(threeBB)}</span></button>
    <button class="btn btn-surface" onclick="playerAction('pot')" ${potOk && myTurn?'':'disabled'}
      style="color:var(--gold)">Pot<br><span style="font-size:0.72rem;opacity:0.8">${formatChipsCompact(potBet)}</span></button>
    <button class="btn btn-surface" onclick="playerAction('allin')" ${allInOk && myTurn?'':'disabled'}
      style="color:var(--red-light);font-weight:700">ALL IN<br><span style="font-size:0.72rem;opacity:0.8">${formatChipsCompact(allInBet)}</span></button>
    <button class="btn btn-primary btn-full" onclick="playerAction('raise')" ${!canRaise || !myTurn?'disabled':''}
      style="grid-column:1/-1">
      Place Bet · ${canRaise ? formatChipsCompact(nextValue) : '—'}
    </button>
    ${isHeadsUp && myTurn && getFormatConfig().chopAllowed ? `<button class="btn btn-surface btn-full" onclick="offerChopShortcut()"
      style="color:var(--gold-pale);margin-top:4px;font-size:0.8rem">🤝 Offer Chop</button>` : ''}
    ${!myTurn ? `<button onclick="leaveGameSitOut()" style="grid-column:1/-1;background:none;
      border:1px solid rgba(192,57,43,0.4);color:var(--red-light);font-size:0.72rem;
      padding:5px 10px;border-radius:var(--r-sm);cursor:pointer;margin-top:4px">
      Leave Game
    </button>` : ''}
  `;

  // Always render the Away toggle so player can prep going AFK
  renderAutoActionBar();
}

function setQuickBet(amount) {
  const sl = document.getElementById('bet-slider');
  if (!sl) return;
  sl.value = Math.max(parseInt(sl.min), Math.min(parseInt(sl.max), amount));
  updateBetLabel();
}

function snapTo5(n) { return Math.round(n / 5) * 5 || 5; }

function updateBetLabel() {
  const sl = document.getElementById('bet-slider');
  const lbl = document.getElementById('bet-amount-label');
  if (sl && lbl) lbl.textContent = formatChipsCompact(parseInt(sl.value) || 0);
  // Also update the Raise button label live
  const raiseBtn = document.querySelector('#action-bar .btn-primary');
  if (raiseBtn) {
    const amt = sl ? formatChipsCompact(parseInt(sl.value) || 0) : '';
    // Rebuild the label so live update keeps both the prefix and amount
    raiseBtn.innerHTML = `Place Bet · ${amt}`;
  }
}


// My turn AND a betting round is actually on screen. A guest whose screen is
// still on the deal / dealer's-choice stage must not get live buttons or a
// running turn timer (it would auto-fold them on a stale state).
function canActNow() {
  return isMyTurn() && ['preflop', 'flop', 'turn', 'river'].includes(G?.stage);
}

let _rebuyAutoDismissTimer = null;
