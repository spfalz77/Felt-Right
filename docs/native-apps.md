# Android and iPhone apps

The store apps are the same page as the website, wrapped by [Capacitor](https://capacitorjs.com).

## How it fits together
- `npm run build` writes `index.html` and copies bundled files into `vendor/` (supabase-js and fonts from `node_modules`; nothing loads from a CDN).
- `npm run build:app` builds `www/` (index.html, vendor/, icons, manifest): the bundle the apps ship with.
- `npm run app:sync` = `build:app` + `npx cap sync`, which copies `www/` into `android/` and `ios/`.
- `capacitor.config.json`: app id `com.feltright.app`, name, splash and system-bar settings.
- `src/js/41-native.js`: native-only behaviour (haptics for `navigator.vibrate`, keep the screen on at a table, Android back button, refresh on resume). Every bit is a no-op in a browser.
- Shared links (invites, password reset) always use `PUBLIC_APP_URL` (`src/js/00-config.js`), because inside the app the page's own address is `https://localhost`.
- Icons and splash screens are generated from `assets/` with `npx capacitor-assets generate --android --ios` (see the PR that added them for the colour flags).
- A web change reaches the apps only through a new app build; the website still updates on every merge.

## Builds (`.github/workflows/apps.yml`)
- **Android:** every PR and push builds a test APK (artifact `felt-right-android`). On `main` it is also published to the `android-latest` release: https://github.com/spfalz77/Felt-Right/releases/tag/android-latest. It's signed with a fixed debug key (`android/app/debug.keystore`, committed, test-only) and `versionCode` = the run number, so a newer test build installs over an older one.
- **iPhone:** compiled for the simulator, unsigned, on macOS, to keep the project working. Nothing to install yet.

## Install the Android test build
On the Android phone, open the release page above, tap `felt-right.apk`, and allow installs from the browser when asked.

## Still to do
- **Google Play:** a Play Console account ($25 once); a release upload key kept as GitHub secrets; build a signed `.aab`; content rating questionnaire ("Simulated Gambling"); privacy policy URL; internal testing track first.
- **iPhone:** Apple developer account ($99/yr); signing certificates + provisioning profile as GitHub secrets; build and upload to TestFlight from the macOS job.
- Push notifications ("your turn", "game starting"): Firebase Cloud Messaging (Android) and APNs (iPhone), sent from Supabase.
- Invite links opening the app (Android App Links / iOS Universal Links).
