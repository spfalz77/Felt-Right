// ════════════════════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════════════════════
async function init() {
  try {
    sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch(e) {
    console.warn('Supabase not configured, running in demo mode');
    enterDemoMode();
    return;
  }

  // Prefill saved email on login screen
  const savedEmail = localStorage.getItem('fr_email');
  if (savedEmail) {
    const el = document.getElementById('login-email');
    if (el) el.value = savedEmail;
  }

  // Check for existing session
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return; // stay on splash screen

    // User has a valid session — check if they're in an active game
    me = await getProfile(session.user.id);
    if (!me) return;
    me.email = session.user.email;

    // Look for an active game this user is still playing in. Not one they quit
    // (a tournament quitter is "away", blinding out) or were knocked out of:
    // those stay on Home, where the game card offers Sit Back Down.
    const { data: activeGames } = await sb.from('game_players')
      .select('game:games!inner(id, status, state)')
      .eq('user_id', me.id)
      .eq('game.status', 'active');

    const stillPlaying = (g) => {
      const mine = g.game?.state?.players?.find?.(p => p.id === me.id);
      return !mine || (!mine.awayFromTable && !mine.eliminated && mine.cashedOutCents == null);
    };
    const activeGame = (activeGames || []).find(g => g.game?.status === 'active' && stillPlaying(g));

    if (activeGame) {
      // Check if user has explicitly left this game — don't auto-rejoin
      let sitOutList = [];
      try { sitOutList = JSON.parse(localStorage.getItem('fr_sitout') || '[]'); } catch(e) {}

      if (!sitOutList.includes(activeGame.game.id)) {
        // Auto-rejoin active game bypassing login
        enterApp();
        setTimeout(() => rejoinActiveGame(activeGame.game.id, activeGame.game), 300);
        return;
      }
    }

    // Check the auto-restore flag for in-app reloads
    if (sessionStorage.getItem('fr_auto_restore') === '1') {
      sessionStorage.removeItem('fr_auto_restore');
      enterApp();
      return;
    }
  } catch(e) { console.warn('init auto-restore:', e); }

  // Default: show splash / login
}

function enterDemoMode() {
  me = { id: 'demo', display_name: 'You', avatar_emoji: '🃏' };
  // DEMO_FRIENDS defined near startGame — same list
  myFriends = [...DEMO_FRIENDS];
  myGames = [];
  enterApp();
}

function enterApp() {
  showScreen('home');
  document.getElementById('nav').classList.add('visible');
  document.getElementById('home-greeting').textContent = `Hey, ${me.display_name.split(' ')[0]}`;
  updateAvatarEverywhere(me.avatar_emoji);
  document.getElementById('my-name').textContent = me.display_name;

  const demoBanner = document.getElementById('demo-banner');
  if (demoBanner) demoBanner.style.display = me.id === 'demo' ? 'flex' : 'none';

  // Show admin kill button only for Fallz
  const killBtn = document.getElementById('admin-kill-btn');
  if (killBtn) killBtn.style.display = me.display_name === 'Fallz' ? 'inline-flex' : 'none';

  // Request notification permission for turn alerts
  if (me.id !== 'demo' && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  renderFriendsList();
  loadGames();
  loadMyStats();
  // Load saved settings preferences
  try {
    _soundsEnabled = localStorage.getItem('fr_sounds_enabled') !== '0';
    _notificationsEnabled = localStorage.getItem('fr_notifications_enabled') !== '0';
  } catch(e) {}

  // Auto-refresh home games every 20s while user is on home screen
  clearInterval(_homeRefreshInterval);
  _homeRefreshInterval = setInterval(() => {
    const homeScreen = document.getElementById('screen-home');
    if (homeScreen && homeScreen.classList.contains('active') &&
        document.visibilityState === 'visible' && me && me.id !== 'demo') {
      loadGames();
    }
  }, 20000);

  // Global: listen for game invites arriving in real time
  if (me.id !== 'demo' && sb) subscribeToInvites();
}

let _homeRefreshInterval = null;

