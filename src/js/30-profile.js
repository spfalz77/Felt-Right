// ════════════════════════════════════════════════════════════════════════════
// PROFILE
// ════════════════════════════════════════════════════════════════════════════
const AVATAR_EMOJIS = [
  '🃏','♠','♥','♦','♣','🎰','🎲','🦁','🐯','🦊','🐺','🦝',
  '🐻','🐼','🐸','🦋','🔥','⚡','🌊','🌙','⭐','💎','👑','🎯',
  '🎱','🧠','👻','🤖','👽','🦄','🍀','🌶','🦅','🐉','🌈','🏆',
];

function loadProfileScreen() {
  document.getElementById('profile-name').value = me.display_name || '';
  if (document.getElementById('profile-email'))
    document.getElementById('profile-email').value = me.email || '';
  document.getElementById('profile-phone').value = me.phone
    ? me.phone.replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3')
    : '';
  const current = me.avatar_emoji || '🃏';
  document.getElementById('profile-avatar-display').textContent = current;

  const grid = document.getElementById('emoji-grid');
  if (grid) {
    grid.innerHTML = '';
    AVATAR_EMOJIS.forEach(e => {
      const btn = document.createElement('button');
      btn.textContent = e;
      btn.style.cssText = `
        background:${e === current ? 'rgba(212,168,67,0.2)' : 'none'};
        border:${e === current ? '1.5px solid var(--gold)' : '1.5px solid transparent'};
        border-radius:8px;font-size:1.5rem;padding:6px;cursor:pointer;
        display:flex;align-items:center;justify-content:center;`;
      btn.onclick = () => selectEmoji(e);
      grid.appendChild(btn);
    });
  }

  // Render stats section
  renderProfileStats();
  // Update settings buttons
  try {
    _soundsEnabled = localStorage.getItem('fr_sounds_enabled') !== '0';
    _notificationsEnabled = localStorage.getItem('fr_notifications_enabled') !== '0';
  } catch(e) {}
  updateSoundButton();
  updateNotificationButton();
}

function renderProfileStats() {
  const el = document.getElementById('profile-stats-section');
  if (!el) return;
  if (!_myPublicStats || !_myPrivateStats) {
    el.innerHTML = `<div style="color:var(--text-dim);font-size:0.85rem;padding:10px 0">Loading stats…</div>`;
    if (me?.id !== 'demo' && sb) loadMyStats().then(() => renderProfileStats());
    return;
  }
  el.innerHTML = renderStatsHtml(_myPublicStats, _myPrivateStats, true);
}

