/**
 * IMAP over a Worker socket.
 *
 * Apple has no mail API, which is why v1 put a Python agent on a PC you own.
 * Workers can open outbound TLS sockets now, so the Worker can speak IMAP
 * itself and the PC stops mattering. Verified against Apple directly:
 *
 *   * OK [CAPABILITY XAPPLEPUSHSERVICE IMAP4rev1 SASL-IR AUTH=PLAIN ...]
 *
 * Only the subset this app needs: log in, list mailboxes, select one, search
 * by UID, fetch, set flags, move. No IDLE, no partial fetch, no SEARCH
 * charsets — the cron polls, so none of that earns its complexity.
 *
 * Everything is handled as latin1 strings: one char per byte, values intact,
 * so protocol parsing stays on plain strings and rfc822.js decides the real
 * charset once a part's own headers say what it is.
 */

import { connect } from "cloudflare:sockets";

const CRLF = "\r\n";
const GREETING_MS = 15_000;
const MAX_LITERAL = 8 * 1024 * 1024; // a single body larger than this is refused

const latin1 = (bytes) => new TextDecoder("latin1").decode(bytes);

/** IMAP quoted-string: backslash and quote are the only escapes. */
const quote = (s) => '"' + String(s ?? "").replace(/([\\"])/g, "\\$1") + '"';

class Imap {
  constructor(socket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.encoder = new TextEncoder();
    this.buf = new Uint8Array(0);
    this.seq = 0;
  }

  async _fill() {
    const { value, done } = await this.reader.read();
    if (done || !value) throw new Error("IMAP connection closed by server");
    const next = new Uint8Array(this.buf.length + value.length);
    next.set(this.buf, 0);
    next.set(value, this.buf.length);
    this.buf = next;
  }

  /** One CRLF-terminated line, without the terminator. */
  async readLine() {
    for (;;) {
      const nl = this.buf.indexOf(10);
      if (nl !== -1) {
        const line = latin1(this.buf.subarray(0, nl)).replace(/\r$/, "");
        this.buf = this.buf.subarray(nl + 1);
        return line;
      }
      await this._fill();
    }
  }

  /** Exactly n bytes, for a literal. */
  async readBytes(n) {
    if (n > MAX_LITERAL) throw new Error(`IMAP literal too large (${n} bytes)`);
    while (this.buf.length < n) await this._fill();
    const out = latin1(this.buf.subarray(0, n));
    this.buf = this.buf.subarray(n);
    return out;
  }

  /**
   * One logical response, literals resolved.
   *
   * A line ending in `{123}` means "the next 123 bytes are data, then the line
   * continues". Message bodies arrive that way and contain CRLFs of their own,
   * so reading naively line-by-line desynchronises the whole stream — every
   * later response is then parsed against the wrong bytes. Literals come back
   * separately rather than spliced in, so the caller reads structure from the
   * line and content from `literals`.
   */
  async readResponse() {
    const literals = [];
    const lines = [];
    let line = await this.readLine();
    lines.push(line);
    while (/\{(\d+)\}$/.test(line)) {
      literals.push(await this.readBytes(Number(/\{(\d+)\}$/.exec(line)[1])));
      line = await this.readLine();
      lines.push(line);
    }
    return { line: lines.join(" "), literals };
  }

  async write(s) {
    await this.writer.write(this.encoder.encode(s));
  }

  /** Sends a tagged command, returns every untagged response it produced. */
  async command(cmd, { secret = false } = {}) {
    const tag = "d" + String(++this.seq).padStart(4, "0");
    await this.write(tag + " " + cmd + CRLF);
    const untagged = [];
    for (;;) {
      const res = await this.readResponse();
      if (res.line.startsWith(tag + " ")) {
        const tail = res.line.slice(tag.length + 1);
        if (!/^OK\b/i.test(tail)) {
          // `secret` keeps an app password out of the error text on a failed
          // LOGIN, which would otherwise land in D1's last_error column.
          const what = secret ? cmd.split(" ")[0] : cmd.slice(0, 60);
          throw new Error(`IMAP ${what}: ${tail.slice(0, 160)}`);
        }
        return untagged;
      }
      untagged.push(res);
    }
  }

  /**
   * A command whose argument is a literal: `CMD … {n}` and then n bytes.
   *
   * `command()` cannot express this. It writes the line and waits for the
   * tagged reply, but a literal command gets `+` first — the server saying it
   * is ready for the bytes — and then both sides sit waiting for the other.
   */
  async commandLiteral(cmd, payload) {
    const bytes = this.encoder.encode(payload);
    if (bytes.length > MAX_LITERAL) throw new Error(`IMAP literal too large (${bytes.length} bytes)`);
    const verb = cmd.split(" ")[0];
    const tag = "d" + String(++this.seq).padStart(4, "0");
    await this.write(`${tag} ${cmd} {${bytes.length}}${CRLF}`);

    // Wait for the go-ahead. A tagged reply arriving instead of `+` is the
    // server refusing outright — a mailbox that does not exist, usually.
    for (;;) {
      const res = await this.readResponse();
      if (res.line.startsWith("+")) break;
      if (res.line.startsWith(tag + " ")) {
        throw new Error(`IMAP ${verb}: ${res.line.slice(tag.length + 1).slice(0, 160)}`);
      }
    }

    await this.writer.write(bytes);
    await this.write(CRLF);

    const untagged = [];
    for (;;) {
      const res = await this.readResponse();
      if (res.line.startsWith(tag + " ")) {
        const tail = res.line.slice(tag.length + 1);
        if (!/^OK\b/i.test(tail)) throw new Error(`IMAP ${verb}: ${tail.slice(0, 160)}`);
        return untagged;
      }
      untagged.push(res);
    }
  }

  async logout() {
    try {
      await this.command("LOGOUT");
    } catch {
      /* already gone */
    }
    try {
      await this.socket.close();
    } catch {
      /* already closed */
    }
  }
}

/** Connects, waits for the greeting, logs in. */
export async function imapOpen({ host = "imap.mail.me.com", port = 993, user, pass }) {
  const socket = connect({ hostname: host, port }, { secureTransport: "on" });
  const im = new Imap(socket);
  const greeting = await Promise.race([
    im.readResponse(),
    new Promise((_, rej) => setTimeout(() => rej(new Error("IMAP greeting timed out")), GREETING_MS)),
  ]);
  if (!/^\* OK/i.test(greeting.line)) throw new Error(`IMAP refused: ${greeting.line.slice(0, 120)}`);
  try {
    await im.command(`LOGIN ${quote(user)} ${quote(pass)}`, { secret: true });
  } catch (e) {
    await im.logout();
    // Apple says NO AUTHENTICATIONFAILED for a bad app password; that is the
    // user's problem to fix, not something to retry forever.
    e.reauth = /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(String(e.message));
    throw e;
  }
  return im;
}

/** The untouched LIST response, for working out why a mailbox went missing. */
export async function imapListRaw(im) {
  return (await im.command('LIST "" "*"')).map((r) => ({
    line: r.line,
    literals: r.literals.map((l) => l.slice(0, 80)),
  }));
}

/** Every selectable mailbox: [{ flags, name }]. */
export async function imapList(im) {
  const out = [];
  for (const { line, literals } of await im.command('LIST "" "*"')) {
    const m = /^\* LIST \(([^)]*)\)\s+(?:"([^"]*)"|NIL)\s+(.*)$/i.exec(line);
    if (!m) continue;
    let name = m[3].trim();
    if (name.startsWith('"')) name = name.slice(1, name.lastIndexOf('"'));
    else if (/^\{\d+\}/.test(name) && literals.length) name = literals[0];
    if (/\\Noselect/i.test(m[1])) continue;
    out.push({ flags: m[1], name });
  }
  return out;
}

/** SELECT, returning the numbers that decide whether a cursor is still valid. */
export async function imapSelect(im, mailbox) {
  const state = { uidvalidity: 0, uidnext: 0, exists: 0 };
  for (const { line } of await im.command(`SELECT ${quote(mailbox)}`)) {
    let m;
    // Anchored to the bracketed response code, and first match wins. Unanchored
    // with last-match-wins, any later line mentioning the word would overwrite
    // a good value — and a wrong UIDVALIDITY silently discards the whole
    // mailbox's cursor at the comparison in syncIcloud, forcing a full resync.
    if (!state.uidvalidity && (m = /\[UIDVALIDITY (\d+)\]/i.exec(line)))
      state.uidvalidity = Number(m[1]);
    if (!state.uidnext && (m = /\[UIDNEXT (\d+)\]/i.exec(line))) state.uidnext = Number(m[1]);
    if ((m = /^\* (\d+) EXISTS/i.exec(line))) state.exists = Number(m[1]);
  }
  return state;
}

/** UID SEARCH, e.g. `UID 120:*` or `ALL`. Returns UIDs ascending. */
export async function imapSearch(im, criteria) {
  for (const { line } of await im.command(`UID SEARCH ${criteria}`)) {
    const m = /^\* SEARCH(.*)$/i.exec(line);
    if (m) {
      return m[1]
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b);
    }
  }
  return [];
}

