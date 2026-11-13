// ════════════════════════════════════════════════════════════════════════════
// LOBBY
// ════════════════════════════════════════════════════════════════════════════
let lobbyPlayers = [];
let _lobbyStatusPoller = null;

async function openLobby(gameId) {
  document.getElementById('invite-banner')?.remove();
  currentLobbyId = gameId;
  // Subscribe to chat for this game (lobby + game share same chat thread)
  subscribeToChatForGame(gameId);
  startNudgeListener(gameId);

  // If game is already active, check if we should rejoin directly
  const gameRef = myGames.find(g => g.id === gameId);
  if (gameRef?.status === 'active' && me.id !== 'demo') {
    await rejoinActiveGame(gameId, gameRef);
    return;
  }

  // If this is a lobby invite, join properly
  if (me.id !== 'demo') {
    try {
      // Always fetch fresh game data — myGames cache may be stale
      const { data: freshGame } = await sb.from('games')
        .select('id, status, host_id').eq('id', gameId).single();

      if (freshGame?.status === 'active') {
        await rejoinActiveGame(gameId, freshGame);
        return;
      }

      if (freshGame?.status === 'lobby') {
        const { data: myRow } = await sb.from('game_players')
          .select('id, status, seat_index')
          .eq('game_id', gameId).eq('user_id', me.id).maybeSingle();

        if (!myRow || myRow.status === 'invited') {
          const { data: seated } = await sb.from('game_players')
            .select('seat_index').eq('game_id', gameId).eq('status', 'joined');
          // Upsert: the host's invite row can land between the read above and
          // this write; a plain insert would then fail and leave us not joined
          const { error: joinErr } = await sb.from('game_players').upsert({
            game_id: gameId, user_id: me.id,
            seat_index: (seated||[]).length, status: 'joined'
          }, { onConflict: 'game_id,user_id' });
          if (joinErr) {
            console.warn('openLobby join error:', joinErr);
            toast('Could not join the game. Try again.');
            currentLobbyId = null;
            return;
          }
        }
        await loadGames();
      }
    } catch(e) { console.warn('openLobby join error:', e); }
  }

  pushScreen('lobby');
  screenStack = ['home', 'lobby'];

  const game = myGames.find(g => g.id === gameId);
  document.getElementById('lobby-game-name').textContent = game?.name || 'Game';
  document.getElementById('lobby-game-id').textContent = `Game ID: ${gameId.slice(0,8).toUpperCase()}`;
  document.getElementById('lobby-invite-url').textContent = `${location.origin}${location.pathname}?join=${gameId.slice(0,8)}`;

  const isHost = !game || game.host_id === me.id;
  const canInvite = isHost || (game?.my_status === 'joined');
  document.getElementById('lobby-start-btn').style.display = isHost ? 'block' : 'none';
  document.getElementById('lobby-waiting-msg').style.display = isHost ? 'none' : 'block';
  document.getElementById('blind-editor-section').style.display = isHost ? 'block' : 'none';
  if (isHost) renderBlindEditor();

  // Load buy_in_amount + game format/variant from DB
  if (sb && me.id !== 'demo') {
    sb.from('games').select('buy_in_amount, game_format, game_variant, blind_config').eq('id', gameId).single().then(({ data }) => {
      if (data?.buy_in_amount !== undefined && data?.buy_in_amount !== null) {
        gameBuyIn = data.buy_in_amount;
      } else {
        gameBuyIn = 20;
      }
      if (data?.game_format) gameFormat = data.game_format;
      if (data?.game_variant) gameVariant = data.game_variant;
      // Load home-game blinds from DB if present
      if (data?.blind_config?.levels?.[0] && gameFormat === 'home') {
        const lvl = data.blind_config.levels[0];
        const sbI = document.getElementById('home-sb-input');
        const bbI = document.getElementById('home-bb-input');
        if (sbI) sbI.value = lvl.small;
        if (bbI) bbI.value = lvl.big;
        BLIND_LEVELS = [{ level: 1, small: lvl.small, big: lvl.big }];
      }
      // Load rebuys_enabled into the toggle (tournament only)
      if (gameFormat === 'tournament') {
        gameRebuysEnabled = !!data?.blind_config?.rebuys_enabled;
        const cb = document.getElementById('rebuys-enabled-checkbox');
        if (cb) cb.checked = gameRebuysEnabled;
      }
      const inp = document.getElementById('buy-in-input');
      if (inp) inp.value = gameBuyIn * 100;
      updatePayoutPreview();
      updateLobbyVariantBadge();
      toggleBlindEditorSection();
      // Show/hide rebuys toggle based on format
      const rebuysGroup = document.getElementById('rebuys-toggle-group');
      if (rebuysGroup) rebuysGroup.style.display = gameFormat === 'tournament' ? 'block' : 'none';
    });
  } else {
    toggleBlindEditorSection();
  }

  // Render friend invite list — all joined players can invite
  await ensureFriendsLoaded();
  if (canInvite) renderLobbyFriendList();
  else document.getElementById('lobby-friend-invite-list').innerHTML =
    `<div style="color:var(--text-dim);font-size:0.85rem;padding:8px 0">Join the lobby to invite friends</div>`;

  if (me.id === 'demo') {
    lobbyPlayers = [{ user: me, seat_index: 0 }];
    renderLobbySeats();
    startDemoLobby();
    return;
  }

  // Host: nothing extra needed in lobby
  // Guests: watch in case host leaves so we can promote
  if (!isHost && me.id !== 'demo') startLobbyHostWatch(gameId);

  // Load players
  try {
    const { data } = await sb.from('game_players')
      .select('*,user:users(id,display_name,avatar_emoji)')
      .eq('game_id', gameId).order('joined_at');

    lobbyPlayers = (data || [])
      .filter(p => p.status === 'joined' || p.status === 'playing' || p.status === 'waiting')
      .sort((a, b) => {
        // Host first, then by joined_at
        const aHost = a.user_id === (myGames.find(g => g.id === gameId)?.host_id);
        const bHost = b.user_id === (myGames.find(g => g.id === gameId)?.host_id);
        if (aHost && !bHost) return -1;
        if (bHost && !aHost) return 1;
        return new Date(a.joined_at||0) - new Date(b.joined_at||0);
      });
    const invitedPlayers = (data || []).filter(p => p.status === 'invited');
    renderLobbySeats();
    renderInvitedList(invitedPlayers);
    _lobbyRosterSig = (data || []).map(p => p.user_id + ':' + p.status).join(',');

    // Subscribe — watch both new joins and status updates
    if (lobbySubscription) lobbySubscription.unsubscribe();
    lobbySubscription = sb.channel(`lobby:${gameId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'game_players', filter: `game_id=eq.${gameId}` },
        () => refreshLobbyRoster(gameId))
      .subscribe();

    // Also watch for game status change (host started) - guests only
    // Only fires once on lobby -> active transition, then unsubscribes
    const gameStartChannel = sb.channel(`gamestart:${gameId}`);
    let alreadyEntered = false;

    // Fallback poller: if real-time event is missed (e.g. user was in chat when host started),
    // a poll every 2s catches the active status and transitions the user into the game.
    // This is the primary mechanism since 'games' table may not be in realtime publication.
    clearInterval(_lobbyStatusPoller);
    const startedAt = Date.now();
    _lobbyStatusPoller = setInterval(async () => {
      if (alreadyEntered) { clearInterval(_lobbyStatusPoller); return; }
      if (currentLobbyId !== gameId) { clearInterval(_lobbyStatusPoller); return; }
      try {
        // A join that landed before the subscription was up would otherwise never show
        refreshLobbyRoster(gameId);
        const { data } = await sb.from('games').select('status, host_id, state').eq('id', gameId).maybeSingle();
        if (!data) {
          // Game might have been deleted — go home
          if (Date.now() - startedAt > 6000) {
            clearInterval(_lobbyStatusPoller);
            toast('Lobby no longer exists');
            goHome();
          }
          return;
        }
        if (data.status === 'active' && data.host_id !== me.id) {
          alreadyEntered = true;
          clearInterval(_lobbyStatusPoller);
          gameStartChannel.unsubscribe();
          try {
            enterGame(gameId, data.state);
          } catch(err) {
            console.error('[lobby poll] enterGame failed:', err);
            toast('Failed to enter game: ' + (err.message || err));
            alreadyEntered = false;
          }
        } else if (data.status === 'finished') {
          clearInterval(_lobbyStatusPoller);
          toast('Game ended');
          goHome();
        }
      } catch(e) { console.warn('lobby status poll:', e); }
    }, 2000);

    gameStartChannel
      .on('postgres_changes',{event:'UPDATE',schema:'public',table:'games',filter:`id=eq.${gameId}`},
        async (payload) => {
          if (alreadyEntered) return;
          if (payload.new.status !== 'active') return;
          // HOST enters via startGame() directly — ignore DB event to avoid double-enterGame
          if (payload.new.host_id === me.id) return;
          alreadyEntered = true;
          clearInterval(_lobbyStatusPoller);
          gameStartChannel.unsubscribe();
          toast('Game starting!');
          // Short delay then fetch FRESH state - host is dealing and pushing updates right now
          // Don't use payload.new.state which is likely stale (handNumber=0 pre-deal)
          setTimeout(async () => {
            try {
              const { data } = await sb.from('games').select('state').eq('id', gameId).maybeSingle();
              enterGame(gameId, data?.state || payload.new.state);
            } catch(e) {
              enterGame(gameId, payload.new.state);
            }
          }, 1200); // wait a bit longer for host's dealNewHand to push
        })
      .subscribe();
  } catch(e) { console.warn(e); lobbyPlayers = [{user:me,seat_index:0}]; renderLobbySeats(); }
}

function renderInvitedList(invited) {
  let el = document.getElementById('lobby-invited-list');
  if (!el) {
    el = document.createElement('div');
    el.id = 'lobby-invited-list';
    el.style.cssText = 'padding:0 16px 8px';
    const seatsEl = document.getElementById('lobby-seats');
    if (seatsEl) seatsEl.parentNode.insertBefore(el, seatsEl.nextSibling);
  }
  if (!invited.length) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div style="font-size:0.72rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:6px">Invited — Pending</div>
    ${invited.map(p => `
      <div style="display:flex;align-items:center;gap:10px;padding:6px 0">
        <div class="avatar sm">${p.user?.avatar_emoji||p.user?.display_name?.[0]||'?'}</div>
        <div style="font-size:0.85rem;color:var(--text-dim);flex:1">${p.user?.display_name||'...'}</div>
        <span class="badge badge-dim">Invited</span>
      </div>`).join('')}`;
}

function renderLobbySeats() {
  const el = document.getElementById('lobby-seats');
  const MAX_SEATS = 9;
  const hostId = myGames.find(g => g.id === currentLobbyId)?.host_id;
  let html = '';

  // Show joined players first (in order), then fill remaining seats with "Open"
  for (let i = 0; i < MAX_SEATS; i++) {
    const p = lobbyPlayers[i];
    if (p) {
      const isHost = p.user?.id === hostId;
      const isMe = p.user?.id === me?.id;
      const canNudge = !isMe && p.user?.id;
      const emoji = p.user?.avatar_emoji||p.user?.display_name?.[0]||'?';
      const name = p.user?.display_name||'Player';
      html += `<div class="seat filled">
        <div class="avatar sm ${canNudge?'lobby-nudge-avatar':''}"
          ${canNudge ? `data-nudge-id="${p.user.id}" data-nudge-name="${name}" style="cursor:pointer" title="Tap to nudge ${name}"` : ''}>${emoji}</div>
        <div class="seat-name">${name}</div>
        ${isHost ? `<div class="seat-host">Host</div>` : ''}
      </div>`;
    } else {
      html += `<div class="seat"><div class="seat-empty">+</div><div class="seat-name" style="color:var(--text-dim);font-size:0.72rem">Open</div></div>`;
    }
  }

  el.innerHTML = html;
  document.getElementById('lobby-player-count').textContent = `${lobbyPlayers.length} / ${MAX_SEATS} joined`;

  // Wire nudge handlers on lobby avatars
  el.querySelectorAll('.lobby-nudge-avatar').forEach(av => {
    av.onclick = (e) => {
      e.stopPropagation();
      const id = av.dataset.nudgeId;
      const name = av.dataset.nudgeName;
      if (id) nudgePlayer(id, name);
    };
  });

  // Update payout preview based on current player count
  updatePayoutPreview();

  // Show Start Game if enough joined (host only)
  if (lobbyPlayers.length >= 2) {
    const startBtn = document.getElementById('lobby-start-btn');
    const waitMsg  = document.getElementById('lobby-waiting-msg');
    if (startBtn && hostId === me?.id) startBtn.style.display = 'block';
    if (waitMsg) waitMsg.style.display = 'none';
  }
}

// ── GLOBAL INVITE LISTENER ────────────────────────────────────────────────────

let inviteSubscription = null;
let _invitePollInterval = null;

function subscribeToInvites() {
  if (inviteSubscription) inviteSubscription.unsubscribe();

  inviteSubscription = sb.channel(`my-invites:${me.id}`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'game_players',
    }, async payload => {
      if (payload.new.user_id !== me.id) return;
      if (payload.new.status !== 'invited') return;
      await handleNewInvite(payload.new.game_id);
    })
    .subscribe(status => {
      // Subscription just went live — immediately check for any invites we missed during handshake
      if (status === 'SUBSCRIBED') {
        setTimeout(checkForNewInvites, 500);
      }
    });

  // Poll every 10s as fallback (down from 20s)
  clearInterval(_invitePollInterval);
  _invitePollInterval = setInterval(checkForNewInvites, 10000);

  // Also run one catch-up check 2s after subscribing
  setTimeout(checkForNewInvites, 2000);
}

async function checkForNewInvites() {
  if (!sb || !me?.id) return;
  try {
    const { data } = await sb.from('game_players')
      .select('game_id')
      .eq('user_id', me.id)
      .eq('status', 'invited');

    for (const row of (data || [])) {
      if (!myGames.find(g => g.id === row.game_id)) {
        await handleNewInvite(row.game_id);
      }
    }
    if (data?.length) await loadGames();
  } catch(e) { console.warn('checkForNewInvites:', e); }
}

async function handleNewInvite(gameId) {
  try {
    const { data: game } = await sb.from('games')
      .select('id, name, host_id, status, users!host_id(display_name)')
      .eq('id', gameId).single();

    if (!game || game.status !== 'lobby' || game.host_id === me.id) return;

    const hostName = game.users?.display_name || 'Someone';
    showInviteBanner(game, hostName);

    if (_notificationsEnabled && 'Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      new Notification('Felt Right — Game Invite', {
        body: `${hostName} invited you to "${game.name}"`,
        tag: `invite-${game.id}`,
      });
    }
    await loadGames();
  } catch(e) { console.warn('handleNewInvite error:', e); }
}

