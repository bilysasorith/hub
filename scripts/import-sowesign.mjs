// Importe l'émargement SoWeSign (signé / absent) des 30 derniers jours dans Supabase, en PRIVÉ.
//
// Variables d'env (secrets GitHub) :
//   SOWESIGN_CODE         — code de connexion à 16 chiffres : établissement (4) + identifiant (8) + PIN (4)
//   SUPABASE_URL          — URL du projet [public]
//   SUPABASE_SERVICE_KEY  — clé service_role
//   HUB_USER_ID           — UUID du compte propriétaire du Hub
//
// Sans SUPABASE_SERVICE_KEY (ou avec DRY_RUN=1) : affiche un résumé, n'écrit rien.
// Si SoWeSign exige un captcha, la connexion échoue : on s'arrête, on ne tente pas de le contourner.

const API = "https://app.sowesign.com/api";
const CODE = (process.env.SOWESIGN_CODE || "").replace(/\s/g, "");
const SUPA_URL = process.env.SUPABASE_URL || "https://dcauisdxvbmcnerjklxm.supabase.co";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const DRY_RUN = process.env.DRY_RUN === "1" || !SERVICE_KEY;

if (!/^\d{16}$/.test(CODE)) {
  console.log("SOWESIGN_CODE absent ou invalide (16 chiffres attendus) — import ignoré.");
  process.exit(0);
}

async function login() {
  const res = await fetch(`${API}/portal/authentication/token`, {
    method: "POST",
    headers: { Authorization: `JBAuth ${Buffer.from(CODE).toString("base64")}`, "X-Origin": "student" },
  });
  if (!res.ok) throw new Error(`connexion SoWeSign refusée (HTTP ${res.status}) — code changé ou captcha demandé ?`);
  const body = await res.json();
  if (!body?.token) throw new Error("connexion SoWeSign : pas de jeton dans la réponse.");
  return body;
}

async function logout(refreshToken) {
  if (!refreshToken) return;
  await fetch(`${API}/portal/authentication/token/logout`, {
    method: "POST", headers: { Authorization: `Bearer ${refreshToken}` },
  }).catch(() => {});
}

const ymd = (d) => d.toISOString().slice(0, 10);

async function fetchCourses(token) {
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 24 * 3600 * 1000);
  const res = await fetch(`${API}/student-portal/courses?from=${ymd(from)}&to=${ymd(to)}`, {
    headers: { Authorization: `Bearer ${token}`, "Accept-Language": "fr" },
  });
  if (!res.ok) throw new Error(`historique SoWeSign : HTTP ${res.status}`);
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error("historique SoWeSign : format inattendu.");
  return list;
}

async function supa(path, opts = {}) {
  const res = await fetch(`${SUPA_URL}${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${path} -> HTTP ${res.status} : ${await res.text()}`);
}

async function run() {
  const auth = await login();
  let courses;
  try {
    courses = await fetchCourses(auth.token);
  } finally {
    await logout(auth.refreshToken); // pas de session qui traîne côté SoWeSign
  }

  // "date" + "start" ("10:05:00+00:00") -> instant UTC, identique au start du planning myefrei.
  const rows = courses
    .filter((c) => c?.id && c.date && c.start)
    .map((c) => ({
      sws_id: c.id,
      start_at: new Date(`${c.date}T${c.start}`).toISOString(),
      end_at: c.end ? new Date(`${c.date}T${c.end}`).toISOString() : null,
      name: c.name || null,
      status: c.signature?.status || null,
      updated_at: new Date().toISOString(),
    }));

  const n = (s) => rows.filter((r) => r.status === s).length;
  console.log(`[sowesign] ${rows.length} cours · ${n("present")} signés · ${n("absent")} absents`);
  if (DRY_RUN) { console.log("[sowesign] dry-run : rien écrit."); return; }

  const userId = (process.env.HUB_USER_ID || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("HUB_USER_ID absent ou invalide — import annulé.");
  if (!rows.length) return;
  await supa("/rest/v1/attendance?on_conflict=user_id,sws_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows.map((r) => ({ ...r, user_id: userId }))),
  });
  console.log("[sowesign] enregistré dans Supabase.");
}

run().catch((e) => { console.error(`[sowesign] ${e.message}`); process.exit(1); });
