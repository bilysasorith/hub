import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateRequest,
  conflictsWith,
  loadGuest,
  rememberRequest,
} from "./booking.js";

const NOW = Date.parse("2026-11-17T10:00:00Z");
const base = {
  start: "2026-11-18T14:00:00Z",
  end: "2026-11-18T15:00:00Z",
  name: "Léa",
  reason: "Révisions",
  contact: "",
  email: "",
};
const check = (over) => validateRequest({ ...base, ...over }, NOW);

function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

test("demande valide", () => {
  assert.deepEqual(check({}), { ok: true });
});

test("nom vide ou blanc refusé", () => {
  assert.equal(check({ name: "   " }).field, "name");
  assert.equal(check({ name: "a".repeat(61) }).field, "name");
});

test("motif requis, 200 caractères max", () => {
  assert.equal(check({ reason: "" }).field, "reason");
  assert.equal(check({ reason: "a".repeat(201) }).ok, false);
  assert.equal(check({ reason: "a".repeat(200) }).ok, true);
});

test("contact 100 caractères max", () => {
  assert.equal(check({ contact: "a".repeat(101) }).field, "contact");
});

test("durée : 14 min refusé, 15 min et 4 h ok, 4 h 15 refusé", () => {
  assert.equal(check({ end: "2026-11-18T14:14:00Z" }).field, "end");
  assert.equal(check({ end: "2026-11-18T14:15:00Z" }).ok, true);
  assert.equal(check({ end: "2026-11-18T18:00:00Z" }).ok, true);
  assert.equal(check({ end: "2026-11-18T18:15:00Z" }).field, "end");
  assert.equal(check({ end: "2026-11-18T13:00:00Z" }).field, "end");
});

test("début dans le passé refusé", () => {
  assert.equal(check({ start: "2026-11-17T09:00:00Z", end: "2026-11-17T10:00:00Z" }).field, "start");
});

test("début à J+28 refusé (exclusif), juste avant ok, J+29 refusé", () => {
  assert.equal(check({ start: "2026-12-15T10:00:00Z", end: "2026-12-15T11:00:00Z" }).field, "start");
  assert.equal(check({ start: "2026-12-15T09:59:00Z", end: "2026-12-15T11:00:00Z" }).ok, true);
  assert.equal(check({ start: "2026-12-16T10:00:00Z", end: "2026-12-16T11:00:00Z" }).field, "start");
});

test("dates illisibles refusées", () => {
  assert.equal(check({ start: "n'importe quoi" }).field, "start");
  assert.equal(check({ end: "" }).field, "end");
});

test("e-mail : vide ok, invalide refusé, valide ok, trop long refusé", () => {
  assert.equal(check({ email: "" }).ok, true);
  assert.equal(check({ email: "a@b" }).field, "email");
  assert.equal(check({ email: "a b@c.fr" }).field, "email");
  assert.equal(check({ email: "a@b.co?subject=x" }).field, "email");
  assert.equal(check({ email: "a&cc=x@b.co" }).field, "email");
  assert.equal(check({ email: " a@b.fr " }).ok, true);
  assert.equal(check({ email: "a".repeat(250) + "@b.fr" }).field, "email");
});

test("changement d'heure : 2 h réelles ok", () => {
  const r = validateRequest(
    { ...base, start: "2027-03-28T00:30:00Z", end: "2027-03-28T02:30:00Z" },
    Date.parse("2027-03-20T10:00:00Z"),
  );
  assert.deepEqual(r, { ok: true });
});

test("conflictsWith : bord à bord n'est pas un conflit", () => {
  const r = { start: "2026-11-18T14:00:00Z", end: "2026-11-18T15:00:00Z" };
  assert.equal(conflictsWith(r, []), false);
  assert.equal(
    conflictsWith(r, [{ start: "2026-11-18T15:00:00Z", end: "2026-11-18T16:00:00Z" }]),
    false,
  );
  assert.equal(
    conflictsWith(r, [{ start: "2026-11-18T14:30:00Z", end: "2026-11-18T15:30:00Z" }]),
    true,
  );
});

test("loadGuest : jeton créé puis stable, rememberRequest sans doublon", () => {
  const s = fakeStorage();
  const g = loadGuest(s);
  assert.match(g.token, /^[0-9a-f-]{36}$/);
  assert.deepEqual(g.ids, []);
  assert.equal(loadGuest(s).token, g.token);
  rememberRequest(s, "abc");
  rememberRequest(s, "abc");
  const g2 = loadGuest(s);
  assert.deepEqual(g2.ids, ["abc"]);
  assert.equal(g2.token, g.token);
});

test("storage défaillant ou corrompu : pas de crash", () => {
  const bad = {
    getItem() { throw new Error("x"); },
    setItem() { throw new Error("x"); },
  };
  assert.ok(loadGuest(bad).token);
  assert.doesNotThrow(() => rememberRequest(bad, "z"));
  const s = fakeStorage();
  s.setItem("hub.guest", "{pas du json");
  const g = loadGuest(s);
  assert.ok(g.token);
  assert.deepEqual(g.ids, []);
});
