// Décide quoi écrire dans calendar_events pour une source, sans toucher au réseau (testable).
//
// planSync(existing, rows) :
//   existing — lignes déjà en base pour cette source : [{ id, title, start_at, end_at, location }]
//   rows     — lignes fraîchement importées (même forme)
// -> { upserts, deletes, skipPurge }
//   upserts   — seulement les lignes nouvelles ou réellement modifiées (pas de réécriture
//               à l'identique : chaque écriture déclenche un événement temps réel côté app).
//   deletes   — ids en base absents du flux.
//   skipPurge — true si le flux semble vide par erreur : on n'efface rien.

const ms = (v) => (v ? new Date(v).getTime() : null);
const norm = (v) => (v == null || v === "" ? null : v);

export function sameRow(a, b) {
  return norm(a.title) === norm(b.title)
    && ms(a.start_at) === ms(b.start_at)
    && ms(a.end_at) === ms(b.end_at)
    && norm(a.location) === norm(b.location);
}

export function planSync(existing, rows) {
  const byId = new Map(existing.map((r) => [r.id, r]));
  const upserts = rows.filter((r) => { const old = byId.get(r.id); return !old || !sameRow(old, r); });
  const fresh = new Set(rows.map((r) => r.id));
  const deletes = existing.filter((r) => !fresh.has(r.id)).map((r) => r.id);
  // Flux vide alors que la base a des événements : lien expiré, panne passagère, réponse tronquée…
  // Effacer tout le calendrier serait pire que garder des événements périmés quelques heures.
  const skipPurge = rows.length === 0 && existing.length > 0;
  return { upserts, deletes: skipPurge ? [] : deletes, skipPurge };
}

// Filtre PostgREST « id=in.(...) » : chaque id entre guillemets, échappé puis encodé
// (les UID Google contiennent « @ », certains peuvent contenir « + », « , » ou « " »).
export function inFilter(ids) {
  const quoted = ids.map((id) => `"${String(id).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
  return `in.(${encodeURIComponent(quoted.join(","))})`;
}
