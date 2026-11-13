// ════════════════════════════════════════════════════════════════════════════
// START GAME
// ════════════════════════════════════════════════════════════════════════════
function startGame() {
  // Every real game is run by the server: it seats everyone and deals
  // (38-server-rules.js). Below: Demo mode only, played locally on this phone.
  if (me.id !== 'demo') { serverStartGame(); return; }
  // lobbyPlayers already contains only joined/playing/waiting (invited filtered out)
  let playerSource = lobbyPlayers;

  if (me.id === 'demo' && lobbyPlayers.length < 2) {
    playerSource = [
      { user: me, seat_index: 0 },
      ...DEMO_FRIENDS.slice(0, 3).map((f, i) => ({ user: f, seat_index: i+1 })),
    ];
  }

  // Build player array. Starting chips depends on format (tournament=1500 abstract chips,
  // home=2000 chips, matching the 2,000-chip buy-in)
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

  amHost = true; // demo acts as the table

  enterGame(currentLobbyId, initialState);
}



