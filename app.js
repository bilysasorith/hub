// Hub — logique de l'app (planning en lecture seule + to-do synchronisée).
// Vanilla JS, pas de framework. Supabase chargé à la demande depuis un CDN (version épinglée).

const SUPABASE_VERSION = "2.47.10";
const cfg = window.HUB_CONFIG || {};
const SUPA_READY = Boolean(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);

const TZ = "Europe/Paris";
const fmtTime = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
const fmtDayKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const fmtDayLabel = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });
const fmtWeekday = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
const fmtWdShort = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, weekday: "short" });
const fmtDayNum = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, day: "numeric" });
const fmtHM = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const fmtRange = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, day: "numeric", month: "short" });
// Minutes depuis minuit (heure de Paris) pour positionner dans la grille
const parisMinutes = (iso) => { const [h, m] = fmtHM.format(new Date(iso)).split(":").map(Number); return h * 60 + m; };
const desktop = () => window.matchMedia("(min-width: 900px)").matches;
// Référence "maintenant". Surchargeable en localhost (window.__setNow) pour tester une autre date.
let nowRef = null;
const now = () => nowRef || new Date();

const dayKey = (d) => fmtDayKey.format(d);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ico = (id, cls = "mi") => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- Sons d'interface ----------
// Synthétisés à la volée (Web Audio) : aucun fichier à charger, donc rien à mettre en cache.
// Volontairement courts et bas ; coupables depuis l'en-tête (préférence mémorisée par appareil).
const SOUND_KEY = "hub-sound";
let soundOn = (() => { try { return localStorage.getItem(SOUND_KEY) !== "off"; } catch { return true; } })();
let _ac = null, _master = null;
function audio() {
  if (!soundOn) return null;
  try {
    if (!_ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      _ac = new AC();
      _master = _ac.createGain();
      _master.gain.value = 0.55;
      _master.connect(_ac.destination);
    }
    if (_ac.state !== "running") _ac.resume().catch(() => {});
    return _ac;
  } catch { return null; }
}
// Une note : fréquence (glissando optionnel vers `to`), attaque sèche, extinction exponentielle.
function tone(ac, { f, to, at = 0, dur = 0.12, gain = 0.2, type = "sine" }) {
  const t0 = ac.currentTime + at;
  const osc = ac.createOscillator(), env = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f, t0);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(env).connect(_master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}
const SFX = {
  check:   [{ f: 660, dur: 0.09, gain: 0.22, type: "triangle" }, { f: 990, at: 0.07, dur: 0.17, gain: 0.2, type: "triangle" }],
  uncheck: [{ f: 520, to: 370, dur: 0.12, gain: 0.13, type: "triangle" }],
  // Journée pliée : arpège do-mi-sol-do + un harmonique qui s'éteint.
  done:    [523.25, 659.25, 783.99, 1046.5].map((f, i) => ({ f, at: i * 0.09, dur: i === 3 ? 0.5 : 0.2, gain: 0.2, type: "triangle" }))
             .concat({ f: 1568, at: 0.27, dur: 0.6, gain: 0.05 }),
  add:     [{ f: 440, to: 660, dur: 0.1, gain: 0.15 }],
  del:     [{ f: 300, to: 150, dur: 0.16, gain: 0.16 }],
  tab:     [{ f: 880, dur: 0.035, gain: 0.06 }],
  open:    [{ f: 420, to: 560, dur: 0.07, gain: 0.07 }],
  close:   [{ f: 520, to: 400, dur: 0.07, gain: 0.06 }],
  toggle:  [{ f: 740, dur: 0.05, gain: 0.1, type: "triangle" }],
  tick:    [{ f: 1040, dur: 0.04, gain: 0.1, type: "triangle" }],
  error:   [{ f: 220, dur: 0.13, gain: 0.2, type: "triangle" }, { f: 174.61, at: 0.13, dur: 0.2, gain: 0.2, type: "triangle" }],
};
function sfx(name) {
  const ac = audio();
  if (!ac) return;
  try { for (const n of SFX[name] || []) tone(ac, n); } catch {}
}
// Les navigateurs n'autorisent le son qu'après un geste : on réveille le contexte au premier.
for (const evt of ["pointerdown", "keydown"]) window.addEventListener(evt, () => audio(), { passive: true });
// Erreur : petit son grave, puis le message (laissé le temps au son de partir).
function oops(msg) { sfx("error"); setTimeout(() => alert(msg), 140); }

// ---------- Mouvement ----------
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
// Attente « de mise en scène » : nulle si l'utilisateur a demandé moins d'animations.
const stage = (ms) => new Promise((r) => setTimeout(r, reduceMotion.matches ? 0 : ms));
let _quietUntil = 0;         // pendant une animation locale, on retarde le re-rendu temps réel
const quiet = (ms) => { _quietUntil = Math.max(_quietUntil, Date.now() + ms); };
let _cheerAt = 0;            // instant où la dernière tâche du jour a été cochée
let _newIds = new Set();     // tâches tout juste ajoutées (animation d'entrée)

// Confettis sobres partant d'un élément (la case cochée). Réservés à « journée pliée ».
function celebrate(origin) {
  if (reduceMotion.matches || !origin) return;
  const r = origin.getBoundingClientRect();
  const box = document.createElement("div");
  box.className = "confetti";
  box.setAttribute("aria-hidden", "true");
  box.style.left = `${r.left + r.width / 2}px`;
  box.style.top = `${r.top + r.height / 2}px`;
  const colors = ["var(--accent)", "var(--ok)", "var(--warn)"];
  const count = 16;
  for (let i = 0; i < count; i++) {
    const p = document.createElement("i");
    const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
    const dist = 44 + Math.random() * 56;
    p.style.setProperty("--dx", `${(Math.cos(angle) * dist).toFixed(1)}px`);
    p.style.setProperty("--dy", `${(Math.sin(angle) * dist - 22).toFixed(1)}px`);
    p.style.setProperty("--rot", `${Math.round(Math.random() * 540 - 270)}deg`);
    p.style.background = colors[i % colors.length];
    p.style.animationDelay = `${Math.round(Math.random() * 70)}ms`;
    if (i % 3 === 0) p.className = "dot";
    box.appendChild(p);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 1200);
}

// Décale une clé YYYY-MM-DD de n jours
const addDays = (key, n) => {
  const [Y, M, D] = key.split("-").map(Number);
  const x = new Date(Date.UTC(Y, M - 1, D + n));
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}-${String(x.getUTCDate()).padStart(2, "0")}`;
};
const fmtWdDay = new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", weekday: "short", day: "numeric" });
// Libellé relatif d'une échéance (auj. / demain / lun 10)
function dueLabel(due) {
  if (!due) return "";
  const todayK = dayKey(new Date());
  if (due === todayK) return "auj.";
  if (due === addDays(todayK, 1)) return "demain";
  return fmtWdDay.format(new Date(due + "T12:00:00Z"));
}

// Dimanche de la semaine courante (pour « à faire avant / cette semaine »).
function endOfWeekKey() {
  const todayK = dayKey(now());
  const dow = (new Date(todayK + "T12:00:00Z").getUTCDay() + 6) % 7; // lundi = 0
  return addDays(todayK, 6 - dow);
}
// Étiquettes de tâche. Couleurs alignées sur les sources d'événements.
const TASK_TAGS = {
  efrei:     { label: "EFREI",     cls: "tg-efrei" },
  sg:        { label: "SG",        cls: "tg-sg" },
  perso:     { label: "Perso",     cls: "tg-perso" },
  freelance: { label: "Freelance", cls: "tg-fl" },
};
const tagChip = (tag) => TASK_TAGS[tag] ? `<span class="tg ${TASK_TAGS[tag].cls}">${TASK_TAGS[tag].label}</span>` : "";
const tagPickHtml = (sel) => Object.entries(TASK_TAGS).map(([k, m]) =>
  `<button type="button" class="tg-opt ${m.cls}${sel === k ? " on" : ""}" data-tag="${k}">${m.label}</button>`).join("");
// Pastille d'échéance : en retard / aujourd'hui / avant [jour].
function deadlinePill(t) {
  if (t.done || !t.due_date) return "";
  const todayK = dayKey(now());
  if (t.due_date < todayK) return `<span class="pill late">${ico("i-alert")}En retard</span>`;
  if (t.due_date === todayK) return `<span class="pill due0">Aujourd'hui</span>`;
  if (t.due_date === addDays(todayK, 1)) return `<span class="pill">avant demain</span>`;
  return `<span class="pill">avant ${esc(fmtWdDay.format(new Date(t.due_date + "T12:00:00Z")))}</span>`;
}

// Heure murale Paris (saisie date+heure du formulaire) -> instant ISO UTC (gère l'heure d'été).
function parisToISO(dateStr, timeStr) {
  const [Y, M, D] = dateStr.split("-").map(Number);
  const [h, mi] = timeStr.split(":").map(Number);
  const t0 = Date.UTC(Y, M - 1, D, h, mi, 0);
  const f = new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const m = {}; for (const p of f.formatToParts(new Date(t0))) m[p.type] = p.value;
  let H = +m.hour; if (H === 24) H = 0;
  const wall = Date.UTC(+m.year, +m.month - 1, +m.day, H, +m.minute, +m.second);
  return new Date(t0 - (wall - t0)).toISOString();
}

// Sources d'événements : cours myefrei / perso ajouté / Teams pro / Teams école.
const SRC_LABEL = { course: "Cours", perso: "Perso", fl: "Pro", ef: "École", gc: "Agenda" };
const normCustom = (c) => ({ source: "perso", cid: c.id, title: c.title, start: c.start_at, end: c.end_at, location: c.location, rooms: [], teacher: null });
const CAL_SRC = { efrei: "ef", google: "gc" }; // source DB -> source d'affichage (défaut : fl)
const normTeams = (t) => ({ source: CAL_SRC[t.source] || "fl", tid: t.id, title: t.title, start: t.start_at, end: t.end_at, location: t.location, rooms: [], teacher: null });

const viewEl = document.getElementById("view");
const titleEl = document.getElementById("top-title");
const dateEl = document.getElementById("top-date");
const liveEl = document.getElementById("live");
const liveTimeEl = document.getElementById("live-time");

let PLANNING = null;        // { generatedAt, events: [...] }
let ALT = null;             // alternance : { start, end, schoolSet, sgHours }
let TRAINING = null;        // rotation muscu : { anchor:{date,index}, cycle:[...] }
let CHANGES = [];           // journal des changements de planning (ajout/suppr/modif), récents d'abord
let current = "today";      // onglet actif
let weekOffset = 0;         // 0 = semaine courante, -1 précédente, +1 suivante
let weekDay = -1;           // mobile : index du jour affiché (-1 = auto = aujourd'hui)
let showHidden = false;     // afficher les cours ignorés ?
let sgOn = false;           // afficher les blocs horaires SG (jours entreprise) ?

// Mode d'un jour selon le calendrier d'alternance : "ecole" | "entreprise" | null (week-end/hors période).
function dayMode(key) {
  if (!ALT || key < ALT.start || key > ALT.end) return null;
  const wd = new Date(key + "T12:00:00Z").getUTCDay(); // 0 dim .. 6 sam
  if (wd === 0 || wd === 6) return null;
  return ALT.schoolSet.has(key) ? "ecole" : "entreprise";
}
const isTelework = (key) => ALT && new Date(key + "T12:00:00Z").getUTCDay() === (ALT.sgHours?.teleworkWeekday ?? 2);
const MODE_LABEL = { ecole: "École", entreprise: "Entreprise" };
function modeBadge(key, { compact = false } = {}) {
  const m = dayMode(key);
  if (!m) return "";
  const tt = m === "entreprise" && isTelework(key);
  const icon = ico(m === "ecole" ? "i-cap" : "i-brief", "bi");
  const txt = compact ? (m === "ecole" ? "École" : "Entr.") : MODE_LABEL[m];
  return `<span class="badge badge-${m}">${icon}${txt}${tt && !compact ? " · Télétravail" : ""}</span>`;
}

// Réunion Teams annulée : titre préfixé « Annulé : » / « Canceled: » — on ne l'affiche pas.
const isCanceledMeeting = (title) => /^\s*(annul[ée]e?s?\s*:|cancell?ed\s*:)/i.test(title || "");

