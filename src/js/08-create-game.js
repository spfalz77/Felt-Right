// ════════════════════════════════════════════════════════════════════════════
// CREATE GAME
// ════════════════════════════════════════════════════════════════════════════
function openCreateGame() {
  document.getElementById('new-game-name').value = '';
  openModal('modal-create-game');
}

async function createGame() {
  const name = document.getElementById('new-game-name').value.trim() || 'Friday Night Poker';
  closeModal('modal-create-game');

  if (me.id === 'demo') {
    const fakeId = 'demo-' + Math.random().toString(36).slice(2,8);
    myGames.unshift({ id: fakeId, name, status:'lobby', hand_number:0, host_id: me.id, player_count:1, game_format: gameFormat, game_variant: gameVariant });
    renderGamesList();
    openLobby(fakeId);
    return;
  }

  try {
    const { data, error } = await sb.from('games')
      .insert({
        name,
        host_id: me.id,
        status: 'lobby',
        game_format: gameFormat,
        game_variant: gameVariant,
        blind_config: {
          levels: BLIND_LEVELS,
          duration: blindDurationSeconds,
          rebuys_enabled: gameFormat === 'tournament' ? !!gameRebuysEnabled : false,
        },
      }).select().single();
    if (error) throw error;
    // Host joins their own game immediately with a seat
    const { error: pErr } = await sb.from('game_players').insert({
      game_id: data.id,
      user_id: me.id,
      seat_index: 0,
      status: 'joined',
    });
    if (pErr) throw pErr;
    await loadGames();
    openLobby(data.id);
  } catch(e) { toast('Error creating game: ' + e.message); }
}

function selectGameFormat(format) {
  gameFormat = format;
  document.getElementById('format-tournament')?.classList.toggle('format-selected', format === 'tournament');
  document.getElementById('format-home')?.classList.toggle('format-selected', format === 'home');
  const variantGroup = document.getElementById('variant-selection-group');
  if (variantGroup) variantGroup.style.display = format === 'tournament' ? 'block' : 'none';
  // Rebuys toggle only relevant for tournaments (home games always allow rebuys)
  const rebuysGroup = document.getElementById('rebuys-toggle-group');
  if (rebuysGroup) rebuysGroup.style.display = format === 'tournament' ? 'block' : 'none';
  if (format === 'home') {
    BLIND_LEVELS = HOME_BLIND_LEVELS.map(l => ({ ...l }));
  } else {
    BLIND_LEVELS = DEFAULT_BLIND_LEVELS.map(l => ({ ...l }));
  }
  toggleBlindEditorSection();
  updateCreateGameSummary();
}

let gameRebuysEnabled = false;
function onRebuysToggle(checked) {
  gameRebuysEnabled = !!checked;
  updateCreateGameSummary();
}

function selectGameVariant(variant) {
  gameVariant = variant;
  document.getElementById('variant-holdem')?.classList.toggle('format-selected', variant === 'holdem');
  ['omaha', 'pineapple', 'crazy_pineapple', 'draw5', 'stud5'].forEach((v) =>
    document.getElementById('variant-' + v)?.classList.toggle('format-selected', variant === v));
  updateCreateGameSummary();
}

function updateCreateGameSummary() {
  const el = document.getElementById('create-game-summary');
  if (!el) return;
  const variantName = (VARIANTS[gameVariant] || VARIANTS.holdem).name;
  if (gameFormat === 'tournament') {
    const rebuyTag = gameRebuysEnabled ? ' · Rebuys allowed' : '';
    el.innerHTML = `<strong style="color:var(--text)">Sit & Go · ${variantName}</strong><br>1500 starting chips · Moderate blinds${rebuyTag}`;
  } else {
    el.innerHTML = `<strong style="color:var(--text)">Home Game</strong><br>2,000 chips each · 5/10 blinds · Dealer's choice each hand`;
  }
}

function updateLobbyVariantBadge() {
  const el = document.getElementById('lobby-variant-badge');
  if (!el) return;
  if (gameFormat === 'home') {
    el.textContent = `HOME GAME · ${chipAmt(gameBuyIn * 100)} CHIPS · DEALER'S CHOICE`;
  } else {
    const cfg = VARIANTS[gameVariant] || VARIANTS.holdem;
    el.textContent = cfg.short + ' · ' + cfg.description;
  }
}

