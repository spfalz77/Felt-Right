// ════════════════════════════════════════════════════════════════════════════
// PUSH NOTIFICATIONS — game starting, your turn, you've been set Away
// ════════════════════════════════════════════════════════════════════════════
// The server (the `table` function) sends them; this file signs the device up.
//   Website / home-screen app: Web Push through sw.js (a service worker).
//   Android app: Firebase Cloud Messaging through @capacitor/push-notifications,
//     once the app is built with Firebase set up (NATIVE_PUSH_READY, set by
//     scripts/build-app.mjs when android/app/google-services.json exists).
// A device's token is stored with save_push_token and removed on sign out or
// when notifications are turned off. Pushes aren't shown while the app is on
// screen (the service worker skips them; Android only shows them in the background).

const NATIVE_PUSH_READY = false;
let _pushToken = null;   // what this device registered, to remove on sign out
let _pushActive = false; // server pushes are on for this device

function pushPlatform() {
  if (IS_NATIVE_APP) return window.Capacitor.getPlatform(); // 'android' | 'ios'
  return 'web';
}

// Can this device get pushes at all? (iPhone Safari: only from the Home Screen app)
function pushSupported() {
  if (IS_NATIVE_APP) return pushPlatform() === 'android' && NATIVE_PUSH_READY && !!nativePlugin('PushNotifications');
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}
function pushUnsupportedReason() {
  if (IS_NATIVE_APP) return 'Coming soon in the app';
  const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (iOS && !navigator.standalone) return 'On iPhone: Share → Add to Home Screen, then open it from there';
  return 'This browser can’t get notifications';
}

// The service worker (website only). Registered on every load so it stays current.
let _swReg = null;
async function pushServiceWorker() {
  if (_swReg || IS_NATIVE_APP || !('serviceWorker' in navigator)) return _swReg;
  try { _swReg = await navigator.serviceWorker.register('sw.js'); await navigator.serviceWorker.ready; }
  catch (e) { console.warn('service worker:', e); _swReg = null; }
  return _swReg;
}

async function savePushToken(platform, token, subscription) {
  const { error } = await sb.rpc('save_push_token', { p_platform: platform, p_token: token, p_subscription: subscription || null });
  if (error) throw error;
  _pushToken = token;
  _pushActive = true;
}

async function webPushKey() {
  const { data, error } = await sb.functions.invoke('table', { body: { action: 'push_key' } });
  if (error || !data?.key) throw error || new Error('no push key');
  return data.key;
}
const b64urlToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

// Sign this device up. ask=true may show the permission prompt (needs a tap on
// the website); ask=false only renews a signup the person already allowed.
async function enablePush({ ask = false } = {}) {
  if (!sb || !me || me.id === 'demo' || !pushSupported()) return false;
  try {
    if (IS_NATIVE_APP) return await enableNativePush(ask);
    if (Notification.permission === 'denied') return false;
    if (Notification.permission !== 'granted') {
      if (!ask) return false;
      if (await Notification.requestPermission() !== 'granted') return false;
    }
    const reg = await pushServiceWorker();
    if (!reg) return false;
    const key = await webPushKey();
    let sub = await reg.pushManager.getSubscription();
    // A subscription made with a different key can't be used
    if (sub && sub.options?.applicationServerKey) {
      const old = new Uint8Array(sub.options.applicationServerKey);
      const want = b64urlToBytes(key);
      if (old.length !== want.length || old.some((b, i) => b !== want[i])) { await sub.unsubscribe(); sub = null; }
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(key) });
    const json = sub.toJSON();
    await savePushToken('web', json.endpoint, { endpoint: json.endpoint, keys: json.keys });
    return true;
  } catch (e) {
    console.warn('enablePush:', e);
    return false;
  }
}

let _nativePushListening = false;
async function enableNativePush(ask) {
  const P = nativePlugin('PushNotifications');
  let perm = await P.checkPermissions();
  if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
    if (!ask && localStorage.getItem('fr_push_asked') === '1') return false;
    try { localStorage.setItem('fr_push_asked', '1'); } catch (e) {}
    perm = await P.requestPermissions();
  }
  if (perm.receive !== 'granted') return false;
  if (!_nativePushListening) {
    _nativePushListening = true;
    await P.createChannel({ id: 'game', name: 'Game alerts', description: 'Game starting, your turn, set Away', importance: 5, visibility: 1, vibration: true }).catch(() => {});
    P.addListener('registration', (t) => {
      savePushToken(pushPlatform(), t.value, null).catch((e) => console.warn('save push token:', e));
    });
    P.addListener('registrationError', (e) => console.warn('push registration:', e));
    // Tapping a notification opens the app; the usual rejoin takes it to the table
    P.addListener('pushNotificationActionPerformed', () => {
      try { document.dispatchEvent(new Event('visibilitychange')); } catch (e) {}
    });
  }
  await P.register();
  return true;
}

async function disablePush() {
  const token = _pushToken;
  _pushActive = false;
  _pushToken = null;
  try {
    if (token && sb) await sb.rpc('remove_push_token', { p_token: token });
    if (!IS_NATIVE_APP && _swReg) { const sub = await _swReg.pushManager.getSubscription(); if (sub) await sub.unsubscribe(); }
    if (IS_NATIVE_APP) await nativePlugin('PushNotifications')?.unregister?.();
  } catch (e) { console.warn('disablePush:', e); }
}

// After sign-in: renew this device's signup if notifications are on
function syncPushOnSignIn() {
  if (typeof _notificationsEnabled !== 'undefined' && !_notificationsEnabled) return;
  // Android app: ask once (Android 13+ shows the system prompt)
  enablePush({ ask: IS_NATIVE_APP }).then(() => {
    if (typeof updateNotificationButton === 'function') updateNotificationButton();
    renderPushLobbyCard();
  });
}

// Lobby: offer notifications once, before the game starts
function renderPushLobbyCard() {
  const el = document.getElementById('push-lobby-card');
  if (!el) return;
  let dismissed = false;
  try { dismissed = localStorage.getItem('fr_push_card_dismissed') === '1'; } catch (e) {}
  const show = !!me && me.id !== 'demo' && pushSupported() && !_pushActive && !dismissed &&
    !(IS_NATIVE_APP ? false : Notification.permission === 'denied');
  el.style.display = show ? 'flex' : 'none';
}
async function onPushLobbyTurnOn() {
  const ok = await enablePush({ ask: true });
  if (ok) {
    _notificationsEnabled = true;
    try { localStorage.setItem('fr_notifications_enabled', '1'); } catch (e) {}
    toast('Notifications on');
  } else toast('Notifications are blocked. Turn them on in your phone’s settings.');
  renderPushLobbyCard();
  if (typeof updateNotificationButton === 'function') updateNotificationButton();
}
function dismissPushLobbyCard() {
  try { localStorage.setItem('fr_push_card_dismissed', '1'); } catch (e) {}
  renderPushLobbyCard();
}

if (!IS_NATIVE_APP) pushServiceWorker();