// ---------- Chargement du planning (réseau d'abord, cache de secours) ----------
async function loadPlanning() {
  try {
    const res = await fetch("planning.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    PLANNING = await res.json();
    try { localStorage.setItem("hub.planning", JSON.stringify(PLANNING)); } catch {}
  } catch {
    try { PLANNING = JSON.parse(localStorage.getItem("hub.planning") || "null"); } catch { PLANNING = null; }
  }
  updateLive();
}

async function loadAlternance() {
  try {
    const res = await fetch("alternance.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    ALT = { start: j.start, end: j.end, sgHours: j.sgHours, schoolSet: new Set(j.school || []) };
  } catch { ALT = null; }
}

async function loadTraining() {
  try {
    const res = await fetch("training.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    if (j?.anchor?.date && Array.isArray(j.cycle) && j.cycle.length) TRAINING = j;
  } catch { TRAINING = null; }
}

const SEEN_KEY = "hub.changesSeen";
async function loadChanges() {
  try {
    const res = await fetch("changes.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const j = await res.json();
    const cut = Date.now() - 21 * 24 * 3600 * 1000;
    CHANGES = (j.items || [])
      .filter((c) => c.ts && new Date(c.ts).getTime() >= cut)
      .sort((a, b) => b.ts.localeCompare(a.ts));
  } catch { CHANGES = []; }
  // Première ouverture (aucun "vu" enregistré) : on part propre, seuls les PROCHAINS changements alertent.
  if (!localStorage_get(SEEN_KEY) && !(_store?.seenAt)) {
    try { localStorage.setItem(SEEN_KEY, CHANGES[0]?.ts || new Date().toISOString()); } catch {}
  }
}
const localStorage_get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

// Horodatage "vu" effectif : la plus récente valeur entre le serveur (Supabase) et l'appareil.
function seenAt() {
  const local = localStorage_get(SEEN_KEY) || "";
  const srv = (_store?.session && _store.seenAt) || "";
  return srv > local ? srv : local;
}
const unseenChanges = () => { const s = seenAt(); return CHANGES.filter((c) => c.ts > s); };

function fmtChWhen(iso) { const d = new Date(iso); return `${cap(fmtWeekday.format(d))} · ${fmtTime.format(d)}`; }
function agoLabel(iso) {
  const h = Math.floor((Date.now() - new Date(iso).getTime()) / 3600000);
  if (h < 1) return "à l'instant";
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}
function changeDetail(c) {
  if (c.type === "added") return `Nouveau cours · ${fmtChWhen(c.start)}`;
  if (c.type === "removed") return `Cours retiré · ${fmtChWhen(c.start)}`;
  const ch = c.changes || {}, parts = [];
  if (ch.time) parts.push(`Déplacé : ${fmtChWhen(ch.time.from)} → ${fmtChWhen(ch.time.to)}`);
  if (ch.room) parts.push(`Salle : ${esc(ch.room.from || "—")} → ${esc(ch.room.to || "—")}`);
  if (ch.title) parts.push("Renommé");
  let s = parts.join(" · ") || "Modifié";
  if (!ch.time) s = `${fmtChWhen(c.start)} · ${s}`;
  return s;
}
const CH_META = { added: ["Ajouté", "ch-add"], removed: ["Supprimé", "ch-rem"], modified: ["Modifié", "ch-mod"] };
function changeRow(c, isUnseen) {
  const [label, cls] = CH_META[c.type] || ["Changement", ""];
  return `<div class="ch-row${isUnseen ? " is-unseen" : ""}">
    <span class="ch-tag ${cls}">${label}</span>
    <div class="ch-body"><div class="ch-ti">${esc(c.title)}</div><div class="ch-de">${changeDetail(c)}</div></div>
    <span class="ch-ago">${agoLabel(c.ts)}</span>
  </div>`;
}

function updateBell() {
  const bell = document.getElementById("notif-bell");
  const badge = document.getElementById("notif-badge");
  if (!bell) return;
  const n = unseenChanges().length;
  bell.hidden = CHANGES.length === 0;
  bell.classList.toggle("has-unseen", n > 0);
  if (badge) { badge.hidden = n === 0; badge.textContent = n > 9 ? "9+" : String(n); }
}

function openChangesSheet() {
  const s = seenAt();
  const unseen = CHANGES.filter((c) => c.ts > s);
  const seen = CHANGES.filter((c) => c.ts <= s);
  const section = (t, list) => list.length ? `<div class="ch-sec"><div class="ch-sec-h">${t}</div>${list.map((c) => changeRow(c, c.ts > s)).join("")}</div>` : "";
  const body = CHANGES.length
    ? `${section("Nouveau", unseen)}${section("Déjà vu", seen)}`
    : `<p class="sheet-note">Aucun changement récent. Tu seras prévenu ici si l'école ajoute, retire ou déplace un cours dans ton planning.</p>`;
  const footer = unseen.length
    ? `<div class="sheet-actions"><button class="btn btn-ghost" id="ch-close">Fermer</button><button class="btn" id="ch-seen">Marquer comme vu</button></div>`
    : `<div class="sheet-actions"><button class="btn" id="ch-close">Fermer</button></div>`;
  const ov = openSheet(`<h3 class="sheet-h">Changements du planning</h3>
    <p class="sheet-sub">Ce que l'école a modifié dans ton emploi du temps.</p>
    <div class="ch-list">${body}</div>${footer}`);
  ov.querySelector("#ch-close")?.addEventListener("click", closeSheet);
  ov.querySelector("#ch-seen")?.addEventListener("click", () => { markChangesSeen(); closeSheet(); });
}

async function markChangesSeen() {
  const latest = CHANGES[0]?.ts || new Date().toISOString();
  try { localStorage.setItem(SEEN_KEY, latest); } catch {}
  updateBell();
  const store = _store?.session ? _store : await getStore();
  if (store?.session) {
    store.seenAt = latest;
    await store.sb.from("planning_seen").upsert({ user_id: store.session.user.id, seen_at: latest }, { onConflict: "user_id" });
  }
}

// ---------- Objectifs (buts SMART) ----------
// Échelle inspirée de « Goal + deadline + plan + action = success » :
// sans échéance ce n'est qu'un rêve ; plus c'est cadré, plus le statut monte.
const GOAL_LADDER = {
  dream: { label: "Rêve",      cls: "g-dream", nudge: "Ajoute une échéance pour en faire un vrai objectif." },
  obj:   { label: "Objectif",  cls: "g-obj",   nudge: "Pose un plan : comment tu comptes t'y prendre ?" },
  strat: { label: "Stratégie", cls: "g-strat", nudge: "Découpe-le en actions concrètes à cocher." },
  go:    { label: "En marche", cls: "g-go",    nudge: "Avance : coche une action." },
  done:  { label: "Atteint",   cls: "g-done",  nudge: "" },
};
function goalStatus(g) {
  if (g.done) return "done";
  const hasD = !!g.deadline;
  const hasP = !!(g.why && g.why.trim());
  const hasA = Array.isArray(g.actions) && g.actions.length > 0;
  if (hasD && hasP && hasA) return "go";
  if (hasD && hasP) return "strat";
  if (hasD) return "obj";
  return "dream";
}
const goalActions = (g) => (Array.isArray(g.actions) ? g.actions : []);
const fmtGoalDate = (d) => cap(fmtRange.format(new Date(d + "T12:00:00Z")));
function goalDeadlineLabel(g) {
  if (!g.deadline) return "";
  const today = dayKey(now());
  const left = daysBetweenKeys(today, g.deadline);
  if (left < 0) return `en retard · ${fmtGoalDate(g.deadline)}`;
  if (left === 0) return "aujourd'hui";
  if (left === 1) return "demain";
  if (left <= 30) return `dans ${left} j · ${fmtGoalDate(g.deadline)}`;
  return `pour le ${fmtGoalDate(g.deadline)}`;
}
function goalStatusChip(g) {
  const m = GOAL_LADDER[goalStatus(g)];
  return `<span class="g-chip ${m.cls}">${m.label}</span>`;
}

// Carte d'un objectif dans l'onglet À faire.
function goalRow(g) {
  const acts = goalActions(g);
  const doneN = acts.filter((a) => a.done).length;
  const st = goalStatus(g);
  const m = GOAL_LADDER[st];
  const dl = goalDeadlineLabel(g);
  const prog = acts.length ? `<div class="g-pbar"><i style="width:${Math.round(doneN / acts.length * 100)}%"></i></div>` : "";
  const meta = [dl ? `<span class="g-meta-i">${ico("i-clock")}${esc(dl)}</span>` : "", acts.length ? `<span class="g-meta-i">${ico("i-tasks")}${doneN}/${acts.length}</span>` : ""].filter(Boolean).join("");
  return `<button class="goal-card" data-gid="${esc(g.id)}">
    <div class="g-top"><span class="g-ti">${esc(g.title)}</span>${goalStatusChip(g)}</div>
    ${meta ? `<div class="g-meta">${meta}</div>` : ""}
    ${prog}
    ${m.nudge ? `<div class="g-nudge">${ico("i-bolt")}${m.nudge}</div>` : ""}
  </button>`;
}

function goalsSection(goals) {
  const active = goals.filter((g) => !g.done);
  const done = goals.filter((g) => g.done);
  const list = active.length
    ? `<div class="goals-list">${active.map(goalRow).join("")}</div>`
    : `<button class="goal-empty" id="goal-empty">${ico("i-target", "")}<span><b>Ajoute un objectif</b> — même vague, comme « apprendre le chinois ». Hub t'aidera à le rendre concret et SMART.</span></button>`;
  const doneLine = done.length ? `<button class="goals-done-line" id="goals-done">${done.length} objectif${done.length > 1 ? "s" : ""} atteint${done.length > 1 ? "s" : ""} 🏁</button>` : "";
  return `<div class="goals-sec">
    <div class="gs-head">
      <p class="section-label">${ico("i-target", "")} Objectifs${active.length ? " · " + active.length : ""}</p>
      <div class="gs-actions">
        <button class="gs-help" id="goal-help" aria-label="C'est quoi SMART ?">?</button>
        <button class="gs-add" id="goal-add">${ico("i-plus", "")}Objectif</button>
      </div>
    </div>
    ${list}${doneLine}
  </div>`;
}

function wireGoals(root, store) {
  root.querySelector("#goal-add")?.addEventListener("click", () => openGoalAdd());
  root.querySelector("#goal-empty")?.addEventListener("click", () => openGoalAdd());
  root.querySelector("#goal-help")?.addEventListener("click", openSmartInfo);
  root.querySelector("#goals-done")?.addEventListener("click", openDoneGoals);
  root.querySelectorAll(".goal-card[data-gid]").forEach((b) => b.addEventListener("click", () => {
    const g = (store.goals || []).find((x) => String(x.id) === b.dataset.gid);
    if (g) openGoalSheet(g.id);
  }));
}

// Carte rappel d'un objectif sur le tableau de bord Aujourd'hui (rotation par jour).
function renderDashGoal() {
  const mount = document.getElementById("dash-goal");
  if (!mount) return;
  const active = (_store?.goals || []).filter((g) => !g.done);
  if (!active.length) { mount.innerHTML = ""; return; }
  const idx = ((daysBetweenKeys("2026-01-01", dayKey(now())) % active.length) + active.length) % active.length;
  const g = active[idx];
  const m = GOAL_LADDER[goalStatus(g)];
  const dl = goalDeadlineLabel(g);
  mount.innerHTML = `<button class="goal-dash" data-gid="${esc(g.id)}">
    <span class="gd-ico">${ico("i-target")}</span>
    <span class="gd-body">
      <span class="gd-k">Ton objectif${dl ? " · " + esc(dl) : ""}</span>
      <span class="gd-ti">${esc(g.title)}</span>
      ${m.nudge ? `<span class="gd-nudge">${m.nudge}</span>` : ""}
    </span>
    ${goalStatusChip(g)}
  </button>`;
  mount.querySelector("[data-gid]")?.addEventListener("click", () => openGoalSheet(g.id));
}

// Événements marqués « ne pas oublier », à venir (dans les 21 prochains jours), triés par heure.
function upcomingReminders() {
  const rem = _store?.reminders;
  if (!_store?.session || !rem || !rem.size) return [];
  const N = now();
  const horizon = new Date(N.getTime() + 21 * 86400000);
  const out = [];
  const consider = (ev) => {
    if (!rem.has(eventKey(ev))) return;
    const s = new Date(ev.start);
    if (s > N && s <= horizon) out.push(ev);
  };
  for (const e of (PLANNING?.events || [])) {
    if ((_store.hidden || new Set()).has(e.uid)) continue;
    consider({ ...e, source: "course" });
  }
  for (const c of (_store.custom || [])) if (c.start_at) consider(normCustom(c));
  for (const t of (_store.teams || [])) {
    if (!t.start_at || isCanceledMeeting(t.title)) continue;
    consider(normTeams(t));
  }
  return out.sort((a, b) => new Date(a.start) - new Date(b.start));
}

// Carte « À ne pas oublier » sur Aujourd'hui : prochains événements marqués, la veille mise en avant.
function renderDashUpcoming() {
  const mount = document.getElementById("dash-upcoming");
  if (!mount) return;
  const list = upcomingReminders();
  if (!list.length) { mount.innerHTML = ""; return; }
  const tomo = addDays(dayKey(now()), 1);
  const rows = list.slice(0, 6).map((ev) => {
    const s = new Date(ev.start);
    const k = dayKey(s);
    const veille = k === tomo;
    const when = veille ? `Demain · ${fmtTime.format(s)}` : `${cap(fmtWeekday.format(s))} · ${fmtTime.format(s)}`;
    return `<button class="rem-row${veille ? " veille" : ""}" ${evAttrs(ev)}>
      <span class="rem-dot s-${ev.source}"></span>
      <span class="rem-body"><span class="rem-ti">${esc(ev.title)}</span><span class="rem-when">${when}</span></span>
      ${veille ? `<span class="rem-tag">la veille</span>` : ""}
    </button>`;
  }).join("");
  mount.innerHTML = `<div class="panel rem-panel"><div class="panel-h"><h2>À ne pas oublier</h2><span class="count">${list.length}</span></div><div class="rem-list">${rows}</div></div>`;
  wireEventTaps(mount);
}

// Carte « Examen à venir » sur Aujourd'hui : compte à rebours sur le plus proche.
function renderDashExam() {
  const mount = document.getElementById("dash-exam");
  if (!mount) return;
  const list = upcomingExams();
  if (!list.length) { mount.innerHTML = ""; return; }
  const todayK = dayKey(now());
  const ddayLabel = (ev) => {
    const d = daysBetweenKeys(todayK, dayKey(new Date(ev.start)));
    return d <= 0 ? "AUJOURD'HUI" : d === 1 ? "DEMAIN" : "J−" + d;
  };
  const whenLine = (ev) => { const s = new Date(ev.start); return `${cap(fmtWeekday.format(s))} · ${fmtTime.format(s)}`; };
  const roomOf = (ev) => (ev.rooms && ev.rooms[0]) || ev.location || "";
  const first = list[0];
  const rest = list.slice(1, 4);
  mount.innerHTML = `<section class="exam-hero" ${evAttrs(first)}>
    <div class="exam-dday">${ddayLabel(first)}</div>
    <div class="exam-body">
      <div class="exam-k">${ico("i-alert")} Examen</div>
      <div class="exam-ti">${esc(first.title)}</div>
      <div class="exam-meta">${whenLine(first)}${roomOf(first) ? " · " + esc(roomOf(first)) : ""}</div>
    </div>
  </section>${rest.length ? `<div class="exam-more">${rest.map((ev) => `<button class="exam-row" ${evAttrs(ev)}><span class="exam-row-d">${ddayLabel(ev)}</span><span class="exam-row-b"><span class="exam-row-t">${esc(ev.title)}</span><span class="exam-row-w">${whenLine(ev)}</span></span></button>`).join("")}</div>` : ""}`;
  wireEventTaps(mount);
}

// Nombre de jours calendaires entre deux clés YYYY-MM-DD (b - a).
const keyToUTC = (k) => { const [Y, M, D] = k.split("-").map(Number); return Date.UTC(Y, M - 1, D); };
const daysBetweenKeys = (a, b) => Math.round((keyToUTC(b) - keyToUTC(a)) / 86400000);

// Séance prévue un jour donné. La rotation avance d'un cran par jour (repos inclus) ;
// chaque jour « sauté » décale toute la suite de +1. Renvoie null avant l'ancrage.
// -> { type:"seance", n, title, short } | { type:"repos" } | { type:"skip" } | null
function trainingForDay(key) {
  if (!TRAINING) return null;
  const { date: a0, index: i0 = 0 } = TRAINING.anchor;
  if (key < a0) return null;
  const skips = _store?.skips || new Set();
  if (skips.has(key)) return { type: "skip" };
  const L = TRAINING.cycle.length;
  let before = 0;
  for (const d of skips) if (d >= a0 && d < key) before++;
  const pos = (((i0 + daysBetweenKeys(a0, key) - before) % L) + L) % L;
  return { ...TRAINING.cycle[pos], pos };
}

const dumb = (cls = "tci") => `<svg class="${cls}" aria-hidden="true"><use href="#i-dumbbell"/></svg>`;

// Pastille compacte pour l'en-tête d'un jour de la vue Semaine.
function trainChip(tr) {
  if (!tr) return "";
  if (tr.type === "seance") return `<span class="tr-chip" title="Séance ${tr.n} · ${esc(tr.title)}">${dumb()}<span class="trc-t">${esc(tr.short)}</span></span>`;
  if (tr.type === "repos") return `<span class="tr-chip is-rest">Repos</span>`;
  if (tr.type === "skip") return `<span class="tr-chip is-skip">Sauté</span>`;
  return "";
}

// Ligne « séance du jour » pour le tableau de bord Aujourd'hui (+ bouton sauter).
function trainLine(tr, key, signed) {
  if (!tr) return "";
  const skipBtn = signed
    ? (tr.type === "skip"
        ? `<button class="train-act" data-skip="${key}">Annuler</button>`
        : tr.type === "seance"
          ? `<button class="train-act" data-skip="${key}">J'ai sauté</button>`
          : "")
    : "";
  let chip;
  if (tr.type === "seance") chip = `<span class="train-chip">${dumb("tli")}<b>Séance ${tr.n}</b> · ${esc(tr.title)}</span>`;
  else if (tr.type === "repos") chip = `<span class="train-chip is-rest">${dumb("tli")}Repos — récupération</span>`;
  else chip = `<span class="train-chip is-skip">${dumb("tli")}Séance sautée — décalée au prochain jour</span>`;
  return `<div class="ctx-row train-row">${chip}${skipBtn}</div>`;
}

function updateLive() {
  if (!PLANNING?.generatedAt) { liveEl.classList.add("is-stale"); liveTimeEl.textContent = "hors-ligne"; liveEl.title = "Planning indisponible"; return; }
  const gen = new Date(PLANNING.generatedAt);
  const stale = Date.now() - gen.getTime() > 4 * 3600 * 1000;
  liveEl.classList.toggle("is-stale", stale);
  liveTimeEl.textContent = fmtTime.format(gen);
  liveEl.title = (stale ? "Planning peut-être daté — dernière mise à jour " : "Planning à jour — ") + fmtTime.format(gen);
}

// ---------- Rendu des cours ----------
function courseMeta(ev, { big = false } = {}) {
  const parts = [];
  const place = (ev.rooms && ev.rooms.length) ? ev.rooms.join(" · ") : ev.location;
  if (place) parts.push(`<span>${ico("i-pin")}${esc(place)}</span>`);
  if (ev.teacher) parts.push(`<span>${ico("i-user")}${esc(ev.teacher)}</span>`);
  const tags = [];
  if (ev.modalite) {
    const remote = !/présentiel/i.test(ev.modalite);
    tags.push(`<span class="tag${remote ? " is-remote" : ""}">${esc(ev.modalite)}</span>`);
  }
  if (big && ev.groups) tags.push(`<span class="tag">${esc(ev.groups)}</span>`);
  const metaRow = parts.length ? `<div class="meta">${parts.join("")}</div>` : "";
  const tagRow = tags.length ? `<div class="meta">${tags.join("")}</div>` : "";
  return metaRow + tagRow;
}

function courseRow(ev, now) {
  const src = ev.source || "course";
  const past = new Date(ev.end || ev.start) < now;
  const sub = (ev.rooms && ev.rooms[0]) || ev.location || (src !== "course" ? SRC_LABEL[src] : "");
  return `<div class="row src-${src}${past ? " is-past" : ""}${ev._hidden ? " is-hidden" : ""}" ${evAttrs(ev)}>
    <div class="row-time mono">${fmtTime.format(new Date(ev.start))}<br><span class="end">${ev.end ? fmtTime.format(new Date(ev.end)) : ""}</span></div>
    <div>
      <div class="row-title">${esc(ev.title)}</div>
      <div class="row-sub">${esc(sub)}${ev.teacher ? " — " + esc(ev.teacher) : ""}</div>
    </div>
  </div>`;
}

// ---------- Vue Aujourd'hui (tableau de bord) ----------

const illus = (id) => `<svg class="ill" viewBox="0 0 220 170" aria-hidden="true"><use href="#${id}"/></svg>`;
const hmMin = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.round(m % 60)).padStart(2, "0")}`;
const durMin = (e) => Math.max(0, (e.end ? parisMinutes(e.end) : parisMinutes(e.start) + 60) - parisMinutes(e.start));

// "dans 1 h 02" / "45 min" / "2 j"
function countdown(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return m ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`;
  return `${Math.round(h / 24)} j`;
}
// "6h" / "6h30" / "45 min"
function hoursLabel(min) {
  if (min <= 0) return "0h";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m >= 30 ? `${h}h30` : `${h}h`;
}

// Emblème (icône) par matière : d'abord la source, puis des mots-clés du titre.
function subjectIcon(ev) {
  if (ev.source === "fl" || ev.source === "ef") return "i-video";
  if (ev.source === "perso" || ev.source === "gc") return "i-user";
  const t = (ev.title || "").toLowerCase();
  if (/archi|logiciel|génie|conception|uml/.test(t)) return "i-cube";
  if (/base de don|bdd|sql|donnée|data/.test(t)) return "i-db";
  if (/web|front|back|dévelop|develop|program|code|java|python|algo|\binfo/.test(t)) return "i-code";
  return "i-cap";
}
const SRC_HC = { course: "var(--ev-course)", perso: "var(--ev-perso)", fl: "var(--ev-fl)", ef: "var(--ev-ef)", gc: "var(--ev-gc)" };

// Trous libres (≥ 45 min) entre les créneaux de la journée (sur l'union des créneaux).
function freeGaps(items) {
  if (!items.length) return [];
  const iv = items.map((e) => [e.s, e.e2]).sort((a, b) => a[0] - b[0]);
  const merged = [iv[0].slice()];
  for (const [s, e] of iv.slice(1)) {
    const last = merged[merged.length - 1];
    if (s <= last[1]) last[1] = Math.max(last[1], e); else merged.push([s, e]);
  }
  const gaps = [];
  for (let i = 1; i < merged.length; i++) {
    const s = merged[i - 1][1], e = merged[i][0];
    if (e - s >= 45) gaps.push({ s, e, len: e - s });
  }
  return gaps;
}
// Prochain trou libre se terminant après maintenant.
function nextFreeGap(items, N) {
  const nm = parisMinutes(N.toISOString());
  return freeGaps(items).find((g) => g.e > nm) || null;
}

// Timeline verticale d'une journée : créneaux positionnés à l'heure, trous libres, ligne "maintenant".
function dayTimeline(evs) {
  const items = packDay(evs.map((e) => ({ ...e, s: parisMinutes(e.start), e2: e.end ? parisMinutes(e.end) : parisMinutes(e.start) + 60 })));
  const PX = desktop() ? 62 : 56;
  let minH = 8, maxH = 19;
  items.forEach((e) => { minH = Math.min(minH, Math.floor(e.s / 60)); maxH = Math.max(maxH, Math.ceil(e.e2 / 60)); });
  minH = Math.max(0, minH); maxH = Math.min(24, maxH);
  const top0 = minH * 60, rows = Math.max(1, maxH - minH);
  const y = (min) => (min - top0) / 60 * PX;

  const rowsHtml = Array.from({ length: rows }, (_, k) =>
    `<div class="tl-row"><span class="tl-ax">${String(minH + k).padStart(2, "0")}:00</span><span class="tl-line"></span></div>`).join("");

  const gapsHtml = freeGaps(items).map((g) => {
    const h = Math.floor(g.len / 60), m = g.len % 60;
    const lab = h ? `${h} h${m ? " " + m : ""} de libre` : `${m} min de libre`;
    return `<div class="tl-gap" style="top:${y(g.s) + 3}px;height:${g.len / 60 * PX - 6}px"><span>${ico("i-coffee")}${lab} · ${hmMin(g.s)}–${hmMin(g.e)}</span></div>`;
  }).join("");

  const evHtml = items.map((ev) => {
    const h = Math.max(30, (ev.e2 - ev.s) / 60 * PX - 4);
    const w = 100 / ev.cols, left = ev.lane * w;
    const dur = ev.e2 - ev.s;
    const size = dur <= 40 ? " is-tiny" : dur <= 70 ? " is-sm" : "";
    const conf = ev.conflict;
    const loc = (ev.rooms && ev.rooms[0]) || ev.location || ev.teacher || "";
    const exam = isExam(ev);
    return `<div class="tev src-${ev.source}${size}${conf ? " is-conf" : ""}${ev._hidden ? " is-hidden" : ""}${exam ? " is-exam" : ""}" ${evAttrs(ev)} title="${esc(ev.title)}"
      style="top:${y(ev.s)}px;height:${h}px;left:calc(${left}% + ${left ? 3 : 0}px);width:calc(${w}% - ${ev.cols > 1 ? 6 : 0}px)">
      <div class="hd"><span class="emb">${ico(exam ? "i-alert" : subjectIcon(ev))}</span><span class="t">${hmMin(ev.s)} – ${hmMin(ev.e2)}</span>${exam ? `<span class="exam-tag">EXAMEN</span>` : conf ? ico("i-alert") : ""}</div>
      <div class="ti">${esc(ev.title)}</div>
      ${loc ? `<div class="lo">${ico("i-pin")}<span>${esc(loc)}</span></div>` : ""}
    </div>`;
  }).join("");

  const nowMin = parisMinutes(now().toISOString());
  const showNow = nowMin >= top0 && nowMin <= maxH * 60;
  const nowHtml = showNow ? `<div class="tl-now" style="top:${y(nowMin)}px"><b>${fmtTime.format(now())}</b></div>` : "";

  return `<div class="tl" style="--px:${PX}px">${rowsHtml}<div class="tl-area">${gapsHtml}${evHtml}${nowHtml}</div></div>`;
}

// Héros "prochain créneau" (ou journée libre / terminée).
function heroNext(evs, curIdx, nextIdx, N) {
  const art = `<svg class="hero-art" viewBox="0 0 200 140" aria-hidden="true"><use href="#art-plan"/></svg>`;
  if (!evs.length) {
    return `<div class="hero-next" style="--hc:var(--ok)">
      <div class="kicker"><i></i>Aujourd'hui</div>
      <div class="cd">Journée libre</div>
      <div class="ti">Rien de prévu — profites-en.</div>${art}</div>`;
  }
  if (curIdx === -1 && nextIdx === -1) {
    return `<div class="hero-next" style="--hc:var(--muted)">
      <div class="kicker"><i></i>Terminé</div>
      <div class="cd">Journée terminée</div>
      <div class="ti">Tous tes créneaux sont passés.</div>${art}</div>`;
  }
  const isNow = curIdx !== -1;
  const ev = evs[isNow ? curIdx : nextIdx];
  const hc = SRC_HC[ev.source] || "var(--ev-course)";
  const start = new Date(ev.start), end = ev.end ? new Date(ev.end) : null;
  const cd = isNow
    ? (end ? `encore ${countdown(end - N)} <small>· fin ${fmtTime.format(end)}</small>` : "En cours")
    : `dans ${countdown(start - N)} <small>· ${fmtTime.format(start)}</small>`;
  const place = (ev.rooms && ev.rooms[0]) || ev.location;
  const meta = [`<span>${ico("i-clock")}${fmtTime.format(start)}${end ? " – " + fmtTime.format(end) : ""}</span>`];
  if (place) meta.push(`<span>${ico("i-pin")}${esc(place)}</span>`);
  meta.push(`<span>${ico(subjectIcon(ev))}${SRC_LABEL[ev.source] || "Cours"}</span>`);
  return `<div class="hero-next" style="--hc:${hc}" ${evAttrs(ev)}>
    <div class="kicker"><i></i>${isNow ? "En ce moment" : "Prochain créneau"}</div>
    <div class="cd">${cd}</div>
    <div class="ti">${esc(ev.title)}</div>
    <div class="meta">${meta.join("")}</div>${art}</div>`;
}

// Carte contexte : badge école/entreprise, prochain trou libre, compteurs.
function ctxCard(evs, key, N, signed) {
  const items = evs.map((e) => ({ s: parisMinutes(e.start), e2: e.end ? parisMinutes(e.end) : parisMinutes(e.start) + 60 }));
  const badge = modeBadge(key);
  const gap = nextFreeGap(items, N);
  const freeChip = gap ? `<span class="free-chip">${ico("i-coffee")}Libre ${hmMin(gap.s)}–${hmMin(gap.e)}</span>` : "";
  const nCours = evs.filter((e) => e.source === "course").length;
  const totalMin = evs.reduce((a, e) => a + durMin(e), 0);
  const nTasks = signed ? openTaskCount(key) : null;
  const topRow = (badge || freeChip) ? `<div class="ctx-row">${badge}${freeChip}</div>` : "";
  const trainRow = trainLine(trainingForDay(key), key, signed);
  const stat = (icn, v, l) => `<span class="ctx-stat">${ico(icn)}<b>${v}</b> ${l}</span>`;
  const stats = [stat("i-cap", nCours, "cours"), stat("i-clock", hoursLabel(totalMin), "aujourd'hui")];
  if (nTasks != null) stats.push(stat("i-tasks", nTasks, nTasks > 1 ? "tâches" : "tâche"));
  return `<div class="hero-ctx"><div class="ctx-card">
    ${topRow}
    ${trainRow}
    <div class="ctx-row ctx-stats">${stats.join("")}</div>
  </div></div>`;
}

function openTaskCount(key) {
  if (!_store?.session) return 0;
  return _store.todos.filter((t) => !t.done && (!t.due_date || t.due_date <= key)).length;
}

// Anneau SVG de progression (faites / total).
function ringHtml(done, total) {
  const r = 17, C = 2 * Math.PI * r;
  const off = C * (1 - (total ? done / total : 0));
  return `<span class="ph-lab">${done} sur ${total}</span>
    <div class="ring" title="${done} faites sur ${total} aujourd'hui" aria-label="${done} sur ${total} tâches du jour">
      <svg viewBox="0 0 40 40" aria-hidden="true"><circle class="bg" cx="20" cy="20" r="${r}"/><circle class="fg" cx="20" cy="20" r="${r}" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/></svg>
      <span class="n">${done}/${total}</span>
    </div>`;
}

// Met à jour l'anneau (en-tête panneau) et le petit mot d'avancement.
function setDayProgress(total, done) {
  const left = total - done;
  // La dernière tâche du jour vient d'être cochée : l'anneau et le mot d'avancement le marquent.
  const cheer = total > 0 && left <= 0 && Date.now() - _cheerAt < 1200;
  const ring = document.getElementById("dash-ring");
  if (ring) { ring.innerHTML = total ? ringHtml(done, total) : ""; ring.classList.toggle("cheer", cheer); }
  const nudge = document.getElementById("day-nudge");
  if (!nudge) return;
  if (!total) { nudge.hidden = true; nudge.innerHTML = ""; }
  else if (left <= 0) { nudge.hidden = false; nudge.className = "nudge is-done" + (cheer ? " cheer" : ""); nudge.innerHTML = `${ico("i-check")}<b>Journée pliée</b> — tout est coché.`; }
  else { nudge.hidden = false; nudge.className = "nudge"; nudge.innerHTML = `${ico("i-bolt")}Plus que <b>${left} tâche${left > 1 ? "s" : ""}</b> pour plier ta journée.`; }
}

// Capture rapide : saisir une tâche en 1 geste, choisir le jour, Entrée.
function wireCapture(root) {
  const form = root.querySelector("#capture");
  if (!form) return;
  const input = form.querySelector("#cap-input");
  const dateInput = form.querySelector("#cap-date");
  const chips = [...form.querySelectorAll(".cap-chip")];
  const dateChip = form.querySelector('[data-day="date"]');
  let selDue = dayKey(now());

  const activate = (el) => chips.forEach((c) => c.classList.toggle("on", c === el));
  const clearDateLabel = () => { const l = dateChip.querySelector(".cap-dlabel"); if (l) l.remove(); };
  form.querySelector('[data-day="today"]').addEventListener("click", (e) => { selDue = dayKey(now()); clearDateLabel(); activate(e.currentTarget); });
  form.querySelector('[data-day="tomorrow"]').addEventListener("click", (e) => { selDue = addDays(dayKey(now()), 1); clearDateLabel(); activate(e.currentTarget); });
  dateInput.addEventListener("change", () => {
    if (!dateInput.value) return;
    selDue = dateInput.value;
    activate(dateChip);
    let l = dateChip.querySelector(".cap-dlabel");
    if (!l) { l = document.createElement("span"); l.className = "cap-dlabel"; dateChip.appendChild(l); }
    l.textContent = fmtWdDay.format(new Date(dateInput.value + "T12:00:00Z"));
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = input.value.trim();
    if (!title || !_store?.session) return;
    input.value = "";
    const { error } = await _store.sb.from("todos").insert({ title, due_date: selDue });
    if (error) { oops("Ajout impossible : " + error.message); return; }
    await refreshAfterAdd();
    rerender();
    document.getElementById("cap-input")?.focus(); // garder le flux pour enchaîner
  });
}

function renderToday() {
  titleEl.textContent = "Aujourd'hui";
  const N = now();
  dateEl.textContent = cap(fmtDayLabel.format(N));
  const key = dayKey(N);
  const signed = !!_store?.session;

  if (!PLANNING) {
    viewEl.innerHTML = `<div class="note">${illus("art-offline")}<h3>Planning indisponible</h3><p>Pas de réseau et aucune copie en cache pour l'instant.</p></div>`;
    updateFab(); return;
  }

  const evs = mergedEventsForDay(key);
  const curIdx = evs.findIndex((e) => new Date(e.start) <= N && N < new Date(e.end || e.start));
  const nextIdx = evs.findIndex((e) => new Date(e.start) > N);

  const countTxt = evs.length ? `${cap(fmtWeekday.format(N))} · ${evs.length} créneau${evs.length > 1 ? "x" : ""}` : "";
  const timeline = evs.length
    ? dayTimeline(evs)
    : `<div class="empty-ill">${illus("art-free")}<div class="ei-t">Journée libre</div><div class="ei-d">Aucun cours ni réunion aujourd'hui.</div></div>`;

  // État d'authentification : connu dès que le store est initialisé (ou qu'une tentative a échoué).
  const authKnown = !!_store || _storeTried;
  const signedOutPanel = `<div class="panel"><div class="panel-h"><h2>À faire</h2></div><div class="empty-ill">${illus("art-signin")}<div class="ei-t">Tes tâches ici</div><div class="ei-d">Connecte-toi pour les retrouver sur tous tes appareils.</div><button class="btn btn-ghost ei-btn" type="button" id="go-signin">Se connecter</button></div></div>`;
  let tasksPanel;
  if (SUPA_READY && signed) tasksPanel = `<div class="panel"><div class="panel-h"><h2>À faire</h2><div class="ph-prog" id="dash-ring"></div></div><div id="dash-tasks"></div></div>`;
  else if (SUPA_READY && !authKnown) tasksPanel = `<div class="panel"><div class="panel-h"><h2>À faire</h2></div><div id="dash-tasks"></div></div>`; // auth en cours de résolution
  else tasksPanel = signedOutPanel;

  // Capture rapide : le premier réflexe en ouvrant l'app (connecté uniquement).
  const captureHtml = signed ? `
    <form class="capture" id="capture">
      <svg class="cap-ico" aria-hidden="true"><use href="#i-pen"/></svg>
      <input class="cap-input" id="cap-input" placeholder="${matchMedia("(max-width: 430px)").matches ? "Nouvelle tâche" : "Qu'est-ce que tu dois faire ?"}" autocomplete="off" maxlength="200" aria-label="Noter une tâche">
      <div class="cap-chips">
        <button type="button" class="cap-chip on" data-day="today">Aujourd'hui</button>
        <button type="button" class="cap-chip" data-day="tomorrow">Demain</button>
        <label class="cap-chip cap-ic" data-day="date" aria-label="Choisir un autre jour"><svg aria-hidden="true"><use href="#i-today"/></svg><input type="date" class="cap-date" id="cap-date" aria-label="Jour de la tâche"></label>
      </div>
      <button class="cap-send" type="submit" aria-label="Ajouter"><svg aria-hidden="true"><use href="#i-plus"/></svg></button>
    </form>
    <div class="nudge" id="day-nudge" hidden></div>` : "";

  viewEl.innerHTML = `
    ${captureHtml}
    <section class="hero">${heroNext(evs, curIdx, nextIdx, N)}${ctxCard(evs, key, N, signed)}</section>
    <div id="dash-exam"></div>
    <div id="dash-goal"></div>
    <div id="dash-upcoming"></div>
    <section class="dash">
      <div class="panel"><div class="panel-h"><h2>Journée</h2><span class="count">${countTxt}</span></div>${timeline}</div>
      ${tasksPanel}
    </section>`;

  wireEventTaps(viewEl);
  wireCapture(viewEl);
  viewEl.querySelector("[data-skip]")?.addEventListener("click", (e) => toggleTrainingSkip(e.currentTarget.dataset.skip));
  viewEl.querySelector("#go-signin")?.addEventListener("click", () => document.querySelector('.tab[data-view="tasks"]')?.click());
  updateFab();
  // Résout l'état connecté une fois (le store charge Supabase à la demande), puis re-rend.
  if (SUPA_READY && !_store && !_storeTried) {
    _storeTried = true;
    getStore().then(() => { if (current === "today") rerender(); });
  } else if (signed) {
    renderDashExam();
    renderDashTasks();
    renderDashGoal();
    renderDashUpcoming();
  }
}

async function renderDashTasks() {
  const mount = document.getElementById("dash-tasks");
  if (!mount) return;
  const store = await getStore();
  if (!store?.session) return;
  const todayK = dayKey(now());
  const todos = store.todos;
  const weekEnd = endOfWeekKey();
  const byDue = (a, b) => (a.due_date || "9999").localeCompare(b.due_date || "9999");
  const late = todos.filter((t) => !t.done && t.due_date && t.due_date < todayK).sort(byDue);
  const today = todos.filter((t) => !t.done && (!t.due_date || t.due_date === todayK));
  const soon = todos.filter((t) => !t.done && t.due_date && t.due_date > todayK && t.due_date <= weekEnd).sort(byDue);
  const later = todos.filter((t) => !t.done && t.due_date && t.due_date > weekEnd).sort(byDue);
  const total = late.length + today.length + soon.length + later.length;

  // Progression du jour : tâches datées d'aujourd'hui (faites / total).
  const dueToday = todos.filter((t) => t.due_date === todayK);
  setDayProgress(dueToday.length, dueToday.filter((t) => t.done).length);

  if (!total) {
    mount.innerHTML = `<div class="empty-ill">${illus("art-done")}<div class="ei-t">Tout est fait</div><div class="ei-d">Aucune tâche en attente.</div></div>`;
    return;
  }
  const groups = [
    ["late", "En retard", "i-alert", late],
    ["", "Aujourd'hui", "i-today", today],
    ["", "Cette semaine", "i-week", soon],
    ["", "Plus tard", "i-clock", later],
  ].filter((g) => g[3].length);
  mount.innerHTML = `<div class="tasks">${groups.map(([cls, label, icn, list]) =>
    `<div class="tgroup ${cls}"><div class="tl-h">${ico(icn, "")}${label}<span class="n">${list.length}</span></div>${list.map(todoRow).join("")}</div>`).join("")}
    <button class="addbox" id="dash-add">${ico("i-plus", "")}Ajouter une tâche…</button></div>`;
  wireTodos(mount, store);
  mount.querySelector("#dash-add")?.addEventListener("click", () => openTaskAdd(todayK));
}

// ---------- Vue Semaine ----------
// Jours (lun→dim) de la semaine décalée de `offset` par rapport à la semaine courante.
function weekDays(offset) {
  const [Y, M, D] = fmtDayKey.format(new Date()).split("-").map(Number);
  const d = new Date(Date.UTC(Y, M - 1, D));
  const dow = (d.getUTCDay() + 6) % 7; // Lundi = 0
  d.setUTCDate(d.getUTCDate() - dow + offset * 7);
  const out = [];
  for (let i = 0; i < 7; i++) {
    const x = new Date(d); x.setUTCDate(d.getUTCDate() + i);
    const key = `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}-${String(x.getUTCDate()).padStart(2, "0")}`;
    out.push({ key, date: x });
  }
  return out;
}

// Événements d'un jour, toutes sources fusionnées : cours myefrei (hors masqués) + perso + Teams.
function mergedEventsForDay(key) {
  const out = [];
  const hidden = _store?.hidden || new Set();
  for (const e of (PLANNING?.events || [])) {
    if (dayKey(new Date(e.start)) !== key) continue;
    const isHidden = hidden.has(e.uid);
    if (isHidden && !showHidden) continue;
    out.push({ ...e, source: "course", _hidden: isHidden });
  }
  if (_store?.session) {
    for (const c of (_store.custom || [])) if (c.start_at && dayKey(new Date(c.start_at)) === key) out.push(normCustom(c));
    for (const t of (_store.teams || [])) {
      if (!t.start_at || dayKey(new Date(t.start_at)) !== key) continue;
      if (isCanceledMeeting(t.title)) continue; // réunions annulées masquées
      out.push(normTeams(t));
    }
  }
  return out.sort((a, b) => new Date(a.start) - new Date(b.start));
}

// Reconstruit l'objet événement depuis les data-attributes d'un bloc cliqué.
function findEventFromDataset(ds) {
  if (ds.src === "course") {
    const e = (PLANNING?.events || []).find((x) => x.uid === ds.uid);
    return e ? { ...e, source: "course", _hidden: (_store?.hidden || new Set()).has(e.uid) } : null;
  }
  if (ds.src === "perso") {
    const c = (_store?.custom || []).find((x) => String(x.id) === ds.cid);
    return c ? normCustom(c) : null;
  }
  const t = (_store?.teams || []).find((x) => String(x.id) === ds.tid);
  return t ? normTeams(t) : null;
}

// Attributs d'identification posés sur chaque bloc cliquable.
function evAttrs(ev) {
  const id = ev.source === "course" ? `data-uid="${esc(ev.uid)}"`
    : ev.source === "perso" ? `data-cid="${esc(ev.cid)}"`
    : `data-tid="${esc(ev.tid)}"`;
  return `data-ev data-src="${ev.source}" ${id} role="button" tabindex="0"`;
}

// Branche le tap/entrée sur les blocs événements d'un conteneur (si connecté).
function wireEventTaps(root) {
  if (!_store?.session) return;
  root.querySelectorAll("[data-ev]").forEach((el) => {
    const open = () => { const ev = findEventFromDataset(el.dataset); if (ev) openEventActions(ev); };
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
}

// Répartit les événements qui se chevauchent en colonnes côte à côte.
// Deux créneaux ne sont mis côte à côte (et signalés en conflit) que s'ils se
// chevauchent de plus de MIN_OVERLAP minutes. Un simple bord qui se touche
// (ex. un RDV qui démarre quand un cours finit) reste plein largeur et lisible.
const MIN_OVERLAP = 15;
const overlapMin = (a, b) => Math.min(a.e2, b.e2) - Math.max(a.s, b.s);

function packDay(evs) {
  evs.sort((a, b) => a.s - b.s || a.e2 - b.e2);
  const clusters = []; let cur = []; let curEnd = -1;
  for (const ev of evs) {
    if (cur.length && ev.s >= curEnd) { clusters.push(cur); cur = []; curEnd = -1; }
    cur.push(ev); curEnd = Math.max(curEnd, ev.e2);
  }
  if (cur.length) clusters.push(cur);
  for (const cl of clusters) {
    const laneEnds = [];
    for (const ev of cl) {
      // On ne passe à une colonne suivante que pour un VRAI chevauchement (> seuil).
      let lane = 0; while (lane < laneEnds.length && laneEnds[lane] - ev.s > MIN_OVERLAP) lane++;
      if (lane === laneEnds.length) laneEnds.push(ev.e2); else laneEnds[lane] = Math.max(laneEnds[lane], ev.e2);
      ev.lane = lane;
    }
    for (const ev of cl) ev.cols = laneEnds.length;
  }
  // Drapeau de conflit, par paire : au moins un autre créneau chevauche de > seuil.
  for (const a of evs) a.conflict = false;
  for (let i = 0; i < evs.length; i++)
    for (let j = i + 1; j < evs.length; j++)
      if (overlapMin(evs[i], evs[j]) > MIN_OVERLAP) { evs[i].conflict = true; evs[j].conflict = true; }
  return evs;
}

// Paires de créneaux en conflit sur la semaine (pour le bandeau + le saut).
function weekConflicts(perDay) {
  const out = [];
  perDay.forEach((items, i) => {
    for (let a = 0; a < items.length; a++)
      for (let b = a + 1; b < items.length; b++)
        if (overlapMin(items[a], items[b]) > MIN_OVERLAP)
          out.push({ i, s: Math.max(items[a].s, items[b].s) });
  });
  return out.sort((x, y) => x.i - y.i || x.s - y.s);
}

// Segmented control de navigation (‹ Cette semaine ›).
function weekNav(days) {
  const label = weekOffset === 0 ? "Cette semaine"
    : weekOffset === 1 ? "Semaine prochaine"
    : weekOffset === -1 ? "Semaine dernière"
    : `${fmtRange.format(days[0].date)} – ${fmtRange.format(days[6].date)}`;
  const chevron = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M${d === "l" ? "15 6l-6 6 6 6" : "9 6l6 6-6 6"}"/></svg>`;
  return `<div class="wk-seg">
    <button class="wk-seg-ic" data-wk="-1" aria-label="Semaine précédente">${chevron("l")}</button>
    <button class="wk-seg-now${weekOffset === 0 ? " is-current" : ""}" data-wk="0">${label}</button>
    <button class="wk-seg-ic" data-wk="1" aria-label="Semaine suivante">${chevron("r")}</button>
  </div>`;
}

function wireWeekNav() {
  viewEl.querySelectorAll("[data-wk]").forEach((b) => b.addEventListener("click", () => {
    const v = b.dataset.wk;
    weekOffset = v === "0" ? 0 : weekOffset + Number(v);
    weekDay = -1; // on repasse en mode auto (aujourd'hui) à chaque changement de semaine
    renderWeek(); window.scrollTo({ top: 0 });
  }));
}

// Bandeau de stats (cours, heures planifiées, réunions pro) à partir des blocs déjà positionnés.
function weekStats(perDay) {
  let nCours = 0, nPro = 0, totalMin = 0;
  perDay.flat().forEach((e) => {
    totalMin += Math.max(0, e.e2 - e.s);
    if (e.source === "course") nCours++;
    if (e.source === "fl") nPro++;
  });
  const hours = Math.round(totalMin / 60);
  const stat = (id, k, l) => `<div class="wk-stat">${ico(id, "si")}<span class="k num">${k}</span><span class="l">${l}</span></div>`;
  let html = stat("i-cap", nCours, nCours > 1 ? "cours" : "cours");
  html += stat("i-clock", `${hours}h`, "planifiées");
  if (_store?.session && nPro) html += stat("i-brief", nPro, nPro > 1 ? "réunions pro" : "réunion pro");
  return `<div class="wk-stats">${html}</div>`;
}

// Légende des sources réellement présentes dans la semaine (+ Entreprise si jour entreprise).
function weekLegend(perDay, days) {
  const present = new Set(perDay.flat().map((e) => e.source));
  const items = [];
  if (present.has("course")) items.push(["var(--ev-course)", "Cours"]);
  if (present.has("perso")) items.push(["var(--ev-perso)", "Perso"]);
  if (present.has("fl")) items.push(["var(--ev-fl)", "Pro"]);
  if (present.has("ef")) items.push(["var(--ev-ef)", "École (Teams)"]);
  if (present.has("gc")) items.push(["var(--ev-gc)", "Agenda Google"]);
  if (days.some((d) => dayMode(d.key) === "entreprise")) items.push(["var(--warn)", "Entreprise"]);
  if (!items.length) return "";
  return `<div class="wk-legend">${items.map(([c, l]) =>
    `<span class="wk-chip" style="--c:${c}"><i></i>${l}</span>`).join("")}</div>`;
}

// Pastilles de jours (mobile) pour choisir le jour affiché.
function weekPills(days, sel) {
  const todayK = dayKey(new Date());
  return `<div class="wk-pills" id="wk-pills">${days.map((d, i) => {
    const wd = new Date(d.key + "T12:00:00Z").getUTCDay();
    const we = wd === 0 || wd === 6;
    return `<button class="wk-pill${i === sel ? " is-on" : ""}${we ? " is-we" : ""}" data-i="${i}" aria-pressed="${i === sel}">
      <span class="pd">${cap(fmtWdShort.format(d.date)).replace(/\.$/, "")}</span><span class="pn num">${fmtDayNum.format(d.date)}</span>
    </button>`;
  }).join("")}</div>`;
}

// Nombre de cours ignorés tombant dans la semaine affichée.
function hiddenCountWeek(days) {
  if (!_store?.session) return 0;
  const hidden = _store.hidden || new Set();
  const keys = new Set(days.map((d) => d.key));
  let n = 0;
  for (const e of (PLANNING?.events || [])) if (hidden.has(e.uid) && keys.has(dayKey(new Date(e.start)))) n++;
  return n;
}

function weekTools(days) {
  const eye = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
  const chips = [];
  const n = hiddenCountWeek(days);
  if (n) chips.push(`<button class="chip${showHidden ? " is-on" : ""}" id="toggle-hidden">${eye}${showHidden ? "Masquer" : "Voir"} les cours ignorés · ${n}</button>`);
  if (days.some((d) => dayMode(d.key) === "entreprise")) {
    chips.push(`<button class="chip${sgOn ? " is-on" : ""}" id="toggle-sg">${ico("i-clock", "si")}Horaires SG</button>`);
  }
  return chips.length ? `<div class="wk-tools">${chips.join("")}</div>` : "";
}

let weekSlide = 0;          // mobile : direction de l'animation de glissement entre jours

function renderWeek() {
  titleEl.textContent = "Semaine";
  const days = weekDays(weekOffset);
  dateEl.textContent = `${fmtRange.format(days[0].date)} – ${fmtRange.format(days[6].date)}`;
  if (!PLANNING) {
    viewEl.innerHTML = `<div class="wk"><div class="wk-bar">${weekNav(days)}</div>
      <div class="note">${illus("art-offline")}<h3>Rien à afficher</h3><p>Planning indisponible.</p></div></div>`;
    wireWeekNav(); return;
  }

  // Une seule passe de positionnement, réutilisée pour les stats, la légende et la grille.
  const perDay = days.map((d) => packDay(mergedEventsForDay(d.key).map((e) => ({
    ...e, s: parisMinutes(e.start), e2: e.end ? parisMinutes(e.end) : parisMinutes(e.start) + 60,
  }))));
  const todayIdx = days.findIndex((d) => d.key === dayKey(new Date()));
  const sel = weekDay >= 0 ? weekDay : (todayIdx >= 0 ? todayIdx : 0);

  const bar = `<div class="wk-bar">${weekNav(days)}${weekStats(perDay)}<div class="wk-spacer"></div>${weekLegend(perDay, days)}</div>`;
  const conflicts = weekConflicts(perDay);
  const alert = conflicts.length
    ? `<button class="wk-alert" id="wk-alert" data-i="${conflicts[0].i}">${ico("i-alert", "si")}
        <span><b>${conflicts.length} conflit${conflicts.length > 1 ? "s" : ""} à vérifier</b> cette semaine — deux créneaux se chevauchent.</span>
        <span class="wk-alert-go">Voir&nbsp;›</span></button>`
    : "";
  viewEl.innerHTML = `<div class="wk">${bar}${alert}${weekTools(days)}${weekPills(days, sel)}${weekGrid(days, perDay, sel)}</div>`;

  wireWeekNav();
  viewEl.querySelector("#toggle-hidden")?.addEventListener("click", () => { showHidden = !showHidden; renderWeek(); });
  viewEl.querySelector("#toggle-sg")?.addEventListener("click", () => { sgOn = !sgOn; renderWeek(); });
  viewEl.querySelector("#wk-alert")?.addEventListener("click", () => {
    const i = conflicts[0].i;
    if (!desktop() && weekDay !== i) { weekDay = i; renderWeek(); }
    requestAnimationFrame(() => {
      const els = [...viewEl.querySelectorAll(".ev.is-conf")].filter((e) => e.offsetParent !== null);
      const el = els[0] || viewEl.querySelector(".ev.is-conf");
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.remove("pulse"); void el.offsetWidth; el.classList.add("pulse");
    });
  });
  wirePills();
  wireEventTaps(viewEl);
  wireCalAdd(days);
  updateFab();
  weekSlide = 0;
}

// Tap sur une zone vide d'une colonne jour -> ajout d'un événement à cette heure.
function wireCalAdd(days) {
  if (!_store?.session) return;
  const cal = viewEl.querySelector(".cal");
  if (!cal) return;
  const top0 = +cal.dataset.top0 || 0;
  const PX = +cal.dataset.px || 56;
  const pad = (n) => String(n).padStart(2, "0");
  const hhmm = (min) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;
  viewEl.querySelectorAll(".cal-col").forEach((col, i) => {
    col.addEventListener("click", (e) => {
      if (e.target.closest(".ev")) return;                 // clic sur un créneau existant -> géré ailleurs
      const rect = col.getBoundingClientRect();
      let min = top0 + ((e.clientY - rect.top) / PX) * 60;  // minutes depuis minuit
      min = Math.max(top0, Math.round(min / 15) * 15);       // arrondi au quart d'heure
      const endMin = Math.min(24 * 60, min + 60);
      openEventForm(days[i].key, hhmm(min), hhmm(endMin));
    });
  });
}

// Sélecteur de jour mobile : change le jour affiché (avec sens de glissement).
function wirePills() {
  const cur = weekDay >= 0 ? weekDay : 0;
  viewEl.querySelectorAll("#wk-pills .wk-pill").forEach((b) => b.addEventListener("click", () => {
    const n = +b.dataset.i;
    if (n === weekDay) return;
    weekSlide = n > cur ? 14 : -14;
    weekDay = n;
    renderWeek();
  }));
}

const SRC_ICON = { course: "i-cap", perso: "i-user", fl: "i-brief", ef: "i-brief", gc: "i-user" };

// Grille horaire 7 jours (desktop) / 1 jour qui défile (mobile), câblée aux vraies sources.
function weekGrid(days, perDay, sel) {
  const todayK = dayKey(new Date());
  const mobile = !desktop();
  const PX = mobile ? 60 : 56;

  // Plage horaire affichée (heures entières), bornée 8→20 puis élargie aux événements.
  let minH = 8, maxH = 20;
  perDay.flat().forEach((e) => { minH = Math.min(minH, Math.floor(e.s / 60)); maxH = Math.max(maxH, Math.ceil(e.e2 / 60)); });
  minH = Math.max(0, minH); maxH = Math.min(24, maxH);
  const top0 = minH * 60, rows = maxH - minH;
  const yTop = (min) => (min - top0) / 60 * PX;
  const nowMin = parisMinutes(new Date().toISOString());

  const dow = (key) => new Date(key + "T12:00:00Z").getUTCDay();
  const wd = (date) => cap(fmtWdShort.format(date)).replace(/\.$/, "");

  const head = `<div class="cal-corner"></div>` + days.map((d, i) => {
    const t = d.key === todayK, we = dow(d.key) === 0 || dow(d.key) === 6;
    const hide = mobile && i !== sel ? " is-hiddenM" : "";
    return `<div class="cal-colh${t ? " is-today" : ""}${we ? " we" : ""}${hide}">
      <div class="cd">${wd(d.date)}</div><div class="cn num">${fmtDayNum.format(d.date)}</div>${modeBadge(d.key, { compact: true })}${trainChip(trainingForDay(d.key))}</div>`;
  }).join("");

  const slots = Array.from({ length: rows }, () => `<div class="cal-slot"></div>`).join("");
  const axis = `<div class="cal-axis">${Array.from({ length: rows }, (_, k) =>
    `<div class="cal-slot"><b>${String(minH + k).padStart(2, "0")}h</b></div>`).join("")}</div>`;

  const toMin = (hm) => { const [h, m] = hm.split(":").map(Number); return h * 60 + m; };
  const sgBands = (key) => {
    if (!sgOn || dayMode(key) !== "entreprise" || !ALT?.sgHours) return "";
    const seg = (a, b, label) => `<div class="ev-sg" style="top:${yTop(a)}px;height:${(b - a) / 60 * PX}px">${label ? `<b>${label}</b>` : ""}</div>`;
    const { am, pm } = ALT.sgHours;
    return seg(toMin(am[0]), toMin(am[1]), isTelework(key) ? "SG · TT" : "SG") + seg(toMin(pm[0]), toMin(pm[1]), "");
  };

  const cols = days.map((d, i) => {
    const t = d.key === todayK, we = dow(d.key) === 0 || dow(d.key) === 6;
    const hide = mobile && i !== sel ? " is-hiddenM" : "";
    const showNow = t && nowMin >= top0 && nowMin <= maxH * 60 && (!mobile || i === sel);
    const blocks = perDay[i].map((ev, j) => {
      const height = Math.max(22, (ev.e2 - ev.s) / 60 * PX - 4);
      const w = 100 / ev.cols, left = ev.lane * w;
      const dur = ev.e2 - ev.s;
      const size = dur <= 40 ? " is-tiny" : dur <= 70 ? " is-sm" : "";
      const loc = (ev.rooms && ev.rooms[0]) || ev.location || ev.teacher || "";
      const range = `${fmtTime.format(new Date(ev.start))}${ev.end ? "–" + fmtTime.format(new Date(ev.end)) : ""}`;
      const exam = isExam(ev);
      const growL = (i === days.length - 1 || ev.cols > 1) && ev.lane === ev.cols - 1 ? " grow-l" : "";
      return `<div class="ev src-${ev.source}${size}${growL}${ev._hidden ? " is-hidden" : ""}${ev.conflict ? " is-conf" : ""}${exam ? " is-exam" : ""}" ${evAttrs(ev)} title="${esc(ev.title)}${exam ? " — EXAMEN" : ev.conflict ? " — conflit à vérifier" : ""}" style="top:${yTop(ev.s)}px;--h:${height}px;height:var(--h);left:calc(${left}% + 4px);width:calc(${w}% - 8px);animation-delay:${j * 32}ms">
        ${exam ? `<span class="ev-exam-tag">EXAMEN</span>` : ev.conflict ? `<span class="ev-conf" aria-label="Conflit">${ico("i-alert")}</span>` : ""}
        <div class="ev-hd">${ico(exam ? "i-alert" : (SRC_ICON[ev.source] || "i-cap"))}<span class="ev-t mono">${range}</span></div>
        <div class="ev-ti">${esc(ev.title)}</div>
        ${loc ? `<div class="ev-lo">${ico("i-pin")}<span>${esc(loc)}</span></div>` : ""}
      </div>`;
    }).join("");
    const now = showNow ? `<div class="cal-now" style="top:${yTop(nowMin)}px"><span class="cal-now-ln"></span><span class="cal-now-dot"></span><span class="cal-now-lab mono">${fmtTime.format(new Date())}</span></div>` : "";
    return `<div class="cal-col${t ? " is-today" : ""}${we ? " we" : ""}${hide}">${sgBands(d.key)}${slots}${blocks}${now}</div>`;
  }).join("");

  // Largeur adaptative : un jour avec des événements en parallèle (conflits) s'élargit
  // proportionnellement au nombre de voies (plafonné à 3×) pour que les blocs restent lisibles.
  const dayW = perDay.map((evs) => Math.min(3, Math.max(1, ...evs.map((e) => e.cols || 1))));
  const calDays = dayW.map((w) => `minmax(0, ${w}fr)`).join(" ");

  return `<div class="cal" data-top0="${top0}" data-px="${PX}" style="--cal-px:${PX}px;--slide-dir:${weekSlide}px;--cal-days:${calDays}"><div class="cal-head">${head}</div><div class="cal-body">${axis}${cols}</div></div>`;
}

// ---------- Vue À faire ----------
async function renderTasks() {
  titleEl.textContent = "À faire";
  dateEl.textContent = "Tâches";
  if (!SUPA_READY) { viewEl.innerHTML = setupNote(); return; }

  const store = await getStore();
  if (!store) { viewEl.innerHTML = `<div class="note">${illus("art-offline")}<h3>Connexion impossible</h3><p>Impossible de joindre Supabase. Réessaie quand tu as du réseau.</p></div>`; return; }

  if (!store.session) { viewEl.innerHTML = signInView(); wireSignIn(store); return; }

  const todayK = dayKey(now());
  const todos = store.todos;
  const weekEnd = endOfWeekKey();
  const byDue = (a, b) => (a.due_date || "9999").localeCompare(b.due_date || "9999");
  const late = todos.filter((t) => !t.done && t.due_date && t.due_date < todayK).sort(byDue);
  const today = todos.filter((t) => !t.done && (!t.due_date || t.due_date === todayK));
  const soon = todos.filter((t) => !t.done && t.due_date && t.due_date > todayK && t.due_date <= weekEnd).sort(byDue);
  const later = todos.filter((t) => !t.done && t.due_date && t.due_date > weekEnd).sort(byDue);
  const done = todos.filter((t) => t.done).slice(-30).reverse();

  const section = (label, list, cls = "") => list.length
    ? `<p class="section-label${cls ? " " + cls : ""}">${label} · ${list.length}</p><div>${list.map(todoRow).join("")}</div>` : "";

  const body = (late.length + today.length + soon.length + later.length)
    ? section("En retard", late, "is-late") + section("Aujourd'hui", today) + section("Cette semaine", soon) + section("Plus tard", later)
    : `<div class="note">${illus("art-empty")}<h3>Rien en attente</h3><p>Ajoute une tâche ci-dessus.</p></div>`;

  viewEl.innerHTML = `
    ${goalsSection(store.goals || [])}
    <form class="add add-task" id="add-form">
      <div class="add-main">
        <input id="add-input" placeholder="Ajouter une tâche…" autocomplete="off" maxlength="200" aria-label="Nouvelle tâche">
        <input id="add-date" type="date" value="${todayK}" class="add-date" aria-label="À faire avant">
        <button class="btn btn-sq" type="submit" aria-label="Ajouter">${ico("i-plus", "")}</button>
      </div>
      <div class="tag-pick" id="add-tags">${tagPickHtml(null)}</div>
    </form>
    ${body}
    ${done.length ? section("Terminé", done) : ""}
  `;
  wireGoals(viewEl, store);
  wireAdd(store);
  wireTodos(viewEl, store);
}

function todoRow(t) {
  const subs = Array.isArray(t.subtasks) ? t.subtasks : [];
  const doneN = subs.filter((s) => s.done).length;
  const hasSubs = !t.done && subs.length > 0;
  const subInner = tagChip(t.tag) + deadlinePill(t);
  const prog = hasSubs ? `<span class="prog">${doneN}/${subs.length}</span>` : "";
  const sub = subInner ? `<div class="sub">${subInner}</div>` : "";
  const pbar = hasSubs ? `<div class="pbar"><i style="width:${Math.round(doneN / subs.length * 100)}%"></i></div>` : "";
  const list = hasSubs
    ? `<ul class="subs">${subs.map((s) => `<li class="${s.done ? "done" : ""}" data-sid="${esc(s.id)}"><span class="sc${s.done ? " on" : ""}">${ico("i-check")}</span><span class="ss-t">${esc(s.title)}</span></li>`).join("")}</ul>`
    : "";
  return `<div class="todo${t.done ? " is-done" : ""}${_newIds.has(String(t.id)) ? " is-new" : ""}" data-id="${esc(t.id)}">
    <button class="check" role="checkbox" aria-checked="${t.done}" aria-label="${t.done ? "Décocher" : "Cocher"}">${ico("i-check")}</button>
    <div class="tx">
      <div class="tt-row"><span class="tt todo-title">${esc(t.title)}</span>${prog}</div>
      ${sub}${pbar}${list}
    </div>
    <button class="todo-del" aria-label="Supprimer">
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 7h12M9 7V5h6v2M8 7l1 13h6l1-13"/></svg>
    </button>
  </div>`;
}

function setupNote() {
  return `<div class="note" style="text-align:left">
    <h3>Activer la to-do synchronisée</h3>
    <p>La to-do se synchronise entre tes appareils via Supabase (gratuit). Une seule mise en place :</p>
    <ol style="margin:12px 0 0;padding-left:18px;line-height:1.7;font-size:14px">
      <li>Crée un projet sur <code>supabase.com</code></li>
      <li>Crée la table <code>todos</code> et active la sécurité (je te donne le SQL)</li>
      <li>Copie l'<code>URL</code> et la clé <code>anon</code> dans <code>config.js</code></li>
    </ol>
    <p style="margin-top:12px">Dis-moi quand ton projet est créé et je te guide pour le reste.</p>
  </div>`;
}

function signInView() {
  return `<div class="note signin">
    ${illus("art-signin")}
    <h3>Connexion</h3>
    <p>Reçois un lien magique par e-mail pour retrouver tes tâches sur tous tes appareils.</p>
    <form class="add" id="signin-form">
      <input id="signin-email" type="email" required placeholder="ton e-mail" autocomplete="email" aria-label="E-mail">
      <button class="btn" type="submit">Recevoir</button>
    </form>
    <p id="signin-msg" role="status"></p>
  </div>`;
}

// ---------- Supabase ----------
let _store = null;
let _storeTried = false; // a-t-on déjà tenté d'initialiser le store (évite les boucles si hors-ligne) ?
async function getStore() {
  if (_store) return _store;
  if (!SUPA_READY) return null;
  try {
    const { createClient } = await import(`https://esm.sh/@supabase/supabase-js@${SUPABASE_VERSION}`);
    const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    _store = { sb, session: null, todos: [], custom: [], hidden: new Set(), teams: [], skips: new Set(), seenAt: null, goals: [], reminders: new Set(), examFlags: new Map() };
    const { data } = await sb.auth.getSession();
    _store.session = data.session;
    sb.auth.onAuthStateChange((_e, session) => {
      _store.session = session;
      if (session) Promise.all([refreshTodos(), refreshPersonal()]).then(() => rerender());
      else { _store.todos = []; _store.custom = []; _store.hidden = new Set(); _store.teams = []; _store.skips = new Set(); _store.seenAt = null; _store.goals = []; _store.reminders = new Set(); _store.examFlags = new Map(); rerender(); }
    });
    if (_store.session) await Promise.all([refreshTodos(), refreshPersonal()]);
    return _store;
  } catch (e) {
    console.error("Supabase indisponible", e);
    return null;
  }
}

async function refreshTodos() {
  if (!_store?.session) return;
  const { data, error } = await _store.sb.from("todos").select("*").order("created_at", { ascending: true });
  if (!error && data) {
    _store.todos = data;
    try { localStorage.setItem("hub.todos", JSON.stringify(data)); } catch {}
    subscribeRealtime();
  } else if (error) {
    // Secours hors-ligne : dernière liste connue
    try { _store.todos = JSON.parse(localStorage.getItem("hub.todos") || "[]"); } catch {}
  }
}

// Après un ajout : recharge, repère la nouvelle tâche (animation d'entrée) et joue le son.
async function refreshAfterAdd() {
  const before = new Set((_store?.todos || []).map((t) => String(t.id)));
  await refreshTodos();
  _newIds = new Set((_store?.todos || []).map((t) => String(t.id)).filter((id) => !before.has(id)));
  sfx("add");
  quiet(800);
  setTimeout(() => { _newIds = new Set(); }, 700);
}

// Données perso (privées, RLS) : événements ajoutés, cours masqués, réunions Teams importées.
// Les tables peuvent ne pas encore exister (avant la mise en place) -> on dégrade en silence.
async function refreshPersonal() {
  if (!_store?.session) { _store.custom = []; _store.hidden = new Set(); _store.teams = []; _store.skips = new Set(); _store.seenAt = null; _store.goals = []; _store.reminders = new Set(); _store.examFlags = new Map(); return; }
  const [c, o, t, s, p, g, r, x] = await Promise.all([
    _store.sb.from("custom_events").select("*").order("start_at", { ascending: true }),
    _store.sb.from("event_overrides").select("event_uid,hidden"),
    _store.sb.from("calendar_events").select("*").order("start_at", { ascending: true }),
    _store.sb.from("training_skips").select("day"),
    _store.sb.from("planning_seen").select("seen_at").maybeSingle(),
    _store.sb.from("goals").select("*").order("created_at", { ascending: true }),
    _store.sb.from("event_reminders").select("event_key"),
    _store.sb.from("exam_flags").select("event_uid,is_exam"),
  ]);
  _store.custom = c.error ? [] : (c.data || []);
  _store.hidden = o.error ? new Set() : new Set((o.data || []).filter((r) => r.hidden).map((r) => r.event_uid));
  _store.teams = t.error ? [] : (t.data || []);
  _store.skips = s.error ? new Set() : new Set((s.data || []).map((r) => String(r.day).slice(0, 10)));
  _store.seenAt = (p && !p.error && p.data) ? p.data.seen_at : null;
  _store.goals = g.error ? [] : (g.data || []);
  _store.reminders = r.error ? new Set() : new Set((r.data || []).map((x) => x.event_key));
  _store.examFlags = x.error ? new Map() : new Map((x.data || []).map((e) => [e.event_uid, !!e.is_exam]));
  updateBell();
  subscribeRealtime();
}

async function refreshGoals() {
  if (!_store?.session) { _store.goals = []; return; }
  const { data, error } = await _store.sb.from("goals").select("*").order("created_at", { ascending: true });
  if (!error) _store.goals = data || [];
}
async function addGoal(fields) {
  if (!_store?.session) return false;
  const { error } = await _store.sb.from("goals").insert(fields);
  if (error) { oops("Ajout impossible : " + error.message + "\n(As-tu lancé le SQL goals.sql ?)"); return false; }
  sfx("add");
  await refreshGoals(); rerender(); return true;
}
async function updateGoal(id, patch) {
  if (!_store?.session) return;
  const g = _store.goals.find((x) => String(x.id) === String(id)); if (g) Object.assign(g, patch);
  const { error } = await _store.sb.from("goals").update(patch).eq("id", id);
  if (error) oops("Modification impossible : " + error.message);
  await refreshGoals();
}
async function deleteGoal(id) {
  if (!_store?.session) return;
  const { error } = await _store.sb.from("goals").delete().eq("id", id);
  if (error) { oops("Suppression impossible : " + error.message); return; }
  sfx("del");
  await refreshGoals(); rerender();
}
async function mutateGoalActions(id, fn, sound = "tick") {
  if (!_store?.session) return;
  const g = _store.goals.find((x) => String(x.id) === String(id)); if (!g) return;
  const next = fn(Array.isArray(g.actions) ? g.actions : []);
  g.actions = next;
  sfx(sound);
  const { error } = await _store.sb.from("goals").update({ actions: next }).eq("id", id);
  if (error) oops("Actions indisponibles : " + error.message);
  await refreshGoals();
}

// Marquer / dé-marquer un jour comme sauté (décale la rotation). Optimiste + persistance Supabase.
async function toggleTrainingSkip(key) {
  const store = await getStore();
  if (!store?.session) return;
  sfx("toggle");
  if (store.skips.has(key)) {
    store.skips.delete(key);
    rerender();
    const { error } = await store.sb.from("training_skips").delete().eq("day", key);
    if (error) { store.skips.add(key); rerender(); }
  } else {
    store.skips.add(key);
    rerender();
    const { error } = await store.sb.from("training_skips").insert({ day: key });
    if (error) { store.skips.delete(key); rerender(); }
  }
}

// Clé stable d'un événement pour le marquage « ne pas oublier ».
function eventKey(ev) {
  if (ev.source === "course") return "c:" + ev.uid;
  if (ev.source === "perso") return "p:" + ev.cid;
  return "t:" + ev.tid;
}

// Basculer le rappel « ne pas oublier » d'un événement. Optimiste + persistance Supabase.
async function toggleReminder(ev) {
  const store = await getStore();
  if (!store?.session) return;
  const key = eventKey(ev);
  sfx("toggle");
  if (store.reminders.has(key)) {
    store.reminders.delete(key);
    rerender();
    const { error } = await store.sb.from("event_reminders").delete().eq("event_key", key);
    if (error) { store.reminders.add(key); rerender(); oops("Impossible : " + error.message + "\n(As-tu lancé event-reminders.sql ?)"); }
  } else {
    store.reminders.add(key);
    rerender();
    const { error } = await store.sb.from("event_reminders").insert({ event_key: key });
    if (error) { store.reminders.delete(key); rerender(); oops("Impossible : " + error.message + "\n(As-tu lancé event-reminders.sql ?)"); }
  }
}

// ---------- Examens ----------
// Codes d'activité myefrei considérés comme examens (confirmé par l'utilisateur : DE).
const EXAM_CODES = new Set(["DE"]);
// Un créneau est-il un examen ? Base = code d'activité ; correction manuelle (exam_flags) prioritaire.
function isExam(ev) {
  if (!ev || ev.source !== "course") return false;
  const o = _store?.examFlags?.get(ev.uid);
  if (o !== undefined) return o;
  return EXAM_CODES.has(ev.activity);
}
// Basculer / corriger le statut examen d'un cours (optimiste + persistance Supabase).
async function toggleExam(ev) {
  const store = await getStore();
  if (!store?.session || ev.source !== "course") return;
  const next = !isExam(ev);
  const prev = store.examFlags.get(ev.uid);
  store.examFlags.set(ev.uid, next);
  sfx("toggle");
  rerender();
  const { error } = await store.sb.from("exam_flags")
    .upsert({ user_id: store.session.user.id, event_uid: ev.uid, is_exam: next }, { onConflict: "user_id,event_uid" });
  if (error) {
    if (prev === undefined) store.examFlags.delete(ev.uid); else store.examFlags.set(ev.uid, prev);
    rerender(); oops("Impossible : " + error.message + "\n(As-tu lancé exam-flags.sql ?)");
  }
}
// Examens à venir (prochains 60 jours), triés par date.
function upcomingExams() {
  if (!_store?.session) return [];
  const N = now();
  const horizon = new Date(N.getTime() + 60 * 86400000);
  const out = [];
  for (const e of (PLANNING?.events || [])) {
    const ev = { ...e, source: "course" };
    if (!isExam(ev)) continue;
    const s = new Date(ev.start);
    if (s > N && s <= horizon) out.push(ev);
  }
  return out.sort((a, b) => new Date(a.start) - new Date(b.start));
}

let _sub = null;
function subscribeRealtime() {
  if (_sub || !_store?.session) return;
  const pg = "postgres_changes";
  // L'écho temps réel de nos propres écritures attend la fin de l'animation en cours.
  let rtTimer = null;
  const onTodos = () => {
    clearTimeout(rtTimer);
    const run = async () => {
      const wait = _quietUntil - Date.now();
      if (wait > 0) { rtTimer = setTimeout(run, wait); return; }
      await refreshTodos(); rerender();
    };
    run();
  };
  const onPerso = async () => { await refreshPersonal(); rerender(); };
  _sub = _store.sb.channel("hub-sync")
    .on(pg, { event: "*", schema: "public", table: "todos" }, onTodos)
    .on(pg, { event: "*", schema: "public", table: "custom_events" }, onPerso)
    .on(pg, { event: "*", schema: "public", table: "event_overrides" }, onPerso)
    .on(pg, { event: "*", schema: "public", table: "calendar_events" }, onPerso)
    .on(pg, { event: "*", schema: "public", table: "training_skips" }, onPerso)
    .on(pg, { event: "*", schema: "public", table: "planning_seen" }, onPerso)
    .on(pg, { event: "*", schema: "public", table: "goals" }, onPerso)
    .on(pg, { event: "*", schema: "public", table: "event_reminders" }, onPerso)
    .on(pg, { event: "*", schema: "public", table: "exam_flags" }, onPerso)
    .subscribe();
}

// ---------- Actions tâches ----------
function wireAdd(store) {
  const form = document.getElementById("add-form");
  const input = document.getElementById("add-input");
  const date = document.getElementById("add-date");
  let tag = null;
  form?.querySelectorAll("#add-tags .tg-opt").forEach((b) => b.addEventListener("click", () => {
    tag = tag === b.dataset.tag ? null : b.dataset.tag;
    form.querySelectorAll("#add-tags .tg-opt").forEach((x) => x.classList.toggle("on", x.dataset.tag === tag));
  }));
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = input.value.trim();
    if (!title) return;
    input.value = "";
    const due_date = date && date.value ? date.value : null;
    quiet(1500);
    const { error } = await store.sb.from("todos").insert({ title, due_date, tag });
    if (error) { oops("Ajout impossible : " + error.message); return; }
    await refreshAfterAdd(); rerender();
  });
}

function wireTodos(root, store) {
  root.querySelectorAll(".todo").forEach((el) => {
    const id = el.dataset.id;
    const checkEl = el.querySelector(".check");
    checkEl?.addEventListener("click", async () => {
      const t = store.todos.find((x) => String(x.id) === String(id));
      if (!t || el.dataset.busy) return;
      el.dataset.busy = "1";
      const checking = !t.done;
      // Retour immédiat : la case se remplit, la coche se dessine, le titre se barre.
      el.classList.toggle("is-done", checking);
      el.classList.toggle("just", checking);
      checkEl.setAttribute("aria-checked", String(checking));
      const finishing = checking && closesTheDay(store.todos, t);
      if (finishing) { _cheerAt = Date.now(); sfx("done"); celebrate(checkEl); quiet(1500); }
      else { sfx(checking ? "check" : "uncheck"); quiet(800); }
      if (checking) { try { navigator.vibrate?.(8); } catch {} }
      // On laisse l'animation se jouer pendant l'écriture (la tâche cochée quitte ensuite la liste).
      const [{ error }] = await Promise.all([
        store.sb.from("todos").update({ done: checking }).eq("id", id),
        stage(checking ? 420 : 160),
      ]);
      if (error) {
        el.classList.toggle("is-done", !checking);
        el.classList.remove("just");
        checkEl.setAttribute("aria-checked", String(!checking));
        delete el.dataset.busy;
        oops("Modification impossible : " + error.message);
        return;
      }
      if (finishing) _cheerAt = Date.now();
      await refreshTodos(); rerender();
    });
    el.querySelector(".todo-del")?.addEventListener("click", async () => {
      if (el.dataset.busy) return;
      el.dataset.busy = "1";
      sfx("del"); quiet(800);
      el.classList.add("is-leaving");
      const [{ error }] = await Promise.all([store.sb.from("todos").delete().eq("id", id), stage(200)]);
      if (error) {
        el.classList.remove("is-leaving");
        delete el.dataset.busy;
        oops("Suppression impossible : " + error.message);
        return;
      }
      await refreshTodos(); rerender();
    });
    // Ouvre la tâche (sous-tâches) au tap sur le titre.
    el.querySelector(".tt")?.addEventListener("click", () => {
      const t = store.todos.find((x) => String(x.id) === String(id));
      if (t) openTaskSheet(t);
    });
    // Coche/décoche une sous-tâche directement dans la liste.
    el.querySelectorAll(".subs li").forEach((li) => li.addEventListener("click", () => {
      const sid = li.dataset.sid;
      mutateSubs(id, (subs) => subs.map((s) => (s.id === sid ? { ...s, done: !s.done } : s)));
    }));
  });
}
// Cocher `t` boucle-t-il la journée ? Soit toutes les tâches datées d'aujourd'hui sont faites
// (l'anneau se ferme), soit il ne reste plus rien à faire pour aujourd'hui ni en retard.
function closesTheDay(todos, t) {
  const todayK = dayKey(now());
  const others = todos.filter((x) => x !== t && !x.done);
  if (t.due_date === todayK && !others.some((x) => x.due_date === todayK)) return true;
  const inDay = (x) => !x.due_date || x.due_date <= todayK;
  return inDay(t) && !others.some(inDay);
}

function wireSignIn(store) {
  const form = document.getElementById("signin-form");
  const msg = document.getElementById("signin-msg");
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("signin-email").value.trim();
    if (!email) return;
    msg.textContent = "Envoi…";
    const { error } = await store.sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href } });
    msg.textContent = error ? "Erreur : " + error.message : "Lien envoyé — vérifie ta boîte mail.";
    sfx(error ? "error" : "check");
  });
}

