# Felt Right — notes for Claude

- Edit files in `src/`, never `index.html` directly. After any change run `npm run build`, then `npm test` and `npm run check`.
- All `src/js/NN-*.js` files are concatenated into ONE classic `<script>` (shared globals, inline `onclick` handlers). Don't add `import`/`export` there; new files need a number prefix for load order.
- Engine logic lives in `src/js/01-engine.js` (hand eval, payouts, blinds) and `25-side-pots.js`. Add a test in `tests/engine.test.mjs` for any rule change.
- Backend: Supabase project `dcfsbtefwkcbdeqreiyx`. Tables: users, friendships, games, game_players, player_actions, private_hands, game_messages, payout_ledger, user_stats_public, user_stats_private. The current game model is host-authoritative (host's device runs the table); the plan is to move rules server-side.
- Chips are play chips only. Keep the ledger disclaimer wording intact (signup, Friends Ledger, cash-out).
- Hosted on GitHub Pages at `/Felt-Right/` from the repo root of `main`.
