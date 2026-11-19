// Hub — logique de l'app (planning en lecture seule + to-do synchronisée).
// Vanilla JS, pas de framework. Supabase chargé à la demande depuis un CDN (version épinglée).

import { cheatStats } from "./lib/cheat-stats.js";
import { moveRange, resizeEnd } from "./lib/drag-math.js";
import { validateRequest, conflictsWith, loadGuest, rememberRequest } from "./lib/booking.js";

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
const fmtWdLong = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, weekday: "long" });
const fmtMonthYear = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, month: "long", year: "numeric" });
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
// ---------- Toasts (messages en bas d'écran, non bloquants) ----------
// toast(texte, { action: "Annuler", onAction, ms, kind: "error" }) -> fonction pour le fermer.
function toast(text, { action, onAction, ms = 4000, kind = "" } = {}) {
  let host = document.getElementById("toasts");
  if (!host) {
    host = document.createElement("div");
    host.id = "toasts"; host.className = "toasts";
    host.setAttribute("role", "status"); host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
  }
  const el = document.createElement("div");
  el.className = `toast${kind ? " is-" + kind : ""}`;
  el.innerHTML = `<span class="toast-t"></span>${action ? `<button class="toast-a" type="button"></button>` : ""}`;
  el.querySelector(".toast-t").textContent = text;
  let timer = null;
  const close = () => {
    clearTimeout(timer);
    if (!el.isConnected) return;
    el.classList.add("is-out");
    setTimeout(() => el.remove(), reduceMotion.matches ? 0 : 180);
  };
  if (action) {
    const b = el.querySelector(".toast-a");
    b.textContent = action;
    b.addEventListener("click", () => { close(); onAction?.(); });
  }
  host.appendChild(el);
  // Pas plus de 3 messages empilés.
  while (host.children.length > 3) host.firstElementChild.remove();
  timer = setTimeout(close, ms);
  return close;
}

// Erreur : petit son grave + toast en clair. Le détail technique part dans la console.
// Les appels gardent la forme « Action impossible : <message brut> ».
function oops(msg) {
  sfx("error");
  const raw = String(msg ?? "");
  console.warn("[Hub]", raw);
  const head = raw.split(/\s:\s/)[0].split("\n")[0].trim() || "Ça n'a pas marché";
  const offline = !navigator.onLine || /failed to fetch|network|load failed|timeout|réseau/i.test(raw);
  const missing = /does not exist|schema cache|relation|column/i.test(raw);
  const why = offline ? "Pas de connexion — réessaie." : missing ? "Fonction pas encore activée côté base." : "Réessaie dans un instant.";
  toast(head === raw.trim() ? raw : `${head}. ${why}`, { kind: "error", ms: 5000 });
}

// Suppression avec « Annuler » : on retire tout de suite à l'écran, on n'écrit en base
// qu'après 5 s. Si la page se ferme avant, on valide immédiatement.
const _pendingDeletes = new Set();
function deferDelete({ label, hide, restore, commit }) {
  hide();
  let done = false;
  const run = async () => {
    if (done) return; done = true;
    _pendingDeletes.delete(run);
    const ok = await commit();
    if (!ok) restore();
  };
  _pendingDeletes.add(run);
  const timer = setTimeout(run, 5000);
  sfx("del");
  toast(label, {
    action: "Annuler", ms: 5000,
    onAction: () => { if (done) return; done = true; clearTimeout(timer); _pendingDeletes.delete(run); restore(); sfx("toggle"); },
  });
}
window.addEventListener("pagehide", () => { for (const run of [..._pendingDeletes]) run(); });

// ---------- Mouvement ----------
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
// Attente « de mise en scène » : nulle si l'utilisateur a demandé moins d'animations.
const stage = (ms) => new Promise((r) => setTimeout(r, reduceMotion.matches ? 0 : ms));
let _quietUntil = 0;         // pendant une animation locale, on retarde le re-rendu temps réel
const quiet = (ms) => { _quietUntil = Math.max(_quietUntil, Date.now() + ms); };
let _cheerAt = 0;            // instant où la dernière tâche du jour a été cochée
let _newIds = new Set();     // tâches tout juste ajoutées (animation d'entrée)

// Transitions de vue (API View Transitions) : continuité entre deux états de l'écran.
// `kind` choisit la chorégraphie côté CSS (html[data-vt="…"]), `dir` le sens (1 ou -1).
// Sans l'API, ou si l'utilisateur a demandé moins d'animations, `update` s'applique tel quel.
const canVT = () => typeof document.startViewTransition === "function" && !reduceMotion.matches;
let _vtSeq = 0, _vtCur = null;
function vt(kind, update, dir = 1) {
  if (!canVT()) { update(); return null; }
  const root = document.documentElement, id = ++_vtSeq;
  root.dataset.vt = kind;
  root.style.setProperty("--vt-dir", dir);
  let t;
  try { t = document.startViewTransition(update); } catch { delete root.dataset.vt; update(); return null; }
  _vtCur = t;
  const done = () => { if (_vtSeq === id) { delete root.dataset.vt; _vtCur = null; } };
  t.finished.then(done, done);
  t.ready.catch(() => {});
  return t;
}

// Dernier élément touché : sert de point de départ à la fiche qui s'ouvre.
let _tapSrc = null, _tapAt = 0;
document.addEventListener("pointerdown", (e) => {
  const el = e.target instanceof Element ? e.target.closest(".ev, .tev, .goal-card, .ctx-cheat, .hero-next, .fab, .wk-alert, .notif") : null;
  _tapSrc = el && !el.closest(".sheet-overlay") ? el : null;
  _tapAt = Date.now();
}, true);
const inViewport = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; };

// Compteurs : à l'arrivée sur une vue, les nombres marqués data-count défilent jusqu'à leur valeur.
let _entering = false;
function countUp(root) {
  if (reduceMotion.matches) return;
  root.querySelectorAll("[data-count]").forEach((el) => {
    const end = Number(el.dataset.count);
    if (!Number.isFinite(end) || end < 2) return;
    const suffix = el.textContent.replace(/^[\d\s]+/, "");
    const dur = Math.min(900, 380 + end * 14), t0 = performance.now();
    const tick = (t) => {
      if (!el.isConnected) return;
      const p = Math.min(1, (t - t0) / dur);
      el.textContent = Math.round(end * (1 - Math.pow(2, -10 * p)) / (1 - Math.pow(2, -10))) + suffix;
      if (p < 1) requestAnimationFrame(tick);
    };
    el.textContent = "0" + suffix;
    requestAnimationFrame(tick);
  });
}

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
// Tâches lointaines (échéance à plus de FAR_DAYS jours) : masquées par défaut, elles
// reviennent d'elles-mêmes à l'approche de l'échéance. Choix d'affichage gardé sur l'appareil.
const FAR_DAYS = 30;
const isFarTask = (t, todayK) => !!t.due_date && t.due_date > addDays(todayK, FAR_DAYS);
let _showFarTasks = (() => { try { return localStorage.getItem("hub.farTasks") === "1"; } catch { return false; } })();
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
// Récurrence de tâche : même jour N mois plus tard (31 -> dernier jour du mois visé).
const REPEATS = { "": "Une fois", monthly: "Tous les mois", semiannual: "Tous les 6 mois", yearly: "Tous les ans" };
const REPEAT_MONTHS = { monthly: 1, semiannual: 6, yearly: 12 };
const REPEAT_PILL = { monthly: "chaque mois", semiannual: "tous les 6 mois", yearly: "chaque année" };
const repeatPickHtml = (sel) => Object.entries(REPEATS).map(([k, label]) =>
  `<button type="button" class="tg-opt rp${(sel || "") === k ? " on" : ""}" data-rep="${k}">${label}</button>`).join("");
const repeatPill = (t) => REPEAT_PILL[t.repeat] && !t.done ? `<span class="pill">${ico("i-repeat")}${REPEAT_PILL[t.repeat]}</span>` : "";
function addMonths(due, n) {
  const [Y, M, D] = (due || dayKey(now())).split("-").map(Number);
  const last = new Date(Date.UTC(Y, M - 1 + n + 1, 0)).getUTCDate(); // dernier jour du mois visé
  const x = new Date(Date.UTC(Y, M - 1 + n, Math.min(D, last)));
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}-${String(x.getUTCDate()).padStart(2, "0")}`;
}
// Tâche récurrente cochée : crée l'occurrence suivante (sous-tâches remises à zéro), sans doublon.
async function spawnNextRepeat(store, t) {
  const n = REPEAT_MONTHS[t.repeat];
  if (!n) return;
  const due_date = addMonths(t.due_date, n);
  if (store.todos.some((x) => !x.done && x.title === t.title && x.due_date === due_date)) return;
  const row = { title: t.title, due_date, tag: t.tag || null, repeat: t.repeat };
  const subs = Array.isArray(t.subtasks) ? t.subtasks : [];
  if (subs.length) row.subtasks = subs.map((s) => ({ ...s, id: SUB_UID(), done: false }));
  const { error } = await store.sb.from("todos").insert(row);
  if (error) oops("Prochaine occurrence non créée : " + error.message);
}

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
const normTeams = (t) => ({ source: CAL_SRC[t.source] || "fl", tid: t.id, _hidden: (_store?.hidden || new Set()).has(t.id), title: t.title, start: t.start_at, end: t.end_at, location: t.location, rooms: [], teacher: null });

const viewEl = document.getElementById("view");
const titleEl = document.getElementById("top-title");
const dateEl = document.getElementById("top-date");
const liveEl = document.getElementById("live");
const liveTimeEl = document.getElementById("live-time");

let PLANNING = null;        // { generatedAt, events: [...] }
let ALT = null;             // alternance : { start, end, schoolSet, sgHours }
let TRAINING = null;        // rotation muscu : { anchor:{date,index}, cycle:[...] }
let COURSES = null;         // historique des séances (page Cours) : { sessions: [...] }
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

// Historique complet des séances (passées comprises) : la page Cours en a besoin pour dire
// si l'on est à jour. Repli : planning.json (semaine en cours et suite seulement).
async function loadCourses() {
  try {
    const res = await fetch("courses.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    COURSES = await res.json();
    try { localStorage.setItem("hub.courses", JSON.stringify(COURSES)); } catch {}
  } catch {
    try { COURSES = JSON.parse(localStorage.getItem("hub.courses") || "null"); } catch { COURSES = null; }
  }
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
    if ((_store.hidden || new Set()).has(t.id)) continue;
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
  // Heure de la dernière mise à jour (et non une horloge) : « màj 13:16 », « màj hier 21:00 ».
  // Le robot passe toutes les 3 h : au-delà de 6 h, un import a sans doute échoué -> orange.
  const gen = new Date(PLANNING.generatedAt);
  const age = Date.now() - gen.getTime();
  const stale = age > 6 * 3600 * 1000;
  const k = dayKey(gen), todayK = dayKey(new Date());
  const when = k === todayK ? fmtTime.format(gen)
    : k === addDays(todayK, -1) ? `hier ${fmtTime.format(gen)}`
    : fmtRange.format(gen);
  liveEl.classList.toggle("is-stale", stale);
  liveTimeEl.textContent = `màj ${when}`;
  liveEl.title = stale
    ? `Pas de mise à jour depuis ${agoLabel(PLANNING.generatedAt).replace("il y a ", "")} — l'import automatique a peut-être échoué.`
    : `Planning mis à jour ${agoLabel(PLANNING.generatedAt)} (${fmtTime.format(gen)}).`;
  liveEl.setAttribute("aria-label", liveEl.title);
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
// Espace Moodle de chaque matière, indexé par code module du planning (ev.module).
// Les codes changent chaque année (suffixe -2627…) : à mettre à jour à la rentrée.
const MOODLE_COURSES = {
  "FE2BG-2627PSA01": 24573,   // Business Game
  "FG2CSR-2627PSA01": 24634,  // CSR
  "FH2HP-2627PSA01": 24669,   // Histoire de la philosophie
  "FP2ENG-2627PSA01": 24612,  // Engineering Project
  "LXP-4GOOD-2627PSA01": 22709, // Efrei For Good Xperience
  "SEMMAJ-01-2627PSP01": 22711, // Séminaire
  "ST2AAN-2627PSA01": 24591,  // Data Integration and Analytics
  "ST2AML-2627PSA01": 24586,  // Machine Learning for Data Analysts
  "ST2BDPV-2627PSA01": 24594, // 3D Data Visualization
  "ST2BIG-2627PSA01": 24598,  // Big Data Processing
  "ST2CGAI-2627PSA01": 24596, // Chatbots & Generative AI
  "ST2DABI-2627PSA01": 24587, // Data Analyst Certification
};
function moodleUrl(ev) {
  const id = ev && MOODLE_COURSES[ev.module];
  return id ? `https://moodle.myefrei.fr/course/view.php?id=${id}` : null;
}
// Émargement SoWeSign : on ne peut signer que pendant les 15 premières minutes du cours.
const SOWESIGN_URL = "https://app.sowesign.com/student/next-course";
const SIGN_WINDOW_MS = 15 * 60000;
// "present" | "absent" (synchro SoWeSign) · "open" (fenêtre de signature en cours)
// · "pending" (fenêtre passée, synchro pas encore arrivée) · null (cours à venir / pas un cours).
function signState(ev, N = now()) {
  if (ev?.source !== "course" || ev._hidden) return null;
  const start = new Date(ev.start);
  const st = _store?.attendance?.get(start.toISOString());
  if (st === "present" || st === "absent") return st;
  const t = N - start;
  if (t < 0) return null;
  return t <= SIGN_WINDOW_MS ? "open" : "pending";
}
// Lien « Signer » avec minutes restantes, mis à jour sur place par tickSignLinks().
function signLink(ev, cls) {
  const until = new Date(ev.start).getTime() + SIGN_WINDOW_MS;
  return `<a class="${cls}" href="${SOWESIGN_URL}" target="_blank" rel="noopener" data-sign-until="${until}" onclick="event.stopPropagation()" onkeydown="event.stopPropagation()">${ico("i-pen")}<span>Signer · ${signLeft(until)}</span></a>`;
}
const signLeft = (until) => `reste ${Math.max(1, Math.ceil((until - now().getTime()) / 60000))} min`;
function tickSignLinks() {
  document.querySelectorAll("[data-sign-until]").forEach((a) => {
    const until = Number(a.dataset.signUntil);
    if (now().getTime() > until) { a.remove(); return; }
    const s = a.querySelector("span"); if (s) s.textContent = `Signer · ${signLeft(until)}`;
  });
}
setInterval(tickSignLinks, 20000);
// Petite pastille de statut sur la tuile d'un cours.
function signTag(ev) {
  const st = signState(ev);
  if (st === "present") return `<span class="sign-tag is-ok" title="Signé sur SoWeSign">${ico("i-check")}signé</span>`;
  if (st === "absent") return `<span class="sign-tag is-bad" title="Absent sur SoWeSign">${ico("i-alert")}non signé</span>`;
  if (st === "open") return signLink(ev, "sign-tag is-open");
  return "";
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
      <div class="hd"><span class="emb">${ico(exam ? "i-alert" : subjectIcon(ev))}</span><span class="t">${hmMin(ev.s)} – ${hmMin(ev.e2)}</span>${exam ? `<span class="exam-tag">EXAMEN</span>` : conf ? ico("i-alert") : ""}${signTag(ev)}</div>
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
  const moodle = ev.source === "course" ? moodleUrl(ev) : null;
  // stopPropagation : le lien ne doit pas aussi ouvrir la fiche de la carte.
  if (moodle) meta.push(`<a class="meta-link" href="${moodle}" target="_blank" rel="noopener" onclick="event.stopPropagation()" onkeydown="event.stopPropagation()">${ico("i-ext")}Moodle</a>`);
  const sign = signState(ev, N);
  const signRow = sign === "open" ? `<div class="hero-sign">${signLink(ev, "btn hero-sign-btn")}</div>`
    : sign === "present" ? `<div class="hero-sign"><span class="sign-tag is-ok">${ico("i-check")}signé</span></div>`
    : sign === "absent" ? `<div class="hero-sign"><span class="sign-tag is-bad">${ico("i-alert")}non signé</span></div>` : "";
  return `<div class="hero-next" style="--hc:${hc}" ${evAttrs(ev)}>
    <div class="kicker"><i></i>${isNow ? "En ce moment" : "Prochain créneau"}</div>
    <div class="cd">${cd}</div>
    <div class="ti">${esc(ev.title)}</div>
    <div class="meta">${meta.join("")}</div>${signRow}${art}</div>`;
}

