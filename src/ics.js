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

/** The offset (ms) of a named zone at a moment, from Intl — null if the name is not IANA. */
function zoneOffset(tz, utcMs) {
  try {
    const f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
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
 * Z means UTC. A TZID is looked up with Intl when it is an IANA name; the
 * Windows names Outlook writes ("Romance Standard Time") are not, so the
 * VTIMEZONE in the same file is used instead — its summer offset from April
 * to October, its winter one otherwise, which is right for every zone that
 * changes clocks in March and October and close enough to show an invite.
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
  const zone = zones[tz];
  if (zone) {
    const summer = +mo >= 4 && +mo <= 10;
    return { ms: wall - (summer ? zone.daylight ?? zone.standard : zone.standard ?? zone.daylight), allDay: false };
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
  return {
    method,
    uid: one("UID")?.value || "",
    sequence: Number(one("SEQUENCE")?.value || 0),
    summary: unescapeText(one("SUMMARY")?.value),
    location: unescapeText(one("LOCATION")?.value),
    description: unescapeText(one("DESCRIPTION")?.value).slice(0, 2000),
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