// ---------- Édition : bouton +, feuille d'action, formulaires ----------
let fabEl = null;
function ensureFab() {
  if (fabEl) return fabEl;
  fabEl = document.createElement("button");
  fabEl.className = "fab"; fabEl.type = "button";
  fabEl.setAttribute("aria-label", "Nouvel événement");
  fabEl.innerHTML = `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`;
  fabEl.addEventListener("click", () => openEventForm());
  document.body.appendChild(fabEl);
  return fabEl;
}
function updateFab() {
  const f = ensureFab();
  f.classList.toggle("is-show", (current === "today" || current === "week") && !!_store?.session);
}

function openSheet(inner) {
  dropSheet();
  sfx("open");
  const ov = document.createElement("div");
  ov.className = "sheet-overlay"; ov.id = "sheet-ov";
  ov.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${inner}</div>`;
  ov.addEventListener("click", (e) => { if (e.target === ov) closeSheet(); });
  document.body.appendChild(ov);
  requestAnimationFrame(() => ov.classList.add("is-open"));
  return ov;
}
// Retire toute feuille sans animation (avant d'en ouvrir une autre).
function dropSheet() { document.querySelectorAll(".sheet-overlay").forEach((o) => o.remove()); }
// Ferme la feuille en la laissant redescendre. `how === "silent"` : pas de son de fermeture
// (l'action qui vient d'aboutir a déjà le sien). Sert aussi de gestionnaire de clic direct.
function closeSheet(how) {
  const ov = document.getElementById("sheet-ov");
  if (!ov) return;
  ov.removeAttribute("id");
  ov.classList.remove("is-open");
  ov.classList.add("is-closing");
  if (how !== "silent") sfx("close");
  setTimeout(() => ov.remove(), reduceMotion.matches ? 0 : 200);
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

function evWhen(ev) {
  const s = new Date(ev.start);
  const range = ev.end ? `${fmtTime.format(s)} – ${fmtTime.format(new Date(ev.end))}` : fmtTime.format(s);
  return `${cap(fmtWeekday.format(s))} · ${range}`;
}

function openEventForm(date, start, end) {
  if (!_store?.session) return;
  const d = date || dayKey(new Date());
  const st = start || "09:00";
  const en = end || "10:00";
  const ov = openSheet(`
    <h3 class="sheet-h">Nouvel événement</h3>
    <form id="ev-form" class="sheet-form">
      <label>Titre<input id="ev-title" required maxlength="120" autocomplete="off" placeholder="Ex. RDV, révisions, sport…"></label>
      <label>Jour<input id="ev-date" type="date" value="${d}" required></label>
      <div class="sheet-two">
        <label>Début<input id="ev-start" type="time" value="${st}" required></label>
        <label>Fin<input id="ev-end" type="time" value="${en}" required></label>
      </div>
      <label>Lieu <span class="opt">(optionnel)</span><input id="ev-loc" maxlength="120" autocomplete="off"></label>
      <div class="sheet-actions">
        <button type="button" class="btn btn-ghost" id="ev-cancel">Annuler</button>
        <button type="submit" class="btn">Ajouter</button>
      </div>
    </form>`);
  ov.querySelector("#ev-cancel").onclick = closeSheet;
  ov.querySelector("#ev-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = ov.querySelector("#ev-title").value.trim();
    if (!title) return;
    const dd = ov.querySelector("#ev-date").value;
    const start_at = parisToISO(dd, ov.querySelector("#ev-start").value);
    let end_at = parisToISO(dd, ov.querySelector("#ev-end").value);
    if (new Date(end_at) <= new Date(start_at)) end_at = null;
    const location = ov.querySelector("#ev-loc").value.trim() || null;
    const { error } = await _store.sb.from("custom_events").insert({ title, start_at, end_at, location });
    if (error) { oops("Ajout impossible : " + error.message); return; }
    sfx("add");
    closeSheet("silent"); await refreshPersonal(); rerender();
  });
  setTimeout(() => ov.querySelector("#ev-title")?.focus(), 50);
}

function openEventActions(ev) {
  if (!_store?.session) return;
  const head = `<h3 class="sheet-h">${esc(ev.title)}</h3><p class="sheet-sub">${evWhen(ev)}${(ev.location) ? " · " + esc(ev.location) : ""}</p>`;
  const isRem = (_store.reminders || new Set()).has(eventKey(ev));
  const remBtn = `<button class="btn btn-ghost rem-toggle${isRem ? " on" : ""}" id="s-rem">${ico("i-bell")}${isRem ? "Rappel activé" : "Ne pas oublier"}</button>`;
  const exam = isExam(ev);
  const examBtn = ev.source === "course" ? `<button class="btn btn-ghost exam-toggle${exam ? " on" : ""}" id="s-exam">${ico("i-alert")}${exam ? "Ce n'est pas un examen" : "Marquer comme examen"}</button>` : "";

  if (ev.source === "perso") {
    const ov = openSheet(`${head}<div class="sheet-actions">${remBtn}
      <button class="btn btn-ghost" id="s-close">Fermer</button>
      <button class="btn btn-danger" id="s-del">Supprimer</button></div>`);
    ov.querySelector("#s-close").onclick = closeSheet;
    ov.querySelector("#s-del").onclick = async () => {
      const { error } = await _store.sb.from("custom_events").delete().eq("id", ev.cid);
      if (error) { oops("Suppression impossible : " + error.message); return; }
      sfx("del");
      closeSheet("silent"); await refreshPersonal(); rerender();
    };
  } else if (ev.source === "course") {
    if (ev._hidden) {
      const ov = openSheet(`${head}<p class="sheet-note">Tu as marqué « je n'y vais pas » pour ce cours.</p>
        <div class="sheet-actions">${remBtn}${examBtn}<button class="btn btn-ghost" id="s-close">Fermer</button>
        <button class="btn" id="s-show">Y retourner</button></div>`);
      ov.querySelector("#s-close").onclick = closeSheet;
      ov.querySelector("#s-show").onclick = async () => {
        const { error } = await _store.sb.from("event_overrides").delete().eq("event_uid", ev.uid);
        if (error) { oops("Erreur : " + error.message); return; }
        sfx("toggle");
        closeSheet("silent"); await refreshPersonal(); rerender();
      };
    } else {
      const ov = openSheet(`${head}<div class="sheet-actions">${remBtn}${examBtn}<button class="btn btn-ghost" id="s-close">Fermer</button>
        <button class="btn btn-danger" id="s-hide">Je n'y vais pas</button></div>`);
      ov.querySelector("#s-close").onclick = closeSheet;
      ov.querySelector("#s-hide").onclick = async () => {
        const { error } = await _store.sb.from("event_overrides")
          .upsert({ user_id: _store.session.user.id, event_uid: ev.uid, hidden: true }, { onConflict: "user_id,event_uid" });
        if (error) { oops("Erreur : " + error.message); return; }
        sfx("del");
        closeSheet("silent"); await refreshPersonal(); rerender();
      };
    }
  } else { // Calendrier importé (lecture seule)
    const note = ev.source === "gc"
      ? "Événement importé depuis ton agenda Google. Modifie-le dans Google Agenda."
      : `Réunion ${ev.source === "ef" ? "école" : "pro"}, importée depuis ton calendrier. Modifie-la dans Outlook / Teams.`;
    const ov = openSheet(`${head}<p class="sheet-note">${note}</p>
      <div class="sheet-actions">${remBtn}<button class="btn" id="s-close">Fermer</button></div>`);
    ov.querySelector("#s-close").onclick = closeSheet;
  }
  document.getElementById("s-rem")?.addEventListener("click", async () => { await toggleReminder(ev); closeSheet("silent"); rerender(); });
  document.getElementById("s-exam")?.addEventListener("click", async () => { await toggleExam(ev); closeSheet("silent"); rerender(); });
}