// Ligne « écarts » : jours clean depuis le dernier écart (ouvre la fiche).
function cheatLine() {
  const st = cheatStats((_store?.cheats || []).map((c) => c.day), dayKey(now()));
  const txt = st.clean === null
    ? "Aucun écart noté"
    : `<b data-count="${st.clean}">${st.clean}</b> ${st.clean > 1 ? "jours" : "jour"} clean · record ${st.record} j`;
  return `<div class="ctx-row"><button class="ctx-cheat" data-cheat>${ico("i-target")}<span>${txt}</span></button></div>`;
}

// ---------- Notifications « signe ton cours » (Web Push) ----------
const PUSH_KEY = "hub.push";
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
// "on" | "off" | "denied" | "ios-browser" (iPhone hors écran d'accueil) | "unsupported"
function pushState() {
  if (isIOS() && !isStandalone()) return "ios-browser";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  let on = false; try { on = localStorage.getItem(PUSH_KEY) === "1"; } catch {}
  return on && Notification.permission === "granted" ? "on" : "off";
}
function pushLine() {
  const st = pushState();
  if (st === "on" || st === "unsupported") return "";
  const txt = st === "ios-browser" ? "Ajoute le Hub à l'écran d'accueil pour être prévenu de signer"
    : st === "denied" ? "Notifications bloquées : autorise-les dans les réglages"
    : "<b>Activer</b> les rappels de signature";
  return `<div class="ctx-row"><button class="ctx-cheat" ${st === "off" ? "data-push" : "disabled"}>${ico("i-bell")}<span>${txt}</span></button></div>`;
}
const b64urlToBytes = (s) => {
  const b = atob((s + "=".repeat((4 - s.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
async function enablePush() {
  const store = await getStore();
  if (!store?.session) return;
  try {
    // Doit rester dans le geste de l'utilisateur (exigence iOS) : la permission d'abord.
    if (await Notification.requestPermission() !== "granted") { rerender(); return; }
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription())
      || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(window.HUB_CONFIG.VAPID_PUBLIC_KEY) });
    const j = sub.toJSON();
    const { error } = await store.sb.from("push_subscriptions")
      .upsert({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth }, { onConflict: "endpoint" });
    if (error) { oops("Notifications : " + error.message + "\n(As-tu lancé push.sql ?)"); return; }
    try { localStorage.setItem(PUSH_KEY, "1"); } catch {}
    sfx("toggle");
    rerender();
  } catch (e) { oops("Notifications impossibles : " + e.message); }
}

// Ligne « N demandes en attente » (ouvre la feuille des demandes) ; rien s'il n'y en a pas.
function bookingLine() {
  const n = pendingBookings().length;
  if (!n) return "";
  return `<div class="ctx-row"><button class="ctx-cheat ctx-book" data-bookings>${ico("i-user")}<span><b data-count="${n}">${n}</b> ${n > 1 ? "demandes" : "demande"} en attente</span></button></div>`;
}

// Carte contexte : badge école/entreprise, prochain trou libre, compteurs.
function ctxCard(evs, key, N, signed) {
  const items = evs.map((e) => ({ s: parisMinutes(e.start), e2: e.end ? parisMinutes(e.end) : parisMinutes(e.start) + 60 }));
  const badge = modeBadge(key);
  const gap = nextFreeGap(items, N);
  const freeChip = gap ? `<span class="free-chip">${ico("i-coffee")}Libre ${hmMin(gap.s)}–${hmMin(gap.e)}</span>` : "";
  const nCours = evs.filter((e) => e.source === "course").length;
  const totalMin = evs.reduce((a, e) => a + durMin(e), 0);
  const topRow = (badge || freeChip) ? `<div class="ctx-row">${badge}${freeChip}</div>` : "";
  const trainRow = trainLine(trainingForDay(key), key, signed);
  const cheatRow = (signed ? cheatLine() : "") + (signed ? pushLine() : "");
  const bookRow = signed ? bookingLine() : "";
  const stat = (icn, v, l) => `<span class="ctx-stat">${ico(icn)}<b${typeof v === "number" ? ` data-count="${v}"` : ""}>${v}</b> ${l}</span>`;
  // Pas de compteurs à zéro : sur une journée libre ils n'apprennent rien.
  // Le nombre de tâches n'est plus répété ici : la liste est juste à côté.
  const stats = [];
  if (nCours) stats.push(stat("i-cap", nCours, "cours"));
  if (totalMin) stats.push(stat("i-clock", hoursLabel(totalMin), "planifiées"));
  const free = evs.length ? "" : `<div class="ctx-free">${ico("i-coffee")}<span><b>Journée libre</b> — aucun cours ni réunion.</span></div>`;
  return `<div class="hero-ctx"><div class="ctx-card">
    ${free}
    ${bookRow}
    ${topRow}
    ${trainRow}
    ${cheatRow}
    ${stats.length ? `<div class="ctx-row ctx-stats">${stats.join("")}</div>` : ""}
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
  // L'onglet dit déjà « Aujourd'hui » : l'en-tête donne la date elle-même.
  const N = now();
  // Téléphone étroit : « Dim. 15 » pour tenir sur une ligne à côté des boutons.
  titleEl.innerHTML = `<span class="wd-long">${cap(fmtWdLong.format(N))}</span><span class="wd-short">${cap(fmtWdShort.format(N))}</span> ${fmtDayNum.format(N)}`;
  dateEl.textContent = cap(fmtMonthYear.format(N));
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

  // Aujourd'hui sert surtout de to-do : la liste passe en premier (colonne principale),
  // le planning du jour vient à côté (desktop) ou dessous (mobile). Journée libre : pas de
  // carte « prochain créneau » ni de timeline vide, la carte contexte le dit en une ligne.
  const dayPanel = evs.length
    ? `<div class="panel"><div class="panel-h"><h2>Journée</h2><span class="count">${countTxt}</span></div>${timeline}</div>`
    : "";
  viewEl.innerHTML = `
    ${guestMode() ? guestBanner() : ""}
    ${captureHtml}
    <div id="dash-exam"></div>
    <section class="dash${evs.length ? "" : " is-free"}">
      <div class="dash-main">${tasksPanel}</div>
      <aside class="dash-side">
        ${evs.length ? heroNext(evs, curIdx, nextIdx, N) : ""}
        ${ctxCard(evs, key, N, signed)}
        <div id="dash-goal"></div>
        <div id="dash-upcoming"></div>
        ${dayPanel}
      </aside>
    </section>`;

  wireEventTaps(viewEl);
  wireCapture(viewEl);
  viewEl.querySelector("[data-skip]")?.addEventListener("click", (e) => toggleTrainingSkip(e.currentTarget.dataset.skip));
  viewEl.querySelector("[data-cheat]")?.addEventListener("click", openCheatSheet);
  viewEl.querySelector("[data-push]")?.addEventListener("click", enablePush);
  viewEl.querySelector("[data-bookings]")?.addEventListener("click", () => openBookingsSheet());
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
  if (guestMode()) guestSync(null);
}

async function renderDashTasks() {
  const mount = document.getElementById("dash-tasks");
  if (!mount) return;
  const store = _store?.session ? _store : await getStore();
  if (!store?.session) return;
  const todayK = dayKey(now());
  const todos = store.todos;
  const weekEnd = endOfWeekKey();
  const byDue = (a, b) => (a.due_date || "9999").localeCompare(b.due_date || "9999");
  const late = todos.filter((t) => !t.done && t.due_date && t.due_date < todayK).sort(byDue);
  const today = todos.filter((t) => !t.done && (!t.due_date || t.due_date === todayK));
  const soon = todos.filter((t) => !t.done && t.due_date && t.due_date > todayK && t.due_date <= weekEnd).sort(byDue);
  const later = todos.filter((t) => !t.done && t.due_date && t.due_date > weekEnd && !isFarTask(t, todayK)).sort(byDue);
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
      if (hidden.has(t.id) && !showHidden) continue; // événement importé retiré par l'utilisateur
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
  // Créneau occupé / demande de l'invité : simple repère, ni cliquable ni focalisable.
  if (ev.source === "busy" || ev.source === "request") return `data-src="${ev.source}"`;
  // Demande reçue (propriétaire) : ouvre la feuille des demandes, pas la fiche événement.
  if (ev.source === "booking") return `data-src="booking" data-booking="${esc(ev.bid)}" role="button" tabindex="0"`;
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
// Plage importée (Teams / Google) de 6 h ou plus : affichée en fond de colonne (vue semaine).
const isBackdrop = (e) => (e.source === "fl" || e.source === "ef" || e.source === "gc") && e.e2 - e.s >= 360;
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
  // Une demande en attente n'est pas un conflit : la feuille des demandes le signale elle-même.
  for (let i = 0; i < evs.length; i++)
    for (let j = i + 1; j < evs.length; j++)
      if (evs[i].source !== "booking" && evs[j].source !== "booking" && overlapMin(evs[i], evs[j]) > MIN_OVERLAP) { evs[i].conflict = true; evs[j].conflict = true; }
  return evs;
}

// Paires de créneaux en conflit sur la semaine (pour le bandeau + le saut).
function weekConflicts(perDay) {
  const out = [];
  perDay.forEach((items, i) => {
    for (let a = 0; a < items.length; a++)
      for (let b = a + 1; b < items.length; b++)
        if (items[a].source !== "booking" && items[b].source !== "booking" && overlapMin(items[a], items[b]) > MIN_OVERLAP)
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
    const before = weekOffset;
    weekOffset = v === "0" ? 0 : weekOffset + Number(v);
    weekDay = -1; // on repasse en mode auto (aujourd'hui) à chaque changement de semaine
    window.scrollTo({ top: 0 });
    if (weekOffset === before) renderWeek();
    else vt("week", renderWeek, weekOffset > before ? 1 : -1);
  }));
}

// Bandeau de stats (cours, heures planifiées, réunions pro) à partir des blocs déjà positionnés.
function weekStats(perDay) {
  let nCours = 0, nPro = 0, totalMin = 0;
  perDay.flat().forEach((e) => {
    if (e.source === "request" || e.source === "booking" || e.source === "busy") return; // demande / occupé invité : hors agenda
    totalMin += Math.max(0, e.e2 - e.s);
    if (e.source === "course") nCours++;
    if (e.source === "fl") nPro++;
  });
  const hours = Math.round(totalMin / 60);
  const stat = (id, k, l) => `<div class="wk-stat">${ico(id, "si")}<span class="k num"${/^d+h?$/.test(String(k)) ? ` data-count="${parseInt(k, 10)}"` : ""}>${k}</span><span class="l">${l}</span></div>`;
  let html = stat("i-cap", nCours, nCours > 1 ? "cours" : "cours");
  // Invité : les heures « occupé » du propriétaire ne sont pas les siennes, pas de total.
  if (!guestMode()) html += stat("i-clock", `${hours}h`, "planifiées");
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
  if (present.has("busy")) items.push(["var(--muted)", "Occupé"]);
  if (present.has("request")) items.push(["var(--accent)", "Ta demande"]);
  if (present.has("booking")) items.push(["var(--accent)", "Demande en attente"]);
  if (days.some((d) => dayMode(d.key) === "entreprise")) items.push(["var(--warn)", "Entreprise"]);
  if (!items.length) return "";
  return `<div class="wk-legend">${items.map(([c, l]) =>
    `<span class="wk-chip" style="--c:${c}"><i></i>${l}</span>`).join("")}</div>`;
}

// Pastilles de jours (mobile) : les 7 jours tiennent sur une ligne, le jour affiché est
// surligné (jamais retiré), un point signale les jours qui ont des créneaux.
function weekPills(days, sel, perDay = []) {
  const todayK = dayKey(new Date());
  return `<div class="wk-pills" id="wk-pills">${days.map((d, i) => {
    const wd = new Date(d.key + "T12:00:00Z").getUTCDay();
    const we = wd === 0 || wd === 6;
    const has = (perDay[i] || []).length > 0;
    const t = d.key === todayK;
    return `<button class="wk-pill${i === sel ? " is-on" : ""}${we ? " is-we" : ""}${t ? " is-today" : ""}" data-i="${i}" aria-pressed="${i === sel}" aria-label="${cap(fmtDayLabel.format(d.date))}${has ? ` · ${perDay[i].length} créneau${perDay[i].length > 1 ? "x" : ""}` : " · libre"}">
      <span class="pd">${cap(fmtWdShort.format(d.date)).replace(/\.$/, "")}</span><span class="pn num">${fmtDayNum.format(d.date)}</span><i class="pdot${has ? " on" : ""}"></i>
    </button>`;
  }).join("")}</div>`;
}

// Cours ignorés et événements importés retirés tombant dans la semaine affichée.
function hiddenCountWeek(days) {
  const out = { courses: 0, imported: 0 };
  if (!_store?.session) return out;
  const hidden = _store.hidden || new Set();
  const keys = new Set(days.map((d) => d.key));
  for (const e of (PLANNING?.events || [])) if (hidden.has(e.uid) && keys.has(dayKey(new Date(e.start)))) out.courses++;
  for (const t of (_store.teams || [])) if (t.start_at && hidden.has(t.id) && keys.has(dayKey(new Date(t.start_at)))) out.imported++;
  return out;
}

function weekTools(days) {
  const eye = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>`;
  const chips = [];
  const { courses, imported } = hiddenCountWeek(days);
  const parts = [];
  if (courses) parts.push(`${courses} cours ignoré${courses > 1 ? "s" : ""}`);
  if (imported) parts.push(`${imported} événement${imported > 1 ? "s" : ""} retiré${imported > 1 ? "s" : ""}`);
  if (parts.length) chips.push(`<button class="chip${showHidden ? " is-on" : ""}" id="toggle-hidden" aria-pressed="${showHidden}">${eye}${showHidden ? "Masquer" : "Voir"} : ${parts.join(" · ")}</button>`);
  if (days.some((d) => dayMode(d.key) === "entreprise")) {
    chips.push(`<button class="chip${sgOn ? " is-on" : ""}" id="toggle-sg">${ico("i-clock", "si")}Horaires SG</button>`);
  }
  return chips.length ? `<div class="wk-tools">${chips.join("")}</div>` : "";
}

let _weekSel = 0;           // index du jour affiché (mobile), lu par le balayage
let weekSlide = 0;          // mobile : direction de l'animation de glissement entre jours
let _calTop = 300;          // ordinateur : haut réel de la grille (mesuré après rendu) pour caler la journée

function renderWeek() {
  titleEl.textContent = "Semaine";
  const days = weekDays(weekOffset);
  dateEl.textContent = `${fmtRange.format(days[0].date)} – ${fmtRange.format(days[6].date)}`;
  if (!PLANNING) {
    viewEl.innerHTML = `<div class="wk"><div class="wk-bar">${weekNav(days)}</div>
      <div class="note">${illus("art-offline")}<h3>Rien à afficher</h3><p>Planning indisponible.</p></div></div>`;
    wireWeekNav(); return;
  }

  // Invité (hors session) : créneaux occupés + ses demandes, chargés à part (guestSync).
  if (SUPA_READY && !_store && !_storeTried) {
    _storeTried = true;
    getStore().then(() => { if (current === "week") rerender(); });
  }
  const guest = guestMode();
  if (guest) guestSync(days);
  // Une seule passe de positionnement, réutilisée pour les stats, la légende et la grille.
  const owner = !!_store?.session;
  const rawDay = days.map((d) => [...mergedEventsForDay(d.key), ...(guest ? guestEventsForDay(d.key) : []), ...(owner ? ownerBookingsForDay(d.key) : [])].map((e) => ({
    ...e, s: e._s ?? parisMinutes(e.start), e2: e._e2 ?? (e.end ? parisMinutes(e.end) : parisMinutes(e.start) + 60),
  })));
  // Les longues plages importées (permanence, « Hotline » sur toute la journée…) passent en fond :
  // elles ne prennent pas de colonne et ne créent pas de faux conflits avec chaque cours.
  const bgDay = rawDay.map((l) => l.filter(isBackdrop));
  const perDay = rawDay.map((l) => packDay(l.filter((e) => !isBackdrop(e))));
  const todayIdx = days.findIndex((d) => d.key === dayKey(new Date()));
  const sel = weekDay >= 0 ? weekDay : (todayIdx >= 0 ? todayIdx : 0);
  _weekSel = sel;

  // Invité : pas d'alerte de conflit (un « Occupé » sur un cours ne le regarde pas).
  if (guest) for (const e of perDay.flat()) e.conflict = false;
  const bar = `<div class="wk-bar">${weekNav(days)}${weekStats(perDay)}<div class="wk-spacer"></div>${weekLegend(perDay.map((l, i) => [...l, ...bgDay[i]]), days)}</div>`;
  const conflicts = guest ? [] : weekConflicts(perDay);
  const alert = conflicts.length
    ? `<button class="wk-alert" id="wk-alert" data-i="${conflicts[0].i}">${ico("i-alert", "si")}
        <span><b>${conflicts.length} conflit${conflicts.length > 1 ? "s" : ""} à vérifier</b> cette semaine — deux créneaux se chevauchent.</span>
        <span class="wk-alert-go">Voir&nbsp;›</span></button>`
    : "";
  viewEl.innerHTML = `<div class="wk">${bar}${guest ? guestBanner() : ""}${alert}${weekTools(days)}${weekPills(days, sel, perDay.map((l, i) => [...l, ...bgDay[i]]))}${weekGrid(days, perDay, sel, bgDay)}</div>`;

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
  wireBookingTaps(viewEl);
  wireCalAdd(days);
  wireCalDrag(days);
  updateFab();
  weekSlide = 0;
  // Ajuste la hauteur des heures à la place réellement disponible (bandeau de conflit, outils…).
  // Un seul second rendu, et seulement si l'estimation était fausse de plus de quelques pixels.
  if (desktop()) {
    const body = viewEl.querySelector(".cal-body");
    if (body) {
      const top = Math.round(body.getBoundingClientRect().top + window.scrollY);
      if (Math.abs(top - _calTop) > 4) { _calTop = top; renderWeek(); }
    }
  }
}

// Tap sur une zone vide d'une colonne jour -> ajout d'un événement à cette heure.
function wireCalAdd(days) {
  const guest = guestMode();
  if (!_store?.session && !guest) return;
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
      if (guest) openBookingForm(days[i].key, hhmm(min), hhmm(endMin));
      else openEventForm(days[i].key, hhmm(min), hhmm(endMin));
    });
  });
}

