/**
 * Calendar invitations (iCalendar, RFC 5545, carried as iMIP, RFC 6047).
 *
 * An invitation arrives as a text/calendar part beside the readable text,
 * and every other mail client turns it into a card with Accept and Decline.
 * Here it used to be dropped on the floor by the MIME walker, so an invite
 * read as a block of "When: … Join meeting" text with no way to answer it.
 *
 * Pure string functions, no Workers API, tested by `node test.mjs`.
 */

/** Folded lines joined back up, then split into { name, params, value }. */
function lines(text) {
  return String(text || "")
    .replace(/\r?\n[ \t]/g, "") // unfold
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      // The value starts at the first colon outside a quoted parameter.
      let i = 0;
      let quoted = false;
      for (; i < line.length; i++) {
        const c = line[i];
        if (c === '"') quoted = !quoted;
        else if (c === ":" && !quoted) break;
      }
      const head = line.slice(0, i);
      const value = line.slice(i + 1);
      const [name, ...rest] = head.split(";");
      const params = {};
      for (const p of rest) {
        const eq = p.indexOf("=");
        if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
      }
      return { name: name.toUpperCase(), params, value, raw: line };
    });
}

/** TEXT values: \n, \, and \; are escapes (RFC 5545 §3.3.11). */
const unescapeText = (v) =>
  String(v || "").replace(/\\([nN,;\\])/g, (_m, c) => (c === "n" || c === "N" ? "\n" : c));

/** Windows timezone names (as written by Outlook, Exchange, Teams) -> IANA names for Intl. */
const WINDOWS_TO_IANA = {
  "romance standard time": "Europe/Paris",
  "w. europe standard time": "Europe/Berlin",
  "central europe standard time": "Europe/Prague",
  "central european standard time": "Europe/Warsaw",
  "gmt standard time": "Europe/London",
  "greenwich standard time": "Atlantic/Reykjavik",
  "w. central africa standard time": "Africa/Lagos",
  "south africa standard time": "Africa/Johannesburg",
  "egypt standard time": "Africa/Cairo",
  "morocco standard time": "Africa/Casablanca",
  "fle standard time": "Europe/Helsinki",
  "gtb standard time": "Europe/Bucharest",
  "e. europe standard time": "Europe/Chisinau",
  "jordan standard time": "Asia/Amman",
  "middle east standard time": "Asia/Beirut",
  "syria standard time": "Asia/Damascus",
  "israel standard time": "Asia/Jerusalem",
  "arabic standard time": "Asia/Baghdad",
  "arab standard time": "Asia/Riyadh",
  "iran standard time": "Asia/Tehran",
  "russian standard time": "Europe/Moscow",
  "belarus standard time": "Europe/Minsk",
  "caucasus standard time": "Asia/Yerevan",
  "azerbaijan standard time": "Asia/Baku",
  "georgian standard time": "Asia/Tbilisi",
  "arabian standard time": "Asia/Dubai",
  "afghanistan standard time": "Asia/Kabul",
  "west asia standard time": "Asia/Tashkent",
  "india standard time": "Asia/Kolkata",
  "sri lanka standard time": "Asia/Colombo",
  "nepal standard time": "Asia/Kathmandu",
  "central asia standard time": "Asia/Almaty",
  "bangladesh standard time": "Asia/Dhaka",
  "myanmar standard time": "Asia/Yangon",
  "se asia standard time": "Asia/Bangkok",
  "china standard time": "Asia/Shanghai",
  "taipei standard time": "Asia/Taipei",
  "singapore standard time": "Asia/Singapore",
  "w. australia standard time": "Australia/Perth",
  "north asia standard time": "Asia/Krasnoyarsk",
  "north asia east standard time": "Asia/Irkutsk",
  "tokyo standard time": "Asia/Tokyo",
  "korea standard time": "Asia/Seoul",
  "yakutsk standard time": "Asia/Yakutsk",
  "cen. australia standard time": "Australia/Adelaide",
  "aus central standard time": "Australia/Darwin",
  "aus eastern standard time": "Australia/Sydney",
  "e. australia standard time": "Australia/Brisbane",
  "tasmania standard time": "Australia/Hobart",
  "vladivostok standard time": "Asia/Vladivostok",
  "west pacific standard time": "Pacific/Port_Moresby",
  "magadan standard time": "Asia/Magadan",
  "new zealand standard time": "Pacific/Auckland",
  "fiji standard time": "Pacific/Fiji",
  "tonga standard time": "Pacific/Tongatapu",
  "hawaiian standard time": "Pacific/Honolulu",
  "alaskan standard time": "America/Anchorage",
  "pacific standard time": "America/Los_Angeles",
  "pacific standard time (mexico)": "America/Tijuana",
  "us mountain standard time": "America/Phoenix",
  "mountain standard time": "America/Denver",
  "mountain standard time (mexico)": "America/Mazatlan",
  "central standard time": "America/Chicago",
  "central standard time (mexico)": "America/Mexico_City",
  "canada central standard time": "America/Regina",
  "eastern standard time": "America/New_York",
  "us eastern standard time": "America/Indiana/Indianapolis",
  "atlantic standard time": "America/Halifax",
  "newfoundland standard time": "America/St_Johns",
  "sa pacific standard time": "America/Bogota",
  "sa western standard time": "America/La_Paz",
  "sa eastern standard time": "America/Cayenne",
  "e. south america standard time": "America/Sao_Paulo",
  "argentina standard time": "America/Argentina/Buenos_Aires",
  "utc": "UTC",
};

