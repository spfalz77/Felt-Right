// Account actions that need the service role.
//
//   POST /functions/v1/account   { action: 'delete' }
//   Authorization: Bearer <the player's session token>
//
// delete: forgets the player (public.forget_user: friends, devices, stats,
// their own Standings rows, name and phone; the profile stays as "Deleted
// player" so other people's history still adds up), then soft-deletes the
// sign-in so it can never be used again. Required by both app stores.

import { createClient } from "jsr:@supabase/supabase-js@2";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: auth, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !auth?.user) return json({ error: "not signed in" }, 401);
    const { action } = await req.json().catch(() => ({}));
    if (action !== "delete") return json({ error: "unknown action" }, 400);

    const id = auth.user.id;
    const { error: forgetErr } = await admin.rpc("forget_user", { p_user_id: id });
    if (forgetErr) throw forgetErr;
    const { error: delErr } = await admin.auth.admin.deleteUser(id, true); // soft delete: the profile row stays
    if (delErr) throw delErr;
    return json({ ok: true });
  } catch (e) {
    console.error(e);
    return json({ error: "server error" }, 500);
  }
});