// ---------- Sous-tâches ----------
// Les sous-tâches vivent dans une colonne jsonb `subtasks` de la table `todos`
// (tableau d'objets { id, title, done }). On relit-modifie-réécrit le tableau entier.
async function mutateSubs(id, fn, sound = "tick") {
  if (!_store?.session) return;
  const t = _store.todos.find((x) => String(x.id) === String(id));
  if (!t) return;
  const next = fn(Array.isArray(t.subtasks) ? t.subtasks : []);
  t.subtasks = next; // optimiste
  sfx(sound);
  const { error } = await _store.sb.from("todos").update({ subtasks: next }).eq("id", id);
  if (error) { oops("Sous-tâches indisponibles : " + error.message + "\n(As-tu lancé le SQL d'activation ?)"); }
  await refreshTodos(); rerender();
}

const SUB_UID = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

async function updateTodo(id, patch) {
  if (!_store?.session) return;
  const t = _store.todos.find((x) => String(x.id) === String(id)); if (t) Object.assign(t, patch);
  const { error } = await _store.sb.from("todos").update(patch).eq("id", id);
  if (error) oops("Modification impossible : " + error.message);
  await refreshTodos();
}

// Feuille d'une tâche : liste des sous-tâches, ajout, et suppression de la tâche.
function openTaskSheet(t0) {
  if (!_store?.session) return;
  const id = t0.id;
  const ov = openSheet(`
    <h3 class="sheet-h" id="ts-title"></h3>
    <p class="sheet-sub" id="ts-sub"></p>
    <div class="ts-meta">
      <label class="ts-field">À faire avant<input id="ts-date" type="date"></label>
      <div class="ts-field"><span class="ts-lab">Étiquette</span><div class="tag-pick" id="ts-tags">${tagPickHtml(null)}</div></div>
    </div>
    <p class="section-label" style="margin-top:4px">Sous-tâches</p>
    <div id="ts-subs"></div>
    <form class="add" id="sub-form" style="margin-top:14px">
      <input id="sub-input" placeholder="Nouvelle sous-tâche…" autocomplete="off" maxlength="160" aria-label="Nouvelle sous-tâche">
      <button class="btn btn-sq" type="submit" aria-label="Ajouter">${ico("i-plus", "")}</button>
    </form>
    <div class="sheet-actions">
      <button class="btn btn-ghost" id="ts-close">Fermer</button>
      <button class="btn btn-danger" id="ts-del">Supprimer la tâche</button>
    </div>`);
  const cur = () => _store.todos.find((x) => String(x.id) === String(id));

  function paint() {
    const t = cur();
    if (!t) { closeSheet(); return; }
    ov.querySelector("#ts-title").textContent = t.title;
    ov.querySelector("#ts-sub").textContent = t.due_date ? "À faire avant " + dueLabel(t.due_date) : "Sans échéance";
    const dateEl2 = ov.querySelector("#ts-date");
    if (document.activeElement !== dateEl2) dateEl2.value = t.due_date || "";
    ov.querySelectorAll("#ts-tags .tg-opt").forEach((b) => b.classList.toggle("on", b.dataset.tag === t.tag));
    const subs = Array.isArray(t.subtasks) ? t.subtasks : [];
    const mount = ov.querySelector("#ts-subs");
    mount.innerHTML = subs.length
      ? `<ul class="subs">${subs.map((s) => `<li class="${s.done ? "done" : ""}">
          <span class="sc${s.done ? " on" : ""}" data-tog="${esc(s.id)}">${ico("i-check")}</span>
          <span class="ss-t">${esc(s.title)}</span>
          <button class="ss-del" data-del="${esc(s.id)}" aria-label="Supprimer la sous-tâche"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        </li>`).join("")}</ul>`
      : `<p class="sheet-note">Découpe cette tâche en sous-tâches à cocher.</p>`;
    mount.querySelectorAll("[data-tog]").forEach((b) => b.onclick = async () => {
      await mutateSubs(id, (subs) => subs.map((s) => (s.id === b.dataset.tog ? { ...s, done: !s.done } : s)));
      paint();
    });
    mount.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => {
      await mutateSubs(id, (subs) => subs.filter((s) => s.id !== b.dataset.del), "del");
      paint();
    });
  }

  ov.querySelector("#sub-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const inp = ov.querySelector("#sub-input");
    const v = inp.value.trim();
    if (!v) return;
    inp.value = "";
    await mutateSubs(id, (subs) => [...subs, { id: SUB_UID(), title: v, done: false }], "add");
    paint(); inp.focus();
  });
  ov.querySelector("#ts-date").addEventListener("change", async (e) => { await updateTodo(id, { due_date: e.target.value || null }); paint(); rerender(); });
  ov.querySelectorAll("#ts-tags .tg-opt").forEach((b) => b.addEventListener("click", async () => {
    const t = cur(); const next = t.tag === b.dataset.tag ? null : b.dataset.tag;
    await updateTodo(id, { tag: next }); paint(); rerender();
  }));
  ov.querySelector("#ts-close").onclick = () => { closeSheet(); rerender(); };
  ov.querySelector("#ts-del").onclick = async () => {
    const { error } = await _store.sb.from("todos").delete().eq("id", id);
    if (error) { oops("Suppression impossible : " + error.message); return; }
    sfx("del");
    closeSheet("silent"); await refreshTodos(); rerender();
  };
  paint();
  setTimeout(() => ov.querySelector("#sub-input")?.focus(), 50);
}