// ---------- Réservations invités (hors session) ----------
// Un invité voit la semaine avec des blocs « Occupé » (heures seules, via busy_slots) et peut
// demander un créneau. Son navigateur garde un jeton anonyme + ses demandes (lib/booking.js).
// Si les fonctions SQL ne répondent pas, la vue reste celle d'avant, sans blocs occupés.
const _guest = { busy: [], mine: [], weekKey: null, mineLoaded: false };
const guestMode = () => SUPA_READY && !!_store?.live && !_store.session;
const _guestMem = new Map();
// localStorage peut être inaccessible (navigation privée stricte) : repli en mémoire.
function guestStorage() {
  try { const ls = window.localStorage; ls.getItem("hub.guest"); return ls; } catch {
    return { getItem: (k) => _guestMem.get(k) ?? null, setItem: (k, v) => { _guestMem.set(k, String(v)); } };
  }
}
// Fusionne les créneaux occupés qui se chevauchent : moins de bruit, et on ne trahit pas
// combien d'événements se cachent derrière un bloc.
function mergeBusy(rows) {
  const list = (rows || []).map((r) => ({ s: Date.parse(r.start_at), e: Date.parse(r.end_at) }))
    .filter((r) => !Number.isNaN(r.s) && !Number.isNaN(r.e) && r.e > r.s)
    .sort((a, b) => a.s - b.s);
  const out = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last && r.s <= last.e) last.e = Math.max(last.e, r.e);
    else out.push({ ...r });
  }
  return out.map((r) => ({ start: new Date(r.s).toISOString(), end: new Date(r.e).toISOString() }));
}
// Créneaux occupés entre deux instants ISO ; null si la fonction SQL ne répond pas.
async function busyBetween(from, to) {
  try {
    const { data, error } = await _store.sb.rpc("busy_slots", { p_from: from, p_to: to });
    if (error) throw error;
    return mergeBusy(data);
  } catch (e) {
    console.warn("[Hub] busy_slots", e?.message || e);
    return null;
  }
}
async function fetchGuestBusy(days) {
  const wk = days[0].key;
  const busy = await busyBetween(parisToISO(wk, "00:00"), parisToISO(addDays(days[6].key, 1), "00:00"));
  if (_guest.weekKey !== wk) return false; // semaine changée entre-temps : réponse périmée
  if (busy === null) { const had = _guest.busy.length > 0; _guest.busy = []; return had; }
  _guest.busy = busy;
  return true;
}
async function fetchGuestMine() {
  const g = loadGuest(guestStorage());
  if (!g.ids.length) { const had = _guest.mine.length > 0; _guest.mine = []; return had; }
  try {
    const { data, error } = await _store.sb.rpc("my_bookings", { p_token: g.token });
    if (error) throw error;
    _guest.mine = (data || []).map((r) => ({ id: r.id, start: r.start_at, end: r.end_at, status: r.status }));
    return true;
  } catch (e) {
    console.warn("[Hub] my_bookings", e?.message || e);
    return false;
  }
}
// Charge (une fois par semaine affichée / par retour sur l'app) puis re-rend si besoin.
function guestSync(days) {
  if (!guestMode()) return;
  const jobs = [];
  if (days && _guest.weekKey !== days[0].key) { _guest.weekKey = days[0].key; jobs.push(fetchGuestBusy(days)); }
  if (!_guest.mineLoaded) { _guest.mineLoaded = true; jobs.push(fetchGuestMine()); }
  if (!jobs.length) return;
  Promise.all(jobs).then((r) => {
    if (r.some(Boolean) && guestMode() && (current === "today" || current === "week")) rerender();
  });
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) { _guest.weekKey = null; _guest.mineLoaded = false; } // le re-rendu suit (démarrage)
});
// Blocs invité d'un jour (heure de Paris), découpés aux bornes du jour.
function guestEventsForDay(key) {
  const d0 = Date.parse(parisToISO(key, "00:00")), d1 = Date.parse(parisToISO(addDays(key, 1), "00:00"));
  const out = [];
  const clip = (s, e, extra) => {
    const a = Math.max(s, d0), b = Math.min(e, d1);
    if (!(b > a)) return;
    const start = new Date(a).toISOString(), end = new Date(b).toISOString();
    out.push({ ...extra, start, end, _s: parisMinutes(start), _e2: b >= d1 ? 24 * 60 : parisMinutes(end) });
  };
  for (const b of _guest.busy) clip(Date.parse(b.start), Date.parse(b.end), { source: "busy", title: "Occupé" });
  for (const r of _guest.mine) {
    if (r.status === "pending") clip(Date.parse(r.start), Date.parse(r.end), { source: "request", title: "Ta demande" });
  }
  return out;
}
// Bandeau « Ta demande du jeu. 19 à 14:00 : en attente » (demandes des 28 derniers jours).
// Demande restée en attente après la fin du créneau : « sans réponse » (style atténué).
const GUEST_STATUS = { pending: "en attente", accepted: "acceptée ✓", declined: "refusée", expired: "sans réponse" };
function guestBanner() {
  const t = now().getTime();
  const since = t - 28 * 24 * 3600 * 1000;
  const rows = _guest.mine.filter((r) => Date.parse(r.end) >= since).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  if (!rows.length) return "";
  return `<div class="guest-reqs">${rows.map((r) => {
    const d = new Date(r.start);
    const status = r.status === "pending" && Date.parse(r.end) <= t ? "expired" : r.status;
    const st = GUEST_STATUS[status] || status;
    return `<div class="guest-req st-${esc(status)}">${ico(status === "accepted" ? "i-check" : "i-clock", "si")}<span>Ta demande du ${esc(fmtWdShort.format(d))} ${esc(fmtDayNum.format(d))} à ${esc(fmtTime.format(d))} : <b>${esc(st)}</b></span></div>`;
  }).join("")}</div>`;
}