// ── LOBBY HOST MIGRATION ──────────────────────────────────────────────────────
// If host leaves the lobby before starting, promote the next joined player
let _lobbyWatchdog = null;
let _lobbyHostCheckInterval = null;

function startLobbyHostWatch(gameId) {
  // Non-host players watch for the host leaving (game deleted entirely)
  clearInterval(_lobbyHostCheckInterval);
  _lobbyHostCheckInterval = setInterval(async () => {
    if (!currentLobbyId) { clearInterval(_lobbyHostCheckInterval); return; }
    try {
      const { data: game } = await sb.from('games')
        .select('id, status').eq('id', gameId).maybeSingle();

      // Host killed the lobby — kick guest back to home
      if (!game || game.status === 'finished') {
        clearInterval(_lobbyHostCheckInterval);
        toast('Host closed the lobby');
        sessionStorage.setItem('fr_auto_restore', '1');
        setTimeout(() => { window.location.href = window.location.pathname; }, 800);
      }
    } catch(e) { /* silent */ }
  }, 5000); // check every 5s
}

function stopLobbyWatchdog() {
  clearInterval(_lobbyWatchdog); _lobbyWatchdog = null;
  clearInterval(_lobbyHostCheckInterval); _lobbyHostCheckInterval = null;
}

async function ensureFriendsLoaded() {
  if (me.id === 'demo') return;
  // Always refresh: friends accepted since the Friends tab was last opened
  // must show up in the lobby invite list
  try {
    const { data } = await sb.from('friendships')
      .select(`id,requester_id,addressee_id,
        requester:users!requester_id(id,display_name,avatar_emoji),
        addressee:users!addressee_id(id,display_name,avatar_emoji)`)
      .or(`requester_id.eq.${me.id},addressee_id.eq.${me.id}`)
      .eq('status','accepted');
    myFriends = (data||[]).map(f => {
      const fr = f.requester_id === me.id ? f.addressee : f.requester;
      return {...fr, friendshipId: f.id};
    });
  } catch(e) { console.warn('ensureFriendsLoaded error:', e); }
}

function renderLobbyFriendList() {
  const fList = document.getElementById('lobby-friend-invite-list');
  if (!fList) return;

  // Get IDs already in this lobby (invited or joined) to show correct button state
  const alreadyIn = new Set(lobbyPlayers.map(p => p.user?.id || p.user_id));

  if (!myFriends.length) {
    fList.innerHTML = `<div style="color:var(--text-dim);font-size:0.85rem;padding:8px 0">Add friends to invite them</div>`;
    return;
  }

  const uninvited = myFriends.filter(f => !alreadyIn.has(f.id));

  fList.innerHTML = `
    ${uninvited.length > 1 ? `
      <button class="btn btn-ghost btn-full btn-sm" onclick="inviteAllFriends()"
        style="margin-bottom:8px;color:var(--gold)">📨 Invite All Friends</button>` : ''}
    ${myFriends.map(f => {
      const inLobby = alreadyIn.has(f.id);
      return `
        <div class="list-row" style="padding:8px 0;border:none">
          <div class="avatar sm">${f.avatar_emoji||f.display_name[0]}</div>
          <div class="list-row-info"><div class="name" style="font-size:0.88rem">${f.display_name}</div></div>
          ${inLobby
            ? `<span class="badge badge-green" style="font-size:0.7rem">In Lobby</span>`
            : `<button class="btn btn-ghost btn-sm" onclick="inviteFriend('${f.id}','${f.display_name}')">Invite</button>`}
        </div>`;
    }).join('')}`;
}

async function inviteAllFriends() {
  const alreadyIn = new Set(lobbyPlayers.map(p => p.user?.id || p.user_id));
  const toInvite = myFriends.filter(f => !alreadyIn.has(f.id));
  if (!toInvite.length) { toast('All friends already in lobby'); return; }
  for (const f of toInvite) {
    await new Promise(resolve => {
      inviteFriend(f.id, f.display_name);
      setTimeout(resolve, 200); // small delay between inserts
    });
  }
  toast(`Invited ${toInvite.length} friend${toInvite.length !== 1 ? 's' : ''} ✓`);
}

