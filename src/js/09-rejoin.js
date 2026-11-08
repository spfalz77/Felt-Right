// ════════════════════════════════════════════════════════════════════════════
// REJOIN ACTIVE GAME
// ════════════════════════════════════════════════════════════════════════════
async function rejoinActiveGame(gameId, gameRef) {
  try {
    // Explicit rejoin clears sit-out + away flags for this game
    try {
      let sitOutList = JSON.parse(localStorage.getItem('fr_sitout') || '[]');
      sitOutList = sitOutList.filter(id => id !== gameId);
      localStorage.setItem('fr_sitout', JSON.stringify(sitOutList));
      localStorage.removeItem(`fr_away_${gameId}`);
    } catch(e) { /* ignore */ }

    const { data, error } = await sb.from('games').select('state,host_id,blind_config,buy_in_amount,game_format,game_variant').eq('id', gameId).single();
    if (error || !data?.state) { toast('Could not load game'); return; }

    amHost = data.host_id === me.id;
    if (data.blind_config) {
      BLIND_LEVELS = data.blind_config.levels || BLIND_LEVELS;
      blindDurationSeconds = data.blind_config.duration || blindDurationSeconds;
    }
    if (data.buy_in_amount !== undefined && data.buy_in_amount !== null) {
      gameBuyIn = data.buy_in_amount;
    }
    if (data.game_format) gameFormat = data.game_format;
    if (data.game_variant) gameVariant = data.game_variant;
    currentGameId = gameId;
    G = data.state;

    // Close chat panel if it was open (so it doesn't cover the rejoined game)
    const chatPanel = document.getElementById('chat-panel');
    const chatBackdrop = document.getElementById('chat-backdrop');
    if (chatPanel) chatPanel.style.display = 'none';
    if (chatBackdrop) chatBackdrop.style.display = 'none';

    showScreen('game');
    screenStack = ['home', 'game'];
    startBlindTimer();
    // Re-subscribe to chat (loads history + listens for new messages)
    subscribeToChatForGame(gameId);
    startNudgeListener(gameId);
    startPresence(gameId);

    if (amHost) {
      // Host's local G was wiped by rejoin — fetch own private cards so we see our hand
      if (G.handNumber > 0) await fetchMyPrivateHand(gameId, G.handNumber);
      renderGame();
      hostListenForActions(gameId);
      startHostHeartbeat(gameId);
      resumeHostDuties();
      if (!isMyTurn()) setTimeout(runCpuTurn, 800);
    } else {
      // Clear any stale auto-action from previous session
      _autoAction = null;
      guestSubscribeToGame(gameId);
      startDisconnectWatcher(gameId);
      // Fetch our private hole cards before first render
      if (G.handNumber > 0) await fetchMyPrivateHand(gameId, G.handNumber);
      renderGame();
      if (isMyTurn()) {
        startTurnTimer(30);
        pushTurnNotification();
      }
    }
    toast('Rejoined game');

    // If I was previously marked away, send a sit_back action to clear the flag
    const myP = G?.players?.find(p => p.id === me.id);
    if (myP?.awayFromTable) {
      if (amHost) {
        // Host clears their own flag directly
        myP.awayFromTable = false;
        myP.disconnected = false;
        myP.lastAction = null;
        syncGameState();
        renderGame();
      } else if (sb && currentGameId) {
        sb.from('player_actions').insert({
          game_id: currentGameId,
          player_id: me.id,
          action: 'sit_back',
          amount: null,
          created_at: new Date().toISOString(),
        }).then(() => {});
      }
    }
  } catch(e) { toast('Rejoin failed: ' + e.message); }
}

