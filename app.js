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

const dayKey = (d) => fmtDayKey.format(d);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ico = (id, cls = "mi") => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
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
const SRC_LABEL = { course: "Cours", perso: "Perso", fl: "Pro", ef: "École" };
const normCustom = (c) => ({ source: "perso", cid: c.id, title: c.title, start: c.start_at, end: c.end_at, location: c.location, rooms: [], teacher: null });
const normTeams = (t) => ({ source: t.source === "efrei" ? "ef" : "fl", tid: t.id, title: t.title, start: t.start_at, end: t.end_at, location: t.location, rooms: [], teacher: null });

const viewEl = document.getElementById("view");
const titleEl = document.getElementById("top-title");
const dateEl = document.getElementById("top-date");
const liveEl = document.getElementById("live");
const liveTimeEl = document.getElementById("live-time");

let PLANNING = null;        // { generatedAt, events: [...] }
let ALT = null;             // alternance : { start, end, schoolSet, sgHours }
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

// ---------- Vue Aujourd'hui ----------
function renderToday() {
  titleEl.textContent = "Aujourd'hui";
  const now = new Date();
  dateEl.textContent = cap(fmtDayLabel.format(now));
  const todays = mergedEventsForDay(dayKey(now));

  let html = "";
  const tb = modeBadge(dayKey(now));
  if (tb) html += `<div class="daymode">${tb}</div>`;
  if (!PLANNING) {
    html += `<div class="note"><h3>Planning indisponible</h3><p>Pas de réseau et aucune copie en cache pour l'instant.</p></div>`;
  } else if (todays.length === 0) {
    html += `<div class="note"><h3>Rien de prévu aujourd'hui</h3><p>Journée libre${_store?.session ? " — touche ＋ pour ajouter un événement." : "."}</p></div>`;
  } else {
    const curIdx = todays.findIndex((e) => new Date(e.start) <= now && now < new Date(e.end || e.start));
    const nextIdx = todays.findIndex((e) => new Date(e.start) > now);
    const featIdx = curIdx !== -1 ? curIdx : (nextIdx !== -1 ? nextIdx : -1);

    if (featIdx !== -1) {
      const ev = todays[featIdx];
      const isNow = curIdx !== -1;
      html += `<section class="card card-now src-${ev.source}" ${evAttrs(ev)}>
        <div class="now-head"><span class="dot"></span>${isNow ? "En cours" : "À suivre"}${ev.source !== "course" ? ` · ${SRC_LABEL[ev.source]}` : ""}</div>
        <div class="now-time">${fmtTime.format(new Date(ev.start))} <small>→ ${ev.end ? fmtTime.format(new Date(ev.end)) : ""}</small></div>
        <div class="now-title">${esc(ev.title)}</div>
        ${courseMeta(ev, { big: true })}
      </section>`;
      const rest = todays.filter((_, i) => i !== featIdx);
      if (rest.length) {
        html += `<p class="section-label">Reste de la journée</p><div class="card">${rest.map((e) => courseRow(e, now)).join("")}</div>`;
      }
    } else {
      html += `<p class="section-label">Journée terminée</p><div class="card">${todays.map((e) => courseRow(e, now)).join("")}</div>`;
    }
  }

  // Tâches du jour (si la to-do est configurée)
  html += `<div id="today-tasks"></div>`;
  viewEl.innerHTML = html;
  wireEventTaps(viewEl);
  updateFab();
  if (SUPA_READY) renderTodayTasks();
}