function showInviteBanner(game, hostName) {
  // Already in a lobby or at a table: don't cover the screen (it sat over the
  // table's Quit button and turned a Quit tap into a rejoin)
  if (currentLobbyId || currentGameId) return;
  // Remove any existing banner
  const existing = document.getElementById('invite-banner');
  if (existing) existing.remove();

  const banner = document.createElement('div');
  banner.id = 'invite-banner';
  banner.style.cssText = `
    position: fixed; top: calc(var(--safe-top) + 12px); left: 12px; right: 12px;
    background: var(--surface); border: 1px solid var(--gold-dim);
    border-radius: var(--r-sm); padding: 12px 14px; z-index: 500;
    display: flex; align-items: center; gap: 12px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.5);
    animation: slideDown 0.25s ease;
  `;
  banner.innerHTML = `
    <div style="font-size:1.4rem">🃏</div>
    <div style="flex:1;min-width:0">
      <div style="font-weight:600;font-size:0.88rem">${hostName} invited you</div>
      <div style="font-size:0.78rem;color:var(--text-dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${game.name}</div>
    </div>
    <button class="btn btn-primary btn-sm" onclick="openLobby('${game.id}');document.getElementById('invite-banner')?.remove()">Join</button>
    <button onclick="this.closest('#invite-banner').remove()"
      style="background:none;border:none;color:var(--text-dim);font-size:1.2rem;cursor:pointer;padding:0 4px">×</button>
  `;
  document.body.appendChild(banner);

  // Auto-dismiss after 8 seconds
  setTimeout(() => banner.remove(), 8000);
}

