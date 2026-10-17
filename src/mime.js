/**
 * Mail plumbing: RFC 2047 headers, quoted-printable, addresses, message
 * building and HTML defusing.
 *
 * Pure string functions, no Workers API, tested by `node test.mjs`.
 */

/* ── bytes and base64 ── */

/**
 * Lenient on purpose: atob throws on anything off-spec, and mail is full of
 * it — a part cut short, two encoded chunks glued together with padding in
 * the middle. One throw here used to stop the whole sync on that message,
 * every minute, for good. What decodes is kept; the junk is dropped.
 */
export const b64decode = (s) => {
  // Padding in the middle ends one chunk and starts the next, so each chunk
  // is decoded on its own rather than run together out of alignment.
  const chunks = String(s).replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/=]/g, "").split(/=+/);
  let bin = "";
  for (let t of chunks) {
    if (t.length % 4 === 1) t = t.slice(0, -1);
    if (t) bin += atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  }
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

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

/**
 * A run of header text that was not encoded → what it says.
 *
 * Headers reach here one char per byte, so a raw UTF-8 header (RFC 6532,
 * `Subject: café` sent as is, which plenty of mailers now do) arrives as
 * "cafÃ©". Bytes that form valid UTF-8 are read as UTF-8; anything else is
 * left as latin1, which it already is. A run holding a char above 0xFF is not
 * bytes at all but text something already decoded, and is left alone.
 */
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
function rawHeaderText(s) {
  if (!/[\x80-\xff]/.test(s) || /[^\x00-\xff]/.test(s)) return s;
  try {
    return STRICT_UTF8.decode(Uint8Array.from(s, (c) => c.charCodeAt(0)));
  } catch {
    return s;
  }
}