// ---------- Demandes reçues (propriétaire connecté) ----------
// _store.bookings : demandes en attente + décidées ces 28 derniers jours (refreshPersonal).
// Tout champ saisi par un invité (nom, motif, contact, e-mail) passe par esc() : ce sont des
// inconnus d'Internet.
const _bookingBusy = new Set(); // ids en cours de décision (évite un double clic)
// Demandes en attente encore à venir, par ordre chronologique.
function pendingBookings() {
  const t = now().getTime();
  return (_store?.bookings || [])
    .filter((b) => b.status === "pending" && Date.parse(b.end_at) > t)
    .sort((a, b) => Date.parse(a.start_at) - Date.parse(b.start_at));
}
// Blocs « demande » d'un jour (vue Semaine), découpés aux bornes du jour comme ceux de l'invité.
function ownerBookingsForDay(key) {
  if (!_store?.session) return [];
  const d0 = Date.parse(parisToISO(key, "00:00")), d1 = Date.parse(parisToISO(addDays(key, 1), "00:00"));
  const out = [];
  for (const r of pendingBookings()) {
    const a = Math.max(Date.parse(r.start_at), d0), b = Math.min(Date.parse(r.end_at), d1);
    if (!(b > a)) continue;
    const start = new Date(a).toISOString(), end = new Date(b).toISOString();
    out.push({ source: "booking", bid: String(r.id), title: `Demande · ${r.name}`, start, end, _s: parisMinutes(start), _e2: b >= d1 ? 24 * 60 : parisMinutes(end) });
  }
  return out;
}
// Tap / Entrée sur un bloc demande -> feuille des demandes, centrée sur celle-ci.
function wireBookingTaps(root) {
  if (!_store?.session) return;
  root.querySelectorAll("[data-booking]").forEach((el) => {
    const open = () => openBookingsSheet(el.dataset.booking);
    el.addEventListener("click", open);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
}
// La demande chevauche-t-elle maintenant un événement (cours non masqué, perso, importé) ?
function bookingOverlaps(row) {
  const s = Date.parse(row.start_at), e = Date.parse(row.end_at);
  const keys = new Set([dayKey(new Date(s)), dayKey(new Date(e - 1))]);
  const evs = [];
  for (const k of keys) for (const ev of mergedEventsForDay(k)) {
    if (ev._hidden) continue;
    const end = ev.end || new Date(Date.parse(ev.start) + 3600 * 1000).toISOString();
    evs.push({ start: ev.start, end });
  }
  return conflictsWith({ start: row.start_at, end: row.end_at }, evs);
}
const bookingWhen = (row) => evWhen({ start: row.start_at, end: row.end_at });
// Feuille des demandes : en attente (Accepter / Refuser) + décidées récemment.
// `id` (optionnel) : la demande touchée dans la semaine, mise en avant.
function openBookingsSheet(id) {
  if (!_store?.session) return;
  const STATUS = { accepted: "Acceptée", declined: "Refusée" };
  const body = () => {
    const list = pendingBookings();
    const items = list.map((b) => {
      const warn = bookingOverlaps(b)
        ? `<p class="bk-warn">${ico("i-alert")}<span>Chevauche maintenant : un autre événement</span></p>` : "";
      const contact = b.contact ? `<span>${ico("i-user")}${esc(b.contact)}</span>` : "";
      const email = b.email ? `<a href="mailto:${esc(b.email)}">${ico("i-ext")}${esc(b.email)}</a>` : "";
      const busy = _bookingBusy.has(String(b.id)) ? " disabled" : "";
      return `<div class="bk-item" data-bk="${esc(String(b.id))}">
        <div class="bk-name">${esc(b.name)}</div>
        <div class="bk-when">${ico("i-clock")}<span>${bookingWhen(b)}</span></div>
        ${b.reason ? `<p class="bk-why">${esc(b.reason)}</p>` : ""}
        ${contact || email ? `<div class="bk-meta">${contact}${email}</div>` : ""}
        ${warn}
        <div class="sheet-actions">
          <button type="button" class="btn btn-danger" data-decide="decline"${busy}>Refuser</button>
          <button type="button" class="btn" data-decide="accept"${busy}>Accepter</button>
        </div>
      </div>`;
    }).join("");
    const recent = (_store.bookings || []).filter((b) => b.status !== "pending" && b.decided_at)
      .sort((a, b) => Date.parse(b.decided_at) - Date.parse(a.decided_at)).slice(0, 5);
    const recentHtml = recent.length
      ? `<div class="bk-recent"><div class="bk-sec-h">Récemment</div>${recent.map((b) =>
          `<div class="bk-done st-${esc(b.status)}"><span class="bk-done-n">${esc(b.name)}</span><span class="bk-done-w">${bookingWhen(b)}</span><b>${STATUS[b.status] || esc(b.status)}</b></div>`).join("")}</div>`
      : "";
    return `${list.length ? `<div class="bk-list">${items}</div>` : `<p class="sheet-note">Aucune demande en attente.</p>`}
      ${recentHtml}
      <div class="sheet-actions"><button type="button" class="btn btn-ghost" id="bk-close">Fermer</button></div>`;
  };
  const ov = openSheet(`<h3 class="sheet-h">Demandes de créneau</h3><div id="bk-body">${body()}</div>`);
  const box = ov.querySelector("#bk-body");
  const wire = () => {
    box.querySelector("#bk-close")?.addEventListener("click", () => closeSheet());
    box.querySelectorAll("[data-decide]").forEach((btn) => btn.addEventListener("click", async () => {
      const item = btn.closest("[data-bk]");
      if (!item) return;
      item.querySelectorAll("[data-decide]").forEach((x) => { x.disabled = true; });
      await decideBooking(item.dataset.bk, btn.dataset.decide === "accept");
      if (box.isConnected) { box.innerHTML = body(); wire(); }
    }));
  };
  wire();
  if (id) {
    const el = [...box.querySelectorAll("[data-bk]")].find((x) => x.dataset.bk === String(id));
    if (el) { el.classList.add("is-focus"); requestAnimationFrame(() => el.scrollIntoView({ block: "nearest" })); }
  }
}
// Accepter : crée l'événement perso puis marque la demande ; refuser : marque seulement.
// L'événement est créé d'abord : s'il échoue, la demande reste en attente. Si la mise à jour
// de la demande échoue ensuite, l'événement tout juste créé est supprimé (pas de doublon).
async function decideBooking(id, accept) {
  const key = String(id);
  const row = (_store?.bookings || []).find((b) => String(b.id) === key);
  if (!_store?.session || !row || row.status !== "pending" || _bookingBusy.has(key)) return false;
  _bookingBusy.add(key);
  quiet(1500);
  try {
    let eventId = null;
    if (accept) {
      const title = row.reason ? `${row.name} — ${row.reason}` : row.name;
      const { data, error } = await _store.sb.from("custom_events")
        .insert({ title, start_at: row.start_at, end_at: row.end_at }).select("id").single();
      if (error || !data) { oops("Acceptation impossible : " + (error?.message || "événement non créé")); return false; }
      eventId = data.id;
    }
    const patch = { status: accept ? "accepted" : "declined", decided_at: new Date().toISOString() };
    if (accept) patch.event_id = eventId;
    // .eq("status", "pending") : une demande déjà traitée (autre appareil) n'est pas réécrite.
    const { data: upd, error } = await _store.sb.from("booking_requests")
      .update(patch).eq("id", row.id).eq("status", "pending").select("id");
    if (error || !upd?.length) {
      if (eventId) {
        const { error: delErr } = await _store.sb.from("custom_events").delete().eq("id", eventId);
        if (delErr) console.warn("[Hub] nettoyage événement", delErr.message);
      }
      oops(error ? "Décision impossible : " + error.message : "Cette demande a déjà été traitée.");
      await refreshPersonal(); rerender();
      return false;
    }
    Object.assign(row, patch);
    sfx(accept ? "add" : "toggle");
    await refreshPersonal(); rerender();
    if (row.email) sendBookingEmail(row.id).catch((e) => console.warn("[Hub] e-mail demande", e?.message || e));
    return true;
  } finally {
    _bookingBusy.delete(key);
  }
}
async function sendBookingEmail(id) {
  const { error } = await _store.sb.functions.invoke("booking-email", { body: { id } });
  if (error) throw error;
}

// Formulaire de demande (invité). date "AAAA-MM-JJ", start/end "HH:MM" (pré-remplis par un tap).
function openBookingForm(dateKey, start, end) {
  if (!guestMode()) return;
  const N = now();
  const today = dayKey(N);
  const pad = (n) => String(n).padStart(2, "0");
  let d = dateKey, st = start, en = end;
  if (!d) {
    // Par défaut : l'heure pleine suivante, 1 h ; trop tard dans la journée -> demain 10:00.
    let h = Math.max(9, Math.floor(parisMinutes(N.toISOString()) / 60) + 1);
    d = today;
    if (h > 21) { d = addDays(today, 1); h = 10; }
    st = `${pad(h)}:00`; en = `${pad(h + 1)}:00`;
  }
  st = st || "09:00"; en = en || "10:00";
  const err = (f) => `<p class="field-err" id="bk-err-${f}" role="alert" hidden></p>`;
  const ov = openSheet(`
    <h3 class="sheet-h">Demander un créneau</h3>
    <p class="sheet-note">Bily reçoit ta demande et te répond. Les blocs « Occupé » sont déjà pris.</p>
    <form id="bk-form" class="sheet-form" novalidate>
      <label>Jour<input id="bk-date" type="date" value="${esc(d)}" min="${today}" max="${addDays(today, 27)}" required></label>
      <div class="sheet-two">
        <label>Début<input id="bk-start" type="time" step="900" value="${esc(st)}" required></label>
        <label>Fin<input id="bk-end" type="time" step="900" value="${esc(en)}" required></label>
      </div>
      ${err("when")}
      <label>Ton nom<input id="bk-name" maxlength="60" autocomplete="name" required></label>
      ${err("name")}
      <label>Motif<input id="bk-reason" maxlength="200" autocomplete="off" placeholder="Ex. bosser le projet, un café…" required></label>
      ${err("reason")}
      <label>Contact <span class="opt">(optionnel)</span><input id="bk-contact" maxlength="100" autocomplete="off" placeholder="Numéro, Insta…"></label>
      ${err("contact")}
      <label>E-mail — pour recevoir la réponse <span class="opt">(optionnel)</span><input id="bk-email" type="email" maxlength="254" autocomplete="email" inputmode="email"></label>
      ${err("email")}
      <div class="sheet-actions">
        <button type="button" class="btn btn-ghost" id="bk-cancel">Annuler</button>
        <button type="submit" class="btn" id="bk-send">Envoyer la demande</button>
      </div>
    </form>`);
  const $ = (id) => ov.querySelector("#" + id);
  const INPUT = { start: "bk-start", end: "bk-end", name: "bk-name", reason: "bk-reason", contact: "bk-contact", email: "bk-email" };
  const SLOT = { start: "when", end: "when", name: "name", reason: "reason", contact: "contact", email: "email" };
  const clearErrs = () => {
    ov.querySelectorAll(".field-err").forEach((p) => { p.hidden = true; p.textContent = ""; });
    ov.querySelectorAll("[aria-invalid]").forEach((i) => i.removeAttribute("aria-invalid"));
  };
  const showErr = (field, msg) => {
    const p = $("bk-err-" + (SLOT[field] || "when"));
    p.textContent = msg; p.hidden = false;
    const inp = $(INPUT[field] || "bk-start");
    inp?.setAttribute("aria-invalid", "true");
    inp?.focus();
    sfx("error");
  };
  $("bk-cancel").onclick = closeSheet;
  let sending = false;
  $("bk-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (sending) return;
    clearErrs();
    const dd = $("bk-date").value, sv = $("bk-start").value, evv = $("bk-end").value;
    if (!dd || !sv || !evv) { showErr(!dd || !sv ? "start" : "end", "Choisis le jour, le début et la fin."); return; }
    const startISO = parisToISO(dd, sv);
    let endISO = parisToISO(dd, evv);
    // « 00:00 » en fin = minuit du lendemain (comme le formulaire d'événement).
    if (Date.parse(endISO) <= Date.parse(startISO) && evv === "00:00") endISO = parisToISO(addDays(dd, 1), "00:00");
    const req = {
      start: startISO, end: endISO,
      name: $("bk-name").value.trim(), reason: $("bk-reason").value.trim(),
      contact: $("bk-contact").value.trim(), email: $("bk-email").value.trim(),
    };
    const v = validateRequest(req, now().getTime());
    if (!v.ok) { showErr(v.field, v.error); return; }
    const btn = $("bk-send");
    sending = true; btn.disabled = true;
    const done = () => { sending = false; btn.disabled = false; };
    // Occupé (relu à l'instant, sinon ce qu'on a déjà) + cours du planning public.
    const fresh = await busyBetween(startISO, endISO);
    const courses = (PLANNING?.events || []).filter((x) => x.start && x.end).map((x) => ({ start: x.start, end: x.end }));
    if (conflictsWith(req, [...(fresh ?? _guest.busy), ...courses])) { done(); showErr("start", "Ce créneau est déjà pris"); return; }
    const g = loadGuest(guestStorage());
    let res;
    try {
      res = await _store.sb.rpc("request_booking", {
        p_start: startISO, p_end: endISO, p_name: req.name, p_reason: req.reason,
        p_contact: req.contact || null, p_email: req.email || null, p_token: g.token,
      });
    } catch (err) { res = { error: err }; }
    if (res?.error || !res?.data) {
      done();
      const msg = String(res?.error?.message || "Réponse vide");
      // Messages du serveur (« Créneau déjà pris »…) affichés tels quels ; erreurs techniques préfixées.
      oops(/schema cache|does not exist|could not find|failed to fetch|network|vide/i.test(msg) ? "Demande impossible : " + msg : msg);
      return;
    }
    const id = String(res.data);
    rememberRequest(guestStorage(), id);
    _guest.mine = [..._guest.mine.filter((r) => r.id !== id), { id, start: startISO, end: endISO, status: "pending" }];
    closeSheet("silent");
    sfx("add");
    toast("Demande envoyée à Bily");
    rerender();
  });
  setTimeout(() => $("bk-name")?.focus(), 50);
}

// ---------- Glisser / redimensionner (vue Semaine) ----------
// Seuls les événements perso bougent. Cours et agendas importés : toast « lecture seule ».
const DRAG_MOUSE_PX = 4;    // souris : le geste démarre au-delà de 4 px
const DRAG_HOLD_MS = 400;   // tactile : appui long avant de pouvoir glisser
const DRAG_SLOP_PX = 8;     // tactile : bouger plus avant l'appui long = défilement, on abandonne
const RO_COURSE = "Cours myefrei — non modifiable";
const RO_IMPORTED = "Événement importé — modifie-le dans son agenda d'origine";
const _dragBusy = new Set(); // id perso en cours d'écriture : gestes ignorés (survit au re-rendu)
let _drag = null;            // geste en cours (un seul à la fois)
let _swallowUntil = 0;       // avale le clic qui suit un vrai glisser (ni fiche, ni formulaire d'ajout)
window.addEventListener("click", (e) => {
  if (performance.now() > _swallowUntil) return;
  _swallowUntil = 0;
  e.preventDefault(); e.stopPropagation();
}, true);
const swallowClick = () => { _swallowUntil = performance.now() + 500; };
// Filet de sécurité : si un re-rendu a détaché le bloc en plein geste, ses propres écouteurs ne
// recevront plus rien (lostpointercapture part au document) -> on termine le geste ici.
for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
  document.addEventListener(type, (e) => {
    if (_drag && e.pointerId === _drag.id && !_drag.el.isConnected) _drag.end();
  }, true);
}

function wireCalDrag(days) {
  // Nouveau rendu = nouveaux blocs : un geste en cours sur l'ancien DOM est abandonné proprement.
  if (_drag) _drag.end();
  if (!_store?.session) return;
  const cal = viewEl.querySelector(".cal");
  if (!cal) return;
  const top0 = +cal.dataset.top0 || 0;
  const PX = +cal.dataset.px || 56;
  const cols = [...cal.querySelectorAll(".cal-col")];
  if (!cols.length) return;
  const gridEnd = top0 + cols[0].querySelectorAll(":scope > .cal-slot").length * 60;
  const pad = (n) => String(n).padStart(2, "0");
  const hhmm = (min) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;
  const yTop = (min) => (min - top0) / 60 * PX;
  const hFor = (dur) => Math.max(22, dur / 60 * PX - 4); // même formule que weekGrid

  // Début/fin (minutes Paris) d'une ligne perso ; null si elle s'étale sur plusieurs jours.
  const rangeOf = (row) => {
    const s = parisMinutes(row.start_at);
    if (!row.end_at) return { s, e: Math.min(1440, s + 60) };
    const k0 = dayKey(new Date(row.start_at)), k1 = dayKey(new Date(row.end_at));
    const e = parisMinutes(row.end_at);
    if (k1 === k0) return e > s ? { s, e } : null;
    if (k1 === addDays(k0, 1) && e === 0) return { s, e: 1440 }; // finit à minuit pile
    return null;
  };

  const restore = (d) => {
    d.el.style.top = d.top;
    d.el.style.setProperty("--h", d.h);
    d.el.style.translate = "";
    if (d.label) d.label.textContent = d.text;
  };

  const end = () => {
    const d = _drag; if (!d) return;
    _drag = null;
    clearTimeout(d.timer);
    const el = d.el;
    el.removeEventListener("pointermove", onMove);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onCancel);
    el.removeEventListener("lostpointercapture", onCancel);
    window.removeEventListener("keydown", onKey);
    try { if (el.hasPointerCapture(d.id)) el.releasePointerCapture(d.id); } catch {}
    el.classList.remove("is-dragging");
    el.style.touchAction = "";
    document.documentElement.classList.remove("is-ev-dragging", "is-ev-resizing");
    return d;
  };

  const activate = () => {
    const d = _drag; if (!d || d.active) return;
    if (!d.el.isConnected) { end(); return; } // appui long arrivé après un re-rendu
    d.active = true;
    if (!d.perso) { toast(d.el.dataset.src === "course" ? RO_COURSE : RO_IMPORTED); return; } // une fois par geste
    // Le doigt tient le bloc : on coupe le défilement pour la suite du geste seulement.
    if (d.touch) { d.el.style.touchAction = "none"; try { navigator.vibrate?.(8); } catch {} }
    d.rects = cols.map((c) => c.getBoundingClientRect());
    d.el.classList.add("is-dragging");
    document.documentElement.classList.add("is-ev-dragging");
    if (d.mode === "resize") document.documentElement.classList.add("is-ev-resizing");
    window.addEventListener("keydown", onKey);
  };

  // Aperçu live : position, hauteur, colonne et libellé horaire du bloc.
  const preview = (x, dy) => {
    const d = _drag;
    const delta = dy / PX * 60;
    let { s, e } = d.mode === "resize" ? resizeEnd(d.s0, d.e0, delta) : moveRange(d.s0, d.e0, delta);
    // On reste dans la plage horaire affichée (le formulaire « Modifier » couvre le reste).
    if (d.mode === "resize") e = Math.min(e, Math.max(gridEnd, s + 15));
    else if (e - s <= gridEnd - top0) { const dur = e - s; s = Math.min(Math.max(s, top0), gridEnd - dur); e = s + dur; }
    // Changement de jour : ordinateur seulement, colonne sous le pointeur (repérée par sa position
    // horizontale, le bloc déplacé étant lui-même sous le pointeur). Mobile : même jour.
    let ci = d.ci;
    if (d.mode === "move" && desktop()) {
      const R = d.rects;
      ci = R.findIndex((r) => x >= r.left && x < r.right);
      if (ci < 0) ci = x < R[0].left ? 0 : R.length - 1;
    }
    d.cur = { ci, s, e };
    d.el.style.top = `${yTop(s)}px`;
    d.el.style.setProperty("--h", `${hFor(e - s)}px`);
    d.el.style.translate = ci === d.ci ? "" : `${d.rects[ci].left - d.rects[d.ci].left}px 0`;
    if (d.label) d.label.textContent = `${hhmm(s)}–${hhmm(e)}`;
  };

  function onMove(e) {
    const d = _drag; if (!d || e.pointerId !== d.id || d.cancelled) return;
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (!d.active) {
      if (d.touch) { if (Math.hypot(dx, dy) > DRAG_SLOP_PX) end(); return; } // ça défile : on laisse faire
      if (Math.hypot(dx, dy) < DRAG_MOUSE_PX) return;
      activate();
    }
    if (!d.perso) return;
    e.preventDefault();
    preview(e.clientX, dy);
  }

  function onUp(e) {
    const d = _drag; if (!d || e.pointerId !== d.id) return;
    end();
    if (!d.active) return;                                  // simple clic : la fiche s'ouvre normalement
    if (d.cancelled || !d.perso) { swallowClick(); return; } // Échap, ou bloc en lecture seule
    const c = d.cur;
    if (!c || (c.ci === d.ci && c.s === d.s0 && c.e === d.e0)) { restore(d); return; } // rien n'a changé
    swallowClick();
    const key = days[c.ci].key;
    const start_at = parisToISO(key, hhmm(c.s));
    // 1440 min (minuit) n'est pas une heure valide pour parisToISO : on écrit 00:00 le lendemain.
    const end_at = c.e >= 1440 ? parisToISO(addDays(key, 1), "00:00") : parisToISO(key, hhmm(c.e));
    const cid = d.el.dataset.cid;
    _dragBusy.add(cid);
    sfx("toggle");
    updateCustomEvent(cid, { start_at, end_at }, { undoLabel: d.mode === "resize" ? "Durée modifiée" : "Déplacé" })
      .then((ok) => { if (!ok && d.el.isConnected) restore(d); })
      .finally(() => _dragBusy.delete(cid));
  }

  function onCancel(e) {
    const d = _drag; if (!d || e.pointerId !== d.id) return;
    end();
    restore(d);
  }

  // Échap pendant le geste : le bloc revient à sa place ; le relâchement qui suit ne fait rien.
  function onKey(e) {
    const d = _drag;
    if (e.key !== "Escape" || !d?.active || d.cancelled) return;
    e.preventDefault();
    d.cancelled = true;
    restore(d);
    d.el.classList.remove("is-dragging");
    document.documentElement.classList.remove("is-ev-dragging", "is-ev-resizing");
  }

  cols.forEach((col, ci) => {
    col.querySelectorAll("[data-ev]").forEach((el) => {
      el.addEventListener("pointerdown", (e) => {
        if (_drag && !_drag.el.isConnected) _drag.end(); // bloc remplacé par un re-rendu en plein geste
        if (_drag || !e.isPrimary) return;
        if (e.pointerType === "mouse" && e.button !== 0) return;
        const perso = el.classList.contains("ev") && el.dataset.src === "perso";
        let r = null;
        if (perso) {
          if (_dragBusy.has(el.dataset.cid)) return;             // écriture précédente pas finie
          const row = (_store.custom || []).find((c) => String(c.id) === el.dataset.cid);
          r = row && rangeOf(row);
          if (!r) return;                                        // introuvable / sur plusieurs jours : clic seul
        }
        const label = el.querySelector(".ev-t");
        _drag = {
          el, ci, id: e.pointerId, touch: e.pointerType !== "mouse", x0: e.clientX, y0: e.clientY,
          perso, s0: r?.s, e0: r?.e, mode: perso && e.target.closest(".ev-rs") ? "resize" : "move",
          active: false, cancelled: false, timer: 0, cur: null, rects: null, end,
          top: el.style.top, h: el.style.getPropertyValue("--h"), label, text: label?.textContent,
        };
        try { el.setPointerCapture(e.pointerId); } catch {}
        if (_drag.touch && perso) _drag.timer = setTimeout(activate, DRAG_HOLD_MS); // tactile sur bloc non perso : rien, comme avant (tap + défilement)
        el.addEventListener("pointermove", onMove);
        el.addEventListener("pointerup", onUp);
        el.addEventListener("pointercancel", onCancel);
        el.addEventListener("lostpointercapture", onCancel);
      });
      // Une fois l'appui long validé, le doigt déplace le bloc au lieu de faire défiler la page.
      el.addEventListener("touchmove", (e) => { if (_drag?.el === el && _drag.perso && _drag.active) e.preventDefault(); }, { passive: false });
      // Pas de menu contextuel / loupe sur l'appui long.
      el.addEventListener("contextmenu", (e) => { if (_drag?.el === el && _drag.touch) e.preventDefault(); });
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

const SRC_ICON = { course: "i-cap", perso: "i-user", fl: "i-brief", ef: "i-brief", gc: "i-user", busy: "i-clock", request: "i-user", booking: "i-user" };

// Grille horaire 7 jours (desktop) / 1 jour qui défile (mobile), câblée aux vraies sources.
function weekGrid(days, perDay, sel, bgDay = days.map(() => [])) {
  const todayK = dayKey(new Date());
  const mobile = !desktop();

  // Plage horaire affichée (heures entières), bornée 8→20 puis élargie aux événements.
  let minH = 8, maxH = 20;
  [...perDay.flat(), ...bgDay.flat()].forEach((e) => { minH = Math.min(minH, Math.floor(e.s / 60)); maxH = Math.max(maxH, Math.ceil(e.e2 / 60)); });
  minH = Math.max(0, minH); maxH = Math.min(24, maxH);
  const top0 = minH * 60, rows = maxH - minH;
  // Ordinateur : la journée entière tient à l'écran, sans descendre sous 40 px/h pour que
  // les créneaux d'1 h restent lisibles. _calTop = haut réel de la grille, mesuré après rendu.
  const PX = mobile ? 60 : Math.max(40, Math.min(60, Math.floor((window.innerHeight - _calTop - 16) / rows)));
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
      // Bloc étroit (deux créneaux côte à côte) : l'heure de début seule, le titre passe devant.
      const narrow = ev.cols > 1 && !mobile;
      const range = narrow ? fmtTime.format(new Date(ev.start))
        : `${fmtTime.format(new Date(ev.start))}${ev.end ? "–" + fmtTime.format(new Date(ev.end)) : ""}`;
      const fullRange = `${fmtTime.format(new Date(ev.start))}${ev.end ? "–" + fmtTime.format(new Date(ev.end)) : ""}`;
      const exam = isExam(ev);
      const growL = (i === days.length - 1 || ev.cols > 1) && ev.lane === ev.cols - 1 ? " grow-l" : "";
      // Nombre de lignes de titre qui tiennent dans le bloc (le reste finit par « … »).
      const lines = Math.max(1, Math.floor((height - (narrow ? 22 : 34)) / 15.5));
      const confIc = exam ? `<span class="ev-exam-tag">EXAMEN</span>`
        : ev.conflict ? `<span class="ev-conf" aria-label="Conflit">${ico("i-alert")}</span>` : "";
      return `<div class="ev src-${ev.source}${ev.source === "request" || ev.source === "booking" ? " is-request" : ""}${size}${narrow ? " is-narrow" : ""}${growL}${ev._hidden ? " is-hidden" : ""}${ev.conflict ? " is-conf" : ""}${exam ? " is-exam" : ""}" ${evAttrs(ev)} title="${esc(ev.title)} · ${fullRange}${exam ? " — EXAMEN" : ev.conflict ? " — conflit à vérifier" : ""}" style="top:${yTop(ev.s)}px;--h:${height}px;height:var(--h);--lines:${lines};left:calc(${left}% + 4px);width:calc(${w}% - 8px);animation-delay:${j * 32}ms">
        <div class="ev-hd">${ico(exam ? "i-alert" : (SRC_ICON[ev.source] || "i-cap"))}<span class="ev-t mono">${range}</span><span class="ev-tt">${esc(ev.title)}</span>${confIc}</div>
        <div class="ev-ti">${esc(ev.title)}</div>
        ${loc ? `<div class="ev-lo">${ico("i-pin")}<span>${esc(loc)}</span></div>` : ""}
        ${ev.source === "perso" && _store?.session ? `<div class="ev-rs" aria-hidden="true"></div>` : ""}
      </div>`;
    }).join("");
    const now = showNow ? `<div class="cal-now" style="top:${yTop(nowMin)}px"><span class="cal-now-ln"></span><span class="cal-now-dot"></span><span class="cal-now-lab mono">${fmtTime.format(new Date())}</span></div>` : "";
    const bands = bgDay[i].map((ev) => {
      const range = `${fmtTime.format(new Date(ev.start))}${ev.end ? "–" + fmtTime.format(new Date(ev.end)) : ""}`;
      return `<div class="ev-bg src-${ev.source}" ${evAttrs(ev)} title="${esc(ev.title)} · ${range}" style="top:${yTop(ev.s)}px;height:${Math.max(22, (ev.e2 - ev.s) / 60 * PX - 4)}px">
        <span class="ev-bg-lab">${ico(SRC_ICON[ev.source] || "i-brief")}<span class="mono">${range}</span><b>${esc(ev.title)}</b></span></div>`;
    }).join("");
    return `<div class="cal-col${t ? " is-today" : ""}${we ? " we" : ""}${hide}">${sgBands(d.key)}${bands}${slots}${blocks}${now}</div>`;
  }).join("");

  // Largeur adaptative : un jour avec des événements en parallèle (conflits) s'élargit
  // selon le nombre de voies (plafonné à 2×) sans écraser le reste de la semaine.
  const dayW = perDay.map((evs) => Math.min(2, Math.max(1, ...evs.map((e) => e.cols || 1))));
  const calDays = dayW.map((w) => `minmax(0, ${w}fr)`).join(" ");

  return `<div class="cal" data-top0="${top0}" data-px="${PX}" style="--cal-px:${PX}px;--slide-dir:${weekSlide}px;--cal-days:${calDays}"><div class="cal-head">${head}</div><div class="cal-body">${axis}${cols}</div></div>`;
}

