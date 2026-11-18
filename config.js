// Configuration Supabase pour la to-do synchronisée.
// Ces deux valeurs sont PUBLIQUES par conception (clé "anon") : sûres à mettre ici.
// La sécurité vient de l'authentification + Row Level Security côté Supabase.
// NE JAMAIS mettre ici la clé "service_role".
//
// Tant que les valeurs restent vides, l'app fonctionne pour le planning et affiche
// un guide de configuration dans l'onglet « À faire ».
window.HUB_CONFIG = {
  SUPABASE_URL: "https://dcauisdxvbmcnerjklxm.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_wvGTwUTuJJHLNR8SL2PyvQ_DN4hCMl0", // clé "publishable" (publique, sûre côté client)
  // Clé VAPID publique des notifications (la privée est un secret de la fonction notify-sign).
  VAPID_PUBLIC_KEY: "BAtN_bi5CcsIfmGM7TclTsQTg4wgzK3xOitMxJR4J1-KLYpn1sC9Xju_5_2zA4Dvd3NqwPRpdJLMUl1HBGy78yA",
};
