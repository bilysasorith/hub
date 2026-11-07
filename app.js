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

const dayKey = (d) => fmtDayKey.format(d);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ico = (id, cls = "mi") => `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const viewEl = document.getElementById("view");
const titleEl = document.getElementById("top-title");
const dateEl = document.getElementById("top-date");
const liveEl = document.getElementById("live");
const liveTimeEl = document.getElementById("live-time");

let PLANNING = null;        // { generatedAt, events: [...] }
let current = "today";      // onglet actif

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
function renderWeek() {
  titleEl.textContent = "Semaine";
  const now = new Date();
  dateEl.textContent = "7 prochains jours";
  if (!PLANNING || !(PLANNING.events || []).length) {
    viewEl.innerHTML = `<div class="note"><h3>Rien à afficher</h3><p>Planning indisponible pour le moment.</p></div>`;
    return;
  }
  const todayK = dayKey(now);
  const byDay = new Map();
  for (const e of PLANNING.events) {
    const k = dayKey(new Date(e.start));
    if (k < todayK) continue;
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(e);
  }
  const keys = [...byDay.keys()].sort().slice(0, 7);
  if (!keys.length) { viewEl.innerHTML = `<div class="note"><h3>Pas de cours à venir</h3></div>`; return; }
  viewEl.innerHTML = keys.map((k) => {
    const evs = byDay.get(k).sort((a, b) => new Date(a.start) - new Date(b.start));
    const d = new Date(evs[0].start);
    const label = k === todayK ? "Aujourd'hui" : cap(fmtWeekday.format(d));
    return `<section class="group">
      <h2 class="group-day">${label} <span class="d">· ${evs.length} cours</span></h2>
      <div class="card">${evs.map((e) => courseRow(e, now)).join("")}</div>
    </section>`;
  }).join("");
}

// ---------- Vue À faire ----------
async function renderTasks() {
  titleEl.textContent = "À faire";
  dateEl.textContent = "Tâches";
  if (!SUPA_READY) { viewEl.innerHTML = setupNote(); return; }

  const store = await getStore();
  if (!store) { viewEl.innerHTML = `<div class="note"><h3>Connexion impossible</h3><p>Impossible de joindre Supabase. Réessaie quand tu as du réseau.</p></div>`; return; }

  if (!store.session) { viewEl.innerHTML = signInView(); wireSignIn(store); return; }

  const open = store.todos.filter((t) => !t.done);
  const done = store.todos.filter((t) => t.done);
  viewEl.innerHTML = `
    <form class="add" id="add-form">
      <input id="add-input" placeholder="Ajouter une tâche…" autocomplete="off" maxlength="200" aria-label="Nouvelle tâche">
      <button class="btn btn-sq" type="submit" aria-label="Ajouter">${ico("i-plus", "")}</button>
    </form>
    ${open.length ? `<div>${open.map(todoRow).join("")}</div>`
      : `<div class="note"><h3>Rien en attente</h3><p>Tout est fait. 🎯 Ajoute une tâche ci-dessus.</p></div>`}
    ${done.length ? `<p class="section-label">Terminé · ${done.length}</p><div>${done.map(todoRow).join("")}</div>` : ""}
  `;
  wireAdd(store);
  wireTodos(viewEl, store);
}

function todoRow(t) {
  const todayK = dayKey(new Date());
  const late = t.due_date && t.due_date < todayK && !t.done;
  const due = t.due_date ? `<span class="todo-due${late ? " is-late" : ""}">${esc(t.due_date.slice(5))}</span>` : "";
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
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = input.value.trim();
    if (!title) return;
    input.value = "";
    const { error } = await store.sb.from("todos").insert({ title });
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

// ---------- Démarrage ----------
await loadPlanning();
rerender();
// Rafraîchit l'état "en cours / prochain" quand on revient sur l'app
document.addEventListener("visibilitychange", () => { if (!document.hidden) { loadPlanning().then(rerender); } });

// Service worker (PWA installable + hors-ligne)
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
