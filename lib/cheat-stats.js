// Calcul des séries d'écarts (jours sans écart).
// Les clés sont des jours calendaires "AAAA-MM-JJ" (Europe/Paris, calculés par l'appelant).
// Les différences se calculent avec Date.UTC sur les composantes de la clé, jamais avec un parsing local.

const JOUR_MS = 86400000;

// Convertit une clé "AAAA-MM-JJ" en millisecondes UTC (minuit du jour).
function versMs(cle) {
  const [annee, mois, jour] = cle.split("-").map(Number);
  return Date.UTC(annee, mois - 1, jour);
}

// days : clés AAAA-MM-JJ (ordre quelconque, doublons possibles)
// todayKey : clé du jour courant
// Retourne { clean, record, lastDay, yearCount } :
//   clean : jours depuis le dernier écart (null si aucun écart passé)
//   record : plus longue série (écarts entre écarts consécutifs ou série en cours)
//   lastDay : dernier écart passé (null si aucun)
//   yearCount : nombre d'écarts distincts dans l'année civile de todayKey
export function cheatStats(days, todayKey) {
  // Dédoublonne, ignore le futur, trie (ordre lexicographique = ordre chronologique pour AAAA-MM-JJ).
  const jours = [...new Set(days)].filter((cle) => cle <= todayKey).sort();

  if (jours.length === 0) {
    return { clean: null, record: null, lastDay: null, yearCount: 0 };
  }

  const lastDay = jours[jours.length - 1];
  const clean = (versMs(todayKey) - versMs(lastDay)) / JOUR_MS;

  // Le record est le plus grand écart entre deux écarts consécutifs, ou la série en cours.
  let record = clean;
  for (let i = 1; i < jours.length; i++) {
    const ecart = (versMs(jours[i]) - versMs(jours[i - 1])) / JOUR_MS;
    if (ecart > record) record = ecart;
  }

  // Année civile : seuls les écarts de l'année de todayKey comptent.
  const annee = todayKey.slice(0, 4);
  const yearCount = jours.filter((cle) => cle.startsWith(annee + "-")).length;

  return { clean, record, lastDay, yearCount };
}
