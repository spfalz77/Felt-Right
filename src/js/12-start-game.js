// ════════════════════════════════════════════════════════════════════════════
// START GAME
// ════════════════════════════════════════════════════════════════════════════
function startGame() {
  // Server-run game: the server seats everyone and deals (38-server-rules.js)
  if (SERVER_RULES && sb && currentLobbyId && me.id !== 'demo') { serverStartGame(); return; }
  // lobbyPlayers already contains only joined/playing/waiting (invited filtered out)
  let playerSource = lobbyPlayers;

  if (me.id === 'demo' && lobbyPlayers.length < 2) {
    playerSource = [
      { user: me, seat_index: 0 },
      ...DEMO_FRIENDS.slice(0, 3).map((f, i) => ({ user: f, seat_index: i+1 })),
    ];
  }

  if (me.id !== 'demo' && playerSource.length < 2) {
    toast(`Need at least 2 players — only ${playerSource.length} joined`);
    return;
  }

  // Build player array. Starting chips depends on format (tournament=1500 abstract chips,
  // home=2000¢ representing $20 buy-in)
  const startingChips = (FORMATS[gameFormat] || FORMATS.tournament).startingChips;
  const players = playerSource.map((lp, i) => ({
    id: lp.user?.id || lp.id || `p${i}`,
    name: lp.user?.display_name || `Player ${i+1}`,
    emoji: lp.user?.avatar_emoji || '🃏',
    chips: startingChips,
    // Track total dollar buy-in (in cents) so re-buys can compound for cash-out math.
    // Only meaningful in home games but harmless in tournaments.
    totalBuyInCents: gameFormat === 'home' ? startingChips : 0,
    hand: [],
    bet: 0,
    totalBet: 0,
    folded: false,
    allIn: false,
    lastAction: null,
    seatIndex: i,
    isDealer: false,
    eliminated: false,
    broke: false,
  }));

  // Random dealer
  const dealerIdx = Math.floor(Math.random() * players.length);
  players[dealerIdx].isDealer = true;

  // Shuffle seating order
  for (let i = players.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [players[i], players[j]] = [players[j], players[i]];
  }
  players.forEach((p,i) => p.seatIndex = i);

  const initialState = {
    players,
    handNumber: 0,
    stage: 'deal',
    community: [],
    pot: 0,
    deck: [],
    currentBet: 0,
    actionIndex: -1,
    dealerId: null,
    dealerPos: -1,
    sbIdx: -1,
    bbIdx: -1,
    finalPlacements: [],
    format: gameFormat,
    variant: gameVariant,
    rebuysEnabled: gameFormat === 'tournament' ? !!gameRebuysEnabled : (gameFormat === 'home' ? true : false),
    rebuyWindowClosed: false, // tournament: flips to true after first break
    breakActive: false,        // tournament: true during break overlay
    readyForBreakEnd: [],     // tournament: players who've tapped Ready during break
  };

  if (me.id !== 'demo' && sb && currentLobbyId) {
    amHost = true;
    stopLobbyWatchdog();
    sb.from('games').update({
      status: 'active',
      state: initialState,
      started_at: new Date().toISOString(),
      last_host_seen: new Date().toISOString(),
      blind_config: {
        levels: BLIND_LEVELS,
        duration: blindDurationSeconds,
        rebuys_enabled: !!gameRebuysEnabled,
      },
      buy_in_amount: gameBuyIn,
    }).eq('id', currentLobbyId).then(({ error }) => {
      if (error) console.error('startGame UPDATE failed:', error);
    });
  } else {
    amHost = me.id === 'demo'; // demo always acts as host
  }

  enterGame(currentLobbyId, initialState);
}