async function renderTodayTasks() {
  const mount = document.getElementById("today-tasks");
  if (!mount) return;
  const store = await getStore();
  if (!store?.session) return; // non connecté : on ne pollue pas la vue Aujourd'hui
  const todayK = dayKey(new Date());
  const open = store.todos.filter((t) => !t.done && (!t.due_date || t.due_date <= todayK));
  if (!open.length) return;
  const shown = open.slice(0, 3);
  mount.innerHTML = `<p class="section-label">À faire aujourd'hui${open.length > 3 ? ` · ${open.length}` : ""}</p>
    <div class="today-tasks">${shown.map(todoRow).join("")}</div>`;
  wireTodos(mount, store);
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
      let lane = 0; while (lane < laneEnds.length && laneEnds[lane] > ev.s) lane++;
      if (lane === laneEnds.length) laneEnds.push(ev.e2); else laneEnds[lane] = ev.e2;
      ev.lane = lane;
    }
    for (const ev of cl) ev.cols = laneEnds.length;
  }
  return evs;
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
      <div class="note"><h3>Rien à afficher</h3><p>Planning indisponible.</p></div></div>`;
    wireWeekNav(); return;
  }

  // Une seule passe de positionnement, réutilisée pour les stats, la légende et la grille.
  const perDay = days.map((d) => packDay(mergedEventsForDay(d.key).map((e) => ({
    ...e, s: parisMinutes(e.start), e2: e.end ? parisMinutes(e.end) : parisMinutes(e.start) + 60,
  }))));
  const todayIdx = days.findIndex((d) => d.key === dayKey(new Date()));
  const sel = weekDay >= 0 ? weekDay : (todayIdx >= 0 ? todayIdx : 0);

  const bar = `<div class="wk-bar">${weekNav(days)}${weekStats(perDay)}<div class="wk-spacer"></div>${weekLegend(perDay, days)}</div>`;
  viewEl.innerHTML = `<div class="wk">${bar}${weekTools(days)}${weekPills(days, sel)}${weekGrid(days, perDay, sel)}</div>`;

  wireWeekNav();
  viewEl.querySelector("#toggle-hidden")?.addEventListener("click", () => { showHidden = !showHidden; renderWeek(); });
  viewEl.querySelector("#toggle-sg")?.addEventListener("click", () => { sgOn = !sgOn; renderWeek(); });
  wirePills();
  wireEventTaps(viewEl);
  updateFab();
  weekSlide = 0;
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

const SRC_ICON = { course: "i-cap", perso: "i-user", fl: "i-brief", ef: "i-brief" };

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
      <div class="cd">${wd(d.date)}</div><div class="cn num">${fmtDayNum.format(d.date)}</div>${modeBadge(d.key, { compact: true })}</div>`;
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
      return `<div class="ev src-${ev.source}${size}${ev._hidden ? " is-hidden" : ""}" ${evAttrs(ev)} title="${esc(ev.title)}" style="top:${yTop(ev.s)}px;height:${height}px;left:calc(${left}% + 4px);width:calc(${w}% - 8px);animation-delay:${j * 32}ms">
        <div class="ev-hd">${ico(SRC_ICON[ev.source] || "i-cap")}<span class="ev-t mono">${range}</span></div>
        <div class="ev-ti">${esc(ev.title)}</div>
        ${loc ? `<div class="ev-lo">${ico("i-pin")}<span>${esc(loc)}</span></div>` : ""}
      </div>`;
    }).join("");
    const now = showNow ? `<div class="cal-now" style="top:${yTop(nowMin)}px"><span class="cal-now-ln"></span><span class="cal-now-dot"></span><span class="cal-now-lab mono">${fmtTime.format(new Date())}</span></div>` : "";
    return `<div class="cal-col${t ? " is-today" : ""}${we ? " we" : ""}${hide}">${sgBands(d.key)}${slots}${blocks}${now}</div>`;
  }).join("");

  return `<div class="cal" style="--cal-px:${PX}px;--slide-dir:${weekSlide}px"><div class="cal-head">${head}</div><div class="cal-body">${axis}${cols}</div></div>`;
}

