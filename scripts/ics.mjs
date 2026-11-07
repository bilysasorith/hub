// Parser ICS partagé : myefrei (UTC "Z") + Outlook (heure locale "TZID", réunions récurrentes).
// parseEvents(text, opts) -> [{ uid, start(ISO), end(ISO), title, location, description, allDay }].
// opts.expand = { from, to } (ms epoch) : développe les RRULE dans cette fenêtre. Sans fenêtre,
// une règle récurrente ne produit que sa première occurrence (comportement de myefrei, sans RRULE).

// Fuseaux Windows (Outlook) -> IANA.
const WIN_TZ = {
  "Romance Standard Time": "Europe/Paris",
  "W. Europe Standard Time": "Europe/Paris",
  "Central Europe Standard Time": "Europe/Paris",
  "Central European Standard Time": "Europe/Paris",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Etc/GMT",
  "Arab Standard Time": "Asia/Riyadh",
  "Arabian Standard Time": "Asia/Dubai",
  "Eastern Standard Time": "America/New_York",
  "Pacific Standard Time": "America/Los_Angeles",
  "India Standard Time": "Asia/Kolkata",
  "UTC": "UTC",
};

const DAY = 86400000;
const WD = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function validTZ(tz) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}
function resolveTZ(tzid) {
  if (!tzid) return "Europe/Paris";
  if (WIN_TZ[tzid]) return WIN_TZ[tzid];
  return validTZ(tzid) ? tzid : "Europe/Paris"; // fuseau inconnu -> Paris (cet utilisateur)
}

// Heure murale (ms "comme si UTC") qu'un fuseau affiche pour un instant donné.
function wallMsInTZ(instantMs, tz) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const m = {};
  for (const p of f.formatToParts(new Date(instantMs))) m[p.type] = p.value;
  let hour = +m.hour; if (hour === 24) hour = 0;
  return Date.UTC(+m.year, +m.month - 1, +m.day, hour, +m.minute, +m.second);
}

// Heure murale (y,mo,d,h,mi,s dans `tz`) -> instant epoch ms (gère l'heure d'été).
function zonedToMs(y, mo, d, h, mi, s, tz) {
  const t0 = Date.UTC(y, mo - 1, d, h, mi, s || 0);
  if (tz === "UTC") return t0;
  const off = wallMsInTZ(t0, tz) - t0;
  return t0 - off;
}
const toISO = (ms) => new Date(ms).toISOString();

const unfold = (t) => t.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
const unescape = (v) => v.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");

// Parse une valeur date/heure ICS + ses paramètres -> composantes murales + instant.
function parseDT(rawKey, value) {
  const params = {};
  for (const p of rawKey.split(";").slice(1)) { const [k, v] = p.split("="); if (k) params[k.toUpperCase()] = v; }
  const m = value.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?(Z)?/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const h = m[4] === undefined ? 0 : +m[4], mi = +(m[5] || 0), s = +(m[6] || 0);
  const z = !!m[7];
  const dateOnly = params.VALUE === "DATE" || m[4] === undefined;
  const tz = z ? "UTC" : resolveTZ(params.TZID);
  const ms = zonedToMs(y, mo, d, dateOnly ? 0 : h, dateOnly ? 0 : mi, dateOnly ? 0 : s, tz);
  return { y, mo, d, h, mi, s, tz, ms, allDay: dateOnly };
}

// EXDATE peut lister plusieurs dates séparées par des virgules.
function parseExdate(rawKey, value) {
  return value.split(",").map((v) => parseDT(rawKey, v)).filter(Boolean).map((p) => p.ms);
}

// Parse "FREQ=WEEKLY;INTERVAL=1;UNTIL=...;BYDAY=MO,WE" -> objet.
function parseRRule(s) {
  const r = {};
  for (const part of s.split(";")) {
    const [k, v] = part.split("=");
    if (k) r[k.toUpperCase()] = v;
  }
  return r;
}

const weekdayUTC = (ms) => WD[new Date(ms).getUTCDay()];
const mondayUTC = (ms) => {
  const dt = new Date(ms); const dow = (dt.getUTCDay() + 6) % 7; // 0 = lundi
  return Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()) - dow * DAY;
};

