// ════════════════════════════════════════════════════════════════════════════
// ACCOUNTS — sign in with an emailed code, unique player names, delete account
// ════════════════════════════════════════════════════════════════════════════
// Getting-in plan, phase 2. Behind the email_code_login switch (it needs an
// email sender and code templates set up in the Supabase dashboard): while
// it's off, the splash keeps the password forms and guests "create an
// account" by signing out first.
//
//   Sign in / create account: email → 6-digit code (signInWithOtp/verifyOtp).
//   A guest verifying: updateUser({ email }) → code (type email_change) →
//     the same user id, now a verified player (the guest's results were never
//     saved, so history starts here).
//   Player names: unique among verified players (player_name_problem /
//     set_player_name in 20261118090000_verified_players.sql). Asked once:
//     after the first code sign-in, after a guest verifies, or when an older
//     account's name clashes with someone else's.
//   Delete account: the `account` Edge Function.

function codeLoginOn() { return featureOn('email_code_login'); }

// The splash's account panel: code form or password forms
function renderAccountPanel() {
  const on = codeLoginOn();
  const code = document.getElementById('account-code');
  const pass = document.getElementById('account-password');
  if (code) code.style.display = on ? '' : 'none';
  if (pass) pass.style.display = on ? 'none' : '';
}

let _codeEmail = '';
function showCodeStep(step) {
  document.getElementById('code-step-email').style.display = step === 'email' ? '' : 'none';
  document.getElementById('code-step-code').style.display = step === 'code' ? '' : 'none';
  if (step === 'code') setTimeout(() => document.getElementById('code-input')?.focus(), 50);
}

const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

