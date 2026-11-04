// ════════════════════════════════════════════════════════════════════════════
// NAVIGATION
// ════════════════════════════════════════════════════════════════════════════
let screenStack = [];

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');
  document.querySelectorAll('.nav-item').forEach((n,i) => {
    const map = ['home','friends','profile'];
    n.classList.toggle('active', map[i] === id);
  });
  const hideNav = ['splash','lobby','game'].includes(id);
  document.getElementById('nav').classList.toggle('visible', !hideNav && !!me);
}

function navTo(id) {
  screenStack = [id];
  showScreen(id);
  if (id === 'friends') { loadFriends(); renderLedger(); }
  if (id === 'home')    loadGames();
  if (id === 'profile') loadProfileScreen();
}

function pushScreen(id) {
  screenStack.push(id);
  showScreen(id);
}

async function leaveLobby() {
  const lobbyId = currentLobbyId;
  const btn = document.getElementById('lobby-leave-btn');
  if (btn) { btn.style.pointerEvents = 'none'; btn.textContent = 'Leaving…'; }

  unsubscribeFromChat();
  stopNudgeListener();
  clearInterval(_lobbyStatusPoller);
  updateChatBadge();

  // Set flag so reload returns to home (not login screen)
  sessionStorage.setItem('fr_auto_restore', '1');

  if (lobbyId && me && me.id !== 'demo' && sb) {
    try {
      const { data: gameRow } = await sb.from('games')
        .select('host_id').eq('id', lobbyId).maybeSingle();

      if (gameRow) {
        if (gameRow.host_id === me.id) {
          // HOST LEAVING: kill the lobby for everyone — MUST await so it completes before reload
          await sb.from('game_players').delete().eq('game_id', lobbyId);
          await sb.from('games').delete().eq('id', lobbyId);
        } else {
          // GUEST LEAVING: revert to invited so they can rejoin
          await sb.from('game_players').update({ status: 'invited', seat_index: null })
            .eq('game_id', lobbyId).eq('user_id', me.id);
        }
      }
    } catch(e) { console.warn('leaveLobby error:', e); }
  }

  // Now safe to reload — DB ops completed
  window.location.href = window.location.pathname;
  return false;
}

function goBack() {
  leaveLobby();
  return false;
}

function switchTab(tab) {
  document.querySelectorAll('.splash-tab').forEach((t,i) => {
    t.classList.toggle('active', (i===0&&tab==='login')||(i===1&&tab==='signup'));
  });
  document.querySelectorAll('.tab-content').forEach((t,i) => {
    t.classList.toggle('active', (i===0&&tab==='login')||(i===1&&tab==='signup'));
  });
}

