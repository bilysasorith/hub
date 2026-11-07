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
};
