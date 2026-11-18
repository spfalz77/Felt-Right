// ════════════════════════════════════════════════════════════════════════════
// GUESTS — play without an account (getting-in plan, phase 1)
// ════════════════════════════════════════════════════════════════════════════
// "Play now" signs in anonymously (Supabase anonymous sign-in) with a name and
// an avatar: a real user id, so server games, presence and notifications all
// work. A guest can join any game they're invited to (a ?join= link or an
// invite) and sees results at the table, but nothing is saved for them: the
// database blocks hosting (until the guest_hosting switch is on), friends and
// stats, and drops Standings rows that involve a guest.
// See supabase/migrations/20261117200000_guest_entry.sql.

const GUEST_AVATARS = ['🃏', '🦊', '🐙', '🦉', '🐻', '🦁', '🐢', '🦄', '🐺', '🐸', '🦈', '🌵'];
let _guestAvatar = GUEST_AVATARS[Math.floor(Math.random() * GUEST_AVATARS.length)];

function isGuest() { return !!(me && me.is_guest); }

// ── Splash ─────────────────────────────────────────────────────────────────
function renderGuestAvatars() {
  const el = document.getElementById('guest-avatars');
  if (!el) return;
  el.innerHTML = GUEST_AVATARS.map((a) => `
    <button type="button" role="radio" aria-checked="${a === _guestAvatar}" aria-label="Avatar ${a}"
      onclick="pickGuestAvatar('${a}')">${a}</button>`).join('');
}
function pickGuestAvatar(a) { _guestAvatar = a; renderGuestAvatars(); }

// The splash shows "Play now" only when the guest_play switch is on (it needs
// Anonymous sign-ins enabled in the Supabase dashboard); otherwise sign in /
// create account, as before. Once someone picks a panel, it stays put.
let _splashPicked = false;
function applyGuestPlaySwitch() {
  const on = featureOn('guest_play');
  const back = document.getElementById('splash-back-to-guest');
  if (back) back.style.display = on ? '' : 'none';
  if (on && !_splashPicked) showGuestPanel(true);
  if (!on && pendingJoinCode()) {
    const acct = document.getElementById('splash-account-invite');
    if (acct) acct.style.display = 'block';
  }
}

function showAccountPanel(tab) {
  _splashPicked = true;
  document.getElementById('splash-play').style.display = 'none';
  document.getElementById('splash-account').style.display = '';
  if (tab) switchTab(tab);
}
function showGuestPanel(auto) {
  if (!auto) _splashPicked = true;
  document.getElementById('splash-account').style.display = 'none';
  document.getElementById('splash-play').style.display = '';
}

async function playAsGuest() {
  const name = (document.getElementById('guest-name').value || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2) { toast('Pick a name (2–20 characters)'); document.getElementById('guest-name').focus(); return; }
  if (!sb) { toast('Can’t reach Felt Right. Check your connection.'); return; }
  const btn = document.getElementById('guest-play-btn');
  btn.disabled = true;
  try {
    const { data, error } = await sb.auth.signInAnonymously({
      options: { data: { display_name: name.slice(0, 20), avatar_emoji: _guestAvatar } },
    });
    if (error) {
      console.warn('guest sign-in:', error);
      toast(/disabled/i.test(error.message || '') ? 'Playing as a guest isn’t switched on yet. Create an account for now.' : 'Couldn’t start. Try again.');
      return;
    }
    me = await getProfile(data.user.id);
    if (!me) { toast('Couldn’t start. Try again.'); return; }
    enterApp();
  } finally {
    btn.disabled = false;
  }
}

// A guest who wants friends, Standings or hosting: sign up for an account.
// (Phase 2 turns this into "verify": email + code, keeping the same identity.
// For now the guest signs out first; nothing was saved for them anyway.)
async function leaveGuestForAccount() {
  if (!isGuest()) return;
  if (!confirm('Create an account? You’ll leave guest mode on this phone. (Results from guest games aren’t saved.)')) return;
  await signOut();
  showAccountPanel('signup');
}

