// Logique pure des réservations de créneaux par des invités.
// Miroir côté client des règles de request_booking (supabase/bookings.sql).

const MIN_MS = 15 * 60 * 1000;
const MAX_MS = 4 * 60 * 60 * 1000;
const HORIZON_MS = 28 * 24 * 60 * 60 * 1000;
const KEY = "hub.guest";
// Même expression que côté serveur ('?' et '&' interdits : pas d'injection mailto).
const EMAIL_RE = /^[^@?&\s]+@[^@?&\s]+\.[^@?&\s]+$/;

const fail = (field, error) => ({ ok: false, field, error });

export function validateRequest(req, nowMs) {
  const { start, end } = req;
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (Number.isNaN(s)) return fail("start", "Date de début invalide.");
  if (Number.isNaN(e)) return fail("end", "Date de fin invalide.");
  // Durée en millisecondes : insensible aux changements d'heure.
  const d = e - s;
  if (d < MIN_MS) return fail("end", "Le créneau doit durer au moins 15 minutes.");
  if (d > MAX_MS) return fail("end", "Le créneau ne peut pas dépasser 4 heures.");
  if (s <= nowMs) return fail("start", "Le créneau doit être dans le futur.");
  if (s >= nowMs + HORIZON_MS) {
    return fail("start", "Le créneau est trop éloigné (28 jours maximum).");
  }

  const name = String(req.name ?? "").trim();
  if (!name) return fail("name", "Indique ton nom.");
  if (name.length > 60) return fail("name", "Nom trop long (60 caractères maximum).");
  const reason = String(req.reason ?? "").trim();
  if (!reason) return fail("reason", "Indique le motif.");
  if (reason.length > 200) return fail("reason", "Motif trop long (200 caractères maximum).");
  const contact = String(req.contact ?? "").trim();
  if (contact.length > 100) return fail("contact", "Contact trop long (100 caractères maximum).");
  const email = String(req.email ?? "").trim();
  if (email) {
    if (email.length > 254) return fail("email", "Adresse e-mail trop longue.");
    if (!EMAIL_RE.test(email)) return fail("email", "Adresse e-mail invalide.");
  }
  return { ok: true };
}

// Chevauchement strict : se toucher bord à bord n'est pas un conflit.
export function conflictsWith(range, busy) {
  const s = Date.parse(range.start);
  const e = Date.parse(range.end);
  return busy.some((b) => Date.parse(b.start) < e && Date.parse(b.end) > s);
}

function read(storage) {
  try {
    const o = JSON.parse(storage.getItem(KEY));
    if (o && typeof o.token === "string" && o.token) {
      return { token: o.token, ids: Array.isArray(o.ids) ? o.ids.filter((x) => typeof x === "string") : [] };
    }
  } catch {}
  return null;
}

function write(storage, guest) {
  try {
    storage.setItem(KEY, JSON.stringify(guest));
  } catch {}
}

export function loadGuest(storage) {
  const g = read(storage);
  if (g) return g;
  const fresh = { token: globalThis.crypto.randomUUID(), ids: [] };
  write(storage, fresh);
  return fresh;
}

export function rememberRequest(storage, id) {
  const g = loadGuest(storage);
  if (g.ids.includes(id)) return;
  write(storage, { token: g.token, ids: [...g.ids, id] });
}
