// ════════════════════════════════════════════════════════════════════════════
// GAMES LIST
// ════════════════════════════════════════════════════════════════════════════
// Each load gets a number; only the newest one may draw the list. Loads run
// at the same time (startup, the 20s refresh, a new invite, coming back to the
// app), and a slow older one used to overwrite a newer list that already had
// the invite in it.
let _loadGamesSeq = 0;
async function loadGames() {
  if (_gamesKilled) return;
  if (me.id === 'demo') { renderGamesList(); return; }
  const seq = ++_loadGamesSeq;
  const stale = () => seq !== _loadGamesSeq;
  try {
    // My games (all statuses including invited)
    const { data, error } = await sb
      .from('game_players')
      .select(`status, game_id, game:games(id, name, status, host_id, hand_number, created_at, state, game_players(count))`)
      .eq('user_id', me.id);

    if (error) { console.warn('loadGames game_players error:', error); throw error; }

    // Detect rows where the join didn't return the game (could indicate RLS filter)
    const rowsWithGame = (data || []).filter(d => d.game);
    const rowsMissingGame = (data || []).filter(d => !d.game && d.game_id);

    if (rowsMissingGame.length) {
      console.warn(`loadGames: ${rowsMissingGame.length} game_players rows had no game join; fetching directly`);
      // Try fetching the games directly (separately from the join)
      const missingIds = rowsMissingGame.map(r => r.game_id);
      const { data: directGames, error: dgError } = await sb
        .from('games')
        .select('id, name, status, host_id, hand_number, created_at, state, game_players(count)')
        .in('id', missingIds);
      if (dgError) console.warn('loadGames direct fetch error:', dgError);
      // Merge fetched games back into rows
      if (directGames?.length) {
        const directMap = new Map(directGames.map(g => [g.id, g]));
        rowsMissingGame.forEach(r => {
          const g = directMap.get(r.game_id);
          if (g) { r.game = g; rowsWithGame.push(r); }
        });
      }
    }

    const games = rowsWithGame
      .map(d => ({
        ...d.game,
        player_count: d.game?.game_players?.[0]?.count || 0,
        i_am_host: d.game?.host_id === me.id,
        my_status: d.status,
      }))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    if (myFriends.length) {
      const friendIds = myFriends.map(f => f.id);
      const myGameIds = new Set(games.map(g => g.id));

      const { data: friendGames } = await sb
        .from('game_players')
        .select(`user_id, game:games(id, name, status, host_id, hand_number, created_at, game_players(count))`)
        .in('user_id', friendIds)
        .eq('status', 'joined');

      (friendGames || []).forEach(fg => {
        if (!fg.game) return;
        if (myGameIds.has(fg.game.id)) return;
        // Include both active and lobby statuses — friend has open game/lobby I could join
        if (fg.game.status !== 'active' && fg.game.status !== 'lobby') return;
        const friend = myFriends.find(f => f.id === fg.user_id);
        // Only show the host's game, not every friend in it (dedup by game_id already done)
        const isHostedByFriend = fg.game.host_id === fg.user_id;
        games.push({
          ...fg.game,
          player_count: fg.game?.game_players?.[0]?.count || 0,
          i_am_host: false,
          my_status: fg.game.status === 'lobby' ? 'friend_lobby' : 'friend_playing',
          friend_name: friend?.display_name || 'A friend',
          friend_is_host: isHostedByFriend,
        });
        myGameIds.add(fg.game.id);
      });
    }

    if (stale()) return; // a newer load has (or will have) the fresher list
    myGames = games;
    renderGamesList();
  } catch(e) { console.warn('loadGames error:', e); if (!stale()) renderGamesList(); }
}

