// Arithmétique du glisser des événements du planning.
// Les valeurs sont des minutes depuis minuit, bornées à [0, 1440].
// Module pur : aucun import, aucune API propre à Node.

const JOURNEE = 1440;
const PAS = 15;

// Arrondit au quart d'heure le plus proche.
export function snap15(min) {
  return Math.round(min / PAS) * PAS;
}

// Déplace le créneau [s, e] de deltaMin en conservant sa durée.
// Le début est aimanté, puis le créneau est ramené dans [0, 1440] sans changer sa durée.
export function moveRange(s, e, deltaMin) {
  const duree = e - s;
  const debut = Math.min(Math.max(snap15(s + deltaMin), 0), JOURNEE - duree);
  return { s: debut, e: debut + duree };
}

// Déplace uniquement la fin de deltaMin : fin aimantée, au moins 15 min après le début, au plus 1440.
export function resizeEnd(s, e, deltaMin) {
  const fin = Math.min(Math.max(snap15(e + deltaMin), s + PAS), JOURNEE);
  return { s, e: fin };
}
