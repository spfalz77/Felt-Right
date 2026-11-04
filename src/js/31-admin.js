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

async function killStuckGames() {
  if (me.id === 'demo') { toast('Not available in demo'); return; }
  if (me.display_name !== 'Fallz') { toast('Admin only'); return; }
  if (!confirm('⚠️ Delete ALL games and history for every user?')) return;
  try {
    const { error: e1 } = await sb.from('player_actions').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    const { error: e2 } = await sb.from('game_players').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    const { error: e3 } = await sb.from('games').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (e1 || e2 || e3) {
      const msg = (e1||e2||e3).message;
      toast('Delete error — run SQL policies. ' + msg);
      return;
    }
    _gamesKilled = true;
    myGames = [];
    renderGamesList();
    toast('All games cleared ✓');
    // Re-enable normal loading after 3s
    setTimeout(() => { _gamesKilled = false; }, 3000);
  } catch(e) { toast('Kill failed: ' + e.message); }
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

