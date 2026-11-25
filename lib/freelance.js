// Heures freelance. La source de vérité est data.js du dépôt suivi-heures (le site que
// consulte l'employeur) : le Hub le lit, et l'écrit via la fonction Supabase « freelance ».
// Module pur (pas de DOM) : utilisé par l'app ET par la fonction (Deno).

export const SUIVI_RAW = "https://raw.githubusercontent.com/bilysasorith/suivi-heures/main/data.js";
// Premier jour soumis à validation (avant : historique, rien à valider).
export const CHECK_FROM = "2026-11-01";
// Nombre de jours non validés à partir duquel on alerte.
export const ALERT_AT = 3;

const STR = String.raw`"((?:[^"\\]|\\.)*)"`;
const unq = (s) => s.replace(/\\(.)/g, "$1");

// Une séance « { date: "…", heures: 1.5 | min: 20, note: "…" } » → { date, min, note } | null
export function parseEntry(body) {
  const d = body.match(/\bdate\s*:\s*"(\d{4}-\d{2}-\d{2})"/);
  if (!d) return null;
  const h = body.match(/\bheures\s*:\s*([\d.]+)/);
  const mn = body.match(/\bmin\s*:\s*([\d.]+)/);
  const min = mn ? Math.round(Number(mn[1])) : h ? Math.round(Number(h[1]) * 60) : 0;
  if (!(min > 0)) return null;
  const note = body.match(new RegExp(`\\bnote\\s*:\\s*${STR}`));
  return { date: d[1], min, note: note ? unq(note[1]) : "" };
}

// Texte de data.js → { goal: minutes/mois, entries: [{ date, min, note }] } (triées par date)
export function parseSuivi(text) {
  const src = String(text || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")   // blocs de commentaires (dont l'exemple d'en-tête)
    .replace(/^\s*\/\/.*$/gm, "");      // séances commentées
  const entries = [];
  for (const m of src.matchAll(/\{([^{}]*)\}/g)) {
    const e = parseEntry(m[1]);
    if (e) entries.push(e);
  }
  entries.sort((a, b) => a.date.localeCompare(b.date));
  const g = src.match(/\bobjectifMensuel\s*:\s*([\d.]+)/);
  return { goal: g ? Math.round(Number(g[1]) * 60) : 0, entries };
}

// Ligne au format du fichier : heures pour les durées rondes (au quart d'heure, ≥ 1 h), sinon min.
export function formatEntry({ date, min, note }) {
  const dur = min >= 60 && min % 15 === 0 ? `heures: ${min / 60}` : `min: ${min}`;
  const n = JSON.stringify(String(note || "").trim());
  return `    { date: "${date}", ${dur}, note: ${n} },`;
}

// Ajoute la séance à la fin de la liste `heures: [ … ]`.
export function insertEntry(text, entry) {
  const start = text.search(/\bheures\s*:\s*\[/);
  if (start < 0) throw new Error("liste « heures » introuvable dans data.js");
  const close = text.indexOf("\n  ],", start);
  const end = close >= 0 ? close : text.indexOf("]", text.indexOf("[", start));
  if (end < 0) throw new Error("fin de la liste « heures » introuvable");
  const before = text.slice(0, end).replace(/\s*$/, "");
  return `${before}\n${formatEntry(entry)}${text.slice(end)}`;
}

// Retire la DERNIÈRE ligne correspondant exactement à la séance (date, durée, note).
export function removeEntry(text, entry) {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (/^\s*\/\//.test(l)) continue;
    const m = l.match(/\{([^{}]*)\}/);
    const e = m && parseEntry(m[1]);
    if (e && e.date === entry.date && e.min === entry.min && e.note === String(entry.note || "")) {
      lines.splice(i, 1);
      return lines.join("\n");
    }
  }
  throw new Error("séance introuvable dans data.js");
}

// Minutes par jour : Map "AAAA-MM-JJ" → minutes
export function minutesByDay(entries) {
  const map = new Map();
  for (const e of entries) map.set(e.date, (map.get(e.date) || 0) + e.min);
  return map;
}

// Total du mois "AAAA-MM" : minutes et jours travaillés.
export function monthTotal(byDay, ym) {
  let min = 0, days = 0;
  for (const [d, m] of byDay) if (d.startsWith(ym)) { min += m; days++; }
  return { min, days };
}

const addDay = (key, n) => new Date(Date.parse(key + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);

// Jours passés (de CHECK_FROM à la veille) ni travaillés ni marqués « 0h ». Plus ancien d'abord.
export function pendingDays(byDay, zeroDays, today, from = CHECK_FROM) {
  const out = [];
  for (let d = from; d < today; d = addDay(d, 1)) if (!byDay.has(d) && !zeroDays.has(d)) out.push(d);
  return out;
}

// "1h30" / "45 min" / "2h" — minutes exactes.
export function hm(min) {
  if (!min) return "0h";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}

// Saisie libre → minutes : "1h30", "1h", "45", "45min", "1,5", "1.5h", "0h45". null si illisible.
export function parseDuration(s) {
  const t = String(s || "").trim().toLowerCase().replace(/\s+/g, "").replace(",", ".");
  if (!t) return null;
  let m;
  if ((m = t.match(/^(\d+)h(\d{1,2})(?:min|m)?$/))) return +m[1] * 60 + +m[2];
  if ((m = t.match(/^(\d+(?:\.\d+)?)h$/))) return Math.round(+m[1] * 60);
  if ((m = t.match(/^(\d+)(?:min|mn|m)$/))) return +m[1];
  // Nombre nu : ≤ 12 = heures (« 2 », « 1.5 »), au-delà = minutes (« 45 »).
  if ((m = t.match(/^(\d+(?:\.\d+)?)$/))) { const v = +m[1]; return v <= 12 ? Math.round(v * 60) : Math.round(v); }
  return null;
}