// ---------- Vue À faire ----------
async function renderTasks() {
  titleEl.textContent = "À faire";
  dateEl.textContent = "Tâches";
  if (!SUPA_READY) { viewEl.innerHTML = setupNote(); return; }

  const store = _store?.session ? _store : await getStore();
  if (!store) { viewEl.innerHTML = `<div class="note">${illus("art-offline")}<h3>Connexion impossible</h3><p>Impossible de joindre Supabase. Réessaie quand tu as du réseau.</p></div>`; return; }

  if (!store.session) { viewEl.innerHTML = signInView(); wireSignIn(store); return; }

  const todayK = dayKey(now());
  const todos = store.todos;
  const weekEnd = endOfWeekKey();
  const byDue = (a, b) => (a.due_date || "9999").localeCompare(b.due_date || "9999");
  const late = todos.filter((t) => !t.done && t.due_date && t.due_date < todayK).sort(byDue);
  const today = todos.filter((t) => !t.done && (!t.due_date || t.due_date === todayK));
  const soon = todos.filter((t) => !t.done && t.due_date && t.due_date > todayK && t.due_date <= weekEnd).sort(byDue);
  const pending = todos.filter((t) => !t.done && t.due_date && t.due_date > weekEnd).sort(byDue);
  const later = pending.filter((t) => !isFarTask(t, todayK));
  const far = pending.filter((t) => isFarTask(t, todayK));
  const done = todos.filter((t) => t.done).slice(-30).reverse();

  const section = (label, list, cls = "") => list.length
    ? `<p class="section-label${cls ? " " + cls : ""}">${label} · ${list.length}</p><div>${list.map(todoRow).join("")}</div>` : "";

  const farToggle = far.length
    ? `<button class="btn btn-ghost cr-more" type="button" id="td-far" aria-expanded="${_showFarTasks}">${_showFarTasks
        ? "Masquer les tâches dans plus d'un mois"
        : `Afficher ${far.length} tâche${far.length > 1 ? "s" : ""} dans plus d'un mois`}</button>` : "";
  const body = (late.length + today.length + soon.length + later.length + far.length)
    ? section("En retard", late, "is-late") + section("Aujourd'hui", today) + section("Cette semaine", soon) + section("Plus tard", later)
      + (_showFarTasks ? section("Dans plus d'un mois", far) : "") + farToggle
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
  viewEl.querySelector("#td-far")?.addEventListener("click", () => {
    _showFarTasks = !_showFarTasks;
    try { localStorage.setItem("hub.farTasks", _showFarTasks ? "1" : "0"); } catch {}
    sfx("toggle"); rerender();
  });
}

function todoRow(t) {
  const subs = Array.isArray(t.subtasks) ? t.subtasks : [];
  const doneN = subs.filter((s) => s.done).length;
  const hasSubs = !t.done && subs.length > 0;
  const subInner = tagChip(t.tag) + deadlinePill(t) + repeatPill(t);
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
    <p>Reçois un code par e-mail pour retrouver tes tâches sur tous tes appareils.</p>
    <form class="add" id="signin-form">
      <input id="signin-email" type="email" required placeholder="ton e-mail" autocomplete="email" aria-label="E-mail">
      <button class="btn" type="submit">Recevoir</button>
    </form>
    <form class="add" id="signin-code-form" hidden>
      <input id="signin-code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}" maxlength="10" required placeholder="code reçu" aria-label="Code reçu par e-mail">
      <button class="btn" type="submit">Valider</button>
    </form>
    <p id="signin-msg" role="status"></p>
  </div>`;
}

// ---------- Supabase ----------
let _store = null;
let _storeP = null;      // chargement de Supabase en cours ou abouti
let _storeTried = false; // a-t-on déjà tenté d'initialiser le store (évite les boucles si hors-ligne) ?
const SIGNED_KEY = "hub.signed", PERSO_KEY = "hub.personal";
const blankPersonal = () => ({ todos: [], custom: [], hidden: new Set(), teams: [], skips: new Set(), seenAt: null, goals: [], reminders: new Set(), examFlags: new Map(), cheats: [], attendance: new Map(), bookings: [], progress: new Set() });
const OFFLINE = { data: null, error: { message: "Hors ligne — réessaie quand le réseau revient." } };

// Client « en attente » : utilisé tant que Supabase n'est pas chargé (ou hors ligne). Il retient
// l'appel (sb.from(…).update(…).eq(…)) et le rejoue sur le vrai client dès qu'il est là ;
// sans réseau, l'appel répond par une erreur lisible au lieu de planter.
function lazySb(path = []) {
  return new Proxy(function () {}, {
    get: (_t, k) => k === "then"
      ? (ok, ko) => getStore().then((st) => {
          const sb = st && st.live ? st.sb : null;
          if (!sb) return OFFLINE;
          let ctx = null, cur = sb;
          for (const step of path) {
            if (step.call) cur = cur.apply(ctx, step.call);
            else { ctx = cur; cur = cur[step.get]; }
          }
          return cur;
        }).then(ok, ko)
      : lazySb([...path, { get: k }]),
    apply: (_t, _this, args) => lazySb([...path, { call: args }]),
  });
}

// Dernier état connu, gardé sur l'appareil : l'app s'affiche tout de suite, connectée, avec ses
// données, puis se met à jour quand Supabase répond. Fonctionne aussi hors ligne (lecture).
function seedStore() {
  if (_store || !SUPA_READY) return;
  try {
    const uid = localStorage.getItem(SIGNED_KEY);
    if (!uid) return;
    const p = JSON.parse(localStorage.getItem(PERSO_KEY) || "{}");
    _store = {
      ...blankPersonal(), sb: lazySb(), live: false, session: { cached: true, user: { id: uid } },
      todos: JSON.parse(localStorage.getItem("hub.todos") || "[]"),
      custom: p.custom || [], hidden: new Set(p.hidden || []), teams: p.teams || [], skips: new Set(p.skips || []),
      seenAt: p.seenAt || null, goals: p.goals || [], reminders: new Set(p.reminders || []),
      examFlags: new Map(p.examFlags || []), cheats: p.cheats || [], attendance: new Map(p.attendance || []),
      bookings: p.bookings || [], progress: new Set(p.progress || []),
    };
  } catch { _store = null; }
}
function savePersonal() {
  if (!_store?.session?.user?.id) return;
  try {
    localStorage.setItem(SIGNED_KEY, _store.session.user.id);
    localStorage.setItem(PERSO_KEY, JSON.stringify({
      custom: _store.custom, hidden: [..._store.hidden], teams: _store.teams, skips: [..._store.skips], seenAt: _store.seenAt,
      goals: _store.goals, reminders: [..._store.reminders], examFlags: [..._store.examFlags], cheats: _store.cheats,
      attendance: [..._store.attendance], bookings: _store.bookings, progress: [...(_store.progress || [])],
    }));
  } catch {}
}
function forgetPersonal() {
  Object.assign(_store, blankPersonal());
  try { for (const k of [SIGNED_KEY, PERSO_KEY, "hub.todos"]) localStorage.removeItem(k); } catch {}
}

function getStore() {
  if (_storeP) return _storeP;
  if (!SUPA_READY) return Promise.resolve(null);
  _storeP = (async () => {
    try {
      // Outil de dev (localhost seulement) : retarder Supabase pour observer l'état affiché depuis le cache.
      if (location.hostname === "localhost") { const d = Number(sessionStorage.getItem("hub.dev.sbDelay")) || 0; if (d) await new Promise((r) => setTimeout(r, d)); }
      const { createClient } = await import(`https://esm.sh/@supabase/supabase-js@${SUPABASE_VERSION}`);
      const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
      const { data } = await sb.auth.getSession();
      if (!_store) _store = { ...blankPersonal(), sb, live: true, session: null };
      _store.sb = sb; _store.live = true;
      _store.session = data.session;
      if (!data.session) forgetPersonal();
      sb.auth.onAuthStateChange((_e, session) => {
        _store.session = session;
        if (session) Promise.all([refreshTodos(), refreshPersonal()]).then(() => rerender());
        else { forgetPersonal(); rerender(); }
      });
      if (_store.session) await Promise.all([refreshTodos(), refreshPersonal()]);
      return _store;
    } catch (e) {
      console.error("Supabase indisponible", e);
      _storeP = null;
      // Hors ligne : on garde l'état connu (lecture seule) s'il y en a un.
      return _store?.session ? _store : null;
    }
  })();
  return _storeP;
}
// Le réseau revient : on retente le chargement et on rafraîchit.
window.addEventListener("online", () => { if (!_store?.live) getStore().then((st) => { if (st?.live) rerender(); }); });

