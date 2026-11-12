// ════════════════════════════════════════════════════════════════════════════
// ADMIN / CLEANUP
// ════════════════════════════════════════════════════════════════════════════
function toggleAdminBar() {
  const bar = document.getElementById('admin-bar');
  bar.style.display = bar.style.display === 'none' || bar.style.display === '' ? 'flex' : 'none';
}

async function archiveMyGames() {
  if (me.id === 'demo') { toast('Not available in demo'); return; }
  try {
    let archivedCount = 0;

    // 1. Mark stale lobbies (older than 1hr) as finished
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: stale } = await sb.from('games')
      .select('id').eq('host_id', me.id).eq('status', 'lobby').lt('created_at', cutoff);
    if (stale?.length) {
      for (const g of stale) await sb.from('games').update({ status: 'finished' }).eq('id', g.id);
      archivedCount += stale.length;
    }

    // 2. Remove my game_players row for any finished games — these will no longer appear
    //    in my home screen since loadGames joins through game_players
    const finishedIds = myGames.filter(g => g.status === 'finished').map(g => g.id);
    if (finishedIds.length) {
      const { error: delErr } = await sb.from('game_players')
        .delete()
        .eq('user_id', me.id)
        .in('game_id', finishedIds);
      if (delErr) console.warn('archive delete error:', delErr);
      else archivedCount += finishedIds.length;
    }

    if (!archivedCount) { toast('Nothing to archive'); return; }
    toast(`Archived ${archivedCount} game${archivedCount === 1 ? '' : 's'}`);
    await loadGames();
  } catch(e) { toast('Archive failed: ' + e.message); }
}

let _gamesKilled = false; // flag to prevent loadGames from re-populating after a kill

// Ends every active game I host that's stuck: a server game the same way the
// host's End Game does (home game: cash out; tournament: called off), a
// phone-run game is marked finished. Only games I host: the database doesn't
// let anyone end, delete or un-seat other people's games.
async function killStuckGames() {
  if (me.id === 'demo') { toast('Not available in demo'); return; }
  const { data: rows, error } = await sb.from('games')
    .select('id, name, state').eq('host_id', me.id).eq('status', 'active');
  if (error) { toast('Could not load your games: ' + error.message); return; }
  if (!rows?.length) { toast('You have no active games to end'); return; }
  if (!confirm(`End ${rows.length} active game${rows.length === 1 ? '' : 's'} you host? Home games cash out; tournaments are called off with nothing recorded.`)) return;
  let ended = 0;
  for (const g of rows) {
    if (isServerState(g.state)) {
      const r = await callTable(g.id, 'end_game');
      if (!r.error) ended++;
      else console.warn('end_game', g.id, r.error);
    } else {
      const { error: e } = await sb.from('games').update({ status: 'finished', finished_at: new Date().toISOString() }).eq('id', g.id);
      if (!e) ended++;
    }
  }
  toast(`Ended ${ended} of ${rows.length} game${rows.length === 1 ? '' : 's'}`);
  await loadGames();
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  const hrs  = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  if (days > 0)  return `${days}d ago`;
  if (hrs > 0)   return `${hrs}h ago`;
  if (mins > 0)  return `${mins}m ago`;
  return 'just now';
}

function ordinal(n) {
  const s = ['th','st','nd','rd'];
  const v = n%100;
  return n + (s[(v-20)%10]||s[v]||s[0]);
}

function formatPhone(input) {
  let v = input.value.replace(/\D/g,'').slice(0,10);
  if (v.length >= 6) v = `(${v.slice(0,3)}) ${v.slice(3,6)}-${v.slice(6)}`;
  else if (v.length >= 3) v = `(${v.slice(0,3)}) ${v.slice(3)}`;
  input.value = v;
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// Hard refresh the app. Clears any cached assets (in case a service worker or the
// browser served stale files) and reloads. Used as a recovery action when the
// backend hiccups or state gets stuck.
async function refreshApp() {
  try {
    // If a service worker is ever registered, clear its caches first
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    if (navigator.serviceWorker?.getRegistrations) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
  } catch(e) { /* ignore — still reload */ }
  // Mark that we want to auto-restore session on reload (so the user isn't
  // bounced to the login screen if they were logged in)
  try { sessionStorage.setItem('fr_auto_restore', '1'); } catch(e) {}
  // Cache-busting reload
  location.reload();
}

