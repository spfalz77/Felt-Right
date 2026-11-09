// ── RENDER ───────────────────────────────────────────────────────────────────
function renderGame() {
  // ── SOUND triggers based on state changes ──
  if (G && _lastSoundState) {
    // Pot GREW = chip movement (someone bet/called/raised)
    if (G.pot > _lastSoundState.pot) playChipSound();
    // Pot SHRUNK to 0 = winner collected (also chip movement)
    else if (G.pot === 0 && _lastSoundState.pot > 0) playChipSound();
    // Community card count grew (flop/turn/river dealt)
    if (G.community.length > _lastSoundState.communityLen) playCardDealSound();
    // New hand started (handNumber incremented) — shuffle sound + small delay then deal sound
    if (G.handNumber > _lastSoundState.handNumber) {
      playCardShuffleSound();
      // Hole-card deal sound a moment after shuffle
      setTimeout(() => playCardDealSound(), 350);
    }
    // Stage transition into showdown — deal sound for revealed hands
    if (G.stage === 'showdown' && _lastSoundState.stage !== 'showdown') {
      playCardDealSound();
    }
  }
  _lastSoundState = G ? {
    pot: G.pot,
    communityLen: G.community.length,
    handNumber: G.handNumber,
    stage: G.stage,
  } : null;

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
    if (amHost && !G?.paused) {
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
    endBtn.style.display = (amHost && !G?.paused && !G?.tournamentOver && getFormatConfig().moneyMode) ? 'inline-block' : 'none';
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
  if (allInPlayers.length > 0 && G.stage !== 'showdown') {
    const previewPots = buildSidePots(G.players);
    const potText = previewPots.length > 1
      ? previewPots.map((p, i) => `${i===0?'Main':'Side'}: ${formatChipsCompact(p.amount)}`).join(' · ')
      : `POT: ${formatChips(G.pot)}`;
    document.getElementById('pot-display').textContent = potText;
  } else {
    document.getElementById('pot-display').textContent = `POT: ${formatChips(G.pot)}`;
  }

  const stages = { preflop:'PRE-FLOP', flop:'FLOP', turn:'TURN', river:'RIVER', showdown:'SHOWDOWN' };
  const variantTag = G.variant === 'omaha' ? ' · OMAHA' : '';
  document.getElementById('stage-label').textContent = (stages[G.stage]||G.stage.toUpperCase()) + variantTag;

  // My hand
  const myPlayer = G.players.find(p => p.id === me.id);
  const myCards = document.getElementById('my-cards');
  myCards.innerHTML = '';
  // Apply variant class so 4-card Omaha gets compact cards
  myCards.className = 'my-cards' + (G.variant === 'omaha' ? ' omaha' : '');
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
      const revealAtShowdown = G.stage === 'showdown' && !p.folded;
      const revealFromReveal = !!revealedCards; // folded player chose to show
      const reveal = revealAtShowdown || revealFromReveal;
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
  const staleSd = document.getElementById('showdown-overlay');
  if (staleSd && staleSd.style.display !== 'none' && staleSd.dataset.kind === 'showdown'
      && ['preflop', 'flop', 'turn', 'river'].includes(G?.stage)) {
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
