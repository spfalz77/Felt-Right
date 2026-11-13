// ════════════════════════════════════════════════════════════════════════════
// STATS TRACKING
// ════════════════════════════════════════════════════════════════════════════
// Each client tracks its OWN stats (host-authoritative game state determines outcomes,
// but stat persistence is per-user). Updates happen at end of each hand and at tournament end.

let _myPublicStats = null;
let _myPrivateStats = null;
let _statsThisHand = null; // tracks per-hand events so we update once at hand end

function resetHandStats() {
  _statsThisHand = {
    hand_played: false,        // any hand we participated in
    voluntarily_in: false,     // VPIP - put money in the pot non-blind
    pre_flop_raised: false,    // PFR
    three_bet_made: false,     // raised over a previous raise pre-flop
    three_bet_faced: false,    // someone 3-bet me preflop
    three_bet_folded: false,   // folded to a 3-bet
    bets_made: 0,
    raises_made: 0,
    calls_made: 0,
    saw_river: false,
    river_called: false,
    river_folded: false,
    went_to_showdown: false,
    won_at_showdown: false,
    won_hand: false,
    won_amount: 0,
    lost_amount: 0,
    all_in_taken: false,
    won_all_in: false,
    final_hand_rank: null,     // 1=high, 9=straight flush, etc. higher = better
    final_hand_label: null,
    is_bad_beat_loser: false,
    pot_at_end: 0,
  };
}
resetHandStats();

async function loadMyStats() {
  if (!sb || !me?.id || me.id === 'demo') return;
  try {
    const [pub, priv] = await Promise.all([
      sb.from('user_stats_public').select('*').eq('user_id', me.id).maybeSingle(),
      sb.from('user_stats_private').select('*').eq('user_id', me.id).maybeSingle(),
    ]);
    _myPublicStats = pub.data || makeEmptyPublicStats();
    _myPrivateStats = priv.data || makeEmptyPrivateStats();
  } catch(e) { console.warn('loadMyStats:', e); }
}

function makeEmptyPublicStats() {
  return {
    user_id: me.id, tournaments_played: 0, tournaments_won: 0, second_place: 0, third_place: 0,
    total_chips_won: 0, best_finish: null, hands_played: 0, hands_won: 0,
    best_hand_rank: null, best_hand_label: null,
    biggest_pot_won: 0, biggest_pot_lost: 0,
    worst_bad_beat_pot: 0, worst_bad_beat_label: null,
    all_in_wins: 0, all_in_losses: 0, showdowns_played: 0, showdowns_won: 0,
  };
}

function makeEmptyPrivateStats() {
  return {
    user_id: me.id, hands_dealt: 0, vpip_count: 0, pfr_count: 0,
    three_bet_count: 0, three_bet_faced: 0, three_bet_folded: 0,
    bets_made: 0, raises_made: 0, calls_made: 0,
    river_seen: 0, river_called: 0, river_folded: 0,
  };
}

async function commitHandStats() {
  if (!sb || !me?.id || me.id === 'demo') return;
  if (!_myPublicStats || !_myPrivateStats) return;
  if (!_statsThisHand.hand_played) { resetHandStats(); return; }

  const s = _statsThisHand;
  const pub = _myPublicStats;
  const priv = _myPrivateStats;

  // PUBLIC stats
  pub.hands_played = (pub.hands_played || 0) + 1;
  if (s.won_hand) {
    pub.hands_won = (pub.hands_won || 0) + 1;
    if (s.won_amount > (pub.biggest_pot_won || 0)) pub.biggest_pot_won = s.won_amount;
  }
  if (s.went_to_showdown) {
    pub.showdowns_played = (pub.showdowns_played || 0) + 1;
    if (s.won_at_showdown) pub.showdowns_won = (pub.showdowns_won || 0) + 1;
    else if (s.pot_at_end > (pub.biggest_pot_lost || 0)) pub.biggest_pot_lost = s.pot_at_end;
  }
  if (s.final_hand_rank && (!pub.best_hand_rank || s.final_hand_rank > pub.best_hand_rank)) {
    pub.best_hand_rank = s.final_hand_rank;
    pub.best_hand_label = s.final_hand_label;
  }
  if (s.all_in_taken) {
    if (s.won_all_in) pub.all_in_wins = (pub.all_in_wins || 0) + 1;
    else pub.all_in_losses = (pub.all_in_losses || 0) + 1;
  }
  if (s.is_bad_beat_loser && s.pot_at_end > (pub.worst_bad_beat_pot || 0)) {
    pub.worst_bad_beat_pot = s.pot_at_end;
    pub.worst_bad_beat_label = s.final_hand_label;
  }

  // PRIVATE stats
  priv.hands_dealt = (priv.hands_dealt || 0) + 1;
  if (s.voluntarily_in) priv.vpip_count = (priv.vpip_count || 0) + 1;
  if (s.pre_flop_raised) priv.pfr_count = (priv.pfr_count || 0) + 1;
  if (s.three_bet_made) priv.three_bet_count = (priv.three_bet_count || 0) + 1;
  if (s.three_bet_faced) priv.three_bet_faced = (priv.three_bet_faced || 0) + 1;
  if (s.three_bet_folded) priv.three_bet_folded = (priv.three_bet_folded || 0) + 1;
  priv.bets_made = (priv.bets_made || 0) + s.bets_made;
  priv.raises_made = (priv.raises_made || 0) + s.raises_made;
  priv.calls_made = (priv.calls_made || 0) + s.calls_made;
  if (s.saw_river) {
    priv.river_seen = (priv.river_seen || 0) + 1;
    if (s.river_called) priv.river_called = (priv.river_called || 0) + 1;
    if (s.river_folded) priv.river_folded = (priv.river_folded || 0) + 1;
  }

  try {
    await sb.from('user_stats_public').upsert({ ...pub, updated_at: new Date().toISOString() });
    await sb.from('user_stats_private').upsert({ ...priv, updated_at: new Date().toISOString() });
  } catch(e) { console.warn('commitHandStats:', e); }

  resetHandStats();
}