async function refreshTodos() {
  if (!_store?.session || !_store.live) return;
  const { data, error } = await _store.sb.from("todos").select("*").order("created_at", { ascending: true });
  if (!error && data) {
    // Une tâche en attente de suppression (toast « Annuler ») reste masquée même si on recharge.
    _store.todos = data.filter((t) => !_todoLeaving.has(String(t.id)));
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
const _cheatLeaving = new Set();  // ids d'écarts supprimés mais encore annulables
const _customLeaving = new Set(); // ids d'événements perso supprimés mais encore annulables
async function refreshPersonal() {
  if (!_store?.session) { _store.custom = []; _store.hidden = new Set(); _store.teams = []; _store.skips = new Set(); _store.seenAt = null; _store.goals = []; _store.reminders = new Set(); _store.examFlags = new Map(); _store.cheats = []; _store.attendance = new Map(); _store.bookings = []; _store.progress = new Set(); return; }
  if (!_store.live) return; // état connu affiché ; le vrai chargement arrive avec Supabase
  // Demandes de créneau : en attente + décidées ces 28 derniers jours (sans le jeton invité).
  const bkSince = new Date(Date.now() - 28 * 24 * 3600 * 1000).toISOString();
  const [c, o, t, s, p, g, r, x, ch, at, bk, sp] = await Promise.all([
    _store.sb.from("custom_events").select("*").order("start_at", { ascending: true }),
    _store.sb.from("event_overrides").select("event_uid,hidden"),
    _store.sb.from("calendar_events").select("*").order("start_at", { ascending: true }),
    _store.sb.from("training_skips").select("day"),
    _store.sb.from("planning_seen").select("seen_at").maybeSingle(),
    _store.sb.from("goals").select("*").order("created_at", { ascending: true }),
    _store.sb.from("event_reminders").select("event_key"),
    _store.sb.from("exam_flags").select("event_uid,is_exam"),
    _store.sb.from("cheat_meals").select("id,day,label").order("day", { ascending: false }),
    _store.sb.from("attendance").select("start_at,status"),
    _store.sb.from("booking_requests").select("id,start_at,end_at,name,reason,contact,email,status,decided_at,event_id,created_at")
      .or(`status.eq.pending,decided_at.gte.${bkSince}`).order("start_at", { ascending: true }),
    _store.sb.from("session_progress").select("event_uid"),
  ]);
  _store.custom = c.error ? [] : (c.data || []).filter((x) => !_customLeaving.has(String(x.id)));
  _store.hidden = o.error ? new Set() : new Set((o.data || []).filter((r) => r.hidden).map((r) => r.event_uid));
  _store.teams = t.error ? [] : (t.data || []);
  _store.skips = s.error ? new Set() : new Set((s.data || []).map((r) => String(r.day).slice(0, 10)));
  _store.seenAt = (p && !p.error && p.data) ? p.data.seen_at : null;
  _store.goals = g.error ? [] : (g.data || []);
  _store.reminders = r.error ? new Set() : new Set((r.data || []).map((x) => x.event_key));
  _store.examFlags = x.error ? new Map() : new Map((x.data || []).map((e) => [e.event_uid, !!e.is_exam]));
  _store.cheats = ch.error ? [] : (ch.data || []).filter((r) => !_cheatLeaving.has(String(r.id))).map((r) => ({ ...r, day: String(r.day).slice(0, 10) }));
  // Table absente (SQL attendance.sql pas encore lancé) : on garde simplement une Map vide.
  _store.attendance = at.error ? new Map() : new Map((at.data || []).map((a) => [new Date(a.start_at).toISOString(), a.status]));
  // Table absente (bookings.sql pas lancé) : aucune demande.
  _store.bookings = bk.error ? [] : (bk.data || []);
  // Table absente (session-progress.sql pas lancé) : rien de coché.
  _store.progress = sp.error ? new Set() : new Set((sp.data || []).map((r) => r.event_uid));
  savePersonal();
  updateBell();
  subscribeRealtime();
}

async function refreshGoals() {
  if (!_store?.session) { _store.goals = []; return; }
  if (!_store.live) return;
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
  if (_sub || !_store?.session || !_store.live) return;
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
  // Un import écrit plusieurs lignes d'un coup -> une rafale d'événements temps réel.
  // On les regroupe : un seul refreshPersonal (8 requêtes) + un seul rendu par rafale.
  let persoTimer = null, persoBusy = false, persoAgain = false;
  const onPerso = () => {
    clearTimeout(persoTimer);
    persoTimer = setTimeout(async function run() {
      const wait = _quietUntil - Date.now();
      if (wait > 0) { persoTimer = setTimeout(run, wait); return; }
      if (persoBusy) { persoAgain = true; return; } // un rafraîchissement tourne déjà : on relancera après
      persoBusy = true;
      try { await refreshPersonal(); rerender(); }
      finally {
        persoBusy = false;
        if (persoAgain) { persoAgain = false; onPerso(); }
      }
    }, 400);
  };
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
    .on(pg, { event: "*", schema: "public", table: "cheat_meals" }, onPerso)
    .on(pg, { event: "*", schema: "public", table: "booking_requests" }, onPerso)
    .on(pg, { event: "*", schema: "public", table: "session_progress" }, onPerso)
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
      if (checking) await spawnNextRepeat(store, t);
      await refreshTodos(); rerender();
    });
    el.querySelector(".todo-del")?.addEventListener("click", async () => {
      if (el.dataset.busy) return;
      el.dataset.busy = "1";
      quiet(800);
      el.classList.add("is-leaving");
      await stage(200);
      deleteTodoWithUndo(id);
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
    const { error } = await store.sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href.split("#")[0] } }); // sans « # » final : sinon « ##access_token » et la connexion échoue
    msg.textContent = error ? "Erreur : " + error.message : "E-mail envoyé — tape le code ici (le lien, lui, s'ouvre dans le navigateur).";
    sfx(error ? "error" : "check");
    if (!error) {
      codeForm.hidden = false;
      document.getElementById("signin-code").focus();
    }
  });
  // Le lien magique ouvre le navigateur, pas l'app installée (PWA) : le code se tape directement ici.
  const codeForm = document.getElementById("signin-code-form");
  codeForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("signin-email").value.trim();
    const token = document.getElementById("signin-code").value.replace(/\D/g, "");
    if (!email || !token) return;
    msg.textContent = "Vérification…";
    const { error } = await store.sb.auth.verifyOtp({ email, token, type: "email" });
    if (error) { msg.textContent = "Code invalide ou expiré : " + error.message; sfx("error"); }
    // Succès : onAuthStateChange prend le relais et réaffiche la vue.
  });
}

// ---------- Édition : bouton +, feuille d'action, formulaires ----------
let fabEl = null;
function ensureFab() {
  if (fabEl) return fabEl;
  fabEl = document.createElement("button");
  fabEl.className = "fab"; fabEl.type = "button";
  fabEl.setAttribute("aria-label", "Nouvel événement");
  fabEl.innerHTML = `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg><span class="fab-l">Demander un créneau</span>`;
  fabEl.addEventListener("click", () => { if (_store?.session) openEventForm(); else if (guestMode()) openBookingForm(); });
  document.body.appendChild(fabEl);
  return fabEl;
}
function updateFab() {
  const f = ensureFab();
  const guest = guestMode();
  f.classList.toggle("is-show", (current === "today" || current === "week") && (!!_store?.session || guest));
  f.classList.toggle("is-guest", guest);
  f.setAttribute("aria-label", guest ? "Demander un créneau" : "Nouvel événement");
}

