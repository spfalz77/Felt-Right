// ── CPU AI ───────────────────────────────────────────────────────────────────
// ── PLAYER ONLINE TRACKING ────────────────────────────────────────────────────
// Host tracks which players have sent a heartbeat recently.
// Guests ping a presence channel; host listens and marks players online/offline.
let _presenceChannel = null;
const PLAYER_TIMEOUT_MS = 25000; // 25s without ping = disconnected

function startPresence(gameId) {
  if (!sb || me.id === 'demo') return;
  stopPresence(); // clean up any existing
  _presenceStartedAt = Date.now();
  _presenceSeenAt = {};

  _presenceChannel = sb.channel(`presence:${gameId}`, {
    config: { presence: { key: me.id } }
  });

  const updateOnlineStatus = () => {
    if (!_presenceChannel) return;
    const state = _presenceChannel.presenceState();
    _onlineIds = new Set(Object.keys(state));
    const now = Date.now();
    _onlineIds.forEach(id => { _presenceSeenAt[id] = now; });

    // Update G.players disconnected flag IN MEMORY ONLY — do NOT push to DB
    // Presence updates should not trigger syncGameState (that restarts UI timers)
    if (amHost && G) {
      G.players.forEach(p => {
        if (p.eliminated) return;
        const isOnline = (p.id === me.id) || (state[p.id] && state[p.id].length > 0);
        p.disconnected = !isOnline;
      });
      // Re-render locally only — don't push state. Host turn enforcer handles away players.
      renderGame();
    }
  };

  _presenceChannel
    .on('presence', { event: 'sync' }, updateOnlineStatus)
    .on('presence', { event: 'join' }, updateOnlineStatus)
    .on('presence', { event: 'leave' }, updateOnlineStatus)
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await _presenceChannel.track({ online_at: new Date().toISOString() });
      }
    });

  // Re-ping every 5s to stay alive (faster heartbeat = faster reconnect detection)
  clearInterval(_presencePingInterval);
  _presencePingInterval = setInterval(() => {
    if (_presenceChannel) _presenceChannel.track({ online_at: new Date().toISOString() });
  }, 5000);
}



// A player counts as gone only after being missing from presence for
// PRESENCE_GONE_MS in a row. Presence can lag or briefly drop someone who is
// still there (weak signal, busy server), and the host auto-acts for players
// who are gone, so a momentary gap must not count. Before the first presence
// sync we don't know, so assume online.
const PRESENCE_GONE_MS = 12000;
let _presenceSeenAt = {};
let _presenceStartedAt = 0;
function isPlayerOnline(playerId) {
  if (!_onlineIds || !_onlineIds.size) return true;
  if (_onlineIds.has(playerId)) return true;
  const lastSeen = _presenceSeenAt[playerId] || _presenceStartedAt || 0;
  return Date.now() - lastSeen < PRESENCE_GONE_MS;
}
