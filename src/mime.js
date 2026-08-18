/**
 * Mail plumbing: RFC 2047 headers, quoted-printable, addresses, message
 * building and HTML defusing.
 *
 * Pure string functions, no Workers API, tested by `node test.mjs` — same
 * contract as util.js/feed.js in dmzs-music.
 */

/* ── bytes and base64 ── */

export const b64decode = (s) =>
  Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export function b64encode(bytes, url = false) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  const out = btoa(s);
  return url ? out.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : out;
}

const decodeCharset = (bytes, charset) => {
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes); // unknown charset: utf-8 and hope
  }
};

/* ── RFC 2047 encoded words: =?utf-8?B?...?= and =?iso-8859-1?Q?...?= ── */

function decodeWord(charset, enc, data) {
  if (enc.toUpperCase() === "B") return decodeCharset(b64decode(data), charset);
  // Q: like quoted-printable, plus "_" means space.
  const bytes = [];
  const s = data.replace(/_/g, " ");
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9a-f]{2}$/i.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(s.charCodeAt(i));
  }
  return decodeCharset(new Uint8Array(bytes), charset);
}

export function decodeWords(input) {
  const s = String(input ?? "");
  // Whitespace BETWEEN two encoded words is ignored per the RFC, which is
  // what keeps a long UTF-8 subject from growing spurious spaces.
  return s
    .replace(/(=\?[^?]+\?[BQ]\?[^?]*\?=)\s+(?==\?)/gi, "$1")
    .replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (m, cs, enc, data) => {
      try {
        return decodeWord(cs, enc, data);
      } catch {
        return m;
      }
    });
}

/* ── quoted-printable bodies ── */

/** Quoted-printable → raw bytes, before any charset is applied. */
export function qpBytes(input) {
  const s = String(input ?? "").replace(/=\r?\n/g, ""); // soft line breaks
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "=" && /^[0-9a-f]{2}$/i.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(s.charCodeAt(i) & 0xff);
  }
  return new Uint8Array(bytes);
}

export function qpDecode(input, charset = "utf-8") {
  return decodeCharset(qpBytes(input), charset);
}

/* ── addresses ── */