// ---------- Vue À faire ----------
async function renderTasks() {
  titleEl.textContent = "À faire";
  dateEl.textContent = "Tâches";
  if (!SUPA_READY) { viewEl.innerHTML = setupNote(); return; }

  const store = await getStore();
  if (!store) { viewEl.innerHTML = `<div class="note"><h3>Connexion impossible</h3><p>Impossible de joindre Supabase. Réessaie quand tu as du réseau.</p></div>`; return; }

  if (!store.session) { viewEl.innerHTML = signInView(); wireSignIn(store); return; }

  const todayK = dayKey(new Date());
  const todos = store.todos;
  const late = todos.filter((t) => !t.done && t.due_date && t.due_date < todayK);
  const today = todos.filter((t) => !t.done && (!t.due_date || t.due_date === todayK));
  const upcoming = todos.filter((t) => !t.done && t.due_date && t.due_date > todayK)
    .sort((a, b) => a.due_date.localeCompare(b.due_date));
  const done = todos.filter((t) => t.done).slice(-30).reverse();

  const section = (label, list, cls = "") => list.length
    ? `<p class="section-label${cls ? " " + cls : ""}">${label} · ${list.length}</p><div>${list.map(todoRow).join("")}</div>` : "";

  const body = (late.length + today.length + upcoming.length)
    ? section("En retard", late, "is-late") + section("Aujourd'hui", today) + section("À venir", upcoming)
    : `<div class="note"><h3>Rien en attente</h3><p>Ajoute une tâche ci-dessus.</p></div>`;

  viewEl.innerHTML = `
    <form class="add" id="add-form">
      <input id="add-input" placeholder="Ajouter une tâche…" autocomplete="off" maxlength="200" aria-label="Nouvelle tâche">
      <input id="add-date" type="date" value="${todayK}" class="add-date" aria-label="Jour de la tâche">
      <button class="btn btn-sq" type="submit" aria-label="Ajouter">${ico("i-plus", "")}</button>
    </form>
    ${body}
    ${done.length ? section("Terminé", done) : ""}
  `;
  wireAdd(store);
  wireTodos(viewEl, store);
}