const UID_OF = (line) => Number((/UID (\d+)/i.exec(line) || [, 0])[1]);
const FLAGS_OF = (line) => (/FLAGS \(([^)]*)\)/i.exec(line) || [, ""])[1];

/**
 * Headers only, for a whole set of UIDs in one round trip.
 *
 * Sync never needs the body: the list shows sender, subject and date, and the
 * body is fetched when a message is opened. Pulling full bodies for a hundred
 * messages would blow both the time and the memory budget for no visible gain.
 */
export async function imapFetchHeaders(im, uidSet) {
  const rows = [];
  const responses = await im.command(
    `UID FETCH ${uidSet} (FLAGS BODY.PEEK[HEADER.FIELDS ` +
      `(FROM TO CC SUBJECT DATE MESSAGE-ID REFERENCES IN-REPLY-TO CONTENT-TYPE)])`
  );
  for (const { line, literals } of responses) {
    if (!/FETCH/i.test(line)) continue;
    const uid = UID_OF(line);
    if (!uid || !literals.length) continue;
    rows.push({ uid, flags: FLAGS_OF(line), head: literals[0] });
  }
  return rows;
}

/**
 * Flags and byte size for a set of UIDs, in one cheap round trip.
 *
 * Asking first is what stops a single 17 MB message wedging the account: it
 * would blow the literal ceiling, throw, and be retried on every pass forever,
 * because the cursor never advances past a message that never succeeds.
 */
