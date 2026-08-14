/**
 * SMTP submission over a Worker socket.
 *
 * The counterpart to imap.js: reading iCloud moved into the Worker, so sending
 * has to as well, or half the mailbox still depends on a machine at home.
 * Apple's submission host answers on 587 with STARTTLS, verified directly:
 *
 *   220 iCloud SMTP - outbound.st.icloud.com
 *
 * Enough of RFC 5321 to hand over one message: EHLO, AUTH PLAIN, MAIL, RCPT,
 * DATA. No pipelining, no 8BITMIME negotiation, no DSN — buildRfc822 already
 * emits 7-bit-safe base64 bodies, so there is nothing to negotiate.
 */

import { connect } from "cloudflare:sockets";
import { b64encode } from "./mime.js";

const CRLF = "\r\n";
const REPLY_MS = 20_000;

const latin1 = (bytes) => new TextDecoder("latin1").decode(bytes);

class Smtp {
  constructor(socket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.encoder = new TextEncoder();
    this.buf = new Uint8Array(0);
  }

  async _fill() {
    if (this.dead) throw new Error("SMTP connection already closed");
    const { value, done } = await this.reader.read();
    if (done || !value) throw new Error("SMTP connection closed by server");
    const next = new Uint8Array(this.buf.length + value.length);
    next.set(this.buf, 0);
    next.set(value, this.buf.length);
    this.buf = next;
  }

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

  /**
   * One reply, however many lines it spans.
   *
   * A multi-line reply marks continuation with a hyphen in the fourth column
   * (`250-SIZE`) and the final line with a space (`250 HELP`). EHLO always
   * answers this way; reading a single line would leave the rest in the buffer
   * and every later command would read the previous command's leftovers.
   */
  async readReply() {
    const lines = [];
    const deadline = Date.now() + REPLY_MS;
    for (;;) {
      // A racing timeout would leave an orphaned read holding the stream, and
      // that orphan is what later rejects as "Stream was cancelled". Checking
      // a deadline between lines keeps exactly one read outstanding.
      if (Date.now() > deadline) throw new Error("SMTP reply timed out");
      const line = await this.readLine();
      lines.push(line);
      if (/^\d{3} /.test(line)) break;
      if (!/^\d{3}-/.test(line)) break; // not a reply at all; stop rather than hang
    }
    return { code: Number(lines[lines.length - 1].slice(0, 3)), lines };
  }

  async write(s) {
    await this.writer.write(this.encoder.encode(s));
  }

  /** Sends a command and insists on an expected reply class. */
  async cmd(line, expect, { secret = false } = {}) {
    if (line !== null) await this.write(line + CRLF);
    const reply = await this.readReply();
    if (!expect.includes(reply.code)) {
      const what = secret ? line.split(" ")[0] : String(line).slice(0, 40);
      throw new Error(`SMTP ${what}: ${reply.lines.join(" ").slice(0, 160)}`);
    }
    return reply;
  }

  /**
   * Hands the underlying socket back unlocked, for the STARTTLS upgrade.
   *
   * `startTls()` requires that neither stream be locked, and returns a *new*
   * socket — so these streams are finished, but the connection is not, and
   * closing it here would drop the very connection being upgraded.
   */
  detach() {
    this.dead = true;
    try {
      this.reader.releaseLock();
    } catch {
      /* nothing held it */
    }
    try {
      this.writer.releaseLock();
    } catch {
      /* nothing held it */
    }
  }

  /**
   * Shut down in the order the streams want.
   *
   * Closing the socket while a reader still holds a lock surfaces as
   * "Stream was cancelled" — an error about plumbing that says nothing about
   * the mail. Release the locks first and that never happens; and once `dead`
   * is set, any read still in flight fails with something meaningful.
   */
  async quit() {
    this.dead = true;
    try {
      await this.writer.write(this.encoder.encode("QUIT" + CRLF));
    } catch {
      /* going away anyway */
    }
    try {
      await this.writer.close();
    } catch {
      /* half-closed already */
    }
    try {
      this.reader.releaseLock();
    } catch {
      /* nothing held it */
    }
    try {
      await this.socket.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Connect, greet, authenticate, hang up. Sends nothing.
 *
 * Separates "can this Worker reach Apple and log in" from "was this particular
 * message accepted", which a failed send conflates into one unhelpful error.
 * Returns every reply verbatim so a rejection names itself.
 */
/**
 * Connects on 587, upgrades to TLS, authenticates. Returns a ready session.
 *
 * Not 465. Implicit TLS on 465 answered a banner when this was first built and
 * stopped being reachable from Workers afterwards — timeouts, then "proxy
 * request failed". 587 with STARTTLS works and is the standard submission port
 * anyway, so nothing is lost by preferring it.
 */
async function smtpConnect({ host = "smtp.mail.me.com", port = 587, user, pass }, trace = []) {
  const plain = connect({ hostname: host, port }, { secureTransport: "starttls" });
  let s = new Smtp(plain);

  trace.push({ step: "greeting", ...(await s.cmd(null, [220])) });
  trace.push({ step: "ehlo", ...(await s.cmd("EHLO dmzs-mail", [250])) });
  trace.push({ step: "starttls", ...(await s.cmd("STARTTLS", [220])) });

  // Locks off before the upgrade, then everything continues on the new socket.
  s.detach();
  s = new Smtp(plain.startTls());

  // The handshake resets the session: capabilities announced in the clear
  // cannot be trusted, so the server requires EHLO again before anything else.
  trace.push({ step: "ehlo-tls", ...(await s.cmd("EHLO dmzs-mail", [250])) });

  const token = b64encode(new TextEncoder().encode(`\0${user}\0${pass}`));
  try {
    trace.push({ step: "auth", ...(await s.cmd(`AUTH PLAIN ${token}`, [235], { secret: true })) });
  } catch (e) {
    e.reauth = true; // a rejected app password is the user's to fix
    throw e;
  }
  return s;
}

export async function smtpCheck(opts) {
  const trace = [];
  let s = null;
  try {
    s = await smtpConnect(opts, trace);
    return { ok: true, trace };
  } catch (e) {
    return { ok: false, failedAt: trace.length, error: String(e.message || e).slice(0, 300), trace };
  } finally {
    if (s) await s.quit();
  }
}

/**
 * Hands one message to Apple for delivery.
 *
 * `raw` is a complete RFC 822 message from buildRfc822, and the same bytes are
 * appended to the Sent mailbox afterwards, so the copy you keep is the message
 * that was actually delivered. `to` is the real envelope: recipients come from
 * it, not from parsing headers back out of the message.
 */
export async function smtpSend({ host, port, user, pass, from, to, raw }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) throw new Error("SMTP: no recipient");

  const s = await smtpConnect({ host, port, user, pass });
  try {
    await s.cmd(`MAIL FROM:<${from}>`, [250]);
    for (const rcpt of recipients) await s.cmd(`RCPT TO:<${rcpt}>`, [250, 251]);
    await s.cmd("DATA", [354]);

    // Dot-stuffing: a line consisting of a single dot ends the message, so any
    // line that genuinely starts with one has to be doubled or the mail is
    // truncated exactly there.
    const body = String(raw).replace(/\r?\n/g, CRLF).replace(/^\./gm, "..");
    await s.write(body + (body.endsWith(CRLF) ? "" : CRLF) + "." + CRLF);
    await s.cmd(null, [250]);
  } finally {
    await s.quit();
  }
}