function todoRow(t) {
  const todayK = dayKey(new Date());
  const late = t.due_date && t.due_date < todayK && !t.done;
  const lbl = dueLabel(t.due_date);
  const due = lbl ? `<span class="todo-due${late ? " is-late" : ""}">${esc(lbl)}</span>` : "";
  return `<div class="todo${t.done ? " is-done" : ""}" data-id="${esc(t.id)}">
    <button class="check" role="checkbox" aria-checked="${t.done}" aria-label="${t.done ? "Décocher" : "Cocher"}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4 4 10-10"/></svg>
    </button>
    <span class="todo-title">${esc(t.title)}</span>
    ${due}
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
  return `<div class="note" style="text-align:left">
    <h3>Connexion</h3>
    <p>Reçois un lien magique par e-mail pour retrouver tes tâches sur tous tes appareils.</p>
    <form class="add" id="signin-form" style="margin-top:14px">
      <input id="signin-email" type="email" required placeholder="ton e-mail" autocomplete="email" aria-label="E-mail">
      <button class="btn" type="submit">Recevoir</button>
    </form>
    <p id="signin-msg" style="margin-top:10px"></p>
  </div>`;
}

// ---------- Supabase ----------
let _store = null;
async function getStore() {
  if (_store) return _store;
  if (!SUPA_READY) return null;
  try {
    const { createClient } = await import(`https://esm.sh/@supabase/supabase-js@${SUPABASE_VERSION}`);
    const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    _store = { sb, session: null, todos: [], custom: [], hidden: new Set(), teams: [] };
    const { data } = await sb.auth.getSession();
    _store.session = data.session;
    sb.auth.onAuthStateChange((_e, session) => {
      _store.session = session;
      if (session) Promise.all([refreshTodos(), refreshPersonal()]).then(() => rerender());
      else { _store.todos = []; _store.custom = []; _store.hidden = new Set(); _store.teams = []; rerender(); }
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

// Données perso (privées, RLS) : événements ajoutés, cours masqués, réunions Teams importées.
// Les tables peuvent ne pas encore exister (avant la mise en place) -> on dégrade en silence.
async function refreshPersonal() {
  if (!_store?.session) { _store.custom = []; _store.hidden = new Set(); _store.teams = []; return; }
  const [c, o, t] = await Promise.all([
    _store.sb.from("custom_events").select("*").order("start_at", { ascending: true }),
    _store.sb.from("event_overrides").select("event_uid,hidden"),
    _store.sb.from("calendar_events").select("*").order("start_at", { ascending: true }),
  ]);
  _store.custom = c.error ? [] : (c.data || []);
  _store.hidden = o.error ? new Set() : new Set((o.data || []).filter((r) => r.hidden).map((r) => r.event_uid));
  _store.teams = t.error ? [] : (t.data || []);
  subscribeRealtime();
}

let _sub = null;
function subscribeRealtime() {
  if (_sub || !_store?.session) return;
  const pg = "postgres_changes";
  const onTodos = async () => { await refreshTodos(); rerender(); };
  const onPerso = async () => { await refreshPersonal(); rerender(); };
  _sub = _store.sb.channel("hub-sync")
    .on(pg, { event: "*", schema: "public", table: "todos" }, onTodos)
    .on(pg, { event: "*", schema: "public", table: "custom_events" }, onPerso)
    .on(pg, { event: "*", schema: "public", table: "event_overrides" }, onPerso)
    .on(pg, { event: "*", schema: "public", table: "calendar_events" }, onPerso)
    .subscribe();
}

// ---------- Actions tâches ----------
function wireAdd(store) {
  const form = document.getElementById("add-form");
  const input = document.getElementById("add-input");
  const date = document.getElementById("add-date");
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = input.value.trim();
    if (!title) return;
    input.value = "";
    const due_date = date && date.value ? date.value : null;
    const { error } = await store.sb.from("todos").insert({ title, due_date });
    if (error) { alert("Ajout impossible : " + error.message); return; }
    await refreshTodos(); rerender();
  });
}

function wireTodos(root, store) {
  root.querySelectorAll(".todo").forEach((el) => {
    const id = el.dataset.id;
    el.querySelector(".check")?.addEventListener("click", async () => {
      const t = store.todos.find((x) => String(x.id) === String(id));
      if (!t) return;
      el.classList.toggle("is-done"); // retour visuel immédiat
      const { error } = await store.sb.from("todos").update({ done: !t.done }).eq("id", id);
      if (error) { el.classList.toggle("is-done"); return; }
      await refreshTodos(); rerender();
    });
    el.querySelector(".todo-del")?.addEventListener("click", async () => {
      const { error } = await store.sb.from("todos").delete().eq("id", id);
      if (error) { alert("Suppression impossible : " + error.message); return; }
      await refreshTodos(); rerender();
    });
  });
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
  closeSheet();
  const ov = document.createElement("div");
  ov.className = "sheet-overlay"; ov.id = "sheet-ov";
  ov.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${inner}</div>`;
  ov.addEventListener("click", (e) => { if (e.target === ov) closeSheet(); });
  document.body.appendChild(ov);
  requestAnimationFrame(() => ov.classList.add("is-open"));
  return ov;
}
function closeSheet() { document.getElementById("sheet-ov")?.remove(); }
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });

function evWhen(ev) {
  const s = new Date(ev.start);
  const range = ev.end ? `${fmtTime.format(s)} – ${fmtTime.format(new Date(ev.end))}` : fmtTime.format(s);
  return `${cap(fmtWeekday.format(s))} · ${range}`;
}

function openEventForm(date) {
  if (!_store?.session) return;
  const d = date || dayKey(new Date());
  const ov = openSheet(`
    <h3 class="sheet-h">Nouvel événement</h3>
    <form id="ev-form" class="sheet-form">
      <label>Titre<input id="ev-title" required maxlength="120" autocomplete="off" placeholder="Ex. RDV, révisions, sport…"></label>
      <label>Jour<input id="ev-date" type="date" value="${d}" required></label>
      <div class="sheet-two">
        <label>Début<input id="ev-start" type="time" value="09:00" required></label>
        <label>Fin<input id="ev-end" type="time" value="10:00" required></label>
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
    if (error) { alert("Ajout impossible : " + error.message); return; }
    closeSheet(); await refreshPersonal(); rerender();
  });
  setTimeout(() => ov.querySelector("#ev-title")?.focus(), 50);
}