async function sendSignInCode(again) {
  const email = again ? _codeEmail : (document.getElementById('code-email').value || '').trim().toLowerCase();
  if (!validEmail(email)) { toast('Enter your email address'); return; }
  const btn = document.getElementById('code-send-btn');
  if (btn) btn.disabled = true;
  try {
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
    if (error) {
      console.warn('signInWithOtp:', error);
      toast(/rate|seconds/i.test(error.message || '') ? 'Wait a minute before asking for another code' : 'Couldn’t send the code. Try again.');
      return;
    }
    _codeEmail = email;
    document.getElementById('code-sent-to').textContent = email;
    document.getElementById('code-input').value = '';
    showCodeStep('code');
    if (again) toast('New code sent');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function verifySignInCode() {
  const token = (document.getElementById('code-input').value || '').replace(/\D/g, '');
  if (token.length !== 6) { toast('Enter the 6-digit code'); return; }
  const btn = document.getElementById('code-verify-btn');
  btn.disabled = true;
  try {
    const { data, error } = await sb.auth.verifyOtp({ email: _codeEmail, token, type: 'email' });
    if (error || !data?.user) { toast('That code didn’t work. Check it or send a new one.'); return; }
    me = await getProfile(data.user.id);
    if (!me) { toast('Couldn’t sign in. Try again.'); return; }
    showCodeStep('email');
    enterApp();
  } finally {
    btn.disabled = false;
  }
}

// ── A guest verifying: same identity, now kept ─────────────────────────────
function startGuestVerify() {
  if (!isGuest()) return;
  if (!codeLoginOn()) { leaveGuestForAccount(); return; }
  let el = document.getElementById('modal-verify');
  if (!el) {
    el = document.createElement('div');
    el.className = 'modal-backdrop';
    el.id = 'modal-verify';
    el.onclick = (e) => { if (e.target === el) closeModal('modal-verify'); };
    el.innerHTML = `
      <div class="modal-sheet" onclick="event.stopPropagation()">
        <div class="modal-handle"></div>
        <div class="modal-title">Keep your results</div>
        <div id="verify-step-email">
          <div style="font-size:0.82rem;color:var(--text-dim);line-height:1.5;margin-bottom:12px">
            Add your email and we’ll send a 6-digit code. You keep playing as you; from now on your
            Standings, stats and friends are saved, and you can host games.</div>
          <form onsubmit="event.preventDefault();sendVerifyCode()">
            <div class="input-group">
              <label class="input-label" for="verify-email">Email</label>
              <input class="input" id="verify-email" type="email" autocomplete="email" placeholder="you@example.com">
            </div>
            <button type="submit" class="btn btn-primary btn-full" id="verify-send-btn">Email me a code</button>
          </form>
          <div id="verify-exists" style="display:none;margin-top:12px;font-size:0.82rem;line-height:1.5">
            That email already has a Felt Right account.
            <button class="btn btn-ghost btn-full" style="margin-top:8px" onclick="signInInsteadOfGuest()">Sign in to that account</button>
          </div>
        </div>
        <div id="verify-step-code" style="display:none">
          <div style="font-size:0.82rem;color:var(--text-dim);line-height:1.5;margin-bottom:12px">
            Enter the code we sent to <span id="verify-sent-to" style="color:var(--text)"></span>.</div>
          <form onsubmit="event.preventDefault();verifyGuestCode()">
            <div class="input-group">
              <label class="input-label" for="verify-code">Code</label>
              <input class="input code-input" id="verify-code" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6"
                autocomplete="one-time-code" placeholder="123456">
            </div>
            <button type="submit" class="btn btn-primary btn-full" id="verify-code-btn">Verify</button>
          </form>
        </div>
        <button class="btn btn-ghost btn-full" style="margin-top:8px" onclick="closeModal('modal-verify')">Not now</button>
      </div>`;
    document.body.appendChild(el);
  }
  document.getElementById('verify-step-email').style.display = '';
  document.getElementById('verify-step-code').style.display = 'none';
  document.getElementById('verify-exists').style.display = 'none';
  openModal('modal-verify');
}

let _verifyEmail = '';
async function sendVerifyCode() {
  const email = (document.getElementById('verify-email').value || '').trim().toLowerCase();
  if (!validEmail(email)) { toast('Enter your email address'); return; }
  const btn = document.getElementById('verify-send-btn');
  btn.disabled = true;
  try {
    const { error } = await sb.auth.updateUser({ email });
    if (error) {
      console.warn('verify updateUser:', error);
      if (error.code === 'email_exists' || /already.*(registered|exists)/i.test(error.message || '')) {
        _verifyEmail = email;
        document.getElementById('verify-exists').style.display = 'block';
      } else toast('Couldn’t send the code. Try again.');
      return;
    }
    _verifyEmail = email;
    document.getElementById('verify-sent-to').textContent = email;
    document.getElementById('verify-step-email').style.display = 'none';
    document.getElementById('verify-step-code').style.display = '';
    setTimeout(() => document.getElementById('verify-code')?.focus(), 50);
  } finally {
    btn.disabled = false;
  }
}

async function verifyGuestCode() {
  const token = (document.getElementById('verify-code').value || '').replace(/\D/g, '');
  if (token.length !== 6) { toast('Enter the 6-digit code'); return; }
  const btn = document.getElementById('verify-code-btn');
  btn.disabled = true;
  try {
    const { error } = await sb.auth.verifyOtp({ email: _verifyEmail, token, type: 'email_change' });
    if (error) { toast('That code didn’t work. Check it or try again.'); return; }
    await sb.auth.refreshSession();
    const guestName = me.display_name;
    me = await getProfile(me.id);
    closeModal('modal-verify');
    applyGuestMode();
    await askPlayerName(guestName);
    enterApp();
    toast('You’re verified. Your results are saved from now on.');
  } finally {
    btn.disabled = false;
  }
}

// The email belongs to an existing account: leave guest mode and sign in there
async function signInInsteadOfGuest() {
  closeModal('modal-verify');
  await signOut();
  showAccountPanel('login');
  document.getElementById('code-email').value = _verifyEmail;
  sendSignInCode();
}

// ── Player names ───────────────────────────────────────────────────────────
const NAME_PROBLEMS = {
  length: 'Use 3–20 characters',
  characters: 'Letters, numbers, spaces, - and _ only',
  reserved: 'That name is reserved',
  taken: 'Taken. Try another',
};

let _nameResolve = null;
let _nameCheckTimer = null;
function askPlayerName(prefill) {
  let el = document.getElementById('modal-player-name');
  if (!el) {
    el = document.createElement('div');
    el.className = 'modal-backdrop';
    el.id = 'modal-player-name';
    el.innerHTML = `
      <div class="modal-sheet" onclick="event.stopPropagation()">
        <div class="modal-handle"></div>
        <div class="modal-title">Pick your player name</div>
        <div style="font-size:0.82rem;color:var(--text-dim);line-height:1.5;margin-bottom:12px">
          It’s yours alone: how friends find you and how you show on Rankings.</div>
        <form onsubmit="event.preventDefault();savePlayerName()">
          <div class="input-group">
            <label class="input-label" for="player-name-input">Player name</label>
            <input class="input" id="player-name-input" type="text" maxlength="20" autocomplete="nickname"
              oninput="checkPlayerName()" aria-describedby="player-name-status">
            <div id="player-name-status" role="status" style="font-size:0.75rem;margin-top:6px;min-height:1em"></div>
          </div>
          <button type="submit" class="btn btn-primary btn-full" id="player-name-btn">Save name</button>
        </form>
      </div>`;
    document.body.appendChild(el);
  }
  const input = document.getElementById('player-name-input');
  input.value = (prefill || '').replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 20);
  openModal('modal-player-name');
  checkPlayerName();
  setTimeout(() => input.focus(), 50);
  return new Promise((resolve) => { _nameResolve = resolve; });
}

function checkPlayerName() {
  clearTimeout(_nameCheckTimer);
  const status = document.getElementById('player-name-status');
  const name = (document.getElementById('player-name-input').value || '').trim();
  status.textContent = '';
  if (!name) return;
  _nameCheckTimer = setTimeout(async () => {
    const { data, error } = await sb.rpc('player_name_problem', { p_name: name });
    if (error) return;
    if ((document.getElementById('player-name-input').value || '').trim() !== name) return; // typed on
    status.style.color = data ? 'var(--red-light)' : 'var(--gold)';
    status.textContent = data ? NAME_PROBLEMS[data] || 'Try another name' : '✓ Available';
  }, 300);
}

async function savePlayerName() {
  const name = (document.getElementById('player-name-input').value || '').trim();
  const btn = document.getElementById('player-name-btn');
  btn.disabled = true;
  try {
    const { data, error } = await sb.rpc('set_player_name', { p_name: name });
    if (error) {
      const status = document.getElementById('player-name-status');
      status.style.color = 'var(--red-light)';
      status.textContent = NAME_PROBLEMS[(error.message || '').trim()] || 'Couldn’t save that name';
      return;
    }
    me.display_name = data || name;
    me.name_set = true;
    closeModal('modal-player-name');
    const r = _nameResolve; _nameResolve = null;
    if (r) r(me.display_name);
  } finally {
    btn.disabled = false;
  }
}

// After entering the app: a verified player without a name of their own picks one
function ensurePlayerName() {
  if (!codeLoginOn() || !me || isGuest() || me.name_set || me.id === 'demo') return;
  askPlayerName(me.display_name).then(() => enterApp());
}

// Profile name edits for verified players go through set_player_name
async function saveVerifiedName(name) {
  const { data, error } = await sb.rpc('set_player_name', { p_name: name });
  if (error) throw new Error(NAME_PROBLEMS[(error.message || '').trim()] || 'Couldn’t save that name');
  return data || name;
}

// ── Delete account ─────────────────────────────────────────────────────────
async function deleteAccount() {
  if (!me || isGuest() || !sb) return;
  if (!confirm('Delete your Felt Right account? Your name, friends, stats and Standings are removed for good. This can’t be undone.')) return;
  if (!confirm('Are you sure? This is permanent.')) return;
  try {
    const { data, error } = await sb.functions.invoke('account', { body: { action: 'delete' } });
    if (error || !data?.ok) throw error || new Error('delete failed');
    await disablePush().catch(() => {});
    await sb.auth.signOut().catch(() => {});
    me = null; G = null;
    document.getElementById('nav').classList.remove('visible');
    showScreen('splash');
    toast('Your account was deleted');
  } catch (e) {
    console.warn('delete account:', e);
    toast('Couldn’t delete the account. Try again.');
  }
}
