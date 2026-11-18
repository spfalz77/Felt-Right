// ════════════════════════════════════════════════════════════════════════════
// INSTALLS + FEATURE SWITCHES
// ════════════════════════════════════════════════════════════════════════════
// Every install registers once (a random id kept on the device) so the server
// can count downloads. Features that open at a threshold (public games: a beta
// at 300 app downloads) switch themselves on in the database when the count
// is reached; the app reads the switches with feature_status().
// See supabase/migrations/20261117090000_installs_and_feature_flags.sql.

let FEATURES = {}; // { key: { state, threshold, installs, reached_at } }

function featureState(key) { return FEATURES[key]?.state || 'off'; }
function featureOn(key) { return ['beta', 'on'].includes(featureState(key)); }

function installId() {
  try {
    let id = localStorage.getItem('fr_install_id');
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15);
          return (c === 'x' ? r : (r & 3) | 8).toString(16);
        }));
      localStorage.setItem('fr_install_id', id);
    }
    return id;
  } catch (e) { return null; }
}

async function registerInstall() {
  if (!sb) return;
  const id = installId();
  if (!id) return;
  const platform = IS_NATIVE_APP ? window.Capacitor.getPlatform() : 'web';
  let version = null;
  try { version = IS_NATIVE_APP ? (await nativePlugin('App')?.getInfo())?.version || null : null; } catch (e) {}
  try { await sb.rpc('register_install', { p_install_id: id, p_platform: platform, p_version: version }); }
  catch (e) { console.warn('register_install:', e); }
}

async function loadFeatures() {
  if (!sb) return;
  try {
    const { data, error } = await sb.rpc('feature_status');
    if (error) throw error;
    FEATURES = Object.fromEntries((data || []).map((f) => [f.key, f]));
    // (tests switch features on in their own page only)
    if (window.FEATURE_OVERRIDES) Object.assign(FEATURES, window.FEATURE_OVERRIDES);
  } catch (e) { console.warn('feature_status:', e); }
  renderPublicGamesCard();
  applyGuestPlaySwitch();
  renderAccountPanel();
}

// Friends screen: where public games will live
function renderPublicGamesCard() {
  const el = document.getElementById('public-games-card');
  if (!el) return;
  const f = FEATURES.public_games;
  if (!f || f.state === 'off') { el.style.display = 'none'; return; }
  el.style.display = 'block';
  const count = Number(f.installs || 0);
  const goal = Number(f.threshold || 0);
  if (f.state === 'coming_soon') {
    const pct = goal ? Math.min(100, Math.round((count / goal) * 100)) : 0;
    el.innerHTML = `
      <div style="font-weight:600;font-size:0.9rem">Public games: coming soon</div>
      <div style="font-size:0.75rem;color:var(--text-dim);margin-top:3px;line-height:1.4">
        Get asked to join open tables with players beyond your friends. Opens as a beta at
        ${goal.toLocaleString()} app downloads.
      </div>
      <div style="margin-top:8px;height:6px;border-radius:3px;background:var(--surface2);overflow:hidden" role="progressbar"
        aria-valuemin="0" aria-valuemax="${goal}" aria-valuenow="${count}" aria-label="App downloads">
        <div style="height:100%;width:${pct}%;background:var(--gold)"></div>
      </div>
      <div style="font-size:0.7rem;color:var(--text-dim);margin-top:4px">${count.toLocaleString()} of ${goal.toLocaleString()} downloads</div>`;
  } else {
    el.innerHTML = `
      <div style="font-weight:600;font-size:0.9rem">Public games: beta</div>
      <div style="font-size:0.75rem;color:var(--text-dim);margin-top:3px;line-height:1.4">
        We passed ${goal.toLocaleString()} downloads. Asking to join public games arrives in the next update.
      </div>`;
  }
}

// On every open (signed in or not), once the database client exists (init()):
// count this install, read the switches
function startFeatures() { registerInstall().then(loadFeatures); }
