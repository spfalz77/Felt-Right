// ════════════════════════════════════════════════════════════════════════════
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible') return;

  // If on home screen, refresh games list so user sees fresh invites/lobbies
  const homeScreen = document.getElementById('screen-home');
  if (homeScreen && homeScreen.classList.contains('active') && me && me.id !== 'demo') {
    loadGames();
    renderFriendsList();
  }

  if (!sb || !currentGameId || !G) return;

  try {
    // Pull latest state fresh from the DB — subscription may have missed events while hidden
    const { data } = await sb.from('games').select('state, host_id, status').eq('id', currentGameId).maybeSingle();
    if (!data?.state) return;

    // If host changed while we were away, update role
    if (isServerState(data.state)) {
      gameHostId = data.host_id; // server game: no table host
    } else if (data.host_id === me.id && !amHost) {
      amHost = true;
      startHostHeartbeat(currentGameId);
      hostListenForActions(currentGameId);
    } else if (data.host_id !== me.id && amHost) {
      amHost = false;
      stopHostHeartbeat();
    }

    // CRITICAL: host's local G has real hole cards. DB state is redacted.
    // Only overwrite G for guests. Host trusts their own in-memory state.
    if (!amHost) {
      G = data.state;
      if (G.handNumber > 0) {
        await fetchMyPrivateHand(currentGameId, G.handNumber);
      }
      applyMyPrivateHand();
    } else {
      // Host: check if my own cards are redacted (shouldn't happen but after page reload it might)
      const myP = G.players.find(p => p.id === me.id);
      if (myP && myP.hand?.length && myP.hand.every(c => c?.hidden)) {
        if (G.handNumber > 0) {
          await fetchMyPrivateHand(currentGameId, G.handNumber);
          applyMyPrivateHand();
        }
      }
    }
    renderGame();

    // Host re-checks turn enforcer
    if (amHost && G.actionIndex >= 0 && !G.paused) {
      startHostTurnEnforcer();
    }

    // Re-track presence to tell everyone we're back
    if (_presenceChannel) {
      try {
        await _presenceChannel.track({ online_at: new Date().toISOString() });
      } catch(e) { /* silent */ }
    }

    // If it's my turn and timer isn't running, restart with correct remaining time from G.turnStartAt
    if (isMyTurn() && !G.paused && !_timerInterval) {
      startTurnTimer(30);
    }
  } catch(e) { console.warn('visibility resume:', e); }
});
