# Felt Right — notes for Claude

- Edit files in `src/`, never `index.html` directly. After any change run `npm run build`, then `npm test` and `npm run check`.
- All `src/js/NN-*.js` files are concatenated into ONE classic `<script>` (shared globals, inline `onclick` handlers). Don't add `import`/`export` there; new files need a number prefix for load order.
- Pure rules (cards, hand eval, payouts, side pots, formats/variants) live in `supabase/functions/_shared/engine/*.js` as ES modules, shared with the server. `scripts/build.mjs` inlines them into the app wherever a `src/js` file has `/* @engine name.js */` (it strips `import`/`export`). Edit rules there, not in `src/js/01-engine.js`. Add a test in `tests/engine.test.mjs` for any rule change.
- Server migration plan: `docs/server-authoritative-migration.md` (one phase per PR, branch `server-rules-phase-N`).
- Backend: Supabase project `dcfsbtefwkcbdeqreiyx`. Tables: users, friendships, games, game_players, player_actions, private_hands, game_messages, payout_ledger, user_stats_public, user_stats_private. The current game model is host-authoritative (host's device runs the table); the plan is to move rules server-side.
- Home-game ledger entries are written only by the DB function `settle_home_game_ledger(game_id)` (both sides of each pair, from `games.state`). Don't insert home-game ledger rows from the client. Quitters keep their take-home stack in `cashedOutCents`.
- Chips are play chips only. Keep the ledger disclaimer wording intact (signup, Friends Ledger, cash-out).
- Hosted on GitHub Pages at `/Felt-Right/` from the repo root of `main`.
