// ════════════════════════════════════════════════════════════════════════════
// GAMES LIST
// ════════════════════════════════════════════════════════════════════════════
async function loadGames() {
  if (_gamesKilled) return;
  if (me.id === 'demo') { renderGamesList(); return; }
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

    myGames = rowsWithGame
      .map(d => ({
        ...d.game,
        player_count: d.game?.game_players?.[0]?.count || 0,
        i_am_host: d.game?.host_id === me.id,
        my_status: d.status,
      }))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    if (myFriends.length) {
      const friendIds = myFriends.map(f => f.id);
      const myGameIds = new Set(myGames.map(g => g.id));

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
        myGames.push({
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

    renderGamesList();
  } catch(e) { console.warn('loadGames error:', e); renderGamesList(); }
}

function renderGamesList() {
  const el = document.getElementById('games-list');

  if (!myGames.length) {
    el.innerHTML = `<div style="padding:40px 20px;text-align:center;color:var(--text-dim);font-size:0.9rem;font-style:italic;">No games yet.<br>Tap + to create one.</div>`;
    return;
  }

  const invites       = myGames.filter(g => g.my_status === 'invited' && g.status === 'lobby');
  const myLobbies     = myGames.filter(g => g.status === 'lobby' && g.i_am_host);
  const friendLobbies = myGames.filter(g => g.my_status === 'friend_lobby');
  const active        = myGames.filter(g => g.status === 'active' && g.my_status !== 'friend_playing');
  const friendActive  = myGames.filter(g => g.my_status === 'friend_playing');
  const finished      = myGames.filter(g => g.status === 'finished');

  let html = '';

  if (invites.length) {
    html += `<div class="section-head" style="color:var(--gold)">📨 Invited — Waiting to Start</div>`;
    html += invites.map(g => gameCard(g, 'invite')).join('');
  }

  if (active.length) {
    html += `<div class="section-head">Active</div>`;
    html += active.map(g => gameCard(g, 'active')).join('');
  }

  if (myLobbies.length) {
    html += `<div class="section-head">Your Lobbies</div>`;
    html += myLobbies.map(g => gameCard(g, 'lobby')).join('');
  }

  if (friendLobbies.length) {
    html += `<div class="section-head">Friends' Open Lobbies</div>`;
    html += friendLobbies.map(g => gameCard(g, 'friend_lobby')).join('');
  }

  if (friendActive.length) {
    html += `<div class="section-head">Friends Playing</div>`;
    html += friendActive.map(g => gameCard(g, 'friend')).join('');
  }

  if (finished.length) {
    html += `<div class="section-head">Recent</div>`;
    html += finished.map(g => gameCard(g, 'finished')).join('');
  }

  el.innerHTML = html;
}

function gameCard(g, type) {
  let badgeClass = type==='active' ? 'badge-green' : type==='invite' ? 'badge-gold' : type==='lobby' ? 'badge-gold' : type==='friend' ? 'badge-green' : type==='friend_lobby' ? 'badge-gold' : 'badge-dim';
  let badgeText  = type==='active' ? 'ACTIVE' : type==='invite' ? 'INVITED' : type==='lobby' ? 'LOBBY' : type==='friend' ? 'ACTIVE' : type==='friend_lobby' ? 'OPEN' : 'DONE';
  let btnClass   = type==='active' ? 'btn-primary' : type==='invite' ? 'btn-primary' : type==='friend_lobby' ? 'btn-primary' : type==='friend' ? 'btn-ghost' : 'btn-ghost';
  let btnText    = type==='active' ? 'Rejoin' : type==='invite' ? 'Join' : type==='friend' ? 'Spectate' : type==='friend_lobby' ? 'Join' : type==='lobby' ? 'Open' : 'View';
  const subLine    = (type==='friend' || type==='friend_lobby') ? `<div style="font-size:0.7rem;color:var(--text-dim)">${g.friend_name}'s game</div>` : '';

  // Find my chips in this game from the state if available
  let myChipsHtml = '';
  let isAway = false;
  if (type === 'active' && g.state?.players) {
    const me_in_game = g.state.players.find(p => p.id === me.id);
    if (me_in_game) {
      const eliminated = me_in_game.eliminated;
      isAway = me_in_game.awayFromTable && !eliminated;
      myChipsHtml = eliminated
        ? `<div class="game-card-stat"><div class="val" style="color:var(--red-light)">Out</div><div class="lbl">Status</div></div>`
        : `<div class="game-card-stat"><div class="val">${me_in_game.chips.toLocaleString()}</div><div class="lbl">My Chips</div></div>`;
    }
  }
  // Override the badge and button for "away" state — the user explicitly left
  // the table and needs to tap Sit Back Down to rejoin active play.
  if (isAway) {
    badgeClass = 'badge-gold';
    badgeText = 'AWAY';
    btnText = '🪑 Sit Back Down';
    btnClass = 'btn-primary';
  }

  const timeStamp = type === 'invite'
    ? `<div style="font-size:0.7rem;color:var(--text-dim);margin-top:2px">${timeAgo(g.created_at)}</div>`
    : '';

  const handInfo = type === 'active'
    ? `<div class="game-card-stat"><div class="val">#${g.hand_number||0}</div><div class="lbl">Hand</div></div>`
    : '';

  return `
    <div class="game-card" onclick="openLobby('${g.id}')">
      <div class="game-card-header">
        <div>
          <div class="game-card-name">${g.name}</div>
          ${subLine}
          ${timeStamp}
        </div>
        <span class="badge ${badgeClass}">${badgeText}</span>
      </div>
      <div class="game-card-body">
        <div class="game-card-meta">
          <div class="game-card-stat"><div class="val">${g.player_count||'—'}</div><div class="lbl">Players</div></div>
          ${handInfo}
          ${myChipsHtml}
        </div>
        <button class="btn ${btnClass} btn-sm">${btnText}</button>
      </div>
    </div>`;
}

