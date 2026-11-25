// Heures freelance : écrit dans data.js du dépôt suivi-heures (le site que consulte
// l'employeur) et envoie le rappel « jours à valider ».
//
//   POST { action: "add", date, min, note }  → ajoute une séance   (connecté, propriétaire seulement)
//   POST { action: "del", date, min, note }  → retire une séance   (idem)
//   POST { action: "remind" }                → notif si ≥ 3 jours non validés (appelé par pg_cron)
//
// Secrets : GITHUB_TOKEN (jeton fin, dépôt suivi-heures, Contents: read & write),
//           FREELANCE_EMAIL (ton e-mail de connexion au Hub), VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { parseSuivi, insertEntry, removeEntry, minutesByDay, pendingDays, hm, ALERT_AT } from "../_shared/freelance.js";

const REPO = "bilysasorith/suivi-heures";
const FILE = "data.js";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const env = (k: string) => Deno.env.get(k) || "";
const OWNER = env("FREELANCE_EMAIL").trim().toLowerCase();
const parisDay = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris" }).format(d);
const fmtDay = new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", day: "numeric", month: "2-digit" });

// ---------- GitHub ----------
const gh = (path: string, init: RequestInit = {}) => fetch(`https://api.github.com/repos/${REPO}/${path}`, {
  ...init,
  headers: {
    Authorization: `Bearer ${env("GITHUB_TOKEN")}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "hub-freelance",
    ...(init.headers || {}),
  },
});
const b64dec = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, "")), (c) => c.charCodeAt(0)));
const b64enc = (s: string) => { let b = ""; for (const x of new TextEncoder().encode(s)) b += String.fromCharCode(x); return btoa(b); };

async function readFile() {
  const r = await gh(`contents/${FILE}?ref=main`);
  if (!r.ok) throw new Error(`lecture GitHub ${r.status}`);
  const j = await r.json();
  return { text: b64dec(j.content), sha: j.sha as string };
}

// Lit, modifie, écrit ; réessaie si data.js a changé entre-temps (conflit de sha).
async function editFile(change: (t: string) => string, message: string) {
  for (let i = 0; i < 3; i++) {
    const { text, sha } = await readFile();
    const next = change(text);
    const r = await gh(`contents/${FILE}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, content: b64enc(next), sha, branch: "main" }),
    });
    if (r.ok) return next;
    if (r.status !== 409 && r.status !== 422) throw new Error(`écriture GitHub ${r.status} ${await r.text()}`);
  }
  throw new Error("data.js modifié en même temps, réessaie");
}

// ---------- Rappel ----------
async function remind() {
  const sb = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
  const { data: users } = await sb.auth.admin.listUsers({ perPage: 200 });
  const owner = users?.users.find((u) => (u.email || "").toLowerCase() === OWNER);
  if (!owner) return json({ error: "FREELANCE_EMAIL inconnu" });

  const res = await fetch(`https://raw.githubusercontent.com/${REPO}/main/${FILE}?t=${Date.now()}`);
  if (!res.ok) return json({ error: `data.js HTTP ${res.status}` });
  const byDay = minutesByDay(parseSuivi(await res.text()).entries);
  const { data: zeros } = await sb.from("freelance_days").select("day").eq("user_id", owner.id);
  const zero = new Set((zeros || []).map((r) => String(r.day).slice(0, 10)));
  const pending = pendingDays(byDay, zero, parisDay());
  if (pending.length < ALERT_AT) return json({ pending: pending.length, sent: 0 });

  const { data: subs } = await sb.from("push_subscriptions").select("endpoint,p256dh,auth").eq("user_id", owner.id);
  webpush.setVapidDetails("https://bilysasorith.github.io/hub/", env("VAPID_PUBLIC_KEY"), env("VAPID_PRIVATE_KEY"));
  const payload = JSON.stringify({
    title: "Heures freelance à remplir",
    body: `${pending.length} jours non validés depuis le ${fmtDay.format(new Date(pending[0] + "T12:00:00Z"))}. Ajoute tes heures ou mets 0h.`,
    url: "./#freelance",
    tag: "freelance-remind",
  });
  let sent = 0;
  for (const s of subs || []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 6 * 3600 });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await sb.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
      else console.error("push", code, (e as Error).message);
    }
  }
  return json({ pending: pending.length, sent });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* vide */ }

  try {
    if (body.action === "remind") return await remind();

    // Écriture : uniquement le propriétaire, connecté au Hub.
    const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY")).auth.getUser(jwt);
    if (!OWNER || (u?.user?.email || "").toLowerCase() !== OWNER) return json({ error: "non autorisé" }, 403);

    const date = String(body.date || "");
    const min = Math.round(Number(body.min));
    const note = String(body.note || "").trim().slice(0, 300);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !(min > 0 && min <= 24 * 60)) return json({ error: "date ou durée invalide" }, 400);
    const entry = { date, min, note };
    const when = fmtDay.format(new Date(date + "T12:00:00Z"));

    let text: string;
    if (body.action === "add") text = await editFile((t) => insertEntry(t, entry), `Ajout : ${hm(min)} le ${when}`);
    else if (body.action === "del") text = await editFile((t) => removeEntry(t, entry), `Retrait : ${hm(min)} le ${when}`);
    else return json({ error: "action inconnue" }, 400);
    return json({ ok: true, entries: parseSuivi(text).entries });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