async function commitTournamentStats(placement, finalChips) {
  if (!sb || !me?.id || me.id === 'demo') return;
  if (!_myPublicStats) return;
  const pub = _myPublicStats;
  pub.tournaments_played = (pub.tournaments_played || 0) + 1;
  if (placement === 1) pub.tournaments_won = (pub.tournaments_won || 0) + 1;
  else if (placement === 2) pub.second_place = (pub.second_place || 0) + 1;
  else if (placement === 3) pub.third_place = (pub.third_place || 0) + 1;
  if (finalChips > 0) pub.total_chips_won = (pub.total_chips_won || 0) + finalChips;
  if (placement && (!pub.best_finish || placement < pub.best_finish)) pub.best_finish = placement;

  try {
    await sb.from('user_stats_public').upsert({ ...pub, updated_at: new Date().toISOString() });
  } catch(e) { console.warn('commitTournamentStats:', e); }
}

async function loadOtherUserPublicStats(userId) {
  if (!sb || !userId) return null;
  try {
    const { data } = await sb.from('user_stats_public').select('*').eq('user_id', userId).maybeSingle();
    return data || makeEmptyPublicStats();
  } catch(e) { console.warn('loadOtherUserPublicStats:', e); return null; }
}

function toggleSounds() {
  _soundsEnabled = !_soundsEnabled;
  try { localStorage.setItem('fr_sounds_enabled', _soundsEnabled ? '1' : '0'); } catch(e) {}
  updateSoundButton();
  if (_soundsEnabled) {
    playChipSound();
    toast('Sounds enabled');
  } else {
    toast('Sounds muted');
  }
}

function updateSoundButton() {
  const btn = document.getElementById('sound-toggle-btn');
  if (!btn) return;
  btn.textContent = _soundsEnabled ? 'On' : 'Off';
  btn.style.color = _soundsEnabled ? 'var(--gold)' : 'var(--text-dim)';
  btn.style.borderColor = _soundsEnabled ? 'var(--gold-dim)' : 'var(--border)';
}

async function toggleNotifications() {
  // If currently on (or unset), turning off
  if (_notificationsEnabled) {
    _notificationsEnabled = false;
    try { localStorage.setItem('fr_notifications_enabled', '0'); } catch(e) {}
    disablePush();
    updateNotificationButton();
    toast('Notifications off');
    return;
  }

  // Turning on: sign this device up for pushes from the server
  if (pushSupported()) {
    if (!(await enablePush({ ask: true }))) { toast('Notifications are blocked. Turn them on in your phone’s settings.'); updateNotificationButton(); return; }
  } else if ('Notification' in window) {
    if (Notification.permission === 'denied') {
      toast('Browser notifications are blocked — enable in site settings');
      return;
    }
    if (Notification.permission !== 'granted') {
      try {
        const result = await Notification.requestPermission();
        if (result !== 'granted') {
          toast('Permission denied');
          return;
        }
      } catch(e) {
        toast('Could not request permission');
        return;
      }
    }
  }

  _notificationsEnabled = true;
  try { localStorage.setItem('fr_notifications_enabled', '1'); } catch(e) {}
  updateNotificationButton();
  toast('Notifications on');
}

function updateNotificationButton() {
  const btn = document.getElementById('notif-toggle-btn');
  if (!btn) return;
  // If browser permission is denied, show "Blocked"
  if ('Notification' in window && Notification.permission === 'denied') {
    btn.textContent = 'Blocked';
    btn.style.color = 'var(--red-light)';
    btn.style.borderColor = 'rgba(192,57,43,0.4)';
    return;
  }
  btn.textContent = _notificationsEnabled ? 'On' : 'Off';
  btn.style.color = _notificationsEnabled ? 'var(--gold)' : 'var(--text-dim)';
  btn.style.borderColor = _notificationsEnabled ? 'var(--gold-dim)' : 'var(--border)';
}

