import { test } from "node:test";
import assert from "node:assert/strict";
import { cheatStats } from "./cheat-stats.js";

test("aucun écart : tout est nul", () => {
  assert.deepEqual(cheatStats([], "2026-11-15"), {
    clean: null,
    record: null,
    lastDay: null,
    yearCount: 0,
  });
});

test("écart du jour même : série à 0, un écart dans l'année", () => {
  const s = cheatStats(["2026-11-15"], "2026-11-15");
  assert.equal(s.clean, 0);
  assert.equal(s.yearCount, 1);
});

test("série en cours et record calculés sur deux écarts", () => {
  const s = cheatStats(["2026-11-01", "2026-11-11"], "2026-11-15");
  assert.equal(s.clean, 4);
  assert.equal(s.record, 10);
  assert.equal(s.lastDay, "2026-11-11");
});

test("série en cours plus longue que les écarts passés", () => {
  const s = cheatStats(["2026-01-01", "2026-01-03"], "2026-03-01");
  assert.equal(s.clean, 57);
  assert.equal(s.record, 57);
});

test("doublons et futur ignorés pour la série", () => {
  const s = cheatStats(["2026-11-10", "2026-11-10", "2026-12-01"], "2026-11-15");
  assert.equal(s.clean, 5);
  assert.equal(s.yearCount, 1);
});

test("année civile : écarts de l'année précédente exclus", () => {
  const s = cheatStats(["2025-12-31", "2026-01-02"], "2026-01-05");
  assert.equal(s.yearCount, 1);
});