async function inviteFriend(friendId, name) {
  if (me.id === 'demo' || !sb || !currentLobbyId) {
    const link = `${location.origin}${location.pathname}?join=${currentLobbyId?.slice(0,8)||'—'}`;
    navigator.clipboard?.writeText(link).then(() => toast(`Invite link copied for ${name}`));
    return;
  }

  // Check if already in the lobby
  const { data: existing } = await sb.from('game_players')
    .select('id, status').eq('game_id', currentLobbyId).eq('user_id', friendId).maybeSingle();

  if (existing) {
    toast(`${name} is already ${existing.status === 'invited' ? 'invited' : 'in the lobby'}`);
    return;
  }

  const { error } = await sb.from('game_players').insert({
    game_id: currentLobbyId,
    user_id: friendId,
    seat_index: null,
    status: 'invited',
  });

  if (error) {
    toast(`Could not invite ${name}: ${error.message}`);
  } else {
    toast(`${name} invited ✓`);
    renderLobbyFriendList();
  }
}

async function cancelLobby() {
  if (!currentLobbyId || me.id === 'demo') { goBack(); return; }
  if (!confirm('Cancel this lobby? Everyone will be removed.')) return;
  try {
    await sb.from('game_players').delete().eq('game_id', currentLobbyId);
    await sb.from('games').delete().eq('id', currentLobbyId);
  } catch(e) { console.warn('cancel lobby error:', e); }
  stopLobbyWatchdog();
  currentLobbyId = null;
  await loadGames();
  navTo('home');
  toast('Lobby cancelled');
}