// Feuille d'ajout rapide d'une tâche (depuis le tableau de bord).
function openTaskAdd(defaultDate) {
  if (!_store?.session) return;
  const ov = openSheet(`
    <h3 class="sheet-h">Nouvelle tâche</h3>
    <form id="ta-form" class="sheet-form">
      <label>Tâche<input id="ta-title" required maxlength="200" autocomplete="off" placeholder="Ex. réviser, rendre le TP…"></label>
      <label>À faire avant<input id="ta-date" type="date" value="${defaultDate || dayKey(now())}"></label>
      <div class="ts-field"><span class="ts-lab">Étiquette</span><div class="tag-pick" id="ta-tags">${tagPickHtml(null)}</div></div>
      <div class="sheet-actions">
        <button type="button" class="btn btn-ghost" id="ta-cancel">Annuler</button>
        <button type="submit" class="btn">Ajouter</button>
      </div>
    </form>`);
  let taTag = null;
  ov.querySelectorAll("#ta-tags .tg-opt").forEach((b) => b.addEventListener("click", () => {
    taTag = taTag === b.dataset.tag ? null : b.dataset.tag;
    ov.querySelectorAll("#ta-tags .tg-opt").forEach((x) => x.classList.toggle("on", x.dataset.tag === taTag));
  }));
  ov.querySelector("#ta-cancel").onclick = closeSheet;
  ov.querySelector("#ta-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = ov.querySelector("#ta-title").value.trim();
    if (!title) return;
    const due_date = ov.querySelector("#ta-date").value || null;
    quiet(1500);
    const { error } = await _store.sb.from("todos").insert({ title, due_date, tag: taTag });
    if (error) { oops("Ajout impossible : " + error.message); return; }
    closeSheet("silent"); await refreshAfterAdd(); rerender();
  });
  setTimeout(() => ov.querySelector("#ta-title")?.focus(), 50);
}

