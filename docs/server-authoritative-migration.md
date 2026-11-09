# Server-authoritative game rules — migration plan

_Status: planned, not started. Written 2026-11-08, after PR #16. Roadmap step 2._
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
- **Supabase Edge Functions:** the Free plan includes 500k invocations a month. One move is one call, so a 100-hand night with 3–6 players (about 1–3k calls) is far under that. pg_cron `tick_all` adds about 43k calls a month. Moving to **Pro ($25/mo, roadmap step 3) first is recommended** anyway, since the Free plan pauses after a week idle.
- **Latency:** each move is a round trip of about 100–300 ms, where today the host applies its own moves instantly. The UI shows the tap at once and confirms on the next state.
- **Cold starts:** the first call after idle can take about 0.5–1 s. Acceptable at the start of a game.

## Risks and how they're handled
- **Behavior drift:** the same engine code runs in both places (phase 0), and the 14 E2E tests are the acceptance bar for every phase.
- **Realtime lag:** unchanged from today, and the guest poller stays as a fallback.
- **Clock skew:** deadlines are judged on server time only. Phone timers are just for display and for calling `tick`.
- **Half-migrated state:** the flag keeps the old path working until cutover, and games started under one model finish under it (`games.rules_version`).

## Decisions needed from you before phase 1
1. **Edge Function (recommended) or Postgres functions?** Postgres would avoid a second runtime but means rewriting hand evaluation and Guts in SQL.
2. **Tournament ledger written automatically by the server (recommended)?** Or keep the per-player "Record to Friends Ledger" button?
3. **Move to Supabase Pro before or during this work (recommended)?**
4. **Anything from your live play session** that changes the rules. Add them below, and they'll be built into phase 3 instead of being ported twice.

## Adjustments from live play
_(Fill in after playing. Each item: what happened, what it should do instead.)_

-

## How to execute (for Claude)
1. Read this file and `claude/roadmap-and-decisions.md` in the project. Confirm the decisions above are answered and fold in the "Adjustments" list.
2. Do **one phase per PR**, on branch `server-rules-phase-N`. Keep the live site on the old path until phase 6 (`SERVER_RULES` off in the deployed build).
3. Each phase:
   - Run `npm run build && npm test && npm run check` locally.
   - Run the full E2E suite in CI (3 shards), plus `repeat=2` on any test touched.
   - For phase 5, apply the database migration to the live project only after the PR is approved.
4. Update `claude/roadmap-and-decisions.md` after each phase, adding the new decisions and removing the workarounds that no longer apply (void on takeover, presence auto-act, host migration).