/** Resolves an iCalendar TZID (Windows name, prefixed path, or IANA) to an IANA identifier. */
function resolveTz(tz) {
  if (!tz) return null;
  let clean = String(tz).trim().replace(/^["'\\]+|["'\\]+$/g, "");
  if (clean.startsWith("/")) clean = clean.slice(1);
  const lower = clean.toLowerCase();
  if (WINDOWS_TO_IANA[lower]) return WINDOWS_TO_IANA[lower];
  const stripped = lower.replace(/\(utc[+-]\d{2}:\d{2}\)\s*/i, "").trim();
  if (WINDOWS_TO_IANA[stripped]) return WINDOWS_TO_IANA[stripped];
  return clean;
}

/** The offset (ms) of a named zone at a moment, from Intl — null if the name is not IANA. */
function zoneOffset(tz, utcMs) {
  const resolved = resolveTz(tz);
  if (!resolved) return null;
  try {
    const f = new Intl.DateTimeFormat("en-US", {
      timeZone: resolved,
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return asUtc - utcMs;
  } catch {
    return null;
  }
}

/** "+0200" → ms. */
const offsetMs = (s) => {
  const m = /^([+-])(\d{2})(\d{2})/.exec(String(s || ""));
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000 : 0;
};

/**
 * A DATE or DATE-TIME property → { ms, allDay }.
 *
 * Z means UTC. A TZID is mapped to IANA and resolved with Intl, which knows
 * the exact DST transition instants for every year. If Intl fails to recognise
 * the name, the VTIMEZONE block in the same file is used, calculating the last
 * Sunday of March and October transitions rather than a blanket month check.
 */
function when(prop, zones) {
  if (!prop) return null;
  const v = prop.value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined || prop.params.VALUE === "DATE") {
    return { ms: Date.UTC(+y, +mo - 1, +d), allDay: true };
  }
  const wall = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0));
  if (z) return { ms: wall, allDay: false };
  const tz = prop.params.TZID;
  if (!tz) return { ms: wall, allDay: false, floating: true };
  const off = zoneOffset(tz, wall);
  if (off !== null) {
    // Once more at the corrected instant, for the hour around a clock change.
    const again = zoneOffset(tz, wall - off);
    return { ms: wall - (again ?? off), allDay: false };
  }
  const zone = zones[tz] || zones[resolveTz(tz)];
  if (zone) {
    const lastSunMarch = 31 - new Date(Date.UTC(+y, 2, 31)).getUTCDay();
    const lastSunOct = 31 - new Date(Date.UTC(+y, 9, 31)).getUTCDay();
    const isSummer =
      (+mo > 3 && +mo < 10) ||
      (+mo === 3 && +d >= lastSunMarch) ||
      (+mo === 10 && +d < lastSunOct);
    const zoff = isSummer ? (zone.daylight ?? zone.standard) : (zone.standard ?? zone.daylight);
    return { ms: wall - zoff, allDay: false };
  }
  return { ms: wall, allDay: false, floating: true };
}

const mailto = (v) => String(v || "").replace(/^mailto:/i, "").trim().toLowerCase();

/**
 * The first VEVENT of a calendar, and what is needed to show and answer it.
 * Null when there is none.
 */
export function parseIcs(text) {
  const all = lines(text);
  if (!all.length) return null;
  const method = (all.find((l) => l.name === "METHOD")?.value || "").toUpperCase();

  // VTIMEZONE offsets by TZID, for zones Intl does not know by name.
  const zones = {};
  let tzid = null;
  let part = null;
  for (const l of all) {
    if (l.name === "BEGIN" && l.value === "VTIMEZONE") tzid = "";
    else if (l.name === "END" && l.value === "VTIMEZONE") tzid = null;
    else if (tzid !== null && l.name === "TZID") tzid = l.value, (zones[tzid] = zones[tzid] || {});
    else if (tzid && l.name === "BEGIN") part = l.value;
    else if (tzid && l.name === "TZOFFSETTO" && part) {
      zones[tzid][part === "DAYLIGHT" ? "daylight" : "standard"] = offsetMs(l.value);
    }
  }

  const start = all.findIndex((l) => l.name === "BEGIN" && l.value === "VEVENT");
  if (start < 0) return null;
  const end = all.findIndex((l, i) => i > start && l.name === "END" && l.value === "VEVENT");
  const ev = all.slice(start + 1, end < 0 ? undefined : end);
  const one = (n) => ev.find((l) => l.name === n);

  const dtstart = when(one("DTSTART"), zones);
  let dtend = when(one("DTEND"), zones);
  if (!dtend && dtstart) {
    const dur = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(one("DURATION")?.value || "");
    if (dur) dtend = { ...dtstart, ms: dtstart.ms + (((+dur[1] || 0) * 24 + (+dur[2] || 0)) * 60 + (+dur[3] || 0)) * 60_000 };
  }
  const org = one("ORGANIZER");
  const summary = unescapeText(one("SUMMARY")?.value);
  const location = unescapeText(one("LOCATION")?.value);
  const description = unescapeText(one("DESCRIPTION")?.value).slice(0, 2000);
  const rawUrl = one("URL")?.value || "";
  const videoMatch = `${rawUrl}\n${location}\n${description}`.match(
    /https:\/\/(?:[a-zA-Z0-9-]+\.)?(?:teams\.microsoft\.com|meet\.google\.com|zoom\.us|webex\.com)\/[^\s<>"')]+/i
  );
  const url = rawUrl || (videoMatch ? videoMatch[0] : "");

  return {
    method,
    uid: one("UID")?.value || "",
    sequence: Number(one("SEQUENCE")?.value || 0),
    summary,
    location,
    description,
    url,
    status: (one("STATUS")?.value || "").toUpperCase(),
    start: dtstart,
    end: dtend,
    organizer: org ? { email: mailto(org.value), name: org.params.CN || "" } : null,
    attendees: ev
      .filter((l) => l.name === "ATTENDEE")
      .map((l) => ({ email: mailto(l.value), name: l.params.CN || "", partstat: (l.params.PARTSTAT || "").toUpperCase() })),
    // Copied verbatim into a reply: the organiser's server matches on them.
    rawStart: one("DTSTART")?.raw || "",
    rawOrganizer: org?.raw || "",
    rawRecurrence: one("RECURRENCE-ID")?.raw || "",
  };
}

const PARTSTAT = { accepted: "ACCEPTED", tentative: "TENTATIVE", declined: "DECLINED" };

/** UTC "now" in iCalendar form. */
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** Folds an iCalendar content line at 75 octets (approximately: characters). */
const foldLine = (l) => (l.length <= 75 ? l : l.match(/.{1,74}/g).join("\r\n "));

/**
 * The METHOD:REPLY that answers an invitation (RFC 5546 §3.2.3): the same
 * UID, SEQUENCE, DTSTART and ORGANIZER, and one ATTENDEE — you — with your
 * answer. Returns null for anything that is not an invitation to answer.
 */
export function icsReply(invite, { email, name = "", status, now = new Date() }) {
  const partstat = PARTSTAT[status];
  if (!invite || !invite.uid || !partstat || !invite.rawOrganizer) return null;
  const cn = String(name || "").replace(/[";:,\r\n]/g, "").trim();
  const out = [
    "BEGIN:VCALENDAR",
    "PRODID:-//dmzs-mail//EN",
    "VERSION:2.0",
    "METHOD:REPLY",
    "BEGIN:VEVENT",
    `UID:${invite.uid}`,
    `SEQUENCE:${invite.sequence || 0}`,
    `DTSTAMP:${stamp(now)}`,
    invite.rawStart,
    invite.rawRecurrence,
    invite.rawOrganizer,
    `ATTENDEE;PARTSTAT=${partstat}${cn ? `;CN="${cn}"` : ""}:mailto:${email}`,
    invite.summary ? `SUMMARY:${invite.summary.replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n")}` : "",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);
  return out.map(foldLine).join("\r\n") + "\r\n";
}

/**
 * Indexes or removes an invitation in the events table for the timeline.
 */
export async function indexEvent(env, messageId, accountId, calendarText, fallbackSubject = "") {
  if (!env?.DB || !messageId) return null;
  if (!calendarText) {
    await env.DB.prepare("DELETE FROM events WHERE id=?").bind(messageId).run().catch(() => {});
    return null;
  }
  const inv = parseIcs(calendarText);
  if (!inv || !inv.start) {
    await env.DB.prepare("DELETE FROM events WHERE id=?").bind(messageId).run().catch(() => {});
    return null;
  }
  const org = inv.organizer ? (inv.organizer.name ? `${inv.organizer.name} <${inv.organizer.email}>` : inv.organizer.email) : "";
  const endMs = inv.end ? inv.end.ms : (inv.start.ms + 3600_000);
  const status = inv.method === "CANCEL" || inv.status === "CANCELLED" ? "CANCELLED" : (inv.status || "CONFIRMED");
  await env.DB.prepare(
    `INSERT INTO events (id, account_id, uid, summary, location, description, url, start_ms, end_ms, all_day, status, organizer, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       summary=excluded.summary,
       location=excluded.location,
       description=excluded.description,
       url=excluded.url,
       start_ms=excluded.start_ms,
       end_ms=excluded.end_ms,
       all_day=excluded.all_day,
       status=excluded.status,
       organizer=excluded.organizer`
  ).bind(
    messageId,
    accountId,
    inv.uid || messageId,
    (inv.summary || fallbackSubject || "Meeting").slice(0, 300),
    (inv.location || "").slice(0, 300),
    (inv.description || "").slice(0, 1000),
    (inv.url || "").slice(0, 500),
    inv.start.ms,
    endMs,
    inv.start.allDay ? 1 : 0,
    status,
    org.slice(0, 200),
    Date.now()
  ).run().catch(() => {});
  return inv;
}
