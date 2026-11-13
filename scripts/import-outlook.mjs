// Importe les calendriers privés (réunions Teams Outlook + agenda Google) dans Supabase, en PRIVÉ.
// Rien n'est écrit dans planning.json : ces données ne sortent jamais du dépôt public.
//
// Variables d'env (secrets GitHub) :
//   OUTLOOK_FREELANCE_ICS_URL  — flux ICS Outlook entreprise (freelance)
//   OUTLOOK_INFOGREFFE_ICS_URL — flux ICS du calendrier Outlook « Infogreffe » (pro)
//   OUTLOOK_EFREI_ICS_URL      — flux ICS Outlook école
//   GOOGLE_ICS_URL             — adresse secrète iCal de l'agenda Google perso
//   SUPABASE_URL               — URL du projet (ex. https://xxxx.supabase.co) [public]
//   SUPABASE_SERVICE_KEY       — clé service_role (secret, jamais dans le code)
//   HUB_USER_ID                — UUID du compte propriétaire du Hub (obligatoire hors dry-run)
//
// Sans SUPABASE_SERVICE_KEY (ou avec DRY_RUN=1) : parse et affiche un résumé, n'écrit rien.

import { parseEvents } from "./ics.mjs";

const SOURCES = [
  { name: "freelance", url: process.env.OUTLOOK_FREELANCE_ICS_URL },
  { name: "infogreffe", url: process.env.OUTLOOK_INFOGREFFE_ICS_URL }, // affiché comme « pro »
  { name: "efrei", url: process.env.OUTLOOK_EFREI_ICS_URL },
  { name: "google", url: process.env.GOOGLE_ICS_URL },
];

// Les cours myefrei (ex. "CX007-2.5-3-JAV-LAB-2") sont déjà dans planning.json.
// On les écarte de l'agenda Google pour éviter les doublons.
const isMyefreiCourse = (title) => /^[A-Z]{2}\d{3}-/.test((title || "").trim());

const SUPA_URL = process.env.SUPABASE_URL || "https://dcauisdxvbmcnerjklxm.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DRY_RUN = process.env.DRY_RUN === "1" || !SERVICE_KEY;

// Fenêtre : d'hier jusqu'à +120 jours (on n'importe pas tout l'historique).
const now = Date.now();
const FROM = now - 24 * 3600 * 1000;
const TO = now + 120 * 24 * 3600 * 1000;

function slug(s) {
  return (s || "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "x";
}

// Réunion annulée (titre préfixé « Annulé : » / « Canceled: ») — on ne l'importe pas.
const isCanceled = (title) => /^\s*(annul[ée]e?s?\s*:|cancell?ed\s*:)/i.test(title || "");

async function fetchICS(url) {
  const res = await fetch(url, { headers: { "User-Agent": "hub-planning-bot" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// --- API Supabase (REST + admin), uniquement hors dry-run ---
async function supa(path, opts = {}) {
  const res = await fetch(`${SUPA_URL}${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${path} -> HTTP ${res.status} : ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

// Compte propriétaire : fixé explicitement. Ne jamais « deviner » (ex. premier utilisateur),
// sinon tout autre compte inscrit récupère les réunions privées.
async function getUserId() {
  const id = (process.env.HUB_USER_ID || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("HUB_USER_ID absent ou invalide — import annulé.");
  const user = await supa(`/auth/v1/admin/users/${id}`, { method: "GET" });
  if (user?.id !== id) throw new Error(`Utilisateur ${id} introuvable dans Supabase Auth.`);
  return id;
}

async function run() {
  let userId = null;
  if (!DRY_RUN) userId = await getUserId();
  const seen = new Set(); // réunions déjà vues, toutes sources confondues

  for (const src of SOURCES) {
    if (!src.url) {
      console.log(`[${src.name}] pas d'URL (secret absent) — ignoré.`);
      continue;
    }
    let raw;
    try {
      raw = await fetchICS(src.url);
    } catch (e) {
      console.error(`[${src.name}] échec fetch : ${e.message}`);
      continue;
    }

    const rows = parseEvents(raw, { expand: { from: FROM, to: TO } })
      .filter((e) => e.start && !e.allDay)
      .filter((e) => !isCanceled(e.title))
      .filter((e) => src.name !== "google" || !isMyefreiCourse(e.title))
      .filter((e) => {
        const t = new Date(e.start).getTime();
        return t >= FROM && t <= TO;
      })
      // Même réunion déjà importée via un autre calendrier (même UID Outlook) : on ne la double pas.
      .filter((e) => {
        const key = e.uid || `${e.title}@${e.start}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((e) => ({
        id: `${src.name}:${e.uid || slug(e.title) + ":" + e.start}`,
        user_id: userId,
        source: src.name,
        title: e.title || "(sans titre)",
        start_at: e.start,
        end_at: e.end,
        location: e.location,
        updated_at: new Date().toISOString(),
      }));

    console.log(`[${src.name}] ${rows.length} réunions dans la fenêtre.`);
    if (rows.length) {
      const sample = rows.slice(0, 3).map((r) => {
        const d = new Date(r.start_at).toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
        return `   • ${d} — ${r.title}`;
      });
      console.log(sample.join("\n"));
    }

    if (DRY_RUN) continue;

    // Upsert (merge sur la clé primaire id)
    if (rows.length) {
      await supa("/rest/v1/calendar_events", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(rows),
      });
    }
    // Purge : supprime de cette source les events qui ne sont plus dans le flux
    const keep = rows.map((r) => `"${r.id}"`).join(",");
    const filter = keep
      ? `source=eq.${src.name}&id=not.in.(${keep})`
      : `source=eq.${src.name}`;
    await supa(`/rest/v1/calendar_events?${filter}`, {
      method: "DELETE",
      headers: { Prefer: "return=minimal" },
    });
    console.log(`[${src.name}] synchronisé dans Supabase.`);
  }

  if (DRY_RUN) console.log("\n(DRY_RUN : rien écrit dans Supabase — pose SUPABASE_SERVICE_KEY pour activer l'écriture.)");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