// Feuille d'ajout d'un objectif.
function openGoalAdd() {
  if (!_store?.session) return;
  const ov = openSheet(`
    <h3 class="sheet-h">Nouvel objectif</h3>
    <p class="sheet-sub">Même vague au début — tu le préciseras ensuite.</p>
    <form id="g-form" class="sheet-form">
      <label>Objectif<input id="g-title" required maxlength="160" autocomplete="off" placeholder="Ex. apprendre le chinois"></label>
      <label>Pour quand ? <span class="lbl-opt">(recommandé)</span><input id="g-deadline" type="date"></label>
      <label>Comment ? <span class="lbl-opt">(ton plan, facultatif)</span><textarea id="g-why" rows="2" maxlength="400" placeholder="Ex. 15 min/jour sur une appli + un cours le samedi"></textarea></label>
      <p class="smart-hint">${ico("i-bolt")} Un objectif <b>sans échéance</b> reste un rêve. Ajoute une date pour le rendre réel.</p>
      <div class="sheet-actions">
        <button type="button" class="btn btn-ghost" id="g-cancel">Annuler</button>
        <button type="submit" class="btn">Créer</button>
      </div>
    </form>`);
  ov.querySelector("#g-cancel").onclick = closeSheet;
  ov.querySelector("#g-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = ov.querySelector("#g-title").value.trim();
    if (!title) return;
    const deadline = ov.querySelector("#g-deadline").value || null;
    const why = ov.querySelector("#g-why").value.trim() || null;
    const ok = await addGoal({ title, deadline, why });
    if (ok) closeSheet("silent");
  });
  setTimeout(() => ov.querySelector("#g-title")?.focus(), 50);
}

