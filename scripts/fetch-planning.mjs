// Récupère le flux ICS myefrei et le transforme en planning.json (same-origin pour la PWA).
// Parsing ICS mutualisé via ics.mjs ; ici on enrichit seulement avec les champs myefrei (DESCRIPTION).
// L'URL vient de la variable d'env MYEFREI_ICS_URL (secret GitHub), jamais en clair dans le dépôt.

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseEvents } from "./ics.mjs";

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

// Extrait les champs structurés de la DESCRIPTION myefrei.
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

// --- Parse + enrichissement ---
const parsed = parseEvents(raw);
const events = parsed.map((e) => {
  const desc = parseDescription(e.description);
  return {
    uid: e.uid,
    start: e.start,
    end: e.end,
    title: e.title,
    location: e.location,
    rooms: desc.rooms,
    teacher: desc.teacher,
    groups: desc.groups,
    module: desc.module,
    activity: desc.activity,
    modalite: desc.modalite,
  };
});

// --- Filtre (on garde depuis le lundi de la semaine en cours) + tri chronologique ---
// Décalage Paris↔UTC au moment donné (+1h l'hiver, +2h l'été).
const parisOffsetMs = (date) => {
  const d = new Date(date);
  const utc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));
  const paris = new Date(d.toLocaleString("en-US", { timeZone: "Europe/Paris" }));
  return paris.getTime() - utc.getTime();
};
// Lundi 00h00 (heure de Paris) de la semaine courante, en instant UTC.
const startOfParisWeek = () => {
  const now = new Date();
  const off = parisOffsetMs(now);
  const wall = new Date(now.getTime() + off); // champs UTC = heure murale Paris
  const dow = (wall.getUTCDay() + 6) % 7; // 0 = lundi
  wall.setUTCHours(0, 0, 0, 0);
  wall.setUTCDate(wall.getUTCDate() - dow);
  return wall.getTime() - off;
};
const cutoff = startOfParisWeek();
const kept = events
  .filter((e) => e.start && new Date(e.start).getTime() >= cutoff)
  .sort((a, b) => new Date(a.start) - new Date(b.start));

const payload = {
  generatedAt: new Date().toISOString(),
  count: kept.length,
  events: kept,
};

await writeFile(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
console.log(`planning.json écrit : ${kept.length} cours (sur ${events.length} au total dans le flux).`);
