// Récupère le flux ICS myefrei et le transforme en planning.json (same-origin pour la PWA).
// Parsing ICS mutualisé via ics.mjs ; ici on enrichit seulement avec les champs myefrei (DESCRIPTION).
// L'URL vient de la variable d'env MYEFREI_ICS_URL (secret GitHub), jamais en clair dans le dépôt.

import { writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseEvents } from "./ics.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "planning.json");
const CHANGES_OUT = join(__dirname, "..", "changes.json");

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

// --- Identifiant stable ---
// myefrei régénère les UID de ses cours de temps en temps, sans autre changement : tout ce qui
// est rattaché à l'UID (cours masqués, examens, rappels) se perdait et le cours « revenait ».
// On dérive donc l'identifiant du titre + de l'heure de début (suffixe si doublon exact).
const usedIds = new Map();
function stableId(e) {
  const base = "c-" + createHash("sha1").update(`${(e.title || "").trim()}|${e.start}`).digest("hex").slice(0, 16);
  const n = usedIds.get(base) || 0;
  usedIds.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}

// --- Parse + enrichissement ---
const parsed = parseEvents(raw).sort((a, b) => (a.start || "").localeCompare(b.start || "") || (a.uid || "").localeCompare(b.uid || ""));
const events = parsed.map((e) => {
  const desc = parseDescription(e.description);
  return {
    uid: stableId(e),
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

// --- Journal des changements (ajout / suppression / modification) venant du flux ---
// Compare le planning qu'on vient de générer avec l'ancien (déjà dans le dépôt).
// On ne retient que les cours à venir, pour éviter le bruit des cours qui tombent du passé.
const readJson = async (p, fallback) => { try { return JSON.parse(await readFile(p, "utf8")); } catch { return fallback; } };
const roomOf = (e) => ((e.rooms && e.rooms.join(", ")) || e.location || "").trim();
const nowISO = new Date().toISOString();
const nowMs = Date.now();
const upcoming = (e) => e.start && new Date(e.start).getTime() >= nowMs;

const old = await readJson(OUT, null);
const fresh = [];
if (old && Array.isArray(old.events)) {
  // Rapprochement par titre + début (et non par UID, que myefrei régénère sans prévenir).
  const keyOf = (e) => `${(e.title || "").trim()}|${e.start}`;
  const oldMap = new Map(old.events.map((e) => [keyOf(e), e]));
  const newMap = new Map(kept.map((e) => [keyOf(e), e]));
  for (const e of kept) if (upcoming(e) && !oldMap.has(keyOf(e)))
    fresh.push({ ts: nowISO, type: "added", uid: e.uid, title: e.title, start: e.start, room: roomOf(e) });
  for (const e of old.events) if (upcoming(e) && !newMap.has(keyOf(e)))
    fresh.push({ ts: nowISO, type: "removed", uid: e.uid, title: e.title, start: e.start, room: roomOf(e) });
  for (const e of kept) {
    const o = oldMap.get(keyOf(e));
    if (!o || !(upcoming(e) || upcoming(o))) continue;
    const ch = {};
    if (o.start !== e.start || o.end !== e.end) ch.time = { from: o.start, to: e.start };
    if (roomOf(o) !== roomOf(e)) ch.room = { from: roomOf(o), to: roomOf(e) };
    if ((o.title || "") !== (e.title || "")) ch.title = { from: o.title, to: e.title };
    if (Object.keys(ch).length)
      fresh.push({ ts: nowISO, type: "modified", uid: e.uid, title: e.title, start: e.start, changes: ch });
  }
}

await writeFile(OUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
console.log(`planning.json écrit : ${kept.length} cours (sur ${events.length} au total dans le flux).`);

if (fresh.length) {
  const PRUNE_MS = 21 * 24 * 3600 * 1000;
  const prev = await readJson(CHANGES_OUT, { items: [] });
  const items = [...fresh, ...(prev.items || [])]
    .filter((c) => nowMs - new Date(c.ts).getTime() < PRUNE_MS)
    .slice(0, 120);
  await writeFile(CHANGES_OUT, JSON.stringify({ generatedAt: nowISO, items }, null, 2) + "\n", "utf8");
  console.log(`changes.json : ${fresh.length} changement(s) détecté(s) (${items.length} au journal).`);
} else {
  console.log("Aucun changement de cours détecté.");
}