function openSheet(inner) {
  dropSheet();
  sfx("open");
  const ov = document.createElement("div");
  ov.className = "sheet-overlay"; ov.id = "sheet-ov";
  ov.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${inner}</div>`;
  ov.addEventListener("click", (e) => { if (e.target === ov) closeSheet(); });
  document.body.appendChild(ov);
  wireSheetDrag(ov);
  // Ouverte depuis un bloc qu'on vient de toucher : le bloc s'agrandit pour devenir la fiche.
  const src = canVT() && _tapSrc?.isConnected && Date.now() - _tapAt < 1500 && inViewport(_tapSrc) ? _tapSrc : null;
  _tapSrc = null;
  if (src) {
    const sheet = ov.querySelector(".sheet");
    ov._src = src;
    ov.classList.add("no-tr");
    src.style.viewTransitionName = "morph";
    const t = vt("sheet", () => {
      src.style.viewTransitionName = "";
      ov.classList.add("is-open");
      sheet.style.viewTransitionName = "morph";
    });
    const end = () => { sheet.style.viewTransitionName = ""; ov.classList.remove("no-tr"); };
    t.finished.then(end, end);
  } else {
    requestAnimationFrame(() => ov.classList.add("is-open"));
  }
  return ov;
}
// Tactile : tirer la fiche vers le bas la fait suivre le doigt ; lâchée assez bas (ou d'un geste
// vif), elle se ferme, sinon elle revient en place.
function wireSheetDrag(ov) {
  const sheet = ov.querySelector(".sheet");
  let g = null;
  const scrolled = (el) => { for (let n = el; n && n !== ov; n = n.parentElement) if (n.scrollTop > 0) return true; return false; };
  sheet.addEventListener("touchstart", (e) => {
    g = null;
    if (e.touches.length !== 1 || e.target.closest("input, textarea, select") || scrolled(e.target)) return;
    g = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: performance.now(), on: false, dy: 0 };
  }, { passive: true });
  sheet.addEventListener("touchmove", (e) => {
    if (!g) return;
    const dy = e.touches[0].clientY - g.y, dx = e.touches[0].clientX - g.x;
    if (!g.on) {
      if (dy < -8 || Math.abs(dx) > 14) { g = null; return; }
      if (dy < 8 || dy < Math.abs(dx) * 1.2) return;
      g.on = true;
      sheet.style.transition = "none"; ov.style.transition = "none";
    }
    if (e.cancelable) e.preventDefault();
    g.dy = Math.max(0, dy - 8);
    sheet.style.transform = `translateY(${g.dy}px)`;
    ov.style.backgroundColor = `rgba(0,0,0,${(0.5 * (1 - Math.min(1, g.dy / 420))).toFixed(3)})`;
  }, { passive: false });
  const end = () => {
    if (!g?.on) { g = null; return; }
    const fast = g.dy / Math.max(1, performance.now() - g.t) > 0.55 && g.dy > 36;
    const close = g.dy > Math.min(140, sheet.offsetHeight * 0.3) || fast;
    g = null;
    sheet.style.transition = ""; ov.style.transition = "";
    if (close) { closeSheet("drag"); return; }
    sheet.style.transform = ""; ov.style.backgroundColor = "";
  };
  sheet.addEventListener("touchend", end);
  sheet.addEventListener("touchcancel", end);
}
// Retire toute feuille sans animation (avant d'en ouvrir une autre).
function dropSheet() {
  if (document.documentElement.dataset.vt === "sheet-out") _vtCur?.skipTransition();
  document.querySelectorAll(".sheet-overlay").forEach((o) => o.remove());
}
// Ferme la feuille en la laissant redescendre. `how === "silent"` : pas de son de fermeture
// (l'action qui vient d'aboutir a déjà le sien). Sert aussi de gestionnaire de clic direct.
function closeSheet(how) {
  const ov = document.getElementById("sheet-ov");
  if (!ov) return;
  ov.removeAttribute("id");
  if (how !== "silent") sfx("close");
  // Fermeture simple : la fiche se replie dans le bloc d'où elle est sortie.
  const src = ov._src, sheet = ov.querySelector(".sheet");
  if (how === "drag") {
    // Lâchée en cours de glissement : elle finit sa course vers le bas depuis là où elle est.
    sheet.style.transition = "transform .22s cubic-bezier(.4,0,1,1)";
    sheet.style.transform = "translateY(calc(100% + 48px))";
    ov.style.backgroundColor = "";
    ov.classList.remove("is-open");
    ov.classList.add("is-closing");
    setTimeout(() => ov.remove(), 230);
    return;
  }
  if (how !== "silent" && src?.isConnected && canVT() && inViewport(src) && document.documentElement.dataset.vt !== "sheet") {
    sheet.style.viewTransitionName = "morph";
    const t = vt("sheet-out", () => { ov.remove(); src.style.viewTransitionName = "morph"; });
    const end = () => { src.style.viewTransitionName = ""; };
    t.finished.then(end, end);
    return;
  }
  ov.classList.remove("is-open");
  ov.classList.add("is-closing");
  setTimeout(() => ov.remove(), reduceMotion.matches ? 0 : 200);
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

function evWhen(ev) {
  const s = new Date(ev.start);
  const range = ev.end ? `${fmtTime.format(s)} – ${fmtTime.format(new Date(ev.end))}` : fmtTime.format(s);
  return `${cap(fmtWeekday.format(s))} · ${range}`;
}

// Met à jour un événement perso (optimiste) ; `undoLabel` ajoute un toast « Annuler ».
// Renvoie true si l'état voulu est en place (ou déjà en place), false si l'écriture a échoué.
async function updateCustomEvent(id, patch, { undoLabel } = {}) {
  const row = (_store.custom || []).find((c) => String(c.id) === String(id));
  if (!row) return false;
  const keys = Object.keys(patch);
  const same = (a, b) => {
    const ta = new Date(a).getTime(), tb = new Date(b).getTime();
    if (a != null && b != null && !Number.isNaN(ta) && !Number.isNaN(tb)) return ta === tb;
    return (a ?? null) === (b ?? null);
  };
  if (keys.every((k) => (k === "start_at" || k === "end_at") ? same(row[k], patch[k]) : (row[k] ?? null) === (patch[k] ?? null))) return true;
  const prev = {};
  for (const k of keys) prev[k] = row[k];
  Object.assign(row, patch);
  rerender();
  const { error } = await _store.sb.from("custom_events").update(patch).eq("id", id);
  if (error) {
    Object.assign(row, prev);
    rerender();
    oops("Modification impossible : " + error.message);
    return false;
  }
  if (undoLabel) toast(undoLabel, { action: "Annuler", ms: 5000, onAction: () => updateCustomEvent(id, prev) });
  return true;
}

function openEventForm(date, start, end, existing) {
  if (!_store?.session) return;
  const editing = !!existing;
  const d = editing ? dayKey(new Date(existing.start)) : (date || dayKey(new Date()));
  const st = editing ? fmtTime.format(new Date(existing.start)) : (start || "09:00");
  const en = editing ? fmtTime.format(new Date(existing.end || existing.start)) : (end || "10:00");
  const ov = openSheet(`
    <h3 class="sheet-h">${editing ? "Modifier" : "Nouvel événement"}</h3>
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
        <button type="submit" class="btn">${editing ? "Enregistrer" : "Ajouter"}</button>
      </div>
    </form>`);
  if (editing) {
    ov.querySelector("#ev-title").value = existing.title || "";
    ov.querySelector("#ev-loc").value = existing.location || "";
  }
  ov.querySelector("#ev-cancel").onclick = closeSheet;
  ov.querySelector("#ev-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = ov.querySelector("#ev-title").value.trim();
    if (!title) return;
    const dd = ov.querySelector("#ev-date").value;
    const start_at = parisToISO(dd, ov.querySelector("#ev-start").value);
    let end_at = parisToISO(dd, ov.querySelector("#ev-end").value);
    if (new Date(end_at) <= new Date(start_at)) {
      // « 00:00 » avant le début = minuit du lendemain ; autre fin invalide : pas de fin.
      end_at = ov.querySelector("#ev-end").value === "00:00" ? parisToISO(addDays(dd, 1), "00:00") : null;
    }
    const location = ov.querySelector("#ev-loc").value.trim() || null;
    if (editing) {
      closeSheet("silent");
      sfx("toggle");
      await updateCustomEvent(existing.cid, { title, start_at, end_at, location }, { undoLabel: "Événement modifié" });
      return;
    }
    const { error } = await _store.sb.from("custom_events").insert({ title, start_at, end_at, location });
    if (error) { oops("Ajout impossible : " + error.message); return; }
    sfx("add");
    closeSheet("silent"); await refreshPersonal(); rerender();
  });
  setTimeout(() => ov.querySelector("#ev-title")?.focus(), 50);
}

// Fiche « écarts » : série en cours, record, historique, ajout et suppression.
function openCheatSheet() {
  if (!_store?.session) return;
  const today = dayKey(now());
  const fmtShort = new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
  const jours = (n) => `${n} jour${n > 1 ? "s" : ""}`;
  const body = () => {
    const list = _store.cheats || [];
    const st = cheatStats(list.map((c) => c.day), today);
    const big = st.clean === null
      ? `<div class="cheat-big"><span>Aucun écart noté</span></div>`
      : `<div class="cheat-big"><b>${st.clean}</b><span>${st.clean > 1 ? "jours" : "jour"} clean</span></div>
         <p class="sheet-note">Record : ${jours(st.record)} · ${st.yearCount} écart${st.yearCount > 1 ? "s" : ""} en ${today.slice(0, 4)}</p>`;
    const rows = list.length
      ? `<ul class="cheat-list">${list.map((c) => `<li><span class="cheat-d">${esc(fmtShort.format(new Date(c.day + "T12:00:00Z")))}</span><span class="cheat-l">${c.label ? esc(c.label) : "—"}</span><button type="button" class="cheat-x" data-del="${esc(String(c.id))}" aria-label="Supprimer cet écart">${ico("i-x")}</button></li>`).join("")}</ul>`
      : "";
    return `${big}${rows}
      <form id="ch-form" class="sheet-form">
        <label>Quoi <span class="opt">(optionnel)</span><input id="ch-label" maxlength="80" autocomplete="off" placeholder="Ex. pizza, glace…"></label>
        <label>Jour<input id="ch-date" type="date" value="${today}" max="${today}" required></label>
        <div class="sheet-actions">
          <button type="button" class="btn btn-ghost" id="ch-close">Fermer</button>
          <button type="submit" class="btn">J'ai craqué</button>
        </div>
      </form>`;
  };
  const ov = openSheet(`<h3 class="sheet-h">Écarts</h3><div id="ch-body">${body()}</div>`);
  const box = ov.querySelector("#ch-body");
  const wire = () => {
    box.querySelector("#ch-close").onclick = closeSheet;
    box.querySelector("#ch-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const day = box.querySelector("#ch-date").value;
      if (!day || day > today) return;
      const label = box.querySelector("#ch-label").value.trim() || null;
      const btn = e.submitter || box.querySelector("#ch-form [type=submit]");
      if (btn?.disabled) return;
      if (btn) btn.disabled = true;
      const { error } = await _store.sb.from("cheat_meals").insert({ day, label });
      if (error) { if (btn) btn.disabled = false; oops("Ajout impossible : " + error.message); return; }
      sfx("add");
      await refreshPersonal();
      box.innerHTML = body(); wire(); rerender();
    });
    box.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
      const idx = _store.cheats.findIndex((c) => String(c.id) === b.dataset.del);
      if (idx < 0) return;
      const row = _store.cheats[idx];
      const key = String(row.id);
      const redraw = () => { if (box.isConnected) { box.innerHTML = body(); wire(); } rerender(); };
      deferDelete({
        label: "Écart supprimé",
        hide: () => { _cheatLeaving.add(key); _store.cheats = _store.cheats.filter((c) => String(c.id) !== key); redraw(); },
        restore: () => {
          _cheatLeaving.delete(key);
          if (!_store.cheats.some((c) => String(c.id) === key)) _store.cheats.splice(Math.min(idx, _store.cheats.length), 0, row);
          redraw();
        },
        commit: async () => {
          const { error } = await _store.sb.from("cheat_meals").delete().eq("id", row.id);
          _cheatLeaving.delete(key);
          redraw();
          if (error) { oops("Suppression impossible : " + error.message); return false; }
          return true;
        },
      });
    }));
  };
  wire();
}

// Même jour, mois suivant (31 jan. -> 28/29 fév.) — clé AAAA-MM-JJ.
const fmtMonShort = (key) => new Intl.DateTimeFormat("fr-FR", { timeZone: "UTC", month: "short" }).format(new Date(key + "T12:00:00Z"));
function addMonthKey(key, n = 1) {
  const [y, m, d] = key.split("-").map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  const x = new Date(Date.UTC(y, m - 1 + n, Math.min(d, last)));
  return x.toISOString().slice(0, 10);
}
const rebookPrefix = (ev) => `Reprendre RDV — ${ev.title}`;
const REBOOK_LEAD = 14; // on reprend RDV ~2 semaines avant la date visée

function openEventActions(ev) {
  if (!_store?.session) return;
  const head = `<h3 class="sheet-h">${esc(ev.title)}</h3><p class="sheet-sub">${evWhen(ev)}${(ev.location) ? " · " + esc(ev.location) : ""}</p>`;
  const isRem = (_store.reminders || new Set()).has(eventKey(ev));
  const remBtn = `<button class="btn btn-ghost rem-toggle${isRem ? " on" : ""}" id="s-rem">${ico("i-bell")}${isRem ? "Rappel activé" : "Ne pas oublier"}</button>`;
  const exam = isExam(ev);
  // Rendez-vous perso / importés : prochain RDV visé un mois après ; la tâche « reprendre RDV »
  // tombe REBOOK_LEAD jours avant, avec la date visée dans le titre.
  const rebookTarget = addMonthKey(dayKey(new Date(ev.start)));
  const rebookDue = addDays(rebookTarget, -REBOOK_LEAD);
  const rebookTitle = `${rebookPrefix(ev)} (pour le ${fmtWdDay.format(new Date(rebookTarget + "T12:00:00Z"))} ${fmtMonShort(rebookTarget)})`;
  const rebookTodo = (_store.todos || []).find((t) => !t.done && t.title.startsWith(rebookPrefix(ev)));
  const rebookBtn = ev.source === "course" ? "" : rebookTodo
    ? `<button class="btn btn-ghost rem-toggle on" id="s-rebook" disabled>${ico("i-check")}Rappel prévu · ${esc(dueLabel(rebookTodo.due_date))}</button>`
    : `<button class="btn btn-ghost" id="s-rebook">${ico("i-today")}Reprendre RDV dans 1 mois</button>`;
  const moodle = ev.source === "course" ? moodleUrl(ev) : null;
  const moodleBtn = (moodle ? `<a class="btn btn-ghost" href="${moodle}" target="_blank" rel="noopener">${ico("i-ext")}Espace Moodle</a>` : "")
    + (signState(ev) === "open" ? signLink(ev, "btn") : "");
  const signSt = signState(ev);
  const signNote = signSt === "present" ? `<p class="sheet-note sign-note is-ok">${ico("i-check")}Signé sur SoWeSign.</p>`
    : signSt === "absent" ? `<p class="sheet-note sign-note is-bad">${ico("i-alert")}Pas signé : SoWeSign te compte absent.</p>`
    : signSt === "pending" ? `<p class="sheet-note sign-note">Statut SoWeSign pas encore synchronisé.</p>` : "";
  const examBtn = (ev.source === "course" ? `<button class="btn btn-ghost exam-toggle${exam ? " on" : ""}" id="s-exam">${ico("i-alert")}${exam ? "Ce n'est pas un examen" : "Marquer comme examen"}</button>` : "") + moodleBtn;

  if (ev.source === "perso") {
    const ov = openSheet(`${head}<div class="sheet-tools">${remBtn}${rebookBtn}</div><div class="sheet-actions">
      <button class="btn btn-ghost" id="s-close">Fermer</button>
      <button class="btn btn-ghost" id="s-edit">Modifier</button>
      <button class="btn btn-danger" id="s-del">Supprimer</button></div>`);
    ov.querySelector("#s-close").onclick = closeSheet;
    ov.querySelector("#s-edit").onclick = () => { closeSheet("silent"); openEventForm(null, null, null, ev); };
    ov.querySelector("#s-del").onclick = () => {
      closeSheet("silent");
      const idx = _store.custom.findIndex((c) => String(c.id) === String(ev.cid));
      if (idx < 0) return;
      const row = _store.custom[idx];
      const key = String(row.id);
      deferDelete({
        label: "Événement supprimé",
        hide: () => { _customLeaving.add(key); _store.custom = _store.custom.filter((c) => String(c.id) !== key); rerender(); },
        restore: () => {
          _customLeaving.delete(key);
          if (!_store.custom.some((c) => String(c.id) === key)) _store.custom.splice(Math.min(idx, _store.custom.length), 0, row);
          rerender();
        },
        commit: async () => {
          const { error } = await _store.sb.from("custom_events").delete().eq("id", row.id);
          _customLeaving.delete(key);
          rerender();
          if (error) { oops("Suppression impossible : " + error.message); return false; }
          return true;
        },
      });
    };
  } else if (ev.source === "course") {
    if (ev._hidden) {
      const ov = openSheet(`${head}<p class="sheet-note">Tu as marqué « je n'y vais pas » pour ce cours.</p>
        <div class="sheet-tools">${remBtn}${examBtn}</div><div class="sheet-actions"><button class="btn btn-ghost" id="s-close">Fermer</button>
        <button class="btn" id="s-show">Y retourner</button></div>`);
      ov.querySelector("#s-close").onclick = closeSheet;
      ov.querySelector("#s-show").onclick = async () => {
        const { error } = await _store.sb.from("event_overrides").delete().eq("event_uid", ev.uid);
        if (error) { oops("Erreur : " + error.message); return; }
        sfx("toggle");
        closeSheet("silent"); await refreshPersonal(); rerender();
      };
    } else {
      const ov = openSheet(`${head}${signNote}<div class="sheet-tools">${remBtn}${examBtn}</div><div class="sheet-actions"><button class="btn btn-ghost" id="s-close">Fermer</button>
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
    const ov = openSheet(`${head}<p class="sheet-note">${ev._hidden ? "Tu as retiré cet événement du Hub (il reste dans ton agenda d'origine)." : note}</p>
      <div class="sheet-tools">${remBtn}${rebookBtn}</div><div class="sheet-actions"><button class="btn btn-ghost" id="s-close">Fermer</button>
      ${ev._hidden ? `<button class="btn" id="s-show">Réafficher</button>` : `<button class="btn btn-danger" id="s-hide">Retirer du Hub</button>`}</div>`);
    ov.querySelector("#s-close").onclick = closeSheet;
    // Retiré côté Hub seulement (event_overrides) : le prochain import ne le fait pas réapparaître.
    ov.querySelector("#s-hide")?.addEventListener("click", async () => {
      const { error } = await _store.sb.from("event_overrides")
        .upsert({ user_id: _store.session.user.id, event_uid: ev.tid, hidden: true }, { onConflict: "user_id,event_uid" });
      if (error) { oops("Erreur : " + error.message); return; }
      sfx("del");
      closeSheet("silent"); await refreshPersonal(); rerender();
    });
    ov.querySelector("#s-show")?.addEventListener("click", async () => {
      const { error } = await _store.sb.from("event_overrides").delete().eq("event_uid", ev.tid);
      if (error) { oops("Erreur : " + error.message); return; }
      sfx("toggle");
      closeSheet("silent"); await refreshPersonal(); rerender();
    });
  }
  document.getElementById("s-rem")?.addEventListener("click", async () => { await toggleReminder(ev); closeSheet("silent"); rerender(); });
  document.getElementById("s-exam")?.addEventListener("click", async () => { await toggleExam(ev); closeSheet("silent"); rerender(); });
  document.getElementById("s-rebook")?.addEventListener("click", async () => {
    const { error } = await _store.sb.from("todos").insert({ title: rebookTitle, due_date: rebookDue });
    if (error) { oops("Ajout impossible : " + error.message); return; }
    sfx("add");
    closeSheet("silent"); await refreshTodos(); rerender();
  });
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

const _todoLeaving = new Set(); // ids de tâches supprimées mais encore annulables

