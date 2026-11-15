import { test } from "node:test";
import assert from "node:assert/strict";
import { snap15, moveRange, resizeEnd } from "./drag-math.js";

test("snap15 arrondit au quart d'heure le plus proche", () => {
  assert.equal(snap15(67), 60);
  assert.equal(snap15(68), 75);
});

test("moveRange conserve la durée et aimante le début", () => {
  assert.deepEqual(moveRange(600, 660, 37), { s: 630, e: 690 });
});

test("moveRange borne la fin à 1440 en décalant tout le créneau", () => {
  assert.deepEqual(moveRange(1400, 1430, 60), { s: 1410, e: 1440 });
});

test("moveRange borne le début à 0 en décalant tout le créneau", () => {
  assert.deepEqual(moveRange(30, 90, -100), { s: 0, e: 60 });
});

test("resizeEnd aimante la fin et garde au moins 15 minutes", () => {
  assert.deepEqual(resizeEnd(600, 660, -60), { s: 600, e: 615 });
});

test("resizeEnd borne la fin à 1440", () => {
  assert.deepEqual(resizeEnd(600, 660, 1000), { s: 600, e: 1440 });
});