// Développe une règle récurrente -> liste d'instants (ms), bornée par la fenêtre.
function expandRule(dt, rrule, exdates, overrides, win) {
  const r = parseRRule(rrule);
  const freq = (r.FREQ || "").toUpperCase();
  const interval = Math.max(1, parseInt(r.INTERVAL || "1", 10));
  const count = r.COUNT ? parseInt(r.COUNT, 10) : null;
  let until = null;
  if (r.UNTIL) {
    const mm = r.UNTIL.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?Z?/);
    if (mm) until = Date.UTC(+mm[1], +mm[2] - 1, +mm[3], +(mm[4] || 23), +(mm[5] || 59), +(mm[6] || 59));
  }
  const byday = r.BYDAY ? r.BYDAY.split(",") : null;
  const bymonthday = r.BYMONTHDAY ? r.BYMONTHDAY.split(",").map(Number) : null;

  const out = [];
  const exSet = new Set(exdates);
  const startUTCday = Date.UTC(dt.y, dt.mo - 1, dt.d);
  const startMonday = mondayUTC(startUTCday);
  let produced = 0;

  // Si COUNT, il faut compter depuis le vrai début ; sinon on peut partir du bord de fenêtre.
  const iterFrom = count ? startUTCday : Math.max(startUTCday, mondayUTC(win.from) - 7 * DAY);
  const hardStop = Math.min(win.to, until ?? win.to) + DAY;

  const emit = (y, mo, d) => {
    const ms = zonedToMs(y, mo, d, dt.h, dt.mi, dt.s, dt.tz);
    produced++;
    if (ms < win.from || ms > win.to) return;
    if (until && ms > until) return;
    if (exSet.has(ms)) return;
    if (overrides.has(ms)) return;
    out.push(ms);
  };

  if (freq === "DAILY") {
    for (let cur = iterFrom; cur <= hardStop; cur += DAY) {
      if (count && produced >= count) break;
      const di = Math.round((cur - startUTCday) / DAY);
      if (di < 0 || di % interval !== 0) continue;
      const dd = new Date(cur);
      emit(dd.getUTCFullYear(), dd.getUTCMonth() + 1, dd.getUTCDate());
    }
  } else if (freq === "WEEKLY") {
    const days = new Set(byday ? byday.map((b) => b.replace(/^[+-]?\d+/, "")) : [weekdayUTC(startUTCday)]);
    for (let cur = iterFrom; cur <= hardStop; cur += DAY) {
      if (count && produced >= count) break;
      if (!days.has(weekdayUTC(cur))) continue;
      const wk = Math.round((mondayUTC(cur) - startMonday) / (7 * DAY));
      if (wk < 0 || wk % interval !== 0) continue;
      const dd = new Date(cur);
      emit(dd.getUTCFullYear(), dd.getUTCMonth() + 1, dd.getUTCDate());
    }
  } else if (freq === "MONTHLY") {
    // Avance mois par mois depuis le début.
    let y = dt.y, mo = dt.mo;
    for (let k = 0; k < 400; k++) {
      if (count && produced >= count) break;
      const monthStart = Date.UTC(y, mo - 1, 1);
      if (monthStart > hardStop) break;
      if ((k % interval) === 0) {
        let dayNums = [];
        if (bymonthday) dayNums = bymonthday;
        else if (byday) {
          // BYDAY=2WE : nième jour de semaine du mois
          for (const b of byday) {
            const mm = b.match(/^([+-]?\d+)?([A-Z]{2})$/);
            if (!mm) continue;
            const nth = mm[1] ? parseInt(mm[1], 10) : 1;
            const wd = WD.indexOf(mm[2]);
            const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
            const matches = [];
            for (let d = 1; d <= daysInMonth; d++) if (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() === wd) matches.push(d);
            const pick = nth > 0 ? matches[nth - 1] : matches[matches.length + nth];
            if (pick) dayNums.push(pick);
          }
        } else dayNums = [dt.d];
        for (const d of dayNums) if (d >= 1 && d <= 31) emit(y, mo, d);
      }
      mo++; if (mo > 12) { mo = 1; y++; }
    }
  } else {
    // FREQ non géré : on garde au moins la première occurrence.
    if (dt.ms >= win.from && dt.ms <= win.to) out.push(dt.ms);
  }
  return out.sort((a, b) => a - b);
}

export function parseEvents(text, opts = {}) {
  const win = opts.expand || null;
  const blocks = unfold(text).split("BEGIN:VEVENT").slice(1);

  // 1er passage : enregistre les VEVENT bruts + repère les RECURRENCE-ID (occurrences modifiées).
  const records = [];
  const overridesByUid = new Map(); // uid -> Set(instant ms des occurrences remplacées)
  for (const block of blocks) {
    const body = block.split("END:VEVENT")[0];
    const fields = {}; const rawKeys = {}; const exLines = [];
    for (const line of body.split("\n")) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const rawKey = line.slice(0, idx);
      const key = rawKey.split(";")[0].trim().toUpperCase();
      const val = line.slice(idx + 1);
      if (key === "EXDATE") { exLines.push({ rawKey, val }); continue; }
      if (!(key in fields)) { fields[key] = val; rawKeys[key] = rawKey; }
    }
    const dt = fields.DTSTART ? parseDT(rawKeys.DTSTART, fields.DTSTART) : null;
    if (!dt) continue;
    const en = fields.DTEND ? parseDT(rawKeys.DTEND, fields.DTEND) : null;
    const recId = fields["RECURRENCE-ID"] ? parseDT(rawKeys["RECURRENCE-ID"], fields["RECURRENCE-ID"]) : null;
    const uid = fields.UID || null;
    if (recId && uid) {
      if (!overridesByUid.has(uid)) overridesByUid.set(uid, new Set());
      overridesByUid.get(uid).add(recId.ms);
    }
    const exdates = exLines.flatMap(({ rawKey, val }) => parseExdate(rawKey, val));
    records.push({
      uid, dt, en, recId, exdates,
      rrule: fields.RRULE || null,
      title: unescape(fields.SUMMARY || "").trim(),
      location: unescape(fields.LOCATION || "").trim() || null,
      description: unescape(fields.DESCRIPTION || ""),
    });
  }

  // 2e passage : produit les événements concrets.
  const events = [];
  const push = (rec, startMs, suffix) => {
    const dur = rec.en ? rec.en.ms - rec.dt.ms : null;
    events.push({
      uid: suffix != null ? `${rec.uid || "x"}::${suffix}` : rec.uid,
      start: toISO(startMs),
      end: dur != null ? toISO(startMs + dur) : null,
      allDay: rec.dt.allDay,
      title: rec.title, location: rec.location, description: rec.description,
    });
  };

  for (const rec of records) {
    if (rec.recId) {                       // occurrence modifiée : événement autonome
      push(rec, rec.dt.ms, rec.recId.ms);
    } else if (rec.rrule && win) {         // série : développée dans la fenêtre
      const overrides = overridesByUid.get(rec.uid) || new Set();
      for (const ms of expandRule(rec.dt, rec.rrule, rec.exdates, overrides, win)) push(rec, ms, ms);
    } else {                                // événement simple
      push(rec, rec.dt.ms, null);
    }
  }
  return events;
}
