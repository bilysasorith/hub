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

const viewEl = document.getElementById("view");
const titleEl = document.getElementById("top-title");
const dateEl = document.getElementById("top-date");
const liveEl = document.getElementById("live");
const liveTimeEl = document.getElementById("live-time");

let PLANNING = null;        // { generatedAt, events: [...] }
let current = "today";      // onglet actif
let weekOffset = 0;         // 0 = semaine courante, -1 précédente, +1 suivante

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
  const past = new Date(ev.end || ev.start) < now;
  return `<div class="row${past ? " is-past" : ""}">
    <div class="row-time mono">${fmtTime.format(new Date(ev.start))}<br><span class="end">${ev.end ? fmtTime.format(new Date(ev.end)) : ""}</span></div>
    <div>
      <div class="row-title">${esc(ev.title)}</div>
      <div class="row-sub">${esc((ev.rooms && ev.rooms[0]) || ev.location || "")}${ev.teacher ? " — " + esc(ev.teacher) : ""}</div>
    </div>
  </div>`;
}

function eventsForDay(key) {
  return (PLANNING?.events || []).filter((e) => dayKey(new Date(e.start)) === key).sort((a, b) => new Date(a.start) - new Date(b.start));
}

// ---------- Vue Aujourd'hui ----------
function renderToday() {
  titleEl.textContent = "Aujourd'hui";
  const now = new Date();
  dateEl.textContent = cap(fmtDayLabel.format(now));
  const todays = eventsForDay(dayKey(now));

  let html = "";
  if (!PLANNING) {
    html += `<div class="note"><h3>Planning indisponible</h3><p>Pas de réseau et aucune copie en cache pour l'instant.</p></div>`;
  } else if (todays.length === 0) {
    html += `<div class="note"><h3>Pas de cours aujourd'hui</h3><p>Journée libre côté planning.</p></div>`;
  } else {
    const curIdx = todays.findIndex((e) => new Date(e.start) <= now && now < new Date(e.end || e.start));
    const nextIdx = todays.findIndex((e) => new Date(e.start) > now);
    const featIdx = curIdx !== -1 ? curIdx : (nextIdx !== -1 ? nextIdx : -1);

    if (featIdx !== -1) {
      const ev = todays[featIdx];
      const isNow = curIdx !== -1;
      html += `<section class="card card-now">
        <div class="now-head"><span class="dot"></span>${isNow ? "En cours" : "Prochain cours"}</div>
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

// Événements d'un jour, toutes sources fusionnées (myefrei pour l'instant ; perso/Teams viendront).
function mergedEventsForDay(key) {
  return (PLANNING?.events || [])
    .filter((e) => dayKey(new Date(e.start)) === key)
    .map((e) => ({ ...e, source: e.source || "course" }))
    .sort((a, b) => new Date(a.start) - new Date(b.start));
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

function weekNav(days) {
  const label = weekOffset === 0 ? "Cette semaine"
    : weekOffset === 1 ? "Semaine prochaine"
    : weekOffset === -1 ? "Semaine dernière"
    : `${fmtRange.format(days[0].date)} – ${fmtRange.format(days[6].date)}`;
  const chevron = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M${d === "l" ? "15 6l-6 6 6 6" : "9 6l6 6-6 6"}"/></svg>`;
  return `<div class="wknav">
    <button class="nav-btn" data-wk="-1" aria-label="Semaine précédente">${chevron("l")}</button>
    <button class="nav-now" data-wk="0">${label}</button>
    <button class="nav-btn" data-wk="1" aria-label="Semaine suivante">${chevron("r")}</button>
  </div>`;
}

function wireWeekNav() {
  viewEl.querySelectorAll("[data-wk]").forEach((b) => b.addEventListener("click", () => {
    const v = b.dataset.wk;
    weekOffset = v === "0" ? 0 : weekOffset + Number(v);
    renderWeek(); window.scrollTo({ top: 0 });
  }));
}

function renderWeek() {
  titleEl.textContent = "Semaine";
  const days = weekDays(weekOffset);
  dateEl.textContent = `${fmtRange.format(days[0].date)} – ${fmtRange.format(days[6].date)}`;
  if (!PLANNING) {
    viewEl.innerHTML = weekNav(days) + `<div class="note"><h3>Rien à afficher</h3><p>Planning indisponible.</p></div>`;
    wireWeekNav(); return;
  }
  viewEl.innerHTML = weekNav(days) + (desktop() ? weekGrid(days) : weekList(days));
  wireWeekNav();
}

// Mobile : liste par jour.
function weekList(days) {
  const todayK = dayKey(new Date());
  const blocks = days.map((d) => {
    const evs = mergedEventsForDay(d.key);
    if (!evs.length) return "";
    const label = d.key === todayK ? "Aujourd'hui" : cap(fmtWeekday.format(d.date));
    return `<section class="group"><h2 class="group-day">${label} <span class="d">· ${evs.length}</span></h2>
      <div class="card">${evs.map((e) => courseRow(e, new Date())).join("")}</div></section>`;
  }).join("");
  return blocks || `<div class="note"><h3>Rien cette semaine</h3><p>Aucun cours sur ces 7 jours.</p></div>`;
}

// Desktop : grille horaire (colonnes par jour).
function weekGrid(days) {
  const todayK = dayKey(new Date());
  const perDay = days.map((d) => packDay(mergedEventsForDay(d.key).map((e) => ({
    ...e, s: parisMinutes(e.start), e2: e.end ? parisMinutes(e.end) : parisMinutes(e.start) + 60,
  }))));
  let minH = 8, maxH = 20;
  perDay.flat().forEach((e) => { minH = Math.min(minH, Math.floor(e.s / 60)); maxH = Math.max(maxH, Math.ceil(e.e2 / 60)); });
  minH = Math.max(0, minH); maxH = Math.min(24, maxH);
  const PX = 56, top0 = minH * 60, H = (maxH - minH) * PX;
  const hours = []; for (let h = minH; h <= maxH; h++) hours.push(h);

  const head = `<div class="wk-head"><div class="wk-corner"></div>${days.map((d) => {
    const t = d.key === todayK;
    return `<div class="wk-colh${t ? " is-today" : ""}"><span class="wd">${cap(fmtWdShort.format(d.date))}</span><span class="dn num">${fmtDayNum.format(d.date)}</span></div>`;
  }).join("")}</div>`;

  const axis = `<div class="wk-axis" style="height:${H}px">${hours.map((h) =>
    `<div class="wk-hr" style="top:${(h * 60 - top0) / 60 * PX}px">${String(h).padStart(2, "0")}:00</div>`).join("")}</div>`;

  const cols = days.map((d, i) => {
    const t = d.key === todayK;
    const lines = hours.map((h) => `<div class="wk-line" style="top:${(h * 60 - top0) / 60 * PX}px"></div>`).join("");
    const blocks = perDay[i].map((ev) => {
      const top = (ev.s - top0) / 60 * PX;
      const height = Math.max(24, (ev.e2 - ev.s) / 60 * PX - 2);
      const w = 100 / ev.cols, left = ev.lane * w;
      const room = (ev.rooms && ev.rooms[0]) || ev.location || "";
      return `<div class="wk-ev src-${ev.source}" style="top:${top}px;height:${height}px;left:calc(${left}% + 2px);width:calc(${w}% - 4px)" title="${esc(ev.title)}">
        <span class="wk-ev-h mono">${fmtTime.format(new Date(ev.start))}</span>
        <span class="wk-ev-t">${esc(ev.title)}</span>
        ${room ? `<span class="wk-ev-r">${esc(room)}</span>` : ""}
      </div>`;
    }).join("");
    return `<div class="wk-col${t ? " is-today" : ""}" style="height:${H}px">${lines}${blocks}</div>`;
  }).join("");

  return `<div class="wk">${head}<div class="wk-scroll"><div class="wk-body">${axis}${cols}</div></div></div>`;
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
    _store = { sb, session: null, todos: [] };
    const { data } = await sb.auth.getSession();
    _store.session = data.session;
    sb.auth.onAuthStateChange((_e, session) => {
      _store.session = session;
      if (session) refreshTodos().then(() => rerender());
      else { _store.todos = []; rerender(); }
    });
    if (_store.session) await refreshTodos();
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

let _sub = null;
function subscribeRealtime() {
  if (_sub || !_store?.session) return;
  _sub = _store.sb.channel("todos-sync")
    .on("postgres_changes", { event: "*", schema: "public", table: "todos" }, async () => {
      await refreshTodos();
      rerender();
    })
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

// ---------- Navigation ----------
function rerender() {
  viewEl.dataset.view = current;
  if (current === "today") renderToday();
  else if (current === "week") renderWeek();
  else renderTasks();
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
await loadPlanning();
rerender();
// Rafraîchit l'état "en cours / prochain" quand on revient sur l'app
document.addEventListener("visibilitychange", () => { if (!document.hidden) { loadPlanning().then(rerender); } });

// Service worker (PWA installable + hors-ligne)
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
