# Felt Right

Texas Hold'em (plus Omaha and 3-card Guts) with friends. Installable web app, hosted on GitHub Pages, backed by Supabase.

Chips are play chips only. The chip ledger is a personal scorecard for self-moderation, not a record of real money.

## Layout

```
src/
  index.html        page markup (template with @inline markers)
  styles/app.css    all styles
  js/NN-*.js        app code, one file per area, loaded in number order
  js/debug-*.js     on-screen debug console
scripts/build.mjs   stitches src/ into ./index.html
tests/              unit tests for the poker engine
index.html          BUILT FILE — what GitHub Pages serves. Don't edit by hand.
```

## Working on it

```
npm run build   # regenerate index.html after editing src/
npm test        # engine tests (hand ranking, payouts, side pots)
npm run check   # fails if index.html is out of date with src/
```

CI runs all three on every push and pull request.

## Roadmap

1. ✅ Split the single file into source files, add build + tests
2. Move game rules server-side (Supabase Edge/database functions) so no one phone runs the table
3. Supabase Pro once regular play starts (free projects pause after a week idle)
4. App-store builds (Capacitor)
5. Poker trainer: CPU opponents with distinct play styles; ledger shows how you match up