// Guests can host once the guest_hosting switch is on (after store launch)
function guestCanHost() { return !isGuest() || featureOn('guest_hosting'); }
function showGuestHostSheet() {
  let el = document.getElementById('modal-guest-host');
  if (!el) {
    el = document.createElement('div');
    el.className = 'modal-backdrop';
    el.id = 'modal-guest-host';
    el.onclick = (e) => { if (e.target === el) closeModal('modal-guest-host'); };
    el.innerHTML = `
      <div class="modal-sheet" onclick="event.stopPropagation()">
        <div class="modal-handle"></div>
        <div class="modal-title">Host a game <span class="badge-dev">In development</span></div>
        <div style="font-size:0.85rem;color:var(--text-dim);line-height:1.5;margin-bottom:14px">
          Hosting as a guest is coming after launch. Until then, guests can join any game they’re invited to.
          Create an account to host your own table now.
        </div>
        <button class="btn btn-primary btn-full" onclick="closeModal('modal-guest-host');leaveGuestForAccount()">Create an account</button>
        <button class="btn btn-ghost btn-full" style="margin-top:8px" onclick="closeModal('modal-guest-host')">Not now</button>
      </div>`;
    document.body.appendChild(el);
  }
  openModal('modal-guest-host');
}

// Applied on entering the app: body class drives what guests see
function applyGuestMode() {
  document.body.classList.toggle('is-guest', isGuest());
  const fab = document.querySelector('#screen-home .fab');
  if (fab) fab.setAttribute('aria-label', isGuest() && !featureOn('guest_hosting') ? 'Host a game (in development for guests)' : 'New game');
}

// ── Invite links: ?join=<code> ─────────────────────────────────────────────
// Kept for the session, so it survives choosing a name or signing in.
(function captureJoinCode() {
  try {
    const code = new URLSearchParams(location.search).get('join');
    if (!code) return;
    sessionStorage.setItem('fr_join', code);
    const url = new URL(location.href);
    url.searchParams.delete('join');
    history.replaceState(null, '', url.pathname + (url.search || '') + url.hash);
  } catch (e) {}
})();

function pendingJoinCode() { try { return sessionStorage.getItem('fr_join'); } catch (e) { return null; } }

function renderSplashInvite() {
  const invited = !!pendingJoinCode();
  const note = document.getElementById('guest-invite-note');
  if (note) note.style.display = invited ? 'block' : 'none';
  const btn = document.getElementById('guest-play-btn');
  if (btn) btn.textContent = invited ? 'Join the game' : 'Play now';
}

async function handlePendingJoin() {
  const code = pendingJoinCode();
  if (!code || !sb || !me) return;
  try { sessionStorage.removeItem('fr_join'); } catch (e) {}
  try {
    const { data, error } = await sb.rpc('game_for_code', { p_code: code });
    if (error) throw error;
    const game = (data || [])[0];
    if (!game) { toast('That game link has expired'); return; }
    if (game.status === 'active') {
      const { data: seat } = await sb.from('game_players').select('id').eq('game_id', game.id).eq('user_id', me.id).maybeSingle();
      if (!seat) { toast('That game has already started'); return; }
    }
    await openLobby(game.id);
  } catch (e) {
    console.warn('join link:', e);
    toast('Couldn’t open that game. Try the link again.');
  }
}

// ── At the end of a game: who counts ──────────────────────────────────────
// Adds one line under a results screen: guests' results aren't saved, and
// verified players' results against guests don't count in Standings.
async function noteGuestResults(container, playerIds) {
  if (!container || !sb || !playerIds?.length || container.querySelector('.guest-results-note')) return;
  let guests = [];
  try {
    const { data } = await sb.from('users').select('id, is_guest').in('id', playerIds);
    guests = (data || []).filter((u) => u.is_guest).map((u) => u.id);
  } catch (e) { return; }
  let text = '';
  if (isGuest()) text = 'You played as a guest: these results aren’t saved. Create an account to keep them next time.';
  else if (guests.length) text = 'Results against guests aren’t counted in Standings.';
  if (!text) return;
  const div = document.createElement('div');
  div.className = 'guest-results-note';
  div.style.cssText = 'font-size:0.75rem;color:var(--text-dim);text-align:center;margin:10px 0 0;line-height:1.4';
  div.textContent = text;
  container.appendChild(div);
}

renderGuestAvatars();
renderSplashInvite();