function renderGamesList() {
  const el = document.getElementById('games-list');

  if (!myGames.length) {
    el.innerHTML = isGuest() && !guestCanHost()
      ? `<div class="games-empty">No games yet.<br>Open an invite link from a friend to join their table.</div>`
      : `<div class="games-empty">No games yet.<br>Tap New game to start one.</div>`;
    return;
  }

  const invites       = myGames.filter(g => g.my_status === 'invited' && g.status === 'lobby');
  const myLobbies     = myGames.filter(g => g.status === 'lobby' && g.i_am_host);
  const friendLobbies = myGames.filter(g => g.my_status === 'friend_lobby');
  const active        = myGames.filter(g => g.status === 'active' && g.my_status !== 'friend_playing');
  const friendActive  = myGames.filter(g => g.my_status === 'friend_playing');
  const finished      = myGames.filter(g => g.status === 'finished');

  // The game that most needs you goes on top as a felt tile: your turn first,
  // then any game in play, then an invite.
  const spotlight = active.find(g => isMyTurnIn(g)) || active[0] || invites[0] || null;
  const rest = (list) => list.filter(g => g !== spotlight);

  let html = '';
  if (spotlight) html += gameCard(spotlight, spotlight.status === 'active' ? 'active' : 'invite', true);

  const section = (title, list, type) => {
    const items = rest(list);
    if (!items.length) return;
    html += `<div class="games-section-title">${title}</div><div class="games-rows">${items.map(g => gameCard(g, type)).join('')}</div>`;
  };
  section('Invited', invites, 'invite');
  section('In play', active, 'active');
  section('Your lobbies', myLobbies, 'lobby');
  section('Friends’ open lobbies', friendLobbies, 'friend_lobby');
  section('Friends playing', friendActive, 'friend');
  section('Recent', finished, 'finished');

  el.innerHTML = html;
}

function isMyTurnIn(g) {
  const st = g?.state;
  if (!st?.players || st.paused || st.tournamentOver || st.stage === 'finished' || st.stage === 'showdown') return false;
  const p = st.players[st.actionIndex];
  return !!p && p.id === me?.id && !p.folded;
}

function gameCard(g, type, featured) {
  let btnText = type==='active' ? 'Rejoin' : type==='invite' ? 'Join' : type==='friend' ? 'Spectate' : type==='friend_lobby' ? 'Join' : type==='lobby' ? 'Open' : 'View';
  let btnClass = (type==='active' || type==='invite' || type==='friend_lobby') ? 'btn-primary' : 'btn-ghost';
  let dot = type==='finished' ? 'done' : (type==='active' || type==='friend') ? 'live' : 'wait';
  let status = type==='invite' ? `Invited ${timeAgo(g.created_at)}`
    : type==='lobby' ? 'Your lobby, waiting to start'
    : type==='friend_lobby' ? `${g.friend_name}'s lobby is open`
    : type==='friend' ? `${g.friend_name} is playing`
    : type==='finished' ? 'Finished'
    : `Hand ${g.hand_number || 0}`;

  let chipsLine = '';
  let pill = '';
  if (type === 'active' && g.state?.players) {
    const mine = g.state.players.find(p => p.id === me.id);
    if (mine) {
      if (mine.eliminated) chipsLine = `<span class="game-card-out">Out</span>`;
      else chipsLine = `<span class="game-card-chips">${(mine.chips || 0).toLocaleString()} chips</span>`;
      if (mine.awayFromTable && !mine.eliminated) {
        btnText = 'Sit Back Down'; btnClass = 'btn-primary'; pill = 'Away'; dot = 'wait';
      }
    }
    if (!pill && isMyTurnIn(g)) { pill = 'Your turn'; dot = 'turn'; }
  }
  if (type === 'invite') pill = pill || 'Invited';

  const players = `${g.player_count || 0} ${g.player_count === 1 ? 'player' : 'players'}`;
  const name = escapeHtml(g.name || 'Game');

  if (featured) {
    return `
    <div class="game-card featured" onclick="openLobby('${g.id}')">
      <div class="game-card-top">
        ${pill ? `<span class="game-card-pill">${pill}</span>` : '<span></span>'}
        <span class="game-card-status">${status}</span>
      </div>
      <div class="game-card-name">${name}</div>
      <div class="game-card-sub">${players}</div>
      <div class="game-card-bottom">
        ${chipsLine || '<span></span>'}
        <button class="btn ${btnClass} btn-sm">${btnText}</button>
      </div>
    </div>`;
  }
  return `
    <div class="game-card row" onclick="openLobby('${g.id}')">
      <span class="game-dot ${dot}" aria-hidden="true"></span>
      <div class="game-card-main">
        <div class="game-card-name">${name}${pill ? ` <span class="game-card-pill sm">${pill}</span>` : ''}</div>
        <div class="game-card-sub">${status}, ${players}${chipsLine ? ', ' : ''}${chipsLine}</div>
      </div>
      <button class="btn ${btnClass} btn-sm">${btnText}</button>
    </div>`;
}

