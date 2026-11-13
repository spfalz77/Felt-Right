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
import { tournamentLedger } from "../_shared/engine/payouts.js";
import * as N from "../_shared/engine/notify.js";
import { sendWebPush, sendFcm, b64url } from "../_shared/push.js";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Test hooks (scripted deals, clock offset) exist only on the local test stack
const TEST_HOOKS = Deno.env.get("ALLOW_TEST_HOOKS") === "1";
// Push notifications. Web Push keys are made on first use (Vault); Android/
// iPhone pushes need FCM_SERVICE_ACCOUNT (a Firebase service account's JSON).
const PUBLIC_APP_URL = Deno.env.get("PUBLIC_APP_URL") || "https://spfalz77.github.io/Felt-Right/";
const PUSH_SUBJECT = Deno.env.get("PUSH_SUBJECT") || "mailto:feltright@users.noreply.github.com";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Cards are shuffled with the platform's cryptographic generator
const rng = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

// A player is gone after 12s with no heartbeat (game_presence). Judged on
// real time, never the test clock offset.
const PRESENCE_GONE_MS = 12000;
async function presenceFor(gameId: string, startedAt: number) {
  const { data } = await admin.from("game_presence").select("user_id, last_seen_at").eq("game_id", gameId);
  const seen = new Map((data || []).map((r: { user_id: string; last_seen_at: string }) => [r.user_id, Date.parse(r.last_seen_at)]));
  const realNow = Date.now();
  return (id: string) => realNow - (seen.get(id) ?? startedAt ?? 0) > PRESENCE_GONE_MS;
}

const admin = createClient(URL_, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

// The backstop's shared secret, generated in Vault by a migration; readable
// only with the service role (public.table_tick_secret()).
let _tickSecret: string | null = null;
async function tickSecret() {
  if (_tickSecret === null) {
    const { data, error } = await admin.rpc("table_tick_secret");
    if (error) { console.error("table_tick_secret", error); return ""; }
    _tickSecret = typeof data === "string" ? data : "";
  }
  return _tickSecret;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    // The once-a-minute backstop (pg_cron → tick_server_tables) proves itself
    // with the tick secret kept in Vault (or with the service key)
    const tickHeader = req.headers.get("x-tick-secret") || "";
    if (token === SERVICE_KEY || (tickHeader.length >= 32 && tickHeader === await tickSecret())) {
      const body = await req.json().catch(() => ({}));
      if (body?.action === "tick_all") return json(await tickAll());
      return json({ error: "unknown action" }, 400);
    }
    const { data: auth, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !auth?.user) return json({ error: "not signed in" }, 401);
    const userId = auth.user.id;

    const body = await req.json().catch(() => ({}));
    const { game_id, action, amount, settings } = body ?? {};
    // The Web Push public key, for a phone turning notifications on
    if (action === "push_key") return json({ ok: true, key: (await vapidKeys()).publicKey });
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
        isGone: await presenceFor(game_id, G.startedAt),
      };
      const dealBefore = G.dealSeq;
      const wasOver = !!G.tournamentOver;
      const before = N.notifySnapshot(G);

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
        // Moves each player made themselves (not auto-acts): the audit count
        // the old engine kept as player_actions rows
        G.moves = { ...(G.moves || {}), [userId]: ((G.moves || {})[userId] || 0) + 1 };
      }
      if (!changed) return json({ ok: true, changed: false, version: row.version, now: ctx.now });

      G.v = row.version + 1; // phones ignore any copy older than the one they show
      const recordLedger = endsTournament(G, wasOver);
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
      if (recordLedger) await writeTournamentLedger(game_id, G);
      inBackground(notify(game_id, G, N.notifyEvents(before, G, action === "tick" ? null : userId)));
      // `now` (server clock) lets phones judge deadlines on the server's time
      return json({ ok: true, changed: true, version: row.version + 1, now: ctx.now });
    }
    return json({ error: "busy, try again" }, 503);
  } catch (e) {
    console.error(e);
    return json({ error: "server error" }, 500);
  }
});

// A tournament that ends with this save gets its Friends Ledger written by the
// server, both sides of every pair (phones no longer record their own rows).
// Marks the state so every phone shows "Recorded to ledger".
// deno-lint-ignore no-explicit-any
function endsTournament(G: any, wasOver: boolean) {
  if (wasOver || !G.tournamentOver || G.format === "home" || G.abandoned) return false;
  G.ledgerRecorded = true;
  return true;
}

// deno-lint-ignore no-explicit-any
async function writeTournamentLedger(gameId: string, G: any) {
  const { count } = await admin.from("payout_ledger").select("id", { count: "exact", head: true })
    .eq("game_id", gameId).eq("kind", "game").not("settled_at", "is", null);
  if (count) return; // already settled up: leave it alone
  const pairs = tournamentLedger(G);
  const { error: delErr } = await admin.from("payout_ledger").delete()
    .eq("game_id", gameId).eq("kind", "game").is("settled_at", null);
  if (delErr) { console.error("tournament ledger", delErr); return; }
  if (!pairs.length) return;
  const rows = pairs.flatMap(({ winner, loser, dollars }) => [
    { game_id: gameId, user_id: winner, opponent_id: loser, amount: dollars, kind: "game", note: "Tournament payout" },
    { game_id: gameId, user_id: loser, opponent_id: winner, amount: -dollars, kind: "game", note: "Tournament buy-in" },
  ]);
  const { error } = await admin.from("payout_ledger").insert(rows);
  if (error) console.error("tournament ledger", error);
}

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
  inBackground(notify(game.id, G, G.players.filter((p: { id: string }) => p.id !== userId)
    .map((p: { id: string }) => ({ userId: p.id, kind: "game_start", key: "start" }))));
  // After the game exists (an earlier update would reach phones with an empty state)
  await admin.from("games").update({
    blind_config: { levels: G.blindLevels, duration: G.blindDuration, rebuys_enabled: G.rebuysEnabled },
    buy_in_amount: buyIn,
  }).eq("id", game.id);
  return json({ ok: true, changed: true, version: 1, now: ctx.now });
}

