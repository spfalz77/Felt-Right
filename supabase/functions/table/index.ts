// The table: the one place a server-run game changes.
//
//   POST /functions/v1/table   { game_id, action, amount?, settings? }
//   Authorization: Bearer <the player's session token>
//
// Loads the full state (game_secrets), applies the action with the shared
// engine, and saves it with a version check (public.save_table), retrying if
// another action got in first. Phones never write game state themselves.
//
// Rules: ../_shared/engine/table.js. Plan: docs/server-authoritative-migration.md

import { createClient } from "jsr:@supabase/supabase-js@2";
import * as T from "../_shared/engine/table.js";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Test hooks (scripted deals, clock offset) exist only on the local test stack
const TEST_HOOKS = Deno.env.get("ALLOW_TEST_HOOKS") === "1";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Cards are shuffled with the platform's cryptographic generator
const rng = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

const admin = createClient(URL_, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: auth, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !auth?.user) return json({ error: "not signed in" }, 401);
    const userId = auth.user.id;

    const body = await req.json().catch(() => ({}));
    const { game_id, action, amount, settings } = body ?? {};
    if (typeof game_id !== "string" || typeof action !== "string") return json({ error: "game_id and action are required" }, 400);

    const { data: game } = await admin.from("games")
      .select("id, host_id, status, blind_config, buy_in_amount, game_format, game_variant")
      .eq("id", game_id).maybeSingle();
    if (!game) return json({ error: "game not found" }, 404);

    if (action === "start") return await start(game, userId, settings);

    // Load → apply → save; if someone else saved first, reload and try again
    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: row } = await admin.from("game_secrets").select("state, version").eq("game_id", game_id).maybeSingle();
      if (!row) return json({ error: "this game is not run by the server" }, 409);
      const G = row.state;
      const ctx: Record<string, unknown> = {
        now: Date.now() + (TEST_HOOKS ? (G.clockOffsetMs || 0) : 0),
        rng, hostId: game.host_id, allowTestHooks: TEST_HOOKS, effects: {},
      };
      const dealBefore = G.dealSeq;

      let changed = true;
      if (action === "tick") {
        if (!inGame(G, game, userId)) return json({ error: "not in this game" }, 403);
        changed = T.tick(G, ctx);
      } else if (action === "rig" || action === "clock_offset") {
        if (!TEST_HOOKS) return json({ error: "unknown action" }, 400);
        if (!inGame(G, game, userId)) return json({ error: "not in this game" }, 403);
        if (action === "rig") T.queueRig(G, amount, ctx);
        else { G.clockOffsetMs = (G.clockOffsetMs || 0) + Number(amount || 0); ctx.now = Date.now() + G.clockOffsetMs; T.tick(G, ctx); }
      } else {
        const r = T.applyAction(G, userId, action, amount, ctx);
        if (!r.ok) return json({ error: r.error }, 409);
      }
      if (!changed) return json({ ok: true, changed: false, version: row.version, now: ctx.now });

      G.v = row.version + 1; // phones ignore any copy older than the one they show
      const { data: saved, error: saveErr } = await admin.rpc("save_table", {
        p_game_id: game_id,
        p_expect_version: row.version,
        p_state: G,
        p_public: T.redact(G),
        p_hands: G.dealSeq !== dealBefore ? T.privateHands(G) : null,
      });
      if (saveErr) throw saveErr;
      if (!saved) continue; // version conflict
      const effects = ctx.effects as { settle?: boolean };
      if (effects.settle) {
        const { error } = await admin.rpc("settle_home_game_ledger", { p_game_id: game_id });
        if (error) console.error("settle_home_game_ledger", error);
      }
      // `now` (server clock) lets phones judge deadlines on the server's time
      return json({ ok: true, changed: true, version: row.version + 1, now: ctx.now });
    }
    return json({ error: "busy, try again" }, 503);
  } catch (e) {
    console.error(e);
    return json({ error: "server error" }, 500);
  }
});

function inGame(G: { players: { id: string }[] }, game: { host_id: string }, userId: string) {
  return game.host_id === userId || G.players.some((p) => p.id === userId);
}

// Host starts the game from the lobby: seat everyone who joined, shuffle seats.
// settings (optional, from the host's lobby screen): { levels, duration, rebuys, buyIn, rigs? }
async function start(
  game: { id: string; host_id: string; status: string; blind_config: Record<string, unknown> | null; buy_in_amount: number | null; game_format: string; game_variant: string },
  userId: string,
  settings?: { levels?: unknown; duration?: unknown; rebuys?: unknown; buyIn?: unknown; rigs?: unknown },
) {
  if (game.host_id !== userId) return json({ error: "only the host can start the game" }, 403);
  if (game.status !== "lobby") return json({ error: "game already started" }, 409);
  const { data: seats } = await admin.from("game_players")
    .select("user_id, seat_index, joined_at, user:users(display_name, avatar_emoji)")
    .eq("game_id", game.id).in("status", ["joined", "playing", "waiting"]).order("seat_index").order("joined_at");
  if (!seats || seats.length < 2) return json({ error: `need at least 2 players, only ${seats?.length ?? 0} joined` }, 409);

  const cfg = game.blind_config || {};
  const levels = Array.isArray(settings?.levels) && settings!.levels.length ? settings!.levels : cfg.levels;
  const duration = Number(settings?.duration ?? cfg.duration) || 600;
  const rebuys = settings?.rebuys ?? cfg.rebuys_enabled;
  const buyIn = Number(settings?.buyIn ?? game.buy_in_amount ?? 20);
  if (!Number.isFinite(buyIn) || buyIn < 0) return json({ error: "bad buy-in" }, 400);

  const ctx = { now: Date.now(), rng, hostId: game.host_id, allowTestHooks: TEST_HOOKS, effects: {} };
  const G = T.newGame({
    // deno-lint-ignore no-explicit-any
    seats: seats.map((s: any) => ({ id: s.user_id, name: s.user?.display_name, emoji: s.user?.avatar_emoji })),
    format: game.game_format, variant: game.game_variant,
    rebuysEnabled: !!rebuys, blindLevels: levels, blindDuration: duration, buyIn,
  }, ctx);

  // Test stack only: scripted deals queued in the lobby, before the game existed
  if (TEST_HOOKS && Array.isArray(settings?.rigs)) for (const r of settings!.rigs) T.queueRig(G, r, ctx);

  G.v = 1;
  const { data: saved, error } = await admin.rpc("save_table", {
    p_game_id: game.id, p_expect_version: null, p_state: G, p_public: T.redact(G), p_hands: null,
  });
  if (error) throw error;
  if (!saved) return json({ error: "game already started" }, 409);
  // After the game exists (an earlier update would reach phones with an empty state)
  await admin.from("games").update({
    blind_config: { levels: G.blindLevels, duration: G.blindDuration, rebuys_enabled: G.rebuysEnabled },
    buy_in_amount: buyIn,
  }).eq("id", game.id);
  return json({ ok: true, changed: true, version: 1, now: ctx.now });
}