// Feuille d'un objectif : statut SMART, édition, actions à cocher.
function openGoalSheet(id) {
  if (!_store?.session) return;
  const ov = openSheet(`
    <div class="gs-sheet-top"><h3 class="sheet-h" id="g-ti"></h3><span id="g-status"></span></div>
    <p class="g-nudge-sheet" id="g-nudge"></p>
    <form class="sheet-form" id="g-edit">
      <label>Objectif<input id="ge-title" maxlength="160" autocomplete="off"></label>
      <div class="sheet-two">
        <label>Échéance<input id="ge-deadline" type="date"></label>
        <label>&nbsp;<button type="button" class="btn btn-ghost btn-sm" id="ge-done">Marquer atteint</button></label>
      </div>
      <label>Plan (comment)<textarea id="ge-why" rows="2" maxlength="400" placeholder="Comment tu comptes t'y prendre ?"></textarea></label>
    </form>
    <p class="section-label" style="margin-top:6px">Actions concrètes</p>
    <div id="g-acts"></div>
    <form class="add" id="ga-form" style="margin-top:10px">
      <input id="ga-input" placeholder="Une action à faire…" autocomplete="off" maxlength="160" aria-label="Nouvelle action">
      <button class="btn btn-sq" type="submit" aria-label="Ajouter">${ico("i-plus", "")}</button>
    </form>
    <div class="sheet-actions">
      <button class="btn btn-ghost" id="g-close">Fermer</button>
      <button class="btn btn-danger" id="g-del">Supprimer</button>
    </div>`);
  const cur = () => (_store.goals || []).find((x) => String(x.id) === String(id));

  function paint() {
    const g = cur();
    if (!g) { closeSheet(); return; }
    const m = GOAL_LADDER[goalStatus(g)];
    ov.querySelector("#g-ti").textContent = g.done ? "🏁 " + g.title : g.title;
    ov.querySelector("#g-status").innerHTML = goalStatusChip(g);
    ov.querySelector("#g-nudge").innerHTML = m.nudge ? `${ico("i-bolt")} ${m.nudge}` : "";
    ov.querySelector("#g-nudge").style.display = m.nudge ? "" : "none";
    const ti = ov.querySelector("#ge-title"), dl = ov.querySelector("#ge-deadline"), wy = ov.querySelector("#ge-why");
    if (document.activeElement !== ti) ti.value = g.title || "";
    if (document.activeElement !== dl) dl.value = g.deadline || "";
    if (document.activeElement !== wy) wy.value = g.why || "";
    ov.querySelector("#ge-done").textContent = g.done ? "Réactiver" : "Marquer atteint";
    const acts = goalActions(g);
    const mount = ov.querySelector("#g-acts");
    mount.innerHTML = acts.length
      ? `<ul class="subs">${acts.map((a) => `<li class="${a.done ? "done" : ""}">
          <span class="sc${a.done ? " on" : ""}" data-tog="${esc(a.id)}">${ico("i-check")}</span>
          <span class="ss-t">${esc(a.title)}</span>
          <button class="ss-del" data-del="${esc(a.id)}" aria-label="Supprimer l'action"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
        </li>`).join("")}</ul>`
      : `<p class="sheet-note">Découpe ton objectif en petites actions à cocher — c'est ce qui le fait avancer.</p>`;
    mount.querySelectorAll("[data-tog]").forEach((b) => b.onclick = async () => { await mutateGoalActions(id, (a) => a.map((x) => (x.id === b.dataset.tog ? { ...x, done: !x.done } : x))); paint(); });
    mount.querySelectorAll("[data-del]").forEach((b) => b.onclick = async () => { await mutateGoalActions(id, (a) => a.filter((x) => x.id !== b.dataset.del), "del"); paint(); });
  }

  const saveField = async (patch) => { await updateGoal(id, patch); paint(); };
  ov.querySelector("#ge-title").addEventListener("change", (e) => { const v = e.target.value.trim(); if (v) saveField({ title: v }); });
  ov.querySelector("#ge-deadline").addEventListener("change", (e) => saveField({ deadline: e.target.value || null }));
  ov.querySelector("#ge-why").addEventListener("change", (e) => saveField({ why: e.target.value.trim() || null }));
  ov.querySelector("#ge-done").onclick = async () => { const g = cur(); sfx(g.done ? "uncheck" : "done"); await saveField({ done: !g.done }); };
  ov.querySelector("#ga-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const inp = ov.querySelector("#ga-input"); const v = inp.value.trim(); if (!v) return;
    inp.value = "";
    await mutateGoalActions(id, (a) => [...a, { id: SUB_UID(), title: v, done: false }], "add");
    paint(); inp.focus();
  });
  ov.querySelector("#g-close").onclick = () => { closeSheet(); rerender(); };
  ov.querySelector("#g-del").onclick = async () => { if (!confirm("Supprimer cet objectif ?")) return; await deleteGoal(id); closeSheet("silent"); };
  paint();
}

