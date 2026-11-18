// Envoie « Signe ton cours » (Web Push) au début de chaque cours myefrei.
// Appelée chaque minute par pg_cron (supabase/push.sql). Sans effet si aucun cours ne commence.
//
// Secrets de la fonction : VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY.
// SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont fournis automatiquement par Supabase.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const PLANNING_URL = "https://bilysasorith.github.io/hub/planning.json";
const SOWESIGN_URL = "https://app.sowesign.com/student/next-course";
const SIGN_WINDOW_MS = 15 * 60_000;
// On notifie un cours entre son début et 10 min après (marge si une minute de cron saute).
const LATE_MS = 10 * 60_000;

const hm = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });
const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "Content-Type": "application/json" } });

webpush.setVapidDetails(
  "https://bilysasorith.github.io/hub/",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

Deno.serve(async () => {
  const now = Date.now();
  const res = await fetch(`${PLANNING_URL}?t=${now}`);
  if (!res.ok) return json({ error: `planning HTTP ${res.status}` });
  const { events = [] } = await res.json();
  const due = events.filter((e: { start: string }) => {
    const t = Date.parse(e.start);
    return t <= now + 30_000 && now - t < LATE_MS;
  });
  if (!due.length) return json({ due: 0 });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: subs } = await sb.from("push_subscriptions").select("endpoint,user_id,p256dh,auth");
  if (!subs?.length) return json({ due: due.length, subs: 0 });

  const uids = due.map((e: { uid: string }) => e.uid);
  const starts = due.map((e: { start: string }) => new Date(e.start).toISOString());
  let sent = 0;

  for (const userId of new Set(subs.map((s) => s.user_id))) {
    const [hid, att, done] = await Promise.all([
      sb.from("event_overrides").select("event_uid").eq("user_id", userId).eq("hidden", true).in("event_uid", uids),
      sb.from("attendance").select("start_at").eq("user_id", userId).eq("status", "present").in("start_at", starts),
      sb.from("push_sent").select("event_uid").eq("user_id", userId).in("event_uid", uids),
    ]);
    const skip = new Set([...(hid.data || []), ...(done.data || [])].map((r) => r.event_uid));
    const signed = new Set((att.data || []).map((r) => new Date(r.start_at).toISOString()));

    for (const ev of due) {
      if (skip.has(ev.uid) || signed.has(new Date(ev.start).toISOString())) continue;
      // Marqué AVANT l'envoi : deux appels simultanés ne notifient pas deux fois.
      const { error } = await sb.from("push_sent").insert({ user_id: userId, event_uid: ev.uid });
      if (error) continue;
      const until = hm.format(new Date(Date.parse(ev.start) + SIGN_WINDOW_MS));
      const payload = JSON.stringify({
        title: "Signe ton cours",
        body: `${ev.title} · avant ${until}`,
        url: SOWESIGN_URL,
        tag: `sign-${ev.uid}`,
      });
      for (const s of subs.filter((x) => x.user_id === userId)) {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 900, urgency: "high" });
          sent++;
        } catch (e) {
          const code = (e as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) await sb.from("push_subscriptions").delete().eq("endpoint", s.endpoint); // appareil désabonné
          else console.error("push", code, (e as Error).message);
        }
      }
    }
  }
  return json({ due: due.length, sent });
});