export function decodeWords(input) {
  // Whitespace BETWEEN two encoded words is ignored per the RFC, which is
  // what keeps a long UTF-8 subject from growing spurious spaces.
  const s = String(input ?? "").replace(/(=\?[^?]+\?[BQ]\?[^?]*\?=)\s+(?==\?)/gi, "$1");
  let out = "";
  let at = 0;
  for (const m of s.matchAll(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi)) {
    out += rawHeaderText(s.slice(at, m.index));
    try {
      out += decodeWord(m[1], m[2], m[3]);
    } catch {
      out += m[0];
    }
    at = m.index + m[0].length;
  }
  return out + rawHeaderText(s.slice(at));
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

/**
 * Strips quotes from around an address, and only from around it.
 *
 * Outlook writes a recipient it could not resolve to a display name as
 * 'someone@example.com', apostrophes included, and that is what everyone on
 * the thread then copies into their Cc. Left on, it reaches Apple as
 * RCPT TO:<'someone@example.com'> and the whole send fails with
 * 501 5.1.3 Bad recipient address syntax — one stray character, and the
 * message goes nowhere until the quotes are deleted by hand.
 *
 * The outside only: an apostrophe is legal inside a local part, so
 * o'brien@x.fr has to come through untouched.
 */
const unquote = (s) => String(s).replace(/^['"]+/, "").replace(/['"]+$/, "");

/** `"Jean Dupont" <jean@x.fr>` | `jean@x.fr` | `Jean <jean@x.fr>` → {name, email} */
export function parseAddress(input) {
  // The address is found before anything is decoded, and only the name is
  // decoded after. Decoding first let an encoded display name carry an
  // address of its own — =?utf-8?B?…?= standing for "PayPal
  // <service@paypal.com>" — and that one was taken as the sender, ahead of
  // the real address sitting after it.
  const raw = String(input ?? "").trim();
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(raw);
  if (angle) {
    const name = decodeWords(raw.slice(0, angle.index)).replace(/^["']|["']\s*$/g, "").replace(/"/g, "").trim();
    return { name, email: unquote(angle[1]).toLowerCase() };
  }
  const bare = /([^\s"<>]+@[^\s"<>]+)/.exec(raw) || /([^\s"<>]+@[^\s"<>]+)/.exec(decodeWords(raw));
  return { name: "", email: bare ? unquote(bare[1]).toLowerCase() : "" };
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

/** Every `<id>` in a Message-ID, In-Reply-To or References value, in order. */
export const messageIds = (s) => String(s ?? "").match(/<[^<>\s]+>/g) || [];

/**
 * The conversation a message belongs to, from its headers.
 *
 * The root's own Message-ID is what every reply carries first in References,
 * so a root keys on that and its replies land beside it. Keying a root on its
 * subject instead — which is what this used to do — put the original in one
 * group and every answer to it in another. In-Reply-To covers the mailers
 * that send no References; the subject is left only for mail with no ids at
 * all.
 */
export function threadKeyOf(headers) {
  const h = headers || {};
  return (
    messageIds(h.references)[0] ||
    messageIds(h["in-reply-to"])[0] ||
    messageIds(h["message-id"])[0] ||
    normalizeSubject(decodeWords(h.subject || ""))
  );
}

/**
 * A References chain kept short enough for a header: the root, then the most
 * recent ids. RFC 5322 §3.6.4 allows trimming the middle; the root is the one
 * id every client threads on, so it is never the one dropped.
 */
export function trimReferences(ids, max = 20) {
  const seen = new Set();
  const list = ids.filter((id) => !seen.has(id) && seen.add(id));
  return list.length > max ? [list[0], ...list.slice(-(max - 1))] : list;
}

/**
 * What a reply to `parent` carries in References: the parent's own chain with
 * the parent's Message-ID at the end.
 *
 * `refs` is the chain stored with the row. Rows stored before it was are
 * missing it, and for those the thread key — the root of the conversation —
 * is the best ancestor known.
 */
export function replyReferences(parent) {
  if (!parent) return [];
  const mid = messageIds(parent.mid)[0];
  let chain = messageIds(parent.refs);
  if (!chain.length) chain = messageIds(parent.thread_key).slice(0, 1);
  return trimReferences(mid ? [...chain, mid] : chain);
}

/* ── outgoing mail ── */

const needsEncoding = (s) => /[^\x20-\x7e]/.test(s);

/**
 * RFC 2047 B-encoding for a header value, only when it has to.
 *
 * In words of at most 45 bytes, split on character boundaries, so no encoded
 * word passes the 75 characters the RFC allows and none cuts a character in
 * two. Space-separated: decoders join adjacent encoded words, and fold() can
 * break the line there.
 */
export function encodeHeader(s) {
  const v = String(s ?? "");
  if (!needsEncoding(v)) return v;
  const enc = new TextEncoder();
  const words = [];
  let cur = "";
  for (const ch of v) {
    if (enc.encode(cur + ch).length > 45) {
      words.push(cur);
      cur = "";
    }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?utf-8?B?${b64encode(enc.encode(w))}?=`).join(" ");
}

/**
 * A From: value with a display name, when there is one worth showing.
 *
 * Quoted when it holds anything RFC 5322 treats as structure (a comma would
 * otherwise split one sender into two), encoded when it is not ASCII, and
 * left off entirely when it is empty or just the address again.
 */
export function formatFrom(name, email) {
  const n = String(name ?? "").replace(/[\r\n"<>]/g, "").trim();
  const e = String(email ?? "").trim();
  if (!n || n.toLowerCase() === e.toLowerCase()) return e;
  if (needsEncoding(n)) return `${encodeHeader(n)} <${e}>`;
  return /[()<>\[\]:;@\\,."]/.test(n) ? `"${n}" <${e}>` : `${n} <${e}>`;
}

/**
 * Folds a header line at 78 columns, breaking only at a space (after the
 * comma between two addresses, between encoded words, between References
 * ids). A long To: or References: line went out whole, and some servers
 * refuse lines past 998 characters outright.
 */
export function fold(line) {
  // Already folded somewhere upstream: each physical line on its own, or a
  // break would land on the space after an existing CRLF and leave an empty
  // line — which ends the headers.
  if (line.includes("\r\n")) return line.split("\r\n").map(fold).join("\r\n");
  if (line.length <= 78) return line;
  const out = [];
  let rest = line;
  while (rest.length > 78) {
    let at = rest.lastIndexOf(" ", 78);
    if (at <= 0) at = rest.indexOf(" ", 78);
    if (at <= 0) break;
    out.push(rest.slice(0, at));
    rest = rest.slice(at); // the space stays, as the continuation's indent
  }
  out.push(rest);
  return out.join("\r\n");
}

/**
 * A filename as MIME parameters: RFC 2231 `name*=utf-8''…` for readers that
 * know it, and a quoted fallback with its quotes and backslashes escaped —
 * a `"` in a filename used to end the parameter early.
 */
function fileParam(key, filename) {
  const name = String(filename);
  const plain = needsEncoding(name) ? encodeHeader(name) : name;
  const quoted = `${key}="${plain.replace(/(["\\])/g, "\\$1")}"`;
  if (!needsEncoding(name) && !/["\\]/.test(name)) return quoted;
  const pct = Array.from(new TextEncoder().encode(name), (b) =>
    /[A-Za-z0-9!#$&+.^_`|~-]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : "%" + b.toString(16).toUpperCase().padStart(2, "0")
  ).join("");
  return `${quoted}; ${key}*=utf-8''${pct}`;
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
  messageId, date, calendar,
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
    // The parent's chain, then the parent. Callers used to pass the parent's
    // id as `references` too, which sent `References: <p> <p>` and dropped
    // every earlier ancestor — so a client that threads on References[0]
    // filed each reply under its parent instead of under the conversation.
    const chain = trimReferences([
      ...(Array.isArray(references) ? references : messageIds(references)),
      ...messageIds(inReplyTo),
    ]);
    // Folded one id per line once it gets long: a header line may not pass
    // 998 octets, and a deep thread's chain does.
    const joined = chain.join(" ");
    lines.push(`References: ${joined.length > 900 ? chain.join("\r\n ") : joined}`);
  }

  const files = (attachments || []).filter((a) => a && a.filename && a.data);

  /**
   * The readable content, as its own MIME entity: either a lone text part or
   * the text+HTML pair. Returned as headers-plus-body rather than a finished
   * message, so multipart/mixed can nest it whole when files are attached.
   */
  const bodyEntity = () => {
    // An answer to an invitation: the words for people, and the same answer
    // as text/calendar for their calendar, which is the part that counts.
    if (calendar) {
      const alt = newBoundary("alt");
      return {
        headers: [`Content-Type: multipart/alternative; boundary="${alt}"`],
        content:
          `--${alt}\r\nContent-Type: text/plain; charset="utf-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64Body(text)}\r\n` +
          `--${alt}\r\nContent-Type: text/calendar; charset="utf-8"; method=${calendar.method || "REPLY"}\r\n` +
          `Content-Transfer-Encoding: base64\r\n\r\n${b64Body(calendar.text)}\r\n--${alt}--\r\n`,
      };
    }
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
  if (!files.length) return lines.map(fold).concat(body.headers).join("\r\n") + "\r\n\r\n" + body.content;

  // With files, the message becomes multipart/mixed: the readable part first,
  // then one part per file. Mixed rather than alternative — these are not
  // different renderings of the same thing, they are separate things.
  const mixed = newBoundary("mix");
  lines.push(`Content-Type: multipart/mixed; boundary="${mixed}"`);

  const filePart = (f) => {
    return (
      `--${mixed}\r\n` +
      `Content-Type: ${f.type || "application/octet-stream"}; ${fileParam("name", f.filename)}\r\n` +
      `Content-Disposition: attachment; ${fileParam("filename", f.filename)}\r\n` +
      "Content-Transfer-Encoding: base64\r\n\r\n" +
      // Already base64 from the browser; only re-wrap it to 76 columns.
      (String(f.data).replace(/\s+/g, "").match(/.{1,76}/g) || [""]).join("\r\n") +
      "\r\n"
    );
  };

  return (
    lines.map(fold).join("\r\n") +
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
 * Character references, decoded the way a browser decodes an attribute value.
 *
 * Every rule below reads values as text, and a browser does not: to it
 * `src="&#104;ttps://t.example/p.gif"` is an https URL, and
 * `style="background:url&#40;…&#41;"` is a url(). Matching the raw text let
 * both straight past the image blocking. Not every named reference is here —
 * only the ones that can spell part of a URL or of a CSS function.
 */
const NAMED_REFS = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", colon: ":", sol: "/", bsol: "\\",
  lpar: "(", rpar: ")", period: ".", comma: ",", semi: ";", equals: "=", num: "#",
  percnt: "%", commat: "@", quest: "?", tab: "\t", newline: "\n", nbsp: " ",
};
export function decodeEntities(s) {
  return String(s ?? "").replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z][a-z0-9]*));?/gi, (m, hex, dec, name) => {
    if (hex || dec) {
      const n = parseInt(hex || dec, hex ? 16 : 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "�";
    }
    return NAMED_REFS[name.toLowerCase()] ?? m;
  });
}

/**
 * CSS as its tokenizer sees it: comments gone, escapes resolved.
 *
 * `u\72l(` is url( and `@\69mport` is @import to a browser. Used to find a
 * fetch hiding behind an escape, never to rewrite CSS that has none — an
 * escaped selector like `.a\:b` means something else unescaped.
 */
const cssPlain = (s) =>
  String(s ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\\([0-9a-f]{1,6})[ \t\n\r\f]?|\\([^\n\r\f0-9a-f])/gi, (_m, hex, ch) =>
      hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 0xfffd) : ch
    );

/**
 * Where a URL in a message would load from: "inline" (cid:, data: — part of
 * the message, leaks nothing), "remote" (another server — a tracker until the
 * reader says otherwise) or "own" (anything that would land on this app).
 *
 * Decided by the URL parser rather than by pattern, because the parser is
 * what the browser runs: it drops tabs and newlines anywhere, takes `\\host`
 * for `//host`, and reads `https:/api/x` as a path on the page's own origin.
 * A message is rendered against this app's address, so every relative URL is
 * a request to this app — with its cookie, wherever the frame shares the
 * origin, as the print frame does. Same for an absolute URL naming this host.
 */
const OWN_BASE = "https://own.invalid/";
function urlWhere(value, host) {
  const v = String(value ?? "").replace(/[\t\n\r]/g, "").replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "");
  if (/^(?:cid|data):/i.test(v)) return "inline";
  let u;
  try {
    u = new URL(v, OWN_BASE);
  } catch {
    return "own"; // unparseable: nothing to load, nothing worth keeping
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "own";
  if (u.host === "own.invalid" || (host && u.hostname === host)) return "own";
  return "remote";
}

/**
 * A srcset's candidates, split the way the browser splits them.
 *
 * Not on every comma: a data: URI is full of them. A URL runs to the next
 * whitespace, losing only trailing commas, and its descriptors run to the
 * next comma after that.
 */
function srcsetCandidates(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (i >= s.length) break;
    let j = i;
    while (j < s.length && !/\s/.test(s[j])) j++;
    let url = s.slice(i, j);
    let k = j;
    if (/,$/.test(url)) url = url.replace(/,+$/, "");
    else while (k < s.length && s[k] !== ",") k++;
    out.push({ url, text: s.slice(i, k).replace(/,+$/, "").trim() });
    i = k + 1;
  }
  return out;
}

/** One <style> block: fetches out, everything else as written. */
function cleanCss(css, host) {
  let blocked = 0;
  const strip = (s) =>
    s
      .replace(/@import[^;}]*;?/gi, () => {
        blocked++;
        return "";
      })
      .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (m, dq, sq, bare) => {
        const where = urlWhere(dq ?? sq ?? bare ?? "", host);
        if (where === "inline") return m;
        if (where === "remote") blocked++;
        return "none";
      })
      // image-set() takes bare strings as URLs, no url() needed.
      .replace(/(?:-webkit-)?image-set\([^)]*\)/gi, (m) => {
        if (!/["']/.test(m)) return m;
        blocked++;
        return "none";
      });
  const once = strip(String(css));
  const counted = blocked;
  const plain = cssPlain(once);
  const again = strip(plain);
  if (again === plain) {
    blocked = counted;
    return { css: once, blocked };
  }
  // Something was hiding behind an escape or a comment. The unescaped form,
  // defused, is what the browser would have read anyway.
  return { css: again, blocked };
}

/**
 * Server-side defusing of message HTML. The real security boundary is the
 * sandboxed iframe the client renders into (no scripts, no same-origin), and
 * the Content-Security-Policy written into that frame is what finally decides
 * what loads. This is belt and braces, plus what the frame cannot decide on
 * its own: remote loads are rewritten to data-blocked-src, so the client can
 * swap them back behind a "Load images" tap, and loads that would land on
 * this app are dropped outright.
 *
 * `opts.host` is this app's hostname, so an absolute URL naming it is caught
 * along with the relative ones.
 *
 * Returns { html, blocked } where blocked counts neutralized remote loads.
 */
export function sanitizeHtml(input, opts = {}) {
  const host = String(opts.host || "").toLowerCase();
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
   * fetch, which is how a sender learns you opened their mail, so url() and
   * @import are what actually gets removed here.
   */
  html = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, (_m, css) => {
    const cleaned = cleanCss(css, host);
    blocked += cleaned.blocked;
    return `<style>${cleaned.css}</style>`;
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
  // `[\s/"']` rather than `\s` throughout: browsers accept `<img/src=…>` as a
  // separator, and an attribute glued straight onto the closing quote of the
  // one before it — `<img src="x"onerror="…">` — is a second attribute, not
  // part of the first. Anchoring on whitespace alone left a way past every
  // rule below. The quote is captured and put back, since it closes the
  // previous value.
  html = html.replace(/([\s/"'])on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "$1 ");
  // Any style carrying url() goes entirely — quoted or bare. Dropped rather
  // than deferred: a CSS background is never the message, and unlike <img>
  // there is nothing meaningful to restore behind the Images tap. Read the
  // way the browser reads it, references and escapes resolved, or
  // `url&#40;` and `u\72l(` walk straight past.
  html = html.replace(/([\s/"'])style\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, (m, sep) =>
    /url\s*\(|image-set\s*\(/i.test(cssPlain(decodeEntities(m))) ? `${sep} ` : m
  );
  // The URL parser drops spaces, control characters and tabs, and the
  // browser resolves references first, so `href=" java&#115;cript:…"` is as
  // live as the plain form.
  html = html.replace(
    /([\s/"'])(href|src|action|formaction|background)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,
    (m, sep, _attr, raw) => {
      const v = decodeEntities(raw.replace(/^["']|["']$/g, "")).replace(/[\x00-\x20]/g, "");
      return /^(?:java|vb)script:/i.test(v) ? `${sep} ` : m;
    }
  );

  /**
   * Loads (images, mostly): remote ones neutralized, counted and reversible
   * client-side; ones that would land on this app dropped.
   *
   * Values arrive quoted *or bare* — `src=https://tracker/p.gif` with no quotes
   * is valid HTML, and matching only the quoted form let it through untouched:
   * the pixel fired on open, and `blocked` stayed 0 so the Images button never
   * appeared to say otherwise. Match all three forms, then decide on the value
   * as the browser will read it.
   */
  html = html.replace(
    /([\s/"'])(src|srcset|background|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (m, sep, attr, dq, sq, bare) => {
      let val = decodeEntities(dq ?? sq ?? bare ?? "");
      const name = attr.toLowerCase();
      const lead = sep === "/" ? "" : sep;
      const quoted = (v) => `"${v.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`;
      // srcset is a list, judged candidate by candidate: the ones that would
      // land on this app go, and what is left is judged together.
      let where;
      if (name === "srcset") {
        const all = srcsetCandidates(val);
        const kept = all.filter((c) => urlWhere(c.url, host) !== "own");
        if (!kept.length) return `${lead} `;
        where = kept.map((c) => urlWhere(c.url, host));
        if (kept.length !== all.length) {
          val = kept.map((c) => c.text).join(", ");
          if (where.every((w) => w === "inline")) return `${lead} srcset=${quoted(val)}`;
        }
      } else where = [urlWhere(val, host)];
      if (where.every((w) => w === "inline")) return m; // cid:, data: — leave it alone
      if (where.includes("own")) return `${lead} `; // never a request to this app
      blocked++;
      // Re-emitted quoted, so a bare value cannot break the tag on restore.
      return `${lead} data-blocked-${name}=${quoted(val)}`;
    }
  );

  return { html, blocked };
}
