// E-mail de réponse à l'invité, envoyé après la décision du propriétaire.
// Secrets : GMAIL_USER, GMAIL_APP_PASSWORD (jamais dans le dépôt).
import nodemailer from "npm:nodemailer@6.9.16";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const HUB_URL = "https://bilysasorith.github.io/hub/";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

const fmt = (opts: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", ...opts });
const dayFmt = fmt({ weekday: "short", day: "numeric", month: "short" });
const timeFmt = fmt({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ sent: false, error: "method" }, 405);

  try {
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ sent: false, error: "unauthorized" }, 401);

    const url = Deno.env.get("SUPABASE_URL")!;
    const authClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: u, error: uErr } = await authClient.auth.getUser(jwt);
    if (uErr || !u?.user) return json({ sent: false, error: "unauthorized" }, 401);

    let id: string | undefined;
    try { id = String((await req.json())?.id || ""); } catch { /* corps invalide */ }
    if (!id) return json({ sent: false, error: "id manquant" }, 400);

    const db = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: owner } = await db.from("hub_owner").select("user_id").eq("user_id", u.user.id).maybeSingle();
    if (!owner) return json({ sent: false, error: "forbidden" }, 403);

    const { data: r, error: rErr } = await db.from("booking_requests")
      .select("id, owner_id, start_at, end_at, email, status, emailed_at").eq("id", id).maybeSingle();
    if (rErr) return json({ sent: false, error: rErr.message }, 500);
    if (!r || r.owner_id !== u.user.id) return json({ sent: false });
    if (!["accepted", "declined"].includes(r.status)) return json({ sent: false });
    if (!r.email || !String(r.email).trim() || r.emailed_at) return json({ sent: false });

    // Réservation atomique : un seul appel concurrent obtient la ligne.
    const { data: claimed, error: cErr } = await db.from("booking_requests")
      .update({ emailed_at: new Date().toISOString() })
      .eq("id", id).is("emailed_at", null).select("id");
    if (cErr) return json({ sent: false, error: cErr.message }, 500);
    if (!claimed || claimed.length === 0) return json({ sent: false });

    try {
      const user = Deno.env.get("GMAIL_USER")!;
      const pass = Deno.env.get("GMAIL_APP_PASSWORD")!;
      const start = new Date(r.start_at), end = new Date(r.end_at);
      const day = dayFmt.format(start);
      const when = `${day} ${timeFmt.format(start)}–${timeFmt.format(end)}`;
      const text = r.status === "accepted"
        ? `Bily a accepté ✓ ta demande du ${when}.`
        : `Bily n'est pas dispo pour ta demande du ${when}.\n\nTu peux proposer un autre créneau sur le Hub : ${HUB_URL}`;

      const transport = nodemailer.createTransport({
        host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass },
      });
      await transport.sendMail({
        from: `"Bily" <${user}>`,
        replyTo: user,
        to: String(r.email).trim(),
        subject: `Ta demande de créneau du ${day}`,
        text,
      });
      return json({ sent: true });
    } catch (e) {
      await db.from("booking_requests").update({ emailed_at: null }).eq("id", id);
      return json({ sent: false, error: String((e as Error)?.message || e) }, 502);
    }
  } catch (e) {
    return json({ sent: false, error: String((e as Error)?.message || e) }, 500);
  }
});