export async function imapFetchMeta(im, uidSet) {
  const out = [];
  for (const { line } of await im.command(`UID FETCH ${uidSet} (FLAGS RFC822.SIZE)`)) {
    if (!/FETCH/i.test(line)) continue;
    const uid = UID_OF(line);
    if (uid) {
      out.push({
        uid,
        flags: FLAGS_OF(line),
        size: Number((/RFC822\.SIZE (\d+)/i.exec(line) || [, 0])[1]),
      });
    }
  }
  return out;
}

/**
 * The message's shape, without its content.
 *
 * BODYSTRUCTURE describes every part — type, encoding, size, filename — in a
 * few hundred bytes, however large the message is. That is what makes a 26 MB
 * mail readable: fetch the structure, find the 2 KB HTML part, fetch only
 * that, and leave the 26 MB attachment on the server until asked for.
 */
export async function imapFetchStructure(im, uid) {
  for (const { line } of await im.command(`UID FETCH ${uid} (BODYSTRUCTURE)`)) {
    const at = line.search(/BODYSTRUCTURE\s*\(/i);
    if (at === -1) continue;
    // Balance the parens by hand: the structure is nested and ends before the
    // FETCH response's own closing bracket, which a greedy regex would eat.
    const start = line.indexOf("(", at);
    let depth = 0;
    let quoted = false;
    for (let i = start; i < line.length; i++) {
      const c = line[i];
      if (quoted) {
        if (c === "\\") i++;
        else if (c === '"') quoted = false;
        continue;
      }
      if (c === '"') quoted = true;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return line.slice(start, i + 1);
    }
  }
  return null;
}

/** Headers alone — enough to list a message whose body is too big to hold. */
export async function imapFetchHead(im, uid) {
  for (const { line, literals } of await im.command(`UID FETCH ${uid} (FLAGS BODY.PEEK[HEADER])`)) {
    if (!/FETCH/i.test(line) || !literals.length) continue;
    return { uid: UID_OF(line) || uid, flags: FLAGS_OF(line), raw: literals[0] };
  }
  return null;
}

/** One whole message, raw RFC 822, for rfc822.parseMessage. */
export async function imapFetchRaw(im, uid) {
  for (const { line, literals } of await im.command(`UID FETCH ${uid} (FLAGS BODY.PEEK[])`)) {
    if (!/FETCH/i.test(line) || !literals.length) continue;
    return { uid: UID_OF(line) || uid, flags: FLAGS_OF(line), raw: literals[0] };
  }
  return null;
}

/**
 * One MIME part, still encoded.
 *
 * The whole point of tracking part paths: a 40 KB PDF inside a 17 MB message
 * costs 40 KB to fetch, not 17 MB. Without this an attachment could only be
 * reached by pulling the entire message back down and re-parsing it.
 */
export async function imapFetchPart(im, uid, part) {
  for (const { line, literals } of await im.command(`UID FETCH ${uid} (BODY.PEEK[${part}])`)) {
    if (!/FETCH/i.test(line) || !literals.length) continue;
    return literals[0];
  }
  return null;
}

/**
 * Writes a message into a mailbox. This is how a sent message reaches Sent.
 *
 * SMTP hands the message to the recipient's server and keeps nothing for the
 * sender — unlike Gmail's API, which files the copy itself. Every mail client
 * appends its own, and one that does not has a Sent folder that stays empty
 * however much mail leaves it.
 */
export const imapAppend = (im, mailbox, raw, flags = "\\Seen") =>
  im.commandLiteral(`APPEND ${quote(mailbox)} (${flags})`, raw);

export const imapFlag = (im, uid, flag, on) =>
  im.command(`UID STORE ${uid} ${on ? "+" : "-"}FLAGS (${flag})`);

/**
 * MOVE if the server has it, otherwise the old copy/delete/expunge dance.
 * Apple supports MOVE; the fallback is for the day it doesn't.
 */
export async function imapMove(im, uid, dest) {
  try {
    await im.command(`UID MOVE ${uid} ${quote(dest)}`);
  } catch {
    await im.command(`UID COPY ${uid} ${quote(dest)}`);
    await im.command(`UID STORE ${uid} +FLAGS (\\Deleted)`);
    await im.command("EXPUNGE");
  }
}

/* ── mailbox management ── */

export const imapCreate = (im, name) => im.command(`CREATE ${quote(name)}`);
export const imapRename = (im, from, to) => im.command(`RENAME ${quote(from)} ${quote(to)}`);

/**
 * DELETE removes the mailbox *and everything in it*, permanently — there is no
 * IMAP equivalent of moving a folder to the bin. Callers are expected to have
 * said so out loud before getting here.
 */
export const imapDelete = (im, name) => im.command(`DELETE ${quote(name)}`);

/**
 * Empties a mailbox: flags everything deleted, then expunges.
 *
 * Permanent. EXPUNGE is the point at which mail stops existing anywhere, and
 * IMAP offers no undo — the caller is expected to have made that clear.
 * Returns how many messages were removed.
 */
/**
 * Removes one message for good.
 *
 * UID EXPUNGE first: plain EXPUNGE removes *every* message flagged \Deleted in
 * the mailbox, so a stray flag left by another client would take unrelated mail
 * with it. The fallback only runs on servers without UIDPLUS.
 */
export async function imapPurge(im, uid) {
  await im.command(`UID STORE ${uid} +FLAGS (\\Deleted)`);
  try {
    await im.command(`UID EXPUNGE ${uid}`);
  } catch {
    await im.command("EXPUNGE");
  }
}

export async function imapEmpty(im, name) {
  const { exists } = await imapSelect(im, name);
  if (!exists) return 0;
  await im.command("STORE 1:* +FLAGS (\\Deleted)");
  await im.command("EXPUNGE");
  return exists;
}

export { quote as imapQuote };
