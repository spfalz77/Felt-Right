// ════════════════════════════════════════════════════════════════════════════
// BOOT
// ════════════════════════════════════════════════════════════════════════════
window.addEventListener('load', () => {
  // Check for join link
  const params = new URLSearchParams(location.search);
  if (params.has('join')) {
    toast(`Joining game ${params.get('join')}…`);
  }
  init();
});

// When the tab becomes visible again (screen unlock / refocus), re-sync state.
// WebSocket subscriptions can drop while the tab is hidden, leaving the user out
// of date. Re-fetching history catches anything missed.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  // Re-fetch chat history if we're in a game/lobby (real-time may have missed messages)
  const gameId = currentGameId || currentLobbyId || _chatCurrentGameId;
  if (gameId && sb && me?.id !== 'demo') {
    loadChatHistory(gameId);
    // Force the realtime channel to re-establish if it was dropped
    if (_chatSubscription) {
      try {
        _chatSubscription.unsubscribe();
      } catch(e) {}
      _chatSubscription = null;
      _chatCurrentGameId = null;
      subscribeToChatForGame(gameId);
    }
  }
  // Re-fetch game state for guests so we don't sit on stale state after returning
  if (currentGameId && !amHost && sb && me?.id !== 'demo') {
    sb.from('games').select('state').eq('id', currentGameId).maybeSingle().then(({ data }) => {
      if (data?.state) { G = data.state; renderGame(); }
    }).catch(() => {});
  }
});
