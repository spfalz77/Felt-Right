// ── PLAYER ACTIONS ───────────────────────────────────────────────────────────
function returnUncalledBets() {
  // After a betting round, if the highest bettor's bet wasn't matched by anyone
  // who's still in the hand, return the difference to them.
  if (!G) return;
  const inHand = G.players.filter(p => !p.folded && !p.eliminated);
  if (inHand.length < 2) return;
  // Find the player with the highest bet
  let highest = inHand[0];
  let secondHighest = 0;
  for (const p of inHand) {
    if (p.bet > highest.bet) {
      secondHighest = highest.bet;
      highest = p;
    } else if (p.bet > secondHighest && p.id !== highest.id) {
      secondHighest = p.bet;
    }
  }
  const overage = highest.bet - secondHighest;
  if (overage > 0) {
    // Return overage to the player
    highest.chips += overage;
    highest.bet = secondHighest;
    highest.totalBet -= overage;
    G.pot -= overage;
    if (highest.allIn && highest.chips > 0) {
      highest.allIn = false; // they're not actually all-in if we returned chips
    }
  }
}

function execRaise(raiseTotal, myPlayer) {
  // If there's an existing bet to match first, call it then raise on top
  const add = raiseTotal - myPlayer.bet;
  if (add > 0) {
    myPlayer.chips -= add; myPlayer.bet = raiseTotal; myPlayer.totalBet += add; G.pot += add;
  }
  if (myPlayer.chips === 0) myPlayer.allIn = true;
  G.currentBet = raiseTotal;
  myPlayer.lastAction = { type:'bet', label:`Raise ${raiseTotal}` };
  G.players.forEach(p => {
    if (p.id !== myPlayer.id && !p.folded && !p.eliminated && !p.allIn) p.lastAction = null;
  });
}

async function leaveGameSitOut() {
  if (!G || !currentGameId) return;
  if (!confirm('Leave the game? You will auto check/fold until you return. You can rejoin from the home screen while the game is still active.')) return;

  const myPlayer = G.players.find(p => p.id === me.id);
  if (myPlayer) {
    myPlayer.disconnected = true;
    myPlayer.sittingOut = true;
  }

  // Flag so auto-rejoin on refresh is skipped for this game
  try {
    const sitOutList = JSON.parse(localStorage.getItem('fr_sitout') || '[]');
    if (!sitOutList.includes(currentGameId)) {
      sitOutList.push(currentGameId);
      localStorage.setItem('fr_sitout', JSON.stringify(sitOutList));
    }
  } catch(e) { /* ignore */ }

  // If we're the host, sync our sit-out state so other players see it
  if (amHost) {
    syncGameState();
  } else {
    // Guest: submit a fold if mid-turn, then reload
    if (isMyTurn()) {
      await submitAction('fold', null);
    }
  }

  sessionStorage.setItem('fr_auto_restore', '1');
  setTimeout(() => { window.location.href = window.location.pathname; }, 400);
}

