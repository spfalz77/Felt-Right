// ════════════════════════════════════════════════════════════════════════════
// DEMO LOBBY — simulate friends joining one by one
// ════════════════════════════════════════════════════════════════════════════
const DEMO_FRIENDS = [
  { id:'f1', display_name:'Amanda', avatar_emoji:'♠' },
  { id:'f2', display_name:'Jake',   avatar_emoji:'♥' },
  { id:'f3', display_name:'Sara',   avatar_emoji:'♦' },
  { id:'f4', display_name:'Mike',   avatar_emoji:'♣' },
];
let demoJoinTimers = [];

function startDemoLobby() {
  // Clear any previous timers
  demoJoinTimers.forEach(t => clearTimeout(t));
  demoJoinTimers = [];

  // Simulate 3 friends joining at staggered intervals (1.5s, 3s, 5s)
  const joining = DEMO_FRIENDS.slice(0, 3);
  joining.forEach((friend, i) => {
    const t = setTimeout(() => {
      if (document.getElementById('screen-lobby').classList.contains('active')) {
        lobbyPlayers.push({ user: friend, seat_index: lobbyPlayers.length });
        renderLobbySeats();
        toast(`${friend.display_name} joined the lobby!`);
        // Reveal Start button once 2+ players are in
        if (lobbyPlayers.length >= 2) {
          document.getElementById('lobby-start-btn').style.display = 'block';
          document.getElementById('lobby-waiting-msg').style.display = 'none';
        }
      }
    }, 1500 + i * 1800);
    demoJoinTimers.push(t);
  });
}