// Apply whatever has come due in every active server-run game.
async function tickAll() {
  const { data: rows } = await admin.from("game_secrets")
    .select("game_id, version, state, game:games!inner(status, host_id)")
    .eq("game.status", "active");
  let ticked = 0;
  for (const row of rows || []) {
    // deno-lint-ignore no-explicit-any
    const r = row as any;
    const G = r.state;
    const ctx = {
      now: Date.now() + (TEST_HOOKS ? (G.clockOffsetMs || 0) : 0),
      rng, hostId: r.game.host_id, allowTestHooks: TEST_HOOKS, effects: {} as { settle?: boolean },
      isGone: await presenceFor(r.game_id, G.startedAt),
    };
    const dealBefore = G.dealSeq;
    const wasOver = !!G.tournamentOver;
    const before = N.notifySnapshot(G);
    if (!T.tick(G, ctx)) continue;
    G.v = r.version + 1;
    const recordLedger = endsTournament(G, wasOver);
    const { data: saved } = await admin.rpc("save_table", {
      p_game_id: r.game_id, p_expect_version: r.version, p_state: G, p_public: T.redact(G),
      p_hands: G.dealSeq !== dealBefore ? T.privateHands(G) : null,
    });
    if (saved) ticked++; // a conflict means a phone just moved the table; fine
    if (saved && ctx.effects.settle) await admin.rpc("settle_home_game_ledger", { p_game_id: r.game_id });
    if (saved && recordLedger) await writeTournamentLedger(r.game_id, G);
    if (saved) await notify(r.game_id, G, N.notifyEvents(before, G, null));
  }
  return { ok: true, games: (rows || []).length, ticked };
}

// ── Push notifications ─────────────────────────────────────────────────────

// Finish work after the response is sent (the phone doesn't wait for pushes)
function inBackground(p: Promise<unknown>) {
  const done = p.catch((e) => console.error("push", e));
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(done);
}

// Web Push key pair: made once, kept in Vault
let _vapid: { jwk: JsonWebKey; publicKey: string } | null = null;
async function vapidKeys() {
  if (_vapid) return _vapid;
  const { data: stored } = await admin.rpc("push_vapid_keys");
  let text = typeof stored === "string" ? stored : "";
  if (!text) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
    const { data, error } = await admin.rpc("push_set_vapid_keys", { p_jwk: JSON.stringify(jwk) });
    if (error) throw error;
    text = data as string;
  }
  const jwk = JSON.parse(text);
  const raw = new Uint8Array(65);
  raw[0] = 4;
  raw.set(Uint8Array.from(atob(jwk.x.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)), 1);
  raw.set(Uint8Array.from(atob(jwk.y.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)), 33);
  _vapid = { jwk, publicKey: b64url(raw) };
  return _vapid;
}

let _fcm: Record<string, string> | null | undefined;
function fcmAccount() {
  if (_fcm === undefined) {
    try { _fcm = JSON.parse(Deno.env.get("FCM_SERVICE_ACCOUNT") || "null"); } catch { _fcm = null; }
  }
  return _fcm;
}

type PushEvent = { userId: string; kind: string; key: string };
// deno-lint-ignore no-explicit-any
async function notify(gameId: string, G: any, events: PushEvent[]) {
  if (!events.length) return;
  const ids = [...new Set(events.map((e) => e.userId))];
  const { data: tokens } = await admin.from("push_tokens").select("id, user_id, platform, token, subscription").in("user_id", ids);
  if (!tokens?.length) return;
  const gone: string[] = [];
  await Promise.all(events.flatMap((e) => {
    const tag = `${e.kind === "set_away" ? "away" : e.kind === "game_start" ? "start" : "turn"}-${gameId}`;
    const ttl = e.kind === "game_start" ? 600 : 120;
    const message = { ...N.notifyText(e.kind, G), tag, url: PUBLIC_APP_URL, gameId, kind: e.kind };
    // deno-lint-ignore no-explicit-any
    return tokens.filter((t: any) => t.user_id === e.userId).map(async (t: any) => {
      try {
        let r;
        if (t.platform === "web") {
          r = await sendWebPush(t.subscription, message, { vapidJwk: (await vapidKeys()).jwk, subject: PUSH_SUBJECT, ttl, topic: tag });
        } else {
          const sa = fcmAccount();
          if (!sa) return;
          r = await sendFcm(sa, t.token, message, { ttl });
        }
        if (r.gone) gone.push(t.id);
        else if (!r.ok) console.error("push failed", t.platform, r.status, r.error);
      } catch (err) { console.error("push", t.platform, err); }
    });
  }));
  if (gone.length) await admin.from("push_tokens").delete().in("id", gone);
}