function openSmartInfo() {
  openSheet(`
    <h3 class="sheet-h">Un objectif SMART</h3>
    <p class="sheet-sub">Plus c'est cadré, plus ça se réalise.</p>
    <ul class="smart-list">
      <li><b>S</b>pécifique — précis, pas « être meilleur »</li>
      <li><b>M</b>esurable — tu sauras quand c'est atteint</li>
      <li><b>A</b>tteignable — réaliste pour toi</li>
      <li><b>R</b>éaliste / pertinent — ça compte vraiment</li>
      <li><b>T</b>emporel — une échéance</li>
    </ul>
    <p class="section-label" style="margin-top:14px">L'échelle de Hub</p>
    <div class="ladder">
      <div class="ladder-row"><span class="g-chip g-dream">Rêve</span> but seul, sans date</div>
      <div class="ladder-row"><span class="g-chip g-obj">Objectif</span> + une échéance</div>
      <div class="ladder-row"><span class="g-chip g-strat">Stratégie</span> + un plan</div>
      <div class="ladder-row"><span class="g-chip g-go">En marche</span> + des actions à cocher</div>
    </div>
    <div class="sheet-actions"><button class="btn" id="si-close">Compris</button></div>`)
    .querySelector("#si-close").onclick = closeSheet;
}

function openDoneGoals() {
  const done = (_store?.goals || []).filter((g) => g.done);
  const body = done.length
    ? `<div class="goals-list">${done.map(goalRow).join("")}</div>`
    : `<p class="sheet-note">Aucun objectif atteint pour l'instant.</p>`;
  const ov = openSheet(`<h3 class="sheet-h">Objectifs atteints 🏁</h3>${body}
    <div class="sheet-actions"><button class="btn" id="dg-close">Fermer</button></div>`);
  ov.querySelector("#dg-close").onclick = closeSheet;
  ov.querySelectorAll(".goal-card[data-gid]").forEach((b) => b.addEventListener("click", () => openGoalSheet(b.dataset.gid)));
}

// ---------- Navigation ----------
function rerender() {
  viewEl.dataset.view = current;
  if (current === "today") renderToday();
  else if (current === "week") renderWeek();
  else renderTasks();
  updateFab();
  updateBell();
}

document.getElementById("notif-bell")?.addEventListener("click", openChangesSheet);

const TAB_ORDER = ["today", "week", "tasks"];
const tabsEl = document.querySelector(".tabs");
viewEl.addEventListener("animationend", (e) => { if (e.target === viewEl) viewEl.classList.remove("view-enter"); });
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const from = TAB_ORDER.indexOf(current), to = TAB_ORDER.indexOf(btn.dataset.view);
    current = btn.dataset.view;
    document.querySelectorAll(".tab").forEach((b) => {
      const active = b === btn;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-selected", String(active));
    });
    window.scrollTo({ top: 0 });
    if (to !== from) {
      // La pastille glisse sous l'onglet ; la vue entre du côté où l'on va.
      tabsEl?.style.setProperty("--tab-i", to);
      viewEl.style.setProperty("--view-dir", to > from ? 1 : -1);
      viewEl.classList.remove("view-enter");
      void viewEl.offsetWidth;
      viewEl.classList.add("view-enter");
      sfx("tab");
    }
    rerender();
  });
});

// Bascule liste/grille de la vue Semaine au redimensionnement
let _rsz;
window.addEventListener("resize", () => { clearTimeout(_rsz); _rsz = setTimeout(() => { if (current === "week") renderWeek(); }, 200); });

// ---------- Thème (clair / sombre) ----------
// Par défaut on suit le système. Dès que l'utilisateur bascule, on force son choix
// (data-theme sur <html>) et on le mémorise par appareil (localStorage).
const THEME_KEY = "hub-theme";
const themeMeta = document.querySelector('meta[name="theme-color"]');
const themeIcon = document.getElementById("theme-icon");
const themeBtn = document.getElementById("theme-toggle");
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
const storedTheme = () => { try { return localStorage.getItem(THEME_KEY); } catch { return null; } };
// Thème réellement affiché : choix forcé, sinon préférence système.
const effectiveTheme = () => storedTheme() || (systemDark.matches ? "dark" : "light");
function syncThemeUI() {
  const dark = effectiveTheme() === "dark";
  // On propose l'inverse : lune pour passer au clair… non : lune = sombre actif.
  themeIcon?.setAttribute("href", dark ? "#i-moon" : "#i-sun");
  themeBtn?.setAttribute("aria-label", dark ? "Passer au thème clair" : "Passer au thème sombre");
  themeMeta?.setAttribute("content", dark ? "#0D1013" : "#F1F3F5");
}
themeBtn?.addEventListener("click", () => {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch {}
  syncThemeUI();
  sfx("toggle");
});

// ---------- Sons : bouton couper / remettre ----------
const soundBtn = document.getElementById("sound-toggle");
const soundIcon = document.getElementById("sound-icon");
function syncSoundUI() {
  soundIcon?.setAttribute("href", soundOn ? "#i-sound" : "#i-mute");
  soundBtn?.setAttribute("aria-pressed", String(soundOn));
  soundBtn?.setAttribute("title", soundOn ? "Sons activés" : "Sons coupés");
  soundBtn?.classList.toggle("is-off", !soundOn);
}
soundBtn?.addEventListener("click", () => {
  soundOn = !soundOn;
  try { localStorage.setItem(SOUND_KEY, soundOn ? "on" : "off"); } catch {}
  syncSoundUI();
  if (soundOn) sfx("check"); // on entend tout de suite ce qu'on vient de rallumer
});
syncSoundUI();
// Si aucun choix forcé, on reflète les changements de thème du système.
systemDark.addEventListener("change", () => { if (!storedTheme()) syncThemeUI(); });
syncThemeUI();

// Outil de dev (localhost seulement) : simuler une autre date/heure pour tester le tableau de bord.
if (location.hostname === "localhost") {
  window.__setNow = (iso) => { nowRef = iso ? new Date(iso) : null; rerender(); };
}

// ---------- Démarrage ----------
await Promise.all([loadPlanning(), loadAlternance(), loadTraining(), loadChanges()]);
rerender();
// Rafraîchit l'état "en cours / prochain" et les changements quand on revient sur l'app
document.addEventListener("visibilitychange", () => { if (!document.hidden) { Promise.all([loadPlanning(), loadChanges()]).then(rerender); } });

// Service worker (PWA installable + hors-ligne)
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