function deleteTodoWithUndo(id) {
  const key = String(id);
  const row = _store?.todos.find((t) => String(t.id) === key);
  if (!row) return;
  deferDelete({
    label: "Tâche supprimée",
    hide: () => { _todoLeaving.add(key); _store.todos = _store.todos.filter((t) => t !== row); rerender(); },
    restore: () => {
      _todoLeaving.delete(key);
      if (!_store.todos.some((t) => String(t.id) === key)) _store.todos.push(row);
      rerender();
    },
    commit: async () => {
      const { error } = await _store.sb.from("todos").delete().eq("id", id);
      _todoLeaving.delete(key);
      if (error) { oops("Suppression impossible : " + error.message); return false; }
      return true;
    },
  });
}

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
      <div class="ts-field"><span class="ts-lab">Répéter</span><div class="tag-pick" id="ts-rep">${repeatPickHtml(null)}</div></div>
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
    ov.querySelectorAll("#ts-rep .tg-opt").forEach((b) => b.classList.toggle("on", b.dataset.rep === (t.repeat || "")));
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
  ov.querySelectorAll("#ts-rep .tg-opt").forEach((b) => b.addEventListener("click", async () => {
    const t = cur(); const rep = b.dataset.rep || null;
    if ((t.repeat || null) === rep) return;
    const patch = { repeat: rep };
    if (rep && !t.due_date) patch.due_date = dayKey(now()); // une récurrence a besoin d'une date de départ
    await updateTodo(id, patch); paint(); rerender();
  }));
  ov.querySelector("#ts-close").onclick = () => { closeSheet(); rerender(); };
  ov.querySelector("#ts-del").onclick = () => { closeSheet("silent"); deleteTodoWithUndo(id); };
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
      <div class="ts-field"><span class="ts-lab">Répéter</span><div class="tag-pick" id="ta-rep">${repeatPickHtml(null)}</div></div>
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
  let taRep = null;
  ov.querySelectorAll("#ta-rep .tg-opt").forEach((b) => b.addEventListener("click", () => {
    taRep = b.dataset.rep || null;
    ov.querySelectorAll("#ta-rep .tg-opt").forEach((x) => x.classList.toggle("on", x === b));
  }));
  ov.querySelector("#ta-cancel").onclick = closeSheet;
  ov.querySelector("#ta-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = ov.querySelector("#ta-title").value.trim();
    if (!title) return;
    let due_date = ov.querySelector("#ta-date").value || null;
    const row = { title, due_date, tag: taTag };
    if (taRep) { row.repeat = taRep; row.due_date = due_date || dayKey(now()); } // colonne envoyée seulement si utilisée
    quiet(1500);
    const { error } = await _store.sb.from("todos").insert(row);
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

// ---------- Page Cours : suis-je à jour ? ----------
// Chaque cours (regroupé par titre) liste ses séances ; on coche celles qu'on a rattrapées / revues.
// Une séance passée non cochée = retard. Les examens (DE ou corrigés à la main) sont des repères.
const COURSE_SKIP = new Set(["IE", "LXP"]); // amphis, forums, événements : pas des cours à suivre
const ACT_LABEL = { CM: "Cours magistral", CTD: "Cours · TD", CTP: "Cours · TP", TD: "TD", TP: "TP", TPA: "TP encadré", PRJ: "Projet", DE: "Examen" };
const fmtSessDay = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
const _coursesOpen = new Set(); // cours dépliés (survit au re-rendu)
// Matières pas encore commencées : masquées par défaut, réaffichables (choix gardé sur l'appareil).
let _showUpcomingCourses = (() => { try { return localStorage.getItem("hub.coursesUpcoming") === "1"; } catch { return false; } })();

function courseList() {
  // Historique (courses.json) + planning du moment : planning.json peut être plus récent.
  const byUid = new Map();
  for (const e of (COURSES?.sessions || [])) byUid.set(e.uid, e);
  for (const e of (PLANNING?.events || [])) byUid.set(e.uid, e);
  const groups = new Map();
  for (const e of byUid.values()) {
    if (!e.start || COURSE_SKIP.has(e.activity)) continue;
    const t = (e.title || "").trim();
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(e);
  }
  const N = now();
  const done = _store?.progress || new Set();
  const out = [];
  for (const [title, list] of groups) {
    list.sort((a, b) => a.start.localeCompare(b.start));
    const sessions = list.map((e) => ({ ...e, exam: isExam({ ...e, source: "course" }), past: new Date(e.start) <= N, done: done.has(e.uid) }));
    const lessons = sessions.filter((s) => !s.exam);
    if (!lessons.length) continue; // un examen seul n'est pas un cours à suivre
    const past = lessons.filter((s) => s.past).length;
    const late = lessons.filter((s) => s.past && !s.done).length;
    const next = sessions.find((s) => !s.past);
    out.push({ title, sessions, total: lessons.length, past, late, next });
  }
  // En retard d'abord (le plus de retard en tête), puis à jour, puis pas encore commencés.
  const rank = (c) => (c.late ? 0 : c.past ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || b.late - a.late || a.title.localeCompare(b.title, "fr"));
}

function courseCard(c, signed) {
  const status = !c.past ? `<span class="cr-pill is-soon">Pas commencé</span>`
    : c.late ? `<span class="cr-pill is-late">${c.late} en retard</span>`
    : `<span class="cr-pill is-ok">${ico("i-check")}À jour</span>`;
  const pct = c.past ? Math.round(((c.past - c.late) / c.past) * 100) : 0;
  const nextTxt = c.next ? `Prochaine : ${fmtSessDay.format(new Date(c.next.start))}${c.next.exam ? " · examen" : ""}` : "Terminé";
  const pl = c.past > 1 ? "s" : "";
  let n = 0;
  const rows = c.sessions.map((s) => {
    const d = new Date(s.start), end = s.end ? new Date(s.end) : null;
    const when = `<span class="cr-d">${cap(fmtSessDay.format(d))}</span><span class="cr-hr">${fmtTime.format(d)}${end ? "–" + fmtTime.format(end) : ""}</span>`;
    if (s.exam) return `<li class="cr-s is-exam${s.past ? " is-past" : ""}"><span class="cr-ex">${ico("i-alert", "")}</span><span class="cr-n"></span><span class="cr-w">${when}</span><span class="cr-a">Examen</span></li>`;
    n++;
    const cls = ["cr-s", s.done && "is-done", s.past ? "is-past" : "is-future", s.past && !s.done && "is-late"].filter(Boolean).join(" ");
    return `<li class="${cls}"><button class="cr-chk" type="button" data-sess="${esc(s.uid)}" aria-pressed="${s.done}"${signed ? "" : " disabled"} aria-label="Séance ${n} du ${esc(fmtSessDay.format(d))}"><span class="check">${ico("i-check", "")}</span></button><span class="cr-n">${n}</span><span class="cr-w">${when}</span><span class="cr-a">${esc(ACT_LABEL[s.activity] || s.activity || "")}</span></li>`;
  }).join("");
  const bulk = signed && c.late ? `<button class="btn btn-ghost cr-bulk" type="button" data-catchup="${esc(c.title)}">${ico("i-check")}Tout marquer à jour jusqu'à aujourd'hui</button>` : "";
  return `<details class="panel cr${c.late ? " has-late" : ""}" data-course="${esc(c.title)}"${_coursesOpen.has(c.title) ? " open" : ""}>
    <summary class="cr-h0">
      <span class="cr-top"><span class="cr-t">${esc(c.title)}</span>${status}</span>
      <span class="cr-bar" aria-hidden="true"><i style="width:${pct}%"></i></span>
      <span class="cr-meta"><span>${c.past - c.late}/${c.past} séance${pl} passée${pl} revue${pl} · ${c.total} au total</span><span>${nextTxt}</span></span>
    </summary>
    <ol class="cr-list">${rows}</ol>${bulk}
  </details>`;
}

function renderCourses() {
  titleEl.textContent = "Cours";
  if (!COURSES && !PLANNING) {
    dateEl.textContent = "Séances";
    viewEl.innerHTML = `<div class="note">${illus("art-offline")}<h3>Cours indisponibles</h3><p>Pas de réseau et aucune copie en cache pour l'instant.</p></div>`;
    return;
  }
  const signed = !!_store?.session;
  const list = courseList();
  const lateCourses = list.filter((c) => c.late).length;
  const lateTotal = list.reduce((s, c) => s + c.late, 0);
  dateEl.textContent = "Séances";
  const summary = list.some((c) => c.past)
    ? `<div class="cr-sum ${lateCourses ? "is-late" : "is-ok"}">${ico(lateCourses ? "i-alert" : "i-check")}<span>${lateCourses
        ? `<b>${lateTotal} séance${lateTotal > 1 ? "s" : ""} à rattraper</b> sur ${lateCourses} cours`
        : `<b>Tu es à jour</b> sur tous tes cours`}</span></div>` : "";
  const signNote = SUPA_READY && !signed && (_store || _storeTried)
    ? `<p class="cr-sign">Connecte-toi (onglet À faire) pour cocher les séances revues.</p>` : "";
  const started = list.filter((c) => c.past), upcoming = list.filter((c) => !c.past);
  const shown = _showUpcomingCourses ? list : started;
  const toggle = upcoming.length
    ? `<button class="btn btn-ghost cr-more" type="button" id="cr-more" aria-expanded="${_showUpcomingCourses}">${_showUpcomingCourses
        ? `Masquer les matières pas encore commencées`
        : `Afficher ${upcoming.length} matière${upcoming.length > 1 ? "s" : ""} pas encore commencée${upcoming.length > 1 ? "s" : ""}`}</button>` : "";
  viewEl.innerHTML = `${summary}${signNote}<div class="cr-grid">${shown.map((c) => courseCard(c, signed)).join("")}</div>${toggle}`;
  viewEl.querySelector("#cr-more")?.addEventListener("click", () => {
    _showUpcomingCourses = !_showUpcomingCourses;
    try { localStorage.setItem("hub.coursesUpcoming", _showUpcomingCourses ? "1" : "0"); } catch {}
    sfx("toggle"); rerender();
  });

  viewEl.querySelectorAll("details.cr").forEach((d) => d.addEventListener("toggle", () => {
    if (d.open) _coursesOpen.add(d.dataset.course); else _coursesOpen.delete(d.dataset.course);
  }));
  viewEl.querySelectorAll("[data-sess]").forEach((b) => b.addEventListener("click", () => toggleSessionDone(b.dataset.sess)));
  viewEl.querySelectorAll("[data-catchup]").forEach((b) => b.addEventListener("click", () => catchUpCourse(b.dataset.catchup)));
  if (SUPA_READY && !_store && !_storeTried) {
    _storeTried = true;
    getStore().then(() => { if (current === "courses") rerender(); });
  }
}

// Cocher / décocher une séance. Optimiste + persistance Supabase.
async function toggleSessionDone(uid) {
  const store = await getStore();
  if (!store?.session) return;
  const had = store.progress.has(uid);
  if (had) store.progress.delete(uid); else store.progress.add(uid);
  sfx("toggle"); quiet(1200); rerender();
  const { error } = had
    ? await store.sb.from("session_progress").delete().eq("event_uid", uid)
    : await store.sb.from("session_progress").upsert({ user_id: store.session.user.id, event_uid: uid }, { onConflict: "user_id,event_uid", ignoreDuplicates: true });
  if (error) {
    if (had) store.progress.add(uid); else store.progress.delete(uid);
    rerender(); oops("Impossible : " + error.message + "\n(As-tu lancé session-progress.sql ?)");
  } else savePersonal();
}

// « Tout marquer à jour » : coche toutes les séances passées d'un cours.
async function catchUpCourse(title) {
  const store = await getStore();
  if (!store?.session) return;
  const c = courseList().find((x) => x.title === title);
  const uids = (c?.sessions || []).filter((s) => !s.exam && s.past && !s.done).map((s) => s.uid);
  if (!uids.length) return;
  uids.forEach((u) => store.progress.add(u));
  sfx("toggle"); quiet(1500); rerender();
  const rows = uids.map((event_uid) => ({ user_id: store.session.user.id, event_uid }));
  const { error } = await store.sb.from("session_progress").upsert(rows, { onConflict: "user_id,event_uid", ignoreDuplicates: true });
  if (error) {
    uids.forEach((u) => store.progress.delete(u));
    rerender(); oops("Impossible : " + error.message + "\n(As-tu lancé session-progress.sql ?)");
  } else savePersonal();
}

// ---------- Navigation ----------
function rerender() {
  viewEl.dataset.view = current;
  if (current === "today") renderToday();
  else if (current === "week") renderWeek();
  else if (current === "courses") renderCourses();
  else renderTasks();
  updateFab();
  updateBell();
  if (_entering) { _entering = false; countUp(viewEl); }
}

document.getElementById("notif-bell")?.addEventListener("click", openChangesSheet);

// Raccourcis clavier (ordinateur) : 1/2/3/4 = onglets, ← → = semaine précédente/suivante,
// T = revenir à cette semaine, N = nouvelle tâche. Ignorés pendant la saisie ou sur une fiche ouverte.
document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  if (document.getElementById("sheet-ov")) return;
  const tab = (v) => document.querySelector(`.tab[data-view="${v}"]`)?.click();
  const k = e.key;
  if (k >= "1" && k <= String(TAB_ORDER.length) && k.length === 1) { e.preventDefault(); tab(TAB_ORDER[+k - 1]); return; }
  if (current === "week" && (k === "ArrowLeft" || k === "ArrowRight" || k === "t" || k === "T")) {
    e.preventDefault();
    const before = weekOffset;
    weekOffset = (k === "t" || k === "T") ? 0 : weekOffset + (k === "ArrowLeft" ? -1 : 1);
    weekDay = -1;
    if (weekOffset === before) renderWeek();
    else vt("week", renderWeek, weekOffset > before ? 1 : -1);
    return;
  }
  if (k === "n" || k === "N") {
    if (!_store?.session) return;
    e.preventDefault();
    if (current !== "today") tab("today");
    requestAnimationFrame(() => document.getElementById("cap-input")?.focus());
  }
});

const TAB_ORDER = ["today", "week", "courses", "tasks"];
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
      sfx("tab");
      _entering = true;
      // Arrivée par balayage : la vue a déjà suivi le doigt, la nouvelle entre simplement.
      if (canVT() && !_swipeNav) { vt("view", rerender, to > from ? 1 : -1); return; }
      viewEl.style.setProperty("--view-dir", to > from ? 1 : -1);
      viewEl.classList.remove("view-enter");
      void viewEl.offsetWidth;
      viewEl.classList.add("view-enter");
    }
    rerender();
  });
});

// ---------- Gestes tactiles : balayer à l'horizontale ----------
// Aujourd'hui / À faire : onglet voisin. Semaine : jour voisin (mobile) ou semaine voisine (grille).
// La zone suit le doigt ; au bord (rien de ce côté) elle résiste et revient.
let _swipeNav = false;
(() => {
  let g = null;
  const hScroll = (el) => {
    for (let n = el; n && n !== viewEl; n = n.parentElement) {
      if (n.scrollWidth > n.clientWidth + 4 && /auto|scroll/.test(getComputedStyle(n).overflowX)) return true;
    }
    return false;
  };
  const plan = () => {
    const i = TAB_ORDER.indexOf(current);
    if (current !== "week") return { el: viewEl, prev: i > 0, next: i < TAB_ORDER.length - 1, go: (dir) => {
      _swipeNav = true;
      try { document.querySelector(`.tab[data-view="${TAB_ORDER[i + dir]}"]`)?.click(); } finally { _swipeNav = false; }
    } };
    const el = viewEl.querySelector(".cal") || viewEl;
    return { el, prev: true, next: true, go: (dir) => {
      weekSlide = dir * 22;
      if (desktop()) { weekOffset += dir; weekDay = -1; }
      else {
        const n = _weekSel + dir;
        if (n < 0) { weekOffset -= 1; weekDay = 6; } else if (n > 6) { weekOffset += 1; weekDay = 0; } else weekDay = n;
      }
      renderWeek();
    } };
  };
  const reset = (el) => { el.style.transition = ""; el.style.transform = ""; el.style.opacity = ""; };
  viewEl.addEventListener("touchstart", (e) => {
    g = null;
    if (e.touches.length !== 1 || document.getElementById("sheet-ov")) return;
    const t = e.target;
    if (!(t instanceof Element) || t.closest("input, textarea, select, .ev.src-perso") || hScroll(t)) return;
    g = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: performance.now(), on: false, dx: 0 };
  }, { passive: true });
  viewEl.addEventListener("touchmove", (e) => {
    if (!g) return;
    const dx = e.touches[0].clientX - g.x, dy = e.touches[0].clientY - g.y;
    if (!g.on) {
      if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) { g = null; return; }
      if (Math.abs(dx) < 12 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (_drag?.active) { g = null; return; }
      g.on = true; g.p = plan();
      g.p.el.style.transition = "none";
    }
    if (e.cancelable) e.preventDefault();
    const d = dx - Math.sign(dx) * 12;
    g.can = d < 0 ? g.p.next : g.p.prev;
    g.dx = g.can ? d : d * 0.2;
    g.p.el.style.transform = `translateX(${g.dx.toFixed(1)}px)`;
    g.p.el.style.opacity = String(1 - Math.min(0.45, Math.abs(g.dx) / 520));
  }, { passive: false });
  const end = () => {
    const s = g; g = null;
    if (!s?.on) return;
    const { el, go } = s.p, dist = Math.abs(s.dx);
    const fast = dist / Math.max(1, performance.now() - s.t) > 0.4 && dist > 24;
    if (!s.can || !(dist > 72 || fast)) {
      el.style.transition = "transform .32s cubic-bezier(.16,1,.3,1), opacity .32s";
      el.style.transform = ""; el.style.opacity = "";
      setTimeout(() => { el.style.transition = ""; }, 340);
      return;
    }
    const dir = s.dx < 0 ? 1 : -1;
    el.style.transition = "transform .12s cubic-bezier(.4,0,1,1), opacity .12s";
    el.style.transform = `translateX(${-dir * 34}%)`; el.style.opacity = "0";
    setTimeout(() => { reset(el); go(dir); }, reduceMotion.matches ? 0 : 120);
  };
  viewEl.addEventListener("touchend", end);
  viewEl.addEventListener("touchcancel", end);
})();

// Bascule liste/grille de la vue Semaine au redimensionnement
let _rsz;
window.addEventListener("resize", () => { clearTimeout(_rsz); _rsz = setTimeout(() => { if (current === "week") renderWeek(); }, 200); });

// ---------- Thème (clair / sombre) ----------
// Sombre par défaut (quel que soit le système). Dès que l'utilisateur bascule, on garde son choix
// (data-theme sur <html>) et on le mémorise par appareil (localStorage).
const THEME_KEY = "hub-theme";
const themeMeta = document.querySelector('meta[name="theme-color"]');
const themeIcon = document.getElementById("theme-icon");
const themeBtn = document.getElementById("theme-toggle");
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
const storedTheme = () => { try { return localStorage.getItem(THEME_KEY); } catch { return null; } };
// Thème réellement affiché : choix mémorisé, sinon sombre.
const effectiveTheme = () => storedTheme() || "dark";
function syncThemeUI() {
  const dark = effectiveTheme() === "dark";
  // On propose l'inverse : lune pour passer au clair… non : lune = sombre actif.
  themeIcon?.setAttribute("href", dark ? "#i-moon" : "#i-sun");
  themeBtn?.setAttribute("aria-label", dark ? "Passer au thème clair" : "Passer au thème sombre");
  themeMeta?.setAttribute("content", dark ? "#0D1013" : "#F1F3F5");
}
themeBtn?.addEventListener("click", () => {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  const apply = () => {
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch {}
    syncThemeUI();
  };
  // Le nouveau thème s'ouvre en cercle depuis le bouton.
  const r = themeBtn.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
  const st = document.documentElement.style;
  st.setProperty("--tx", `${x}px`); st.setProperty("--ty", `${y}px`);
  st.setProperty("--tr", `${Math.ceil(Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y)))}px`);
  vt("theme", apply);
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
// Au lever de l'écran d'entrée (index.html) : les cartes arrivent en cascade, les compteurs défilent.
window.addEventListener("hub-intro-lift", () => {
  viewEl.classList.add("cascade");
  setTimeout(() => viewEl.classList.remove("cascade"), 900);
  countUp(viewEl);
}, { once: true });
seedStore();
if (_store?.session) { _storeTried = true; getStore().then(() => rerender()); }
await Promise.all([loadPlanning(), loadAlternance(), loadTraining(), loadChanges(), loadCourses()]);
rerender();
// Rafraîchit l'état "en cours / prochain" et les changements quand on revient sur l'app
document.addEventListener("visibilitychange", () => { if (!document.hidden) { Promise.all([loadPlanning(), loadChanges(), loadCourses()]).then(rerender); } });

// Service worker (PWA installable + hors-ligne)
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
