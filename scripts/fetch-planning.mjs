// Récupère le flux ICS myefrei et le transforme en planning.json (same-origin pour la PWA).
// Zéro dépendance : parser ICS minimal (le flux est en UTC "Z", lignes repliées RFC5545).
// L'URL vient de la variable d'env MYEFREI_ICS_URL (secret GitHub), jamais en clair dans le dépôt.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "planning.json");

const URL = process.env.MYEFREI_ICS_URL;
if (!URL) {
  console.error("MYEFREI_ICS_URL manquant (variable d'environnement / secret).");
  process.exit(1);
}

// --- Récupération ---
const res = await fetch(URL, { headers: { "User-Agent": "hub-planning-bot" } });
if (!res.ok) {
  console.error(`Échec du fetch ICS : HTTP ${res.status}`);
  process.exit(1);
}
const raw = await res.text();

// --- Dépliage des lignes (une ligne qui commence par espace/tab continue la précédente) ---
function unfold(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n[ \t]/g, ""); // RFC5545 : CRLF + WSP = continuation
}

// Déséchappe un texte de propriété ICS (\n, \, \; \\)
function unescape(v) {
  return v
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

// "20261102T130000Z" -> ISO ; gère aussi la forme sans Z (rare ici, traité comme UTC)
function parseDate(val) {
  const m = val.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)).toISOString();
}

// Extrait les champs structurés de la DESCRIPTION myefrei
function parseDescription(desc) {
  const out = { module: null, teacher: null, groups: null, modalite: null, activity: null, rooms: [] };
  if (!desc) return out;
  const lines = desc.split("\n").map((l) => l.trim());
  let inRooms = false;
  for (const line of lines) {
    if (!line) { inRooms = false; continue; }
    if (/^Code module\s*:/i.test(line)) { out.module = line.split(/:(.+)/)[1]?.trim() || null; inRooms = false; }
    else if (/^Enseignant\(s\)\s*:/i.test(line)) { out.teacher = line.split(/:(.+)/)[1]?.trim() || null; inRooms = false; }
    else if (/^Groupes?\(s\)\s*:/i.test(line)) { out.groups = line.split(/:(.+)/)[1]?.trim() || null; inRooms = false; }
    else if (/^Modalit[ée]\s*:/i.test(line)) { out.modalite = line.split(/:(.+)/)[1]?.trim() || null; inRooms = false; }
    else if (/^Activit[ée]\s*:/i.test(line)) { out.activity = line.split(/:(.+)/)[1]?.trim() || null; inRooms = false; }
    else if (/^Salles?\s*:/i.test(line)) { inRooms = true; const rest = line.split(/:(.+)/)[1]?.trim(); if (rest) out.rooms.push(rest); }
    else if (inRooms) { out.rooms.push(line); }
  }
  return out;
}

// --- Parse des VEVENT ---
const text = unfold(raw);
const events = [];
const blocks = text.split("BEGIN:VEVENT").slice(1);

for (const block of blocks) {
  const body = block.split("END:VEVENT")[0];
  const fields = {};
  for (const line of body.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).split(";")[0].trim().toUpperCase(); // ignore les paramètres
    const val = line.slice(idx + 1);
    if (!(key in fields)) fields[key] = val; // garde la première occurrence
  }

  const start = parseDate(fields.DTSTART || "");
  const end = parseDate(fields.DTEND || "");
  if (!start) continue;

  const desc = parseDescription(unescape(fields.DESCRIPTION || ""));
  events.push({
    uid: fields.UID || null,
    start,
    end,
    title: unescape(fields.SUMMARY || "").trim(),
    location: unescape(fields.LOCATION || "").trim() || null,
    rooms: desc.rooms,
    teacher: desc.teacher,
    groups: desc.groups,
    module: desc.module,
    activity: desc.activity,
    modalite: desc.modalite,
  });
}

// --- Filtre (on garde à partir d'hier) + tri chronologique ---
const cutoff = Date.now() - 24 * 3600 * 1000;
const kept = events
  .filter((e) => new Date(e.start).getTime() >= cutoff)
  .sort((a, b) => new Date(a.start) - new Date(b.start));

const payload = {
  generatedAt: new Date().toISOString(),
  count: kept.length,
  events: kept,
};

await writeFile(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
console.log(`planning.json écrit : ${kept.length} cours (sur ${events.length} au total dans le flux).`);
