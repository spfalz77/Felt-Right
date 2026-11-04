// ════════════════════════════════════════════════════════════════════════════
// APP STATE
// ════════════════════════════════════════════════════════════════════════════
let sb = null; // supabase client
let me = null; // { id, display_name, avatar_emoji }
let myFriends = [];
let myGames   = [];
let currentGameId = null;
let currentLobbyId = null;
let gameSubscription = null;
let lobbySubscription = null;
let actionSubscription = null; // host listens for non-host actions
let amHost = false; // true if this client is the game host (game engine runner)

// Local game state (maintained by host, synced to all via Supabase)
let G = null; // full game state object