function toggleStatExplain(labelEl) {
  if (!labelEl) return;
  // DOM structure:
  //   outer-div  <-- this is what we want
  //     flex-row     <-- labelEl.parentElement
  //       label   <-- labelEl
  //       value
  //     stat-explain  <-- the div we're toggling
  const outerWrapper = labelEl.parentElement?.parentElement;
  if (!outerWrapper) return;
  const explainDiv = outerWrapper.querySelector('.stat-explain');
  if (!explainDiv) return;

  const explanation = labelEl.dataset.explain || '';
  if (explainDiv.style.display === 'block') {
    explainDiv.style.display = 'none';
    explainDiv.textContent = '';
  } else {
    explainDiv.textContent = explanation;
    explainDiv.style.display = 'block';
  }
}

async function clearMyPublicStats() {
  if (!confirm('Clear all your public stats? This cannot be undone.')) return;
  try {
    await sb.from('user_stats_public').delete().eq('user_id', me.id);
    _myPublicStats = makeEmptyPublicStats();
    toast('Public stats cleared');
    if (typeof renderProfileStats === 'function') renderProfileStats();
  } catch(e) { toast('Failed: ' + e.message); }
}

async function clearMyPrivateStats() {
  if (!confirm('Clear all your private stats? This cannot be undone.')) return;
  try {
    await sb.from('user_stats_private').delete().eq('user_id', me.id);
    _myPrivateStats = makeEmptyPrivateStats();
    toast('Private stats cleared');
    if (typeof renderProfileStats === 'function') renderProfileStats();
  } catch(e) { toast('Failed: ' + e.message); }
}

const HAND_RANK_LABELS = {
  1: 'High Card', 2: 'Pair', 3: 'Two Pair', 4: 'Three of a Kind',
  5: 'Straight', 6: 'Flush', 7: 'Full House', 8: 'Four of a Kind',
  9: 'Straight Flush', 10: 'Royal Flush'
};

// Subscribe to chat events to update UI
onChatEvent((evt) => {
  updateChatBadge();
  const panel = document.getElementById('chat-panel');
  const panelOpen = panel && panel.style.display === 'flex';

  if (panelOpen) {
    renderChatMessages();
    const list = document.getElementById('chat-messages');
    if (list) setTimeout(() => { list.scrollTop = list.scrollHeight; }, 50);
    // If panel is open, auto-mark as read
    if (evt.type === 'new' && evt.message?.sender_id !== me.id) {
      markChatRead();
    }
  } else if (evt.type === 'new' && evt.message?.sender_id !== me.id) {
    // Panel closed — notify the recipient
    const msg = evt.message;
    const preview = msg.text.length > 60 ? msg.text.slice(0, 57) + '…' : msg.text;
    showChatNotification(`${msg.sender_emoji || '🃏'} ${msg.sender_name}: ${preview}`);
    if (navigator.vibrate) navigator.vibrate(40);
    // Browser notification if app in background
    if (_notificationsEnabled && 'Notification' in window && Notification.permission === 'granted' &&
        document.visibilityState !== 'visible') {
      new Notification('Felt Right — Table Chat', {
        body: `${msg.sender_name}: ${preview}`,
        tag: 'chat-' + msg.game_id,
      });
    }
  }
});

function showChatNotification(text) {
  let el = document.getElementById('chat-notification');
  if (!el) {
    el = document.createElement('div');
    el.id = 'chat-notification';
    el.style.cssText = `
      position: fixed; top: calc(var(--safe-top) + 60px); left: 50%;
      transform: translateX(-50%) translateY(-20px);
      background: var(--surface); border: 1px solid var(--gold-dim);
      border-radius: 12px; padding: 10px 14px; z-index: 450;
      color: var(--text); font-size: 0.85rem; line-height: 1.3;
      max-width: 320px; box-shadow: 0 6px 24px rgba(0,0,0,0.5);
      opacity: 0; transition: all 0.25s; cursor: pointer;
      display: flex; align-items: center; gap: 8px;
    `;
    el.onclick = () => {
      openChatPanel();
      hideChatNotification();
    };
    document.body.appendChild(el);
  }
  el.textContent = text;
  // Force reflow then animate in
  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translateX(-50%) translateY(0)';
  });

  clearTimeout(_chatNotifTimer);
  _chatNotifTimer = setTimeout(hideChatNotification, 4000);
}

function hideChatNotification() {
  const el = document.getElementById('chat-notification');
  if (!el) return;
  el.style.opacity = '0';
  el.style.transform = 'translateX(-50%) translateY(-20px)';
}
let _chatNotifTimer = null;

