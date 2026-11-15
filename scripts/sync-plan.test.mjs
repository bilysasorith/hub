// node --test scripts/sync-plan.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { planSync, inFilter } from "./sync-plan.mjs";

const row = (id, extra = {}) => ({
  id, title: "RDV", start_at: "2026-11-11T15:45:00.000Z", end_at: "2026-11-11T17:00:00.000Z", location: null, ...extra,
});
// Supabase renvoie les timestamptz sous une autre forme ISO : ce n'est pas un changement.
const dbRow = (id, extra = {}) => row(id, { start_at: "2026-11-11T15:45:00+00:00", end_at: "2026-11-11T17:00:00+00:00", ...extra });

test("ligne identique (format de date différent) : rien à écrire", () => {
  const p = planSync([dbRow("google:a")], [row("google:a")]);
  assert.deepEqual(p.upserts, []);
  assert.deepEqual(p.deletes, []);
});

test("ligne nouvelle ou modifiée : écrite", () => {
  const p = planSync([dbRow("google:a")], [row("google:a", { title: "RDV déplacé" }), row("google:b")]);
  assert.deepEqual(p.upserts.map((r) => r.id), ["google:a", "google:b"]);
});

test("location vide et null sont équivalents", () => {
  const p = planSync([dbRow("google:a", { location: "" })], [row("google:a", { location: null })]);
  assert.deepEqual(p.upserts, []);
});

test("ligne disparue du flux : supprimée", () => {
  const p = planSync([dbRow("google:a"), dbRow("google:b")], [row("google:a")]);
  assert.deepEqual(p.deletes, ["google:b"]);
  assert.equal(p.skipPurge, false);
});

test("flux vide alors que la base a des lignes : aucune suppression", () => {
  const p = planSync([dbRow("google:a"), dbRow("google:b")], []);
  assert.equal(p.skipPurge, true);
  assert.deepEqual(p.deletes, []);
});

test("flux vide et base vide : rien à faire, pas d'alerte", () => {
  const p = planSync([], []);
  assert.equal(p.skipPurge, false);
});

test("filtre in.() : guillemets échappés et caractères spéciaux encodés", () => {
  const f = inFilter(['google:x+y@google.com', 'a"b,c']);
  assert.equal(decodeURIComponent(f.slice(4, -1)), '"google:x+y@google.com","a\\"b,c"');
  assert.ok(!f.includes("+") && !f.includes(","));
});
