// ════════════════════════════════════════════════════════════════════════════
// REFRESH, ON EVERY SCREEN
// ════════════════════════════════════════════════════════════════════════════
// Pull down from the top of any screen (or tap a ↻ button) to fetch that
// screen's data again, without reloading the app:
//   Home → games and invites · Friends → friends and Standings · Me → profile
//   and stats · Lobby → who's joined · Table → the latest table, cards and turn
// A full reload (the old ↻) is still in Settings → Reload app, and on the
// sign-in screen.

let _refreshing = false;

function activeScreenId() {
  return document.querySelector('.screen.active')?.id?.replace('screen-', '') || '';
}

async function refreshCurrentScreen() {
  if (_refreshing) return;
  _refreshing = true;
  pullIndicator('spin');
  try {
    const id = activeScreenId();
    const isDemo = !me || me.id === 'demo';
    if (id === 'home') {
      await Promise.all([loadGames(), isDemo ? null : checkForNewInvites()]);
    } else if (id === 'friends') {
      await Promise.all([loadFriends(), renderLedger(), loadFeatures()]);
    } else if (id === 'profile') {
      await loadProfileScreen();
    } else if (id === 'lobby') {
      if (currentLobbyId && !isDemo) await refreshLobbyRoster(currentLobbyId);
    } else if (id === 'game') {
      // Same path as coming back to the app: latest table, my cards, my turn
      document.dispatchEvent(new Event('visibilitychange'));
      if (!isDemo && typeof isServerGame === 'function' && isServerGame()) await refreshGuestState();
    } else {
      location.reload(); // sign-in screen: nothing to fetch, start fresh
      return;
    }
  } catch (e) {
    console.warn('refresh:', e);
    toast('Couldn’t refresh. Check your connection.');
  } finally {
    _refreshing = false;
    pullIndicator('done');
  }
}

// ── Pull to refresh ────────────────────────────────────────────────────────
const PULL_TRIGGER_PX = 70;
let _pull = null; // { startY, startX, dy, el }

function pullIndicator(state, dy = 0) {
  let el = document.getElementById('pull-refresh');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pull-refresh';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = '<span class="pull-refresh-icon">↻</span>';
    document.body.appendChild(el);
  }
  el.classList.toggle('ready', state === 'pull' && dy >= PULL_TRIGGER_PX);
  el.classList.toggle('spinning', state === 'spin');
  if (state === 'pull') {
    el.style.transition = 'none';
    el.style.opacity = String(Math.min(dy / PULL_TRIGGER_PX, 1));
    el.style.transform = `translate(-50%, ${Math.min(dy, PULL_TRIGGER_PX * 1.4) * 0.6}px) rotate(${dy * 3}deg)`;
  } else if (state === 'spin') {
    el.style.transition = 'transform 0.15s, opacity 0.15s';
    el.style.opacity = '1';
    el.style.transform = `translate(-50%, ${PULL_TRIGGER_PX * 0.6}px)`;
  } else {
    el.style.transition = 'transform 0.25s, opacity 0.25s';
    el.style.opacity = '0';
    el.style.transform = 'translate(-50%, 0)';
  }
}

// The pull starts only when everything under the finger is scrolled to the top
function atTop(target, screen) {
  for (let n = target; n && n !== document.body; n = n.parentElement) {
    if (n.scrollTop > 0) return false;
    if (n === screen) return true;
  }
  return true;
}

document.addEventListener('touchstart', (e) => {
  if (_refreshing || e.touches.length !== 1) return;
  const screen = document.querySelector('.screen.active');
  if (!screen || document.querySelector('.modal-backdrop.open')) return;
  const t = e.target;
  if (t.closest && t.closest('input, textarea, select, [data-no-pull]')) return;
  if (!atTop(t, screen)) return;
  _pull = { startY: e.touches[0].clientY, startX: e.touches[0].clientX, dy: 0 };
}, { passive: true });

document.addEventListener('touchmove', (e) => {
  if (!_pull) return;
  const dy = e.touches[0].clientY - _pull.startY;
  const dx = Math.abs(e.touches[0].clientX - _pull.startX);
  if (dy <= 0 || dx > dy) { if (_pull.dy) pullIndicator('done'); _pull = null; return; } // scrolling or swiping sideways
  _pull.dy = dy;
  pullIndicator('pull', dy);
}, { passive: true });

document.addEventListener('touchend', () => {
  if (!_pull) return;
  const pulled = _pull.dy >= PULL_TRIGGER_PX;
  _pull = null;
  if (pulled) refreshCurrentScreen();
  else pullIndicator('done');
});
document.addEventListener('touchcancel', () => { if (_pull) { _pull = null; pullIndicator('done'); } });
