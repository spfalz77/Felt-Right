// ── DEAL ─────────────────────────────────────────────────────────────────────
function dealNewHand() {
  const activePlayers = G.players.filter(p => !p.eliminated && p.chips > 0);
  if (activePlayers.length < 2) { endTournament(); return; }

  // SAFETY: if we're in the middle of a Guts progression, route to continuation
  // instead of starting a fresh hand.
  if (G.variant === 'guts3' && G.gutsResults && G.gutsResults.progressionEnded === false) {
    if (amHost || me.id === 'demo') continueGutsProgression();
    return;
  }

  // Starting a new hand: clear any leftover Guts result from a prior progression
  // so the guest stops trying to show the old reveal overlay.
  G.gutsResults = null;
  G.gutsDecisions = {};
  G.gutsRollCount = 0;
  G.stage = 'deal'; // neutral pre-deal stage

  // Home game: dealer picks variant before dealing.
  if (getFormatConfig().dealerChoiceVariant && !G.pendingDealerChoice) {
    rotateDealer();
    G.pendingDealerChoice = true;
    G.dealerChoiceDeadlineMs = Date.now() + DEALER_CHOICE_SECONDS * 1000;
    G.handNumber = (G.handNumber || 0) + 1;
    // Clear any leftover overlay before showing dealer choice
    const sd = document.getElementById('showdown-overlay');
    if (sd) { sd.style.display = 'none'; sd.dataset.kind = ''; }
    syncGameState();
    showDealerChoice();
    return;
  }

  proceedToDeal();
}

// Rotate the dealer to the next eligible player. Sets G.dealerId and player.isDealer.
function rotateDealer() {
  const eligible = G.players.filter(p => !p.eliminated && p.chips > 0);
  G.players.forEach(p => p.isDealer = false);
  let newDealerEligIdx;
  if (!G.dealerId || (G.handNumber || 0) === 0) {
    newDealerEligIdx = Math.floor(Math.random() * eligible.length);
  } else {
    const prevIdx = eligible.findIndex(p => p.id === G.dealerId);
    newDealerEligIdx = (prevIdx + 1) % eligible.length;
  }
  const dealer = eligible[newDealerEligIdx];
  dealer.isDealer = true;
  G.dealerId = dealer.id;
}