/** `"Jean Dupont" <jean@x.fr>` | `jean@x.fr` | `Jean <jean@x.fr>` → {name, email} */
export function parseAddress(input) {
  const s = decodeWords(String(input ?? "").trim());
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(s);
  if (angle) {
    const name = s.slice(0, angle.index).replace(/^["']|["']\s*$/g, "").replace(/"/g, "").trim();
    return { name, email: angle[1].toLowerCase() };
  }
  const bare = /([^\s"<>]+@[^\s"<>]+)/.exec(s);
  return { name: "", email: bare ? bare[1].toLowerCase() : "" };
}

/** Splits an address header on commas that sit outside quotes and <>. */
export function parseAddressList(input) {
  const s = String(input ?? "");
  const parts = [];
  let cur = "", quoted = false, angle = false;
  for (const c of s) {
    if (c === '"') quoted = !quoted;
    else if (c === "<" && !quoted) angle = true;
    else if (c === ">" && !quoted) angle = false;
    if (c === "," && !quoted && !angle) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map(parseAddress).filter((a) => a.email);
}

/* ── blocked senders ── */

/**
 * Whether one sender address falls under one blocking rule.
 *
 * A rule is either a whole address, which matches only itself, or a bare
 * domain, which takes its subdomains with it — `tiktok.com` has to cover
 * `sellersupport@shop.tiktok.com`, because a sender who owns a domain owns
 * every name under it and would otherwise only have to move one label left.
 *
 * The dot in `.` + pattern is what keeps that from over-reaching: without it
 * `tiktok.com` would also match `nottiktok.com`, and the rule destroys mail
 * permanently, so a near-miss is not a cosmetic error.
 */
export function blockMatches(email, pattern) {
  const e = String(email ?? "").trim().toLowerCase();
  // A rule written "@tiktok.com" means the domain, not a nameless address.
  const p = String(pattern ?? "").trim().toLowerCase().replace(/^@/, "");
  if (!e || !p) return false;
  if (p.includes("@")) return e === p;

  const at = e.lastIndexOf("@");
  if (at === -1) return false;
  const host = e.slice(at + 1);
  return host === p || host.endsWith("." + p);
}

/** True for something that can safely become a rule: an address, or a domain. */
export function isBlockPattern(s) {
  const p = String(s ?? "").trim().toLowerCase().replace(/^@/, "");
  if (p.length < 4 || p.length > 200 || /\s/.test(p)) return false;
  if (p.includes("@")) return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(p);
  // At least two labels, so a bare TLD cannot become a rule that eats
  // everything from .com. Written without a quantifier inside a quantifier:
  // the nested form backtracks exponentially on a near-miss, and this runs on
  // a string that arrived over the wire.
  return /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*\.[a-z]{2,}$/.test(p);
}

/* ── subjects and threading ── */

/** Strips any pile of Re:/Fwd:/RE :/Tr: prefixes, for thread grouping. */
export function normalizeSubject(s) {
  return String(s ?? "")
    .replace(/^(\s*(re|fwd?|fw|tr)\s*(\[\d+\])?\s*:\s*)+/i, "")
    .trim()
    .toLowerCase();
}

/* ── outgoing mail ── */

const needsEncoding = (s) => /[^\x20-\x7e]/.test(s);

/** RFC 2047 B-encoding for a header value, only when it has to. */
export function encodeHeader(s) {
  const v = String(s ?? "");
  if (!needsEncoding(v)) return v;
  return `=?utf-8?B?${b64encode(new TextEncoder().encode(v))}?=`;
}

/** UTF-8 → base64, wrapped at 76 chars, which keeps old SMTP servers happy. */
const b64Body = (s) =>
  (b64encode(new TextEncoder().encode(String(s ?? ""))).match(/.{1,76}/g) || [""]).join("\r\n");

/** Rough plain-text rendering of HTML, for the alternative part. */
export function htmlToText(html) {
  return String(html ?? "")
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** RFC 5322 date: `Thu, 14 Aug 2026 08:53:40 +0000`. */
export function rfc822Date(d = new Date()) {
  const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${DAY[d.getUTCDay()]}, ${p(d.getUTCDate())} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`
  );
}

/**
 * A Message-ID for outgoing mail.
 *
 * This is a message's identity: it is what threads a reply at the recipient's
 * end, and what this app searches IMAP by when it later needs to find the
 * message again — to star it, move it, or read its body. A message sent without
 * one is unfindable afterwards, and every such message hashes to the same local
 * id, so they overwrite each other.
 */
export function newMessageId(from) {
  const domain = String(from || "").split("@")[1] || "dmzs-mail.invalid";
  const rand = [...crypto.getRandomValues(new Uint8Array(12))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `<${Date.now().toString(36)}.${rand}@${domain}>`;
}

/** A boundary that cannot occur in the content it delimits. */
const newBoundary = (tag) =>
  `dmzs-${tag}-` +
  [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * A complete RFC 822 message, UTF-8, base64 body — what goes out over SMTP,
 * and the same bytes that get appended to the Sent mailbox afterwards.
 *
 * There is deliberately no `bcc`. A Bcc header written here would travel
 * intact to every recipient, which is the exact opposite of blind; blind
 * recipients belong in the SMTP envelope and nowhere else. The parameter used
 * to exist because one API read the header and stripped it before delivery —
 * that API is gone, and leaving the parameter behind would be leaving a
 * loaded foot-gun for whoever next passes it in good faith.
 */
export function buildRfc822({
  from, to, cc, draftBcc, subject, text, html, attachments, inReplyTo, references,
  messageId, date,
}) {
  const lines = [`From: ${from}`, `To: ${to}`];
  if (cc) lines.push(`Cc: ${cc}`);
  // Deliberately not called `bcc`.
  //
  // A `bcc` handed to this function is ignored and always has been, because
  // blind recipients belong in the SMTP envelope and nowhere else — writing
  // them into the bytes is precisely how a Bcc stops being blind, and a caller
  // passing the field by mistake must not be able to cause that. There are
  // tests holding that line.
  //
  // A draft is the one message that is sent to nobody, and its Bcc header is
  // how the field survives the composer being closed and reopened. That needs
  // a name no one reaches for by accident.
  if (draftBcc) lines.push(`Bcc: ${draftBcc}`);
  // Date and Message-ID are not optional decoration: a message without them is
  // scored as spam by most receivers, threads nowhere, and — because the local
  // id is derived from the Message-ID — cannot be told apart from every other
  // message sent without one.
  lines.push(
    `Subject: ${encodeHeader(subject || "")}`,
    `Date: ${date || rfc822Date()}`,
    `Message-ID: ${messageId || newMessageId(from)}`,
    "MIME-Version: 1.0"
  );
  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`);
    lines.push(`References: ${(references ? references + " " : "") + inReplyTo}`.trim());
  }

  const files = (attachments || []).filter((a) => a && a.filename && a.data);

  /**
   * The readable content, as its own MIME entity: either a lone text part or
   * the text+HTML pair. Returned as headers-plus-body rather than a finished
   * message, so multipart/mixed can nest it whole when files are attached.
   */
  const bodyEntity = () => {
    if (!html) {
      return {
        headers: ['Content-Type: text/plain; charset="utf-8"', "Content-Transfer-Encoding: base64"],
        // CRLF-terminated, like every other branch: SMTP ends DATA with
        // \r\n.\r\n, so a body without the final break would run its last
        // base64 line into the terminating dot.
        content: b64Body(text) + "\r\n",
      };
    }
    // multipart/alternative, simplest part first: that ordering is the whole
    // contract — a reader takes the last part it understands, so HTML must come
    // second or rich clients would show the stripped version.
    const alt = newBoundary("alt");
    const part = (type, payload) =>
      `--${alt}\r\nContent-Type: text/${type}; charset="utf-8"\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n${b64Body(payload)}\r\n`;
    return {
      headers: [`Content-Type: multipart/alternative; boundary="${alt}"`],
      content: part("plain", text || htmlToText(html)) + part("html", html) + `--${alt}--\r\n`,
    };
  };

  const body = bodyEntity();
  if (!files.length) return lines.concat(body.headers).join("\r\n") + "\r\n\r\n" + body.content;

  // With files, the message becomes multipart/mixed: the readable part first,
  // then one part per file. Mixed rather than alternative — these are not
  // different renderings of the same thing, they are separate things.
  const mixed = newBoundary("mix");
  lines.push(`Content-Type: multipart/mixed; boundary="${mixed}"`);

  const filePart = (f) => {
    const name = encodeHeader(f.filename);
    return (
      `--${mixed}\r\n` +
      `Content-Type: ${f.type || "application/octet-stream"}; name="${name}"\r\n` +
      `Content-Disposition: attachment; filename="${name}"\r\n` +
      "Content-Transfer-Encoding: base64\r\n\r\n" +
      // Already base64 from the browser; only re-wrap it to 76 columns.
      (String(f.data).replace(/\s+/g, "").match(/.{1,76}/g) || [""]).join("\r\n") +
      "\r\n"
    );
  };

  return (
    lines.join("\r\n") +
    "\r\n\r\n" +
    `--${mixed}\r\n${body.headers.join("\r\n")}\r\n\r\n${body.content}` +
    files.map(filePart).join("") +
    `--${mixed}--\r\n`
  );
}

/* ── incoming HTML, defused ── */

const escHtml = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Plain text becomes minimal HTML: escaped, line breaks kept, links tappable. */
export function textToHtml(t) {
  const linked = escHtml(t).replace(
    /(https?:\/\/[^\s<>"']+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  return `<div style="white-space:pre-wrap;word-break:break-word">${linked}</div>`;
}

/**
 * Server-side defusing of message HTML. The real security boundary is the
 * sandboxed iframe the client renders into (no scripts, no same-origin), so
 * this is belt and braces — plus the one thing the sandbox cannot do:
 * blocking remote images, which are how senders track opens. Remote loads
 * are rewritten to data-blocked-src; the client swaps them back behind a
 * "Load images" tap.
 *
 * Returns { html, blocked } where blocked counts neutralized remote loads.
 */
export function sanitizeHtml(input) {
  let html = String(input ?? "");
  let blocked = 0;

  // Whole elements whose content must not survive.
  html = html.replace(/<(script|iframe|object|embed|title)\b[\s\S]*?<\/\1\s*>/gi, "");

  /**
   * <style> is kept, not deleted.
   *
   * It used to go the way of <script>, content and all. But mail is laid out
   * in CSS as often as in tags, and a very common pattern ships a block
   * hidden inline — `style="display:none"` — and reveals it from a rule in
   * <style>. Delete the rule and the message does not merely lose its
   * styling: it renders as an entirely blank white page, with the text
   * sitting right there in the source, permanently hidden.
   *
   * The sandboxed iframe already denies CSS anything dangerous — no scripts,
   * no same-origin, nothing to exfiltrate to. What CSS *can* still do is
   * fetch, which is how a sender learns you opened their mail, so remote
   * url() and @import are what actually gets removed here.
   */
  html = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, (_m, css) => {
    const cleaned = String(css)
      .replace(/@import[^;}]*;?/gi, () => {
        blocked++;
        return "";
      })
      .replace(/url\(\s*['"]?\s*(?:https?:)?\/\/[^)]*\)/gi, () => {
        blocked++;
        return "none";
      });
    return `<style>${cleaned}</style>`;
  });
  // An unclosed <style> makes everything after it CSS as far as a browser is
  // concerned, so dropping the remainder is what actually renders, not a
  // heavy-handed choice. The lookahead is what keeps this from eating the
  // well-formed blocks the line above just rewrote — every one of those ends
  // in a </style>, so only a genuinely unterminated one matches.
  html = html.replace(/<style\b[^>]*>(?![\s\S]*?<\/style\s*>)[\s\S]*$/i, "");

  // Void/opening tags that have no business in a message. `style` is absent
  // deliberately — stripping the tags but not the rules would spill raw CSS
  // into the message as visible text.
  html = html.replace(/<\/?(script|iframe|object|embed|form|input|button|link|meta|base|svg|math)\b[^>]*>/gi, "");
  // Event handlers, style with url(), javascript: targets.
  //
  // `[\s/]` rather than `\s` throughout: browsers accept `<img/src=…>` as a
  // separator, so anchoring on whitespace alone leaves a way past every rule
  // below.
  html = html.replace(/[\s/]on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, " ");
  // Any style carrying url() goes entirely — quoted or bare. Dropped rather
  // than deferred: a CSS background is never the message, and unlike <img>
  // there is nothing meaningful to restore behind the Images tap.
  html = html.replace(/[\s/]style\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, (m) =>
    /url\s*\(/i.test(m) ? " " : m
  );
  html = html.replace(/[\s/](href|src|action|formaction|background)\s*=\s*("javascript:[^"]*"|'javascript:[^']*'|javascript:[^\s>]+)/gi, " ");

  /**
   * Remote loads (images, mostly): neutralized, counted, reversible client-side.
   *
   * Values arrive quoted *or bare* — `src=https://tracker/p.gif` with no quotes
   * is valid HTML, and matching only the quoted form let it through untouched:
   * the pixel fired on open, and `blocked` stayed 0 so the Images button never
   * appeared to say otherwise. Match all three forms, then decide on the value.
   */
  const remote = (v) =>
    !/^[\x00-\x20]*(?:cid|data):/i.test(v) && // inline parts leak nothing
    /(?:^|[\s,])[\x00-\x20]*(?:https?:)?\/\//i.test(v); // ,/space covers srcset lists

  html = html.replace(
    /[\s/](src|srcset|background|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (m, attr, dq, sq, bare) => {
      const val = dq ?? sq ?? bare ?? "";
      if (!remote(val)) return m; // relative, cid:, data: — leave it alone
      blocked++;
      // Re-emitted quoted, so a bare value cannot break the tag on restore.
      return ` data-blocked-${attr.toLowerCase()}="${val.replace(/"/g, "&quot;")}"`;
    }
  );

  return { html, blocked };
}
