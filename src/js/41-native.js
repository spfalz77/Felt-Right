// ════════════════════════════════════════════════════════════════════════════
// NATIVE APP (Android / iPhone via Capacitor)
// ════════════════════════════════════════════════════════════════════════════
// The store apps run this same page inside a native shell. Everything here is
// a no-op in a normal browser. Plugins are reached through window.Capacitor.Plugins
// (the app is one classic script, no bundler).

function nativePlugin(name) {
  return IS_NATIVE_APP ? (window.Capacitor?.Plugins?.[name] || null) : null;
}

// Haptics: iPhones have no navigator.vibrate, so route the app's existing
// vibrate calls (turn alerts, long-press, nudges) to the native haptics.
(function nativeVibrate() {
  const H = nativePlugin('Haptics');
  if (!H) return;
  navigator.vibrate = function (pattern) {
    const total = Array.isArray(pattern)
      ? pattern.filter((_, i) => i % 2 === 0).reduce((a, b) => a + (Number(b) || 0), 0)
      : Number(pattern) || 0;
    if (total <= 0) return true;
    if (total <= 50) H.impact({ style: 'MEDIUM' }).catch(() => {});
    else H.vibrate({ duration: Math.min(total, 1000) }).catch(() => {});
    return true;
  };
})();

// Keep the screen on while you're at a table (a phone that sleeps mid-hand
// times out and goes Away). Checked every 2s; cheap, and covers every way in
// and out of a game.
let _nativeAwake = false;
function nativeKeepAwakeTick() {
  const K = nativePlugin('KeepAwake');
  if (!K) return;
  const atTable = !!document.getElementById('screen-game')?.classList.contains('active');
  if (atTable === _nativeAwake) return;
  _nativeAwake = atTable;
  (atTable ? K.keepAwake() : K.allowSleep()).catch(() => { _nativeAwake = !atTable; });
}
if (IS_NATIVE_APP) setInterval(nativeKeepAwakeTick, 2000);

// Android back button: close the top sheet, else go back to Home; on Home
// (or the sign-in screen) leave the app. At a table it never leaves the game:
// Quit is the way out, so a stray back press can't drop you from a hand.
(function nativeBackButton() {
  const App = nativePlugin('App');
  if (!App) return;
  App.addListener('backButton', () => {
    const open = Array.from(document.querySelectorAll('.modal-backdrop.open'));
    if (open.length) { open[open.length - 1].classList.remove('open'); return; }
    const active = document.querySelector('.screen.active')?.id?.replace('screen-', '');
    if (active === 'game') { toast('Use Quit to leave the table'); return; }
    if (active === 'lobby') { toast('Use Leave to leave the lobby'); return; }
    if (!active || active === 'home' || active === 'splash' || !me) { App.exitApp(); return; }
    navTo('home');
  });
})();

// Coming back to the app: the existing visibility handler refreshes the table.
// Android also pauses timers in the background, so nudge it on resume too.
(function nativeResume() {
  const App = nativePlugin('App');
  if (!App) return;
  App.addListener('resume', () => {
    try { document.dispatchEvent(new Event('visibilitychange')); } catch (e) {}
  });
})();