// Show variant picker to the dealer, banner to others, while dealer's choice is pending.
function showDealerChoice() {
  const dealerId = G.dealerId;
  const isDealer = dealerId === me.id || (me.id === 'demo' && amHost);
  const dealerPlayer = G.players.find(p => p.id === dealerId);
  const dealerName = dealerPlayer?.name || 'Dealer';
  const dealerEmoji = dealerPlayer?.emoji || '🃏';

  const overlay = document.getElementById('showdown-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  overlay.dataset.kind = 'dealer-choice';
  if (amHost) startDealerChoiceTimer();

  // The picker covers the table header, so the host's End button lives here too
  const hostEndBtn = amHost && me.id !== 'demo' && getFormatConfig().moneyMode ? `
        <button id="dc-endgame-btn" onclick="openCashOutModal()" style="background:none;border:none;
          color:var(--text-dim);font-size:0.78rem;text-decoration:underline;cursor:pointer;margin-top:10px">
          End game &amp; cash out</button>` : '';
  const autoNote = `
        <div style="font-size:0.7rem;color:var(--text-dim);margin-top:10px">
          No pick in ${DEALER_CHOICE_SECONDS}s → Hold'em is dealt</div>`;

  if (isDealer) {
    overlay.innerHTML = `
      <div class="showdown-bar" style="max-width:380px">
        <div style="font-family:'Bebas Neue',sans-serif;font-size:1.6rem;letter-spacing:0.1em;
          color:var(--gold);margin-bottom:6px">DEALER'S CHOICE</div>
        <div style="font-size:0.85rem;color:var(--text-dim);margin-bottom:14px">
          You're dealing. Pick the variant for this hand.
        </div>
        <div style="display:grid;grid-template-columns:1fr;gap:8px;width:100%">
          <button onclick="dealerPickedVariant('holdem')" class="format-btn"
            style="padding:14px 12px;cursor:pointer;text-align:left">
            <div style="font-family:'Bebas Neue',sans-serif;font-size:1.05rem;letter-spacing:0.08em">Hold'em</div>
            <div style="font-size:0.68rem;color:var(--text-dim);margin-top:2px">2 hole cards · standard betting</div>
          </button>
          <button onclick="dealerPickedVariant('omaha')" class="format-btn"
            style="padding:14px 12px;cursor:pointer;text-align:left">
            <div style="font-family:'Bebas Neue',sans-serif;font-size:1.05rem;letter-spacing:0.08em">Omaha</div>
            <div style="font-size:0.68rem;color:var(--text-dim);margin-top:2px">4 hole cards · use exactly 2</div>
          </button>
          <button onclick="dealerPickedVariant('guts3')" class="format-btn"
            style="padding:14px 12px;cursor:pointer;text-align:left">
            <div style="font-family:'Bebas Neue',sans-serif;font-size:1.05rem;letter-spacing:0.08em">3-Card Guts</div>
            <div style="font-size:0.68rem;color:var(--text-dim);margin-top:2px">In/out · match full pot · 10¢ ante</div>
          </button>
        </div>${autoNote}${hostEndBtn}
      </div>`;
  } else {
    overlay.innerHTML = `
      <div class="showdown-bar">
        <div style="font-family:'Bebas Neue',sans-serif;font-size:1.4rem;letter-spacing:0.1em;
          color:var(--gold);margin-bottom:6px">DEALER'S CHOICE</div>
        <div style="font-size:1.1rem;margin-bottom:8px">${dealerEmoji} ${dealerName}</div>
        <div style="font-size:0.85rem;color:var(--text-dim)">Choosing the variant…</div>${autoNote}${hostEndBtn}
      </div>`;
  }
}

// Host-only: if the dealer doesn't pick in time (stepped away, phone asleep),
// deal Hold'em so the table doesn't wait forever.
const DEALER_CHOICE_SECONDS = 25;
let _dealerChoiceTimer = null;

function stopDealerChoiceTimer() {
  clearInterval(_dealerChoiceTimer);
  _dealerChoiceTimer = null;
}

function startDealerChoiceTimer() {
  stopDealerChoiceTimer();
  if (!G) return;
  if (!G.dealerChoiceDeadlineMs) G.dealerChoiceDeadlineMs = Date.now() + DEALER_CHOICE_SECONDS * 1000;
  _dealerChoiceTimer = setInterval(() => {
    if (!G || !amHost || !G.pendingDealerChoice || G.tournamentOver || G.stage === 'finished') {
      stopDealerChoiceTimer(); return;
    }
    // Paused / on a break / cash-out sheet open: don't auto-deal; restart the clock
    const cashOutOpen = document.getElementById('modal-cashout')?.classList.contains('open');
    if (G.paused || G.breakActive || cashOutOpen) {
      G.dealerChoiceDeadlineMs = Date.now() + DEALER_CHOICE_SECONDS * 1000; return;
    }
    // Dealer's app is closed / offline: don't make the table wait the full time
    const dealer = G.players.find(p => p.id === G.dealerId);
    const dealerGone = dealer && dealer.id !== me.id && dealer.disconnected && !isPlayerOnline(dealer.id);
    const startedAt = G.dealerChoiceDeadlineMs - DEALER_CHOICE_SECONDS * 1000;
    const dueAt = dealerGone ? Math.min(G.dealerChoiceDeadlineMs, startedAt + DISCONNECTED_GRACE_MS) : G.dealerChoiceDeadlineMs;
    if (Date.now() < dueAt) return;
    stopDealerChoiceTimer();
    const dealerName = G.players.find(p => p.id === G.dealerId)?.name || 'Dealer';
    G.variant = 'holdem';
    G.pendingDealerChoice = false;
    const overlay = document.getElementById('showdown-overlay');
    if (overlay && overlay.dataset.kind === 'dealer-choice') { overlay.style.display = 'none'; overlay.dataset.kind = ''; }
    toast(`${dealerName} didn't pick — dealing Hold'em`);
    syncGameState();
    proceedToDeal();
  }, 1000);
}

// Called when dealer picks variant. Clears the pending flag and starts the deal.
function dealerPickedVariant(variant) {
  if (!G) return;
  if (G.dealerId !== me.id && !(me.id === 'demo' && amHost)) return;
  G.variant = variant;
  G.pendingDealerChoice = false;

  // Hide the variant picker overlay
  const overlay = document.getElementById('showdown-overlay');
  if (overlay) overlay.style.display = 'none';

  if (amHost || me.id === 'demo') {
    // Host can proceed directly
    syncGameState();
    proceedToDeal();
  } else {
    // Guest dealer: submit choice to host via player_actions.
    // Variant encoded in `amount`: 1=holdem, 2=omaha, 3=guts3 (target_id is a UUID column).
    const variantCode = { holdem: 1, omaha: 2, guts3: 3 }[variant] || 1;
    if (sb && currentGameId) {
      sb.from('player_actions').insert({
        game_id: currentGameId,
        player_id: me.id,
        action: 'pick_variant',
        amount: variantCode,
        created_at: new Date().toISOString(),
      }).then(({ error }) => {
        if (error) {
          toast('Could not submit variant choice');
          // Restore the picker so dealer can retry
          G.pendingDealerChoice = true;
          showDealerChoice();
        }
      });
    }
  }
}

function proceedToDeal() {
  const activePlayers = G.players.filter(p => !p.eliminated && p.chips > 0);

  // Stat tracking: commit any leftover hand stats from prior hand, reset for this hand
  commitHandStats();
  resetHandStats();
  // Mark "hand_played" if I'm an eligible non-eliminated player
  const myP = G.players.find(p => p.id === me.id);
  if (myP && !myP.eliminated && myP.chips > 0) {
    _statsThisHand.hand_played = true;
  }

  // Home games with dealer's choice already rotated the dealer + bumped handNumber
  // before showing the variant picker. Skip those steps here.
  const dealerChoiceFormat = getFormatConfig().dealerChoiceVariant;
  if (!dealerChoiceFormat) {
    G.handNumber++;
  }
  G.stage = 'preflop';
  G.community = [];
  G.pot = 0;
  G.deck = makeDeck();
  G.revealedHands = {};
  G.winnerMucked = false; // clear fold-win muck flag
  G.chopOfferedBy = null;
  _autoAction = null; // away mode resets each hand
  _animatedCards.clear();
  stopTurnTimer();
  const autoBar = document.getElementById('auto-action-bar');
  if (autoBar) autoBar.innerHTML = '';

  const blinds = getBlinds(getCurrentBlindLevel());

  // Reset players — totalBet tracks cumulative contribution this hand for side pot math
  G.players.forEach(p => {
    p.hand = []; p.bet = 0; p.totalBet = 0; p.folded = false;
    p.allIn = false; p.lastAction = null;
    if (p.eliminated || p.chips <= 0) p.folded = true;
  });

  // Compute eligible players list once (used for dealer rotation and seat positioning)
  const eligible = G.players.filter(p => !p.eliminated && p.chips > 0);

  if (!dealerChoiceFormat) {
    // Rotate dealer — if prev dealer busted, findIndex returns -1 → (0 % n) = next player
    G.players.forEach(p => p.isDealer = false);
    let newDealerEligIdx;
    if (G.handNumber === 1) {
      newDealerEligIdx = Math.floor(Math.random() * eligible.length);
    } else {
      const prevIdx = eligible.findIndex(p => p.id === G.dealerId);
      newDealerEligIdx = (prevIdx + 1) % eligible.length;
    }
    const dealer = eligible[newDealerEligIdx];
    dealer.isDealer = true;
    G.dealerId = dealer.id;
  }

  // Log this hand's variant + dealer in the event history (used by the history panel)
  if (!G.handHistory) G.handHistory = [];
  const dealerP = G.players.find(p => p.id === G.dealerId);
  G.handHistory.push({
    hand: G.handNumber,
    variant: G.variant || 'holdem',
    dealerName: dealerP?.name || '?',
    dealerEmoji: dealerP?.emoji || '🃏',
  });
  if (G.handHistory.length > 200) G.handHistory.shift();

  // Deal hole cards to each active player (2 for Hold'em, 4 for Omaha)
  const numHoleCards = (VARIANTS[G.variant] || VARIANTS.holdem).holeCards;
  for (const p of G.players) {
    if (!p.folded) {
      p.hand = [];
      for (let i = 0; i < numHoleCards; i++) p.hand.push(G.deck.pop());
    }
  }
  applyRiggedHand(numHoleCards);

  // Write each player's hole cards to private_hands BEFORE syncing state
  // So guests always find their cards waiting when they react to the hand number change
  if (sb && currentGameId && me.id !== 'demo') {
    const handNum = G.handNumber;
    const rows = G.players
      .filter(p => !p.folded && !p.eliminated && p.hand?.length)
      .map(p => ({
        game_id: currentGameId,
        hand_number: handNum,
        player_id: p.id,
        cards: p.hand,
      }));
    if (rows.length) {
      // Fire-and-forget: delete stale, insert fresh
      (async () => {
        try {
          await sb.from('private_hands').delete().eq('game_id', currentGameId).eq('hand_number', handNum);
          await sb.from('private_hands').insert(rows);
        } catch(e) { console.warn('private_hands write:', e); }
      })();
    }
  }

  // ── BRANCH ON VARIANT STYLE ──
  // Community games (Hold'em, Omaha): post blinds, enter preflop betting
  // Guts games: post ante, enter simultaneous decision phase (no betting rounds)
  const vCfg = VARIANTS[G.variant] || VARIANTS.holdem;
  if (vCfg.style === 'guts') {
    const anteAmount = blinds.big; // ante always equals the BB
    postAntes(anteAmount);
    G.stage = 'guts_decision';
    G.gutsDecisions = {};
    G.gutsResults = null;
    G.gutsRollCount = 0;
    G.gutsDeadlineMs = Date.now() + ((vCfg.decisionTimerSec || 20) * 1000);
    G.actionIndex = -1;
    renderGame();
    syncGameState();
    showGutsDecision();
    // Host-only: tick every second to enforce deadline (auto-out any non-deciders)
    if (amHost || me.id === 'demo') {
      if (window._gutsHostInterval) clearInterval(window._gutsHostInterval);
      window._gutsHostInterval = setInterval(() => {
        if (!G || G.stage !== 'guts_decision') {
          clearInterval(window._gutsHostInterval);
          window._gutsHostInterval = null;
          return;
        }
        gutsDeadlineCheck();
      }, 1000);
    }
    return;
  }

  // Post blinds — heads-up: dealer = SB
  G.currentBet = blinds.big;
  const dealerPos = G.players.findIndex(p => p.id === G.dealerId);
  let sbIdx, bbIdx;
  if (eligible.length === 2) {
    sbIdx = dealerPos;
    bbIdx = nextActive(dealerPos);
  } else {
    sbIdx = nextActive(dealerPos);
    bbIdx = nextActive(sbIdx);
  }

  G.dealerPos = dealerPos;
  G.sbIdx = sbIdx;
  G.bbIdx = bbIdx;

  postBlind(sbIdx, blinds.small);
  postBlind(bbIdx, blinds.big);
  G.players[sbIdx].lastAction = { type:'bet', label:`SB ${blinds.small}` };

  // Heads-up preflop: dealer/SB acts first
  G.actionIndex = eligible.length === 2 ? sbIdx : nextActive(bbIdx);

  renderGame();
  syncGameState(); // push new hand state to guests
  // Host backstop for the first turn of the hand too: if that player's phone
  // has dropped, fold/check them after the limit instead of waiting forever.
  if (amHost) startHostTurnEnforcer();
  if (!isMyTurn()) setTimeout(runCpuTurn, 1000);
}

function postAntes(anteCents) {
  G.currentBet = 0;
  // Carry-over from previous Guts hand (losers' match-pot money)
  if (G.gutsCarryPot) {
    G.pot = (G.pot || 0) + G.gutsCarryPot;
    G.gutsCarryPot = 0;
  }
  G.players.forEach(p => {
    if (p.folded || p.eliminated) return;
    const paid = Math.min(anteCents, p.chips);
    p.chips -= paid;
    p.totalBet += paid;
    G.pot += paid;
    if (p.chips === 0) { p.allIn = true; p.broke = true; }
  });
}


// ── Test hook (end-to-end tests only) ──────────────────────────────────────
// The app never sets window.__feltRightRiggedHands, so in normal play this
// returns immediately. Tests push { hands: { <player name>: [card, card] },
// board: [5 cards] } onto it on the host's screen; the next dealt hand then
// uses those hole cards and that board, so pot and side-pot payouts can be
// checked exactly. Cards are { rank, suit } like makeDeck() produces.
function applyRiggedHand(numHoleCards) {
  const queue = typeof window !== 'undefined' ? window.__feltRightRiggedHands : null;
  if (!Array.isArray(queue) || !queue.length) return;
  const rig = queue.shift();
  const key = (c) => c.rank + c.suit;
  const forced = new Set([...Object.values(rig.hands || {}).flat(), ...(rig.board || [])].map(key));
  const rest = makeDeck().filter((c) => !forced.has(key(c)));
  for (const p of G.players) {
    if (p.folded) continue;
    const h = rig.hands?.[p.name];
    p.hand = h ? h.map((c) => ({ ...c })) : Array.from({ length: numHoleCards }, () => rest.pop());
  }
  // Board cards are popped from the end of the deck, first card last
  G.deck = [...rest, ...[...(rig.board || [])].reverse().map((c) => ({ ...c }))];
}
