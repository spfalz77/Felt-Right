# Server-authoritative game rules — migration plan

_Status: **in progress.** Phases 0–5 done (PRs #19–#24, 2026-11-11); the server-rules tables and the games lock-down are on the live database. Phase 6a done (PR #25). Live-play fixes from the 2026-11-12 session in PR #32. Phase 6b-1 (this PR): server rules on for everyone. Next: 6b-2, deleting the phone-run engine. Written 2026-11-08, after PR #16. Roadmap step 2._
_To run it, ask Claude to "execute docs/server-authoritative-migration.md, phase N". Each phase is one PR, and each phase is merged only when the full E2E suite is green._

## Why

Today the **host's phone runs the table**. It shuffles, holds everyone's hole cards in memory, applies every move, runs the timers, and writes the result to `games.state`. Almost every serious bug found in PRs #7–#16 traces back to that:

- **Host takeover is fragile.** A new host can't see the other players' cards, so the hand in progress is voided (PR #11).
- **Timers live on phones.** They stall when a phone sleeps or drops, and they need presence-based workarounds (#9, #11, #14).
- **The host and the database can disagree.** That caused racing saves (#7), echoes overwriting the table (#11) and duplicate payouts (#15).
- **Security:** any signed-in user can `UPDATE games` (an RLS policy allows it), so a modified client could rewrite a table. The deck is also in the host's memory.

Moving the rules to the server makes one place the truth. Any phone can drop or reload without consequence, and there's no host migration, no voided hands and no client-writable game state.

## Target design

```
phone ──(action + JWT)──▶ Edge Function `table` ──▶ Postgres
  ▲                         • checks it's your turn / legal      games.state        (public, redacted; clients render this, as today)
  │                         • applies the rules (shared engine)  game_secrets       (deck + all hole cards; no client access)
  └──── realtime ◀──────────• writes the new state in one         private_hands      (your own cards, as today)
        (unchanged)           versioned update                    payout_ledger      (server writes both sides)
```

- **Edge Function** (Deno/TypeScript), not Postgres functions. Hand evaluation, side pots and Guts are already written and unit-tested in JS (`01-engine.js`, `25-side-pots.js`), and the server reuses them instead of rewriting them in SQL.
- **Shared engine:** the pure rules (deal, betting round, advance, showdown, payouts, Guts, chop math) move into ES modules under `engine/`. The browser build inlines them as it does today, the Edge Function imports them, and the unit tests cover both.
- **One writer, versioned:** every action is `read state+secrets → apply → write where version = n`. On a conflict it retries, so two moves can never race.
- **Clients become thin.** Every phone renders `games.state` and sends actions. The "host" keeps only lobby powers (start, settings, end game). `amHost` engine branches, host heartbeat and migration, and void-on-takeover are deleted.
- **Timers become deadlines.** `turnDeadline`, `dealerChoiceDeadline`, `gutsDeadline`, `rebuyDeadline`, `nextDealAt`, `levelEndsAt` and `breakEndsAt` live in state:
  - Any phone that sees a deadline pass calls `tick`.
  - The server checks it against server time and applies the auto-action: check if allowed, else fold; Hold'em on no pick; sit out on no re-buy answer.
  - **Backstop:** pg_cron calls `tick_all` every minute via pg_net, so a table with every phone asleep still moves.
- **Away / disconnected:** each phone sends a heartbeat every ~5s (`game_players.last_seen`). Gone means missing for 12s or more, the same rule as today but computed on the server. A gone player's turn auto-acts after 5s.
- **Ledger:** `settle_home_game_ledger` stays. **Tournaments:** the server writes both sides when the tournament ends. Nobody has to tap "Record to Friends Ledger", and ledgers can't be half-recorded.
- **Security:** drop `"Anyone authenticated can update games"`. Only the Edge Function (service role) writes `games`, `game_secrets`, `private_hands` and ledger rows.

### API (one function, `POST /functions/v1/table`)

`{ game_id, action, amount?, expect_version? }`. The caller is identified by their JWT.

| action | who | notes |
|---|---|---|
| `start` | host | builds players, deals hand 1 (or dealer's choice) |
| `fold` `check` `call` `raise` `allin` `twobb` `threebb` `pot` | player on turn | same amounts as today |
| `pick_variant` | dealer | holdem / omaha / guts3 |
| `guts_in` `guts_out` | any eligible | simultaneous |
| `rebuy` `sit_out` `add_on` `break_ready` | the player | |
| `quit` | the player | home: take stack home; tournament: blind out |
| `step_away` `sit_back` | the player | tournament away |
| `chop_offer` `chop_accept` `chop_decline` `chop_cancel` | heads-up players | |
| `pause` `resume` `end_game` | host | `end_game` = cash out (voids a hand in progress) |
| `reveal` `muck` | fold winner | |
| `tick` | anyone in the game | applies any passed deadline (no-op otherwise) |
| `heartbeat` | anyone | updates last_seen (could be a plain row update instead) |

**Test hooks** (only active when `ALLOW_TEST_HOOKS=1`, which is set only by the local CI stack):
- `rig` queues hole cards and a board, replacing today's `window.__feltRightRiggedHands`.
- `clock_offset` shifts server time, replacing `page.clock.fastForward` on the host.

## Progress

- ✅ **Phase 0 (PR #19):** shared engine modules in `supabase/functions/_shared/engine/` (cards, config, payouts, side pots), inlined into the app by `build.mjs`.
- ✅ **Phase 1 (PR #20):** `engine/table.js` (the table as pure functions), the `table` Edge Function, `game_secrets` + `save_table()`, a CI job that plays games over HTTP. The app doesn't use any of it yet. **Not deployed to the live project** (no live migration, no function deploy).
  - Already in the engine, ahead of plan: dealer's choice (Hold'em/Omaha), re-buy / sit out with the 60s limit, quit (both formats), cash-out with void, blind clock, `tick` for next-hand / dealer's-choice / re-buy deadlines.
  - Still to add in phase 3: Guts, first break + add-on, chop, pause, reveal/muck. Phase 4: turn deadlines and heartbeats.
  - Deliberate rule fixes on the server: a check is rejected when there's a bet to call; an all-in for less than the current bet no longer lowers the bet everyone else must match; cards are shuffled with a cryptographic generator.
- ✅ **Phase 2 (PR #21):** behind `SERVER_RULES` (off on live), every phone plays a server-run game through the guest code path. The host calls `start`; moves go to the function (`postAction`); a phone calls `tick` only when a deadline in state has passed, using the server's clock from each reply. Host-only buttons follow the lobby owner (`isTableHost()`), and server games never migrate the host. E2E helpers use the `rig` / `clock_offset` hooks. A CI job runs the phone tests on server rules.
- ✅ **Phase 3 (PR #22):** Guts (antes, in/out, pot matching), the first break with add-on, tournament heads-up chop, pause / resume, and show or muck after a fold win, all on the server. Each saved table carries a sequence number (`v` on the server, `syncSeq` on phone-run games), and phones ignore any copy older than the one on screen. Also fixed a lobby race where a guest who joined just before the host's subscription came up never appeared.
- ✅ **Phase 4 (PR #23):** turn deadlines, Away auto-act, heartbeats (`game_presence`) and a pg_cron backstop that ticks active server tables once a minute through pg_net. The cron job does nothing until the Vault secrets are set in phase 6. On server rules, closing the host's app hands the table to nobody: their turns are auto-acted and they rejoin as host. The function also keeps each player's own move count in `state.moves` (server games write no `player_actions` rows).
- ✅ **Phase 5 (PR #24):** when a server-run tournament ends, the function writes both sides of the Friends Ledger (`tournamentLedger` in `payouts.js`); the results screen shows "Recorded to ledger". Lock-down migration: only a game's host or players can update it, nobody's phone can update a server-run game, and only a host can delete their own lobby. Phone-run games (the live site) keep working; phase 6 removes phone writes to `games` entirely. Applied to the live project together with the phase 1 and 4 migrations (`game_secrets`, `save_table`, `game_presence`, the tick cron job, which stays idle until the Vault secrets exist). Also fixed: a repeated dealer's pick on a server game brought the picker back over the dealt hand.
- ✅ **Phase 6a (PR #25, live 2026-11-11):** `?server=1` opts a phone in to server rules (only the host's phone matters; everyone else follows the game; `?server=0` turns it off). The pg_cron backstop authenticates with a random secret generated in Vault (`table_tick_secret`, read by the function through `table_tick_secret()`, service role only). On the live project: migration applied, Vault entries `table_function_url` and `table_anon_key` added, `table` function deployed (verify_jwt on; the engine is bundled in `engine/` next to `index.ts`). Checked live: `tick_all` with the secret answers 200, without it 401.
  - Redeploying: the function was deployed through the Supabase connector. Any change under `supabase/functions/` needs a redeploy; a deploy workflow with a `SUPABASE_ACCESS_TOKEN` repo secret would make that automatic.
  - Real-phone session: the host opens `https://spfalz77.github.io/Felt-Right/?server=1`; others open the site normally. Worth trying: dealer's choice (Hold'em, Omaha, Guts), a re-buy, quitting, closing the app mid-hand and rejoining, the host closing the app, pause, cash out; and a tournament to the end (the ledger records itself).
- ✅ **Phase 6b-1 (2026-11-12):** `SERVER_RULES_DEFAULT = true`: every new game is run by the server; the `?server=` switch is gone. The phone-run engine stays (for the E2E phone-run shards) until 6b-2.
- ⏭ **Phase 6b-2:** `SERVER_RULES_DEFAULT = true` for everyone; once no phone-run games are left, drop the remaining phone update policy on `games`, the client `private_hands` writes and the per-player tournament ledger insert path, and delete the phone-run engine code.

## Phases and estimates

These are estimates of build time with Claude (hours of focused work, including CI runs), then your review and merge.

| # | Phase (one PR each) | What changes | Gate | Estimate |
|---|---|---|---|---|
| 0 | **Shared engine** | Move the pure rules into `engine/*.js` ES modules; `build.mjs` inlines them; unit tests import them. No behavior change. | unit + full E2E green | 3–4 h |
| 1 | **Server skeleton + Hold'em** | `game_secrets` table + RLS; Edge Function with auth, versioned write, `start`, betting actions, showdown/side pots; enable `edge-runtime` in local CI; test hooks `rig` + `clock_offset`. Clients still on the old path. | new server unit/integration tests | 6–8 h |
| 2 | **Clients switch for Hold'em** | Behind a flag (`SERVER_RULES`, default **off** on the live site): phones send actions to the server and stop running the hand. E2E helpers use the server rig/clock hooks. | home-game, side-pots, tournament, quit E2E green with the flag on | 5–7 h |
| 3 | **Everything else** | Dealer's choice, Omaha, Guts progression, re-buys, break + add-on, chop, pause, cash-out/void, step-away. | all E2E green with the flag on (except timer/disconnect) | 6–8 h |
| 4 | **Timers + disconnects** | Deadlines + `tick` + pg_cron backstop + heartbeat. Remove host enforcer, presence-based auto-act, host migration. Rewrite turn-timer, dealer-choice, disconnect E2E for the new model (no host takeover; "host closes app" just keeps playing). | full E2E green with the flag on | 5–7 h |
| 5 | **Ledger + lock-down** | Server writes tournament ledger (both sides); drop the client `UPDATE games` policy; clients can't write game rows at all. Migration applied to the live DB. | full E2E + an RLS test that a client update is rejected | 3–4 h |
| 6 | **Cutover** | Flag **on** for the live site after a real-phone session; then delete the old host engine code. | live game with real players; E2E green | 2–3 h + your play session |

**Total: about 30–40 hours of build time, as 7 PRs over roughly 5–7 working sessions.** The live site keeps the current engine until phase 6, so you can keep playing throughout.

### Cost and performance
- **Supabase Edge Functions:** the Free plan includes 500k invocations a month. One move is one call, so a 100-hand night with 3–6 players (about 1–3k calls) is far under that. The pg_cron backstop calls `tick_all` once a minute only while a server game is active (at most about 43k calls a month if one never ended), so the Free plan is enough. Pro is optional and comes last (see Decisions).
- **Latency:** each move is a round trip of about 100–300 ms, where today the host applies its own moves instantly. The UI shows the tap at once and confirms on the next state.
- **Cold starts:** the first call after idle can take about 0.5–1 s. Acceptable at the start of a game.

## Risks and how they're handled
- **Behavior drift:** the same engine code runs in both places (phase 0), and the 14 E2E tests are the acceptance bar for every phase.
- **Realtime lag:** unchanged from today, and the guest poller stays as a fallback.
- **Clock skew:** deadlines are judged on server time only. Phone timers are just for display and for calling `tick`.
- **Half-migrated state:** the flag keeps the old path working until cutover, and games started under one model finish under it (`games.rules_version`).

## Decisions (answered 2026-11-08)
1. **Rules run in a Supabase Edge Function.** ✅ Yes. Hand evaluation and Guts are reused from the existing JS engine.
2. **The server writes the tournament ledger automatically.** ✅ Yes. The per-player "Record to Friends Ledger" button goes away in phase 5.
3. **Supabase Pro:** not needed for this migration; the Free plan covers it. If you do it, do it **last**, after cutover. The reasons it's still worth considering are no auto-pause, daily backups of the ledger, and 7-day logs; see the roadmap doc.
4. **Anything from your live play session** that changes the rules goes in the list below, so it's built into phase 3 instead of being ported twice.

## Adjustments from live play
_(Each item: what happened, what it does now.)_

**Tournament, 2026-11-11 (host on `?server=1`, 3 phones), fixed in PR #27:**
- Couldn't leave the New Game screen → Cancel button and ✕; the sheet scrolls.
- Invites showed on Home only after Friends → Home → loads can't overwrite each other out of order; the invite check keeps running after leaving a table.
- Pause: each phone showed a different online/away list; no way to say "I'm back" → every phone reads the server's heartbeats (stamped with the database clock) and redraws every second; I'm Back marks the player Ready on every phone; the host sees "N of M ready".
- Everyone quit the tournament but it kept dealing; End Game didn't work for tournaments → a tournament where everyone still in has quit is called off; the host's End Game for All calls a tournament off; nothing goes to the ledger; phones go Home. Startup no longer pulls a phone back into a game its player quit.
- "Kill Stuck Games" deleted every seat in every game for every user → it now ends only active games you host ("End My Stuck Games"), and seats can be deleted only by their own player or the game's host.
- Live: function redeployed and migration `20261112090000_presence_clock_and_seat_lockdown.sql` applied (2026-11-11).

**Heads-up tournament, 2026-11-12 (server rules), fixed in PR #32:**
- Sounds didn't match what was on screen → chips for every bet, knock knock for every check (not when checked as Away), a riffle on the shuffle, one flip per card. The server numbers each move (`recentMoves`).
- All-in dealt the whole board at once → hands face up, one card every 4s (`RUNOUT_CARD_SECONDS`); stud one street at a time.
- The result screen showed only sometimes; the end of the game froze until a rejoin → the backup poller now does everything the live update does. The result stays up until everyone taps Got It (30s at most) and shows each pot, its winner, and each stack before → after.
- "The pot didn't go to the winner" → the chips were paid, but bets stayed drawn in front of each seat after the showdown. Bets are cleared when the pot is paid. The server keeps a per-hand payout log (`resultLog`, last 100 hands) to check a disputed pot.

## How to execute (for Claude)
1. Read this file and `claude/roadmap-and-decisions.md` in the project. The decisions are answered; fold in the "Adjustments" list.
2. Do **one phase per PR**, on branch `server-rules-phase-N`. Keep the live site on the old path until phase 6 (`SERVER_RULES` off in the deployed build).
3. Each phase:
   - Run `npm run build && npm test && npm run check` locally.
   - Run the full E2E suite in CI (3 shards), plus `repeat=2` on any test touched.
   - For phase 5, apply the database migration to the live project only after the PR is approved.
4. Update `claude/roadmap-and-decisions.md` after each phase, adding the new decisions and removing the workarounds that no longer apply (void on takeover, presence auto-act, host migration).