function copyLobbyLink() {
  const url = document.getElementById('lobby-invite-url').textContent;
  navigator.clipboard?.writeText(url).then(() => toast('Link copied!'));
}

// Re-reads who's in the lobby and redraws the seats (realtime event or poll).
// Toasts only for someone new, and only redraws when the roster changed.
let _lobbyRosterSig = '';
async function refreshLobbyRoster(gameId) {
  const { data: fresh } = await sb.from('game_players')
    .select('*,user:users(id,display_name,avatar_emoji)')
    .eq('game_id', gameId).order('joined_at');
  if (currentLobbyId !== gameId || !fresh) return;
  const sig = fresh.map(p => p.user_id + ':' + p.status).join(',');
  if (sig === _lobbyRosterSig) return;
  _lobbyRosterSig = sig;

  const hostId = myGames.find(g => g.id === gameId)?.host_id;
  const newLobby = fresh
    .filter(p => p.status === 'joined' || p.status === 'playing' || p.status === 'waiting')
    .sort((a, b) => {
      if (a.user_id === hostId) return -1;
      if (b.user_id === hostId) return 1;
      return new Date(a.joined_at||0) - new Date(b.joined_at||0);
    });

  const previousIds = new Set(lobbyPlayers.map(p => p.user_id));
  lobbyPlayers = newLobby;
  renderLobbySeats();
  renderInvitedList(fresh.filter(p => p.status === 'invited'));

  const joiner = newLobby.find(p => !previousIds.has(p.user_id) && p.user_id !== me.id);
  if (joiner) toast(`${joiner.user?.display_name||'Someone'} joined!`);
}