function renderStatsHtml(pub, priv, isOwnProfile) {
  if (!pub) pub = makeEmptyPublicStats();

  const winRate = pub.hands_played ? ((pub.hands_won / pub.hands_played) * 100).toFixed(1) : '—';
  const tournamentWinRate = pub.tournaments_played ? ((pub.tournaments_won / pub.tournaments_played) * 100).toFixed(0) : '—';
  const showdownWinRate = pub.showdowns_played ? ((pub.showdowns_won / pub.showdowns_played) * 100).toFixed(1) : '—';

  const statRow = (label, value) => `
    <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
      <div style="color:var(--text-dim);font-size:0.85rem">${label}</div>
      <div style="font-family:'Bebas Neue',sans-serif;font-size:1rem;color:var(--gold-pale);letter-spacing:0.04em">${value}</div>
    </div>`;

  // Same as statRow but the label is tappable to toggle an explanation row beneath
  const statRowExplain = (label, value, explanation) => {
    const safeExp = explanation.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
    return `
      <div style="border-bottom:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;padding:6px 0">
          <div onclick="toggleStatExplain(this)" style="color:var(--gold-pale);font-size:0.85rem;cursor:pointer;
            border-bottom:1px dotted var(--gold-dim);padding-bottom:1px;user-select:none"
            data-explain="${safeExp}">${label}</div>
          <div style="font-family:'Bebas Neue',sans-serif;font-size:1rem;color:var(--gold-pale);letter-spacing:0.04em">${value}</div>
        </div>
        <div class="stat-explain" style="display:none;font-size:0.78rem;color:var(--text-dim);
          padding:6px 10px 10px 4px;line-height:1.4;font-style:italic"></div>
      </div>`;
  };

  let html = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px;margin-bottom:12px">
      <div style="font-size:0.78rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:10px">
        🏆 Tournaments
      </div>
      ${statRow('Played', pub.tournaments_played || 0)}
      ${statRow('Wins', `${pub.tournaments_won || 0} (${tournamentWinRate}${tournamentWinRate==='—'?'':'%'})`)}
      ${statRow('2nd Place', pub.second_place || 0)}
      ${statRow('3rd Place', pub.third_place || 0)}
      ${statRow('Best Finish', pub.best_finish ? `#${pub.best_finish}` : '—')}
      ${statRow('Total Chips Won', (pub.total_chips_won || 0).toLocaleString())}
    </div>

    <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px;margin-bottom:12px">
      <div style="font-size:0.78rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:10px">
        🃏 Hand Stats
      </div>
      ${statRow('Hands Played', pub.hands_played || 0)}
      ${statRow('Hands Won', `${pub.hands_won || 0} (${winRate}${winRate==='—'?'':'%'})`)}
      ${statRow('Showdowns', `${pub.showdowns_won || 0}/${pub.showdowns_played || 0} (${showdownWinRate}${showdownWinRate==='—'?'':'%'})`)}
      ${statRow('Best Hand', pub.best_hand_label || '—')}
      ${statRow('Biggest Pot Won', (pub.biggest_pot_won || 0).toLocaleString())}
      ${statRow('Biggest Pot Lost', (pub.biggest_pot_lost || 0).toLocaleString())}
      ${statRow('Worst Bad Beat', pub.worst_bad_beat_pot ? `${pub.worst_bad_beat_label||'?'} for ${pub.worst_bad_beat_pot.toLocaleString()}` : '—')}
      ${statRow('All-In W/L', `${pub.all_in_wins || 0}/${pub.all_in_losses || 0}`)}
    </div>
  `;

  // Private stats only shown on own profile
  if (isOwnProfile && priv) {
    const vpip = priv.hands_dealt ? ((priv.vpip_count / priv.hands_dealt) * 100).toFixed(1) : '—';
    const pfr = priv.hands_dealt ? ((priv.pfr_count / priv.hands_dealt) * 100).toFixed(1) : '—';
    const totalActions = (priv.bets_made || 0) + (priv.calls_made || 0);
    const aggFactor = priv.calls_made ? (priv.bets_made / priv.calls_made).toFixed(2) : '—';
    const fold3bet = priv.three_bet_faced ? ((priv.three_bet_folded / priv.three_bet_faced) * 100).toFixed(1) : '—';
    const riverCallRate = priv.river_seen ? ((priv.river_called / priv.river_seen) * 100).toFixed(1) : '—';

    html += `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px;margin-bottom:12px">
        <div style="font-size:0.78rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:4px">
          🔒 Private — Playstyle
        </div>
        <div style="font-size:0.7rem;color:var(--text-dim);margin-bottom:10px;font-style:italic">
          Only you can see these. Tap a stat name to learn what it means.
        </div>
        ${statRowExplain('VPIP %', vpip + (vpip==='—'?'':'%'),
          'Voluntarily Put $ In Pot. The percent of hands where you chose to put money in pre-flop (calls or raises, not just blinds). High VPIP = loose; low VPIP = tight.')}
        ${statRowExplain('PFR %', pfr + (pfr==='—'?'':'%'),
          'Pre-Flop Raise. The percent of hands where you raised pre-flop. Aggressive players have high PFR. The gap between VPIP and PFR shows how often you call vs raise.')}
        ${statRowExplain('Aggression Factor', aggFactor,
          'Bets and raises divided by calls. Higher = more aggressive. AF below 1 means you call more than you bet/raise; above 2 is aggressive.')}
        ${statRowExplain('3-Bets Made', priv.three_bet_count || 0,
          'A 3-bet is when you re-raise after someone has already raised pre-flop. Tracks how often you put pressure with re-raises.')}
        ${statRowExplain('Fold to 3-Bet %', fold3bet + (fold3bet==='—'?'':'%'),
          'When someone 3-bets you pre-flop, how often you fold. High percentages can be exploited by aggressive opponents.')}
        ${statRowExplain('River Call %', riverCallRate + (riverCallRate==='—'?'':'%'),
          'When you reach the river, the percent of times you call a bet. High = you go to showdown often; low = you fold rivers easily.')}
        ${statRowExplain('Bets / Calls', `${priv.bets_made || 0} / ${priv.calls_made || 0}`,
          'Raw counts of times you bet or raised vs times you called. Used to compute Aggression Factor.')}
      </div>
    `;
  }

  // Reset buttons (only on own profile)
  if (isOwnProfile) {
    html += `
      <div style="display:flex;gap:10px;margin-bottom:12px">
        <button onclick="clearMyPublicStats()" style="flex:1;background:none;
          border:1px solid rgba(192,57,43,0.4);color:var(--red-light);
          font-size:0.78rem;padding:10px;border-radius:var(--r-sm);cursor:pointer">
          Clear Public Stats
        </button>
        <button onclick="clearMyPrivateStats()" style="flex:1;background:none;
          border:1px solid rgba(192,57,43,0.4);color:var(--red-light);
          font-size:0.78rem;padding:10px;border-radius:var(--r-sm);cursor:pointer">
          Clear Private Stats
        </button>
      </div>
    `;
  }

  return html;
}

function updateAvatarEverywhere(emoji) {
  const e = emoji || me?.avatar_emoji || '🃏';
  ['home-avatar','my-avatar','nav-profile-icon','profile-avatar-display'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = e;
  });
}

function toggleEmojiPicker() {
  const picker = document.getElementById('emoji-picker');
  picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
}

function selectEmoji(emoji) {
  me.avatar_emoji = emoji;
  updateAvatarEverywhere(emoji);
  loadProfileScreen();
  document.getElementById('emoji-picker').style.display = 'none';
}

async function saveProfile() {
  const name  = document.getElementById('profile-name').value.trim();
  const phone = document.getElementById('profile-phone').value.replace(/\D/g,'');
  const emoji = me.avatar_emoji || '🃏';
  if (!name) { toast("Name can't be empty"); return; }

  if (me.id === 'demo') {
    me.display_name = name; me.phone = phone;
    document.getElementById('home-greeting').textContent = `Hey, ${name.split(' ')[0]}`;
    toast('Profile updated!'); return;
  }

  try {
    const { error } = await sb.from('users')
      .update({ display_name: name, avatar_emoji: emoji, phone })
      .eq('id', me.id);
    if (error) throw error;
    me.display_name = name; me.phone = phone;
    document.getElementById('home-greeting').textContent = `Hey, ${name.split(' ')[0]}`;
    document.getElementById('my-name').textContent = name;
    updateAvatarEverywhere(emoji);
    toast('Profile saved ✓');
  } catch(e) { toast('Save failed: ' + e.message); }
}

async function signOut() {
  if (me.id !== 'demo' && sb) {
    await sb.auth.signOut();
  }
  me = null; myFriends = []; myGames = []; G = null;
  stopBlindTimer(); stopTurnTimer(); stopHostHeartbeat();
  stopDisconnectWatcher(); stopPresence();
  document.getElementById('nav').classList.remove('visible');
  showScreen('splash');
}