function playerAction(action) {
  stopTurnTimer();

  // ── STATS: track this player's actions ──
  if (_statsThisHand) {
    const isPreflop = G.stage === 'preflop';
    if (action === 'fold') {
      // If facing a 3-bet preflop, mark folded to 3-bet
      if (isPreflop && _statsThisHand.three_bet_faced) {
        _statsThisHand.three_bet_folded = true;
      }
      if (G.stage === 'river') _statsThisHand.river_folded = true;
    } else if (action === 'call') {
      _statsThisHand.calls_made++;
      // VPIP - voluntary money in pot (not just BB defense)
      if (isPreflop) _statsThisHand.voluntarily_in = true;
      if (G.stage === 'river') _statsThisHand.river_called = true;
    } else if (['raise','twobet','twobb','threebb','pot','allin'].includes(action)) {
      _statsThisHand.bets_made++;
      _statsThisHand.raises_made++;
      _statsThisHand.voluntarily_in = true;
      if (isPreflop) {
        _statsThisHand.pre_flop_raised = true;
        // Detect 3-bet: if currentBet > BB (someone already raised)
        const blinds = getBlinds(getCurrentBlindLevel());
        if (G.currentBet > blinds.big) {
          _statsThisHand.three_bet_made = true;
        }
      }
      if (action === 'allin') _statsThisHand.all_in_taken = true;
    }
  }

  // GUEST: submit to DB, host will process and broadcast new state
  if (!amHost && me.id !== 'demo' && sb) {
    const myPlayer = G.players.find(p => p.id === me.id);
    const callAmt = Math.min(G.currentBet - myPlayer.bet, myPlayer.chips);
    const blinds = getBlinds(getCurrentBlindLevel());
    const minRaiseTotal = G.currentBet === 0 ? blinds.big : G.currentBet * 2;
    const maxBet = myPlayer.chips + myPlayer.bet;

    let amount = null;
    if (action === 'raise') {
      amount = parseInt(document.getElementById('bet-slider').value);
    } else if (action === 'twobet') {
      amount = Math.min(G.currentBet * 2, maxBet);
    } else if (action === 'twobb') {
      amount = Math.min(blinds.big * 2, maxBet);
    } else if (action === 'threebb') {
      amount = Math.min(blinds.big * 3, maxBet);
    } else if (action === 'pot') {
      amount = Math.min(snapTo5(G.pot + callAmt + myPlayer.bet), maxBet);
    } else if (action === 'allin') {
      amount = maxBet;
    }
    if (amount !== null && action !== 'allin') {
      amount = Math.max(amount, minRaiseTotal);
    }
    document.getElementById('bet-slider-row').style.display = 'none';
    submitAction(action, amount);
    renderActionBar();
    return;
  }

  // HOST / DEMO: run locally
  const myPlayer = G.players.find(p => p.id === me.id);
  const callAmt = Math.min(G.currentBet - myPlayer.bet, myPlayer.chips);
  const blinds = getBlinds(getCurrentBlindLevel());
  const minRaiseTotal = G.currentBet === 0 ? blinds.big : G.currentBet * 2;

  if (action === 'fold') {
    myPlayer.folded = true;
    myPlayer.lastAction = { type:'fold', label:'Fold' };

  } else if (action === 'check') {
    myPlayer.lastAction = { type:'check', label:'Check' };

  } else if (action === 'call') {
    const amt = Math.min(G.currentBet - myPlayer.bet, myPlayer.chips);
    myPlayer.chips -= amt; myPlayer.bet += amt; myPlayer.totalBet += amt; G.pot += amt;
    if (myPlayer.chips === 0) myPlayer.allIn = true;
    myPlayer.lastAction = { type:'bet', label:`Call ${amt}` };

  } else if (action === 'raise') {
    const raiseTotal = parseInt(document.getElementById('bet-slider').value);
    execRaise(Math.min(raiseTotal, myPlayer.chips + myPlayer.bet), myPlayer);

  } else if (action === 'twobet') {
    const target = Math.min(G.currentBet * 2, myPlayer.chips + myPlayer.bet);
    execRaise(Math.max(target, minRaiseTotal), myPlayer);

  } else if (action === 'twobb') {
    const target = Math.min(blinds.big * 2, myPlayer.chips + myPlayer.bet);
    execRaise(Math.max(target, minRaiseTotal), myPlayer);

  } else if (action === 'threebb') {
    const target = Math.min(blinds.big * 3, myPlayer.chips + myPlayer.bet);
    execRaise(Math.max(target, minRaiseTotal), myPlayer);

  } else if (action === 'pot') {
    const potTotal = Math.min(snapTo5(G.pot + callAmt + myPlayer.bet), myPlayer.chips + myPlayer.bet);
    execRaise(Math.max(potTotal, minRaiseTotal), myPlayer);

  } else if (action === 'allin') {
    execRaise(myPlayer.chips + myPlayer.bet, myPlayer);
  }

  document.getElementById('bet-slider-row').style.display = 'none';
  renderGame();
  advanceAction(); // advanceAction will sync the final state
}

