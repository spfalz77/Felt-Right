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
    // Pull the latest table: realtime may have missed updates while the phone
    // slept. Same path as the backup poller, so a result or the end of the
    // game that happened meanwhile shows up too. (Demo mode has nothing saved.)
    if (me?.id !== 'demo' && isServerGame()) await refreshGuestState();

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