function openEventActions(ev) {
  if (!_store?.session) return;
  const head = `<h3 class="sheet-h">${esc(ev.title)}</h3><p class="sheet-sub">${evWhen(ev)}${(ev.location) ? " · " + esc(ev.location) : ""}</p>`;

  if (ev.source === "perso") {
    const ov = openSheet(`${head}<div class="sheet-actions">
      <button class="btn btn-ghost" id="s-close">Fermer</button>
      <button class="btn btn-danger" id="s-del">Supprimer</button></div>`);
    ov.querySelector("#s-close").onclick = closeSheet;
    ov.querySelector("#s-del").onclick = async () => {
      const { error } = await _store.sb.from("custom_events").delete().eq("id", ev.cid);
      if (error) { alert("Suppression impossible : " + error.message); return; }
      closeSheet(); await refreshPersonal(); rerender();
    };
  } else if (ev.source === "course") {
    if (ev._hidden) {
      const ov = openSheet(`${head}<p class="sheet-note">Tu as marqué « je n'y vais pas » pour ce cours.</p>
        <div class="sheet-actions"><button class="btn btn-ghost" id="s-close">Fermer</button>
        <button class="btn" id="s-show">Y retourner</button></div>`);
      ov.querySelector("#s-close").onclick = closeSheet;
      ov.querySelector("#s-show").onclick = async () => {
        const { error } = await _store.sb.from("event_overrides").delete().eq("event_uid", ev.uid);
        if (error) { alert("Erreur : " + error.message); return; }
        closeSheet(); await refreshPersonal(); rerender();
      };
    } else {
      const ov = openSheet(`${head}<div class="sheet-actions"><button class="btn btn-ghost" id="s-close">Fermer</button>
        <button class="btn btn-danger" id="s-hide">Je n'y vais pas</button></div>`);
      ov.querySelector("#s-close").onclick = closeSheet;
      ov.querySelector("#s-hide").onclick = async () => {
        const { error } = await _store.sb.from("event_overrides")
          .upsert({ user_id: _store.session.user.id, event_uid: ev.uid, hidden: true }, { onConflict: "user_id,event_uid" });
        if (error) { alert("Erreur : " + error.message); return; }
        closeSheet(); await refreshPersonal(); rerender();
      };
    }
  } else { // Teams (lecture seule)
    const ov = openSheet(`${head}<p class="sheet-note">Réunion ${ev.source === "ef" ? "école" : "pro"}, importée depuis ton calendrier. Modifie-la dans Outlook / Teams.</p>
      <div class="sheet-actions"><button class="btn" id="s-close">Fermer</button></div>`);
    ov.querySelector("#s-close").onclick = closeSheet;
  }
}

// ---------- Navigation ----------
function rerender() {
  viewEl.dataset.view = current;
  if (current === "today") renderToday();
  else if (current === "week") renderWeek();
  else renderTasks();
  updateFab();
}

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    current = btn.dataset.view;
    document.querySelectorAll(".tab").forEach((b) => {
      const active = b === btn;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-selected", String(active));
    });
    window.scrollTo({ top: 0 });
    rerender();
  });
});

// Bascule liste/grille de la vue Semaine au redimensionnement
let _rsz;
window.addEventListener("resize", () => { clearTimeout(_rsz); _rsz = setTimeout(() => { if (current === "week") renderWeek(); }, 200); });

// ---------- Démarrage ----------
await Promise.all([loadPlanning(), loadAlternance()]);
rerender();
// Rafraîchit l'état "en cours / prochain" quand on revient sur l'app
document.addEventListener("visibilitychange", () => { if (!document.hidden) { loadPlanning().then(rerender); } });

// Service worker (PWA installable + hors-ligne)
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
