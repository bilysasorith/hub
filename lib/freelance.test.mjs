import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSuivi, insertEntry, removeEntry, formatEntry, pendingDays, minutesByDay, monthTotal, hm, parseDuration } from "./freelance.js";

const SAMPLE = `/* exemple : { date: "2026-01-01", heures: 9, note: "ignoré" } */
window.SUIVI = {
  config: {
    objectifMensuel: 40,           // OBJECTIF
  },
  heures: [
    { date: "2026-11-02", heures: 1.5, note: "PPT \\"T3\\"" },
    { date: "2026-11-02", min: 20, note: "Appel" },
    // { date: "2026-11-03", heures: 5, note: "commentée" },
    { date: "2026-11-04", heures: 0.75, note: "SQL" },
  ],
};
`;

test("lit les séances, ignore les commentaires, garde les guillemets échappés", () => {
  const { goal, entries } = parseSuivi(SAMPLE);
  assert.equal(goal, 40 * 60);
  assert.deepEqual(entries, [
    { date: "2026-11-02", min: 90, note: 'PPT "T3"' },
    { date: "2026-11-02", min: 20, note: "Appel" },
    { date: "2026-11-04", min: 45, note: "SQL" },
  ]);
});

test("format : heures si rond et ≥ 1h, sinon minutes", () => {
  assert.equal(formatEntry({ date: "2026-11-25", min: 90, note: "A" }), `    { date: "2026-11-25", heures: 1.5, note: "A" },`);
  assert.equal(formatEntry({ date: "2026-11-25", min: 45, note: "" }), `    { date: "2026-11-25", min: 45, note: "" },`);
  assert.equal(formatEntry({ date: "2026-11-25", min: 70, note: "x" }), `    { date: "2026-11-25", min: 70, note: "x" },`);
});

test("ajout puis suppression : aller-retour exact", () => {
  const e = { date: "2026-11-25", min: 75, note: 'Requête "SQL"' };
  const added = insertEntry(SAMPLE, e);
  assert.deepEqual(parseSuivi(added).entries.at(-1), e);
  assert.match(added, /note: "SQL" },\n    \{ date: "2026-11-25", heures: 1.25, note: "Requête \\"SQL\\"" },\n  \],/);
  assert.equal(removeEntry(added, e), SAMPLE);
});

test("suppression introuvable : erreur", () => {
  assert.throws(() => removeEntry(SAMPLE, { date: "2026-11-03", min: 300, note: "commentée" }));
});

test("jours à valider : ni heures ni 0h, avant aujourd'hui", () => {
  const by = minutesByDay(parseSuivi(SAMPLE).entries);
  assert.deepEqual(pendingDays(by, new Set(["2026-11-03"]), "2026-11-06", "2026-11-01"), ["2026-11-01", "2026-11-05"]);
  assert.deepEqual(monthTotal(by, "2026-11"), { min: 155, days: 2 });
});

test("durées", () => {
  assert.equal(hm(90), "1h30"); assert.equal(hm(45), "45 min"); assert.equal(hm(120), "2h"); assert.equal(hm(65), "1h05");
  for (const [s, v] of [["1h30", 90], ["1h", 60], ["45min", 45], ["45", 45], ["2", 120], ["1,5", 90], ["0h45", 45], ["1.25h", 75], ["abc", null], ["", null]])
    assert.equal(parseDuration(s), v, s);
});

test("vrai data.js (si fourni)", async () => {
  const p = process.env.SUIVI_FILE;
  if (!p) return;
  const txt = (await import("node:fs")).readFileSync(p, "utf8");
  const { entries, goal } = parseSuivi(txt);
  const lines = (txt.match(/^\s*\{ date: "\d{4}/gm) || []).length;
  assert.equal(entries.length, lines);
  assert.equal(goal, 2400);
  const e = { date: "2026-11-26", min: 30, note: "test" };
  assert.equal(removeEntry(insertEntry(txt, e), e), txt);
});

test("la copie de la fonction Supabase est identique (cp lib/freelance.js supabase/functions/_shared/)", async () => {
  const fs = await import("node:fs");
  const a = fs.readFileSync(new URL("./freelance.js", import.meta.url), "utf8");
  const b = fs.readFileSync(new URL("../supabase/functions/_shared/freelance.js", import.meta.url), "utf8");
  assert.equal(b, a);
});
