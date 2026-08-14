/**
 * Reading a whole message: headers, MIME structure, transfer decoding.
 *
 * The iCloud agent got all of this free from Python's `email` package. Moving
 * IMAP into the Worker means writing it, so it lives here as pure string
 * functions with no Workers API and no network — the same contract as mime.js,
 * and the same reason: this is the part that corrupts mail *quietly* when it is
 * wrong, so it has to be testable without a mailbox.
 *
 * Bytes are carried as latin1 strings throughout. One char per byte, values
 * preserved exactly, which keeps boundary-splitting and header parsing on
 * plain strings while leaving the real charset decision until a leaf part is
 * decoded and its charset is actually known.
 */

import { b64decode, qpBytes, decodeWords } from "./mime.js";

const MAX_DEPTH = 12; // a message nested deeper than this is not a message

export const bytesToLatin1 = (bytes) =>
  typeof bytes === "string" ? bytes : new TextDecoder("latin1").decode(bytes);

export const latin1ToBytes = (s) => Uint8Array.from(String(s), (c) => c.charCodeAt(0) & 0xff);

function decodeCharset(bytes, charset) {
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes); // unknown label: utf-8 and hope
  }
}

/* ── headers ── */

/** Splits on the first blank line. Everything after it is the body, verbatim. */
export function splitMessage(raw) {
  const m = /\r?\n\r?\n/.exec(raw);
  if (!m) return { head: raw, body: "" };
  return { head: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) };
}

/**
 * name → value, lowercased names, first occurrence wins.
 *
 * Continuation lines are folded back first: a header may be split across lines
 * as long as each continuation starts with space or tab, and a long
 * Content-Type boundary is exactly where that shows up in real mail.
 */
export function parseHeaders(head) {
  const out = {};
  for (const line of String(head).replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const c = line.indexOf(":");
    if (c < 1) continue;
    const name = line.slice(0, c).trim().toLowerCase();
    if (out[name] === undefined) out[name] = line.slice(c + 1).trim();
  }
  return out;
}

/**
 * `multipart/mixed; boundary="a;b"; charset=utf-8`
 *   → { value: "multipart/mixed", params: { boundary: "a;b", charset: "utf-8" } }
 *
 * Split by hand rather than on /;/ because a quoted boundary is allowed to
 * contain a semicolon, and splitting naively truncates it — which then matches
 * nothing and silently flattens the message to a single part.
 */
export function parseParams(input) {
  const s = String(input ?? "");
  const chunks = [];
  let cur = "";
  let quoted = false;
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (ch === ";" && !quoted) {
      chunks.push(cur);
      cur = "";
    } else cur += ch;
  }
  chunks.push(cur);

  const params = {};
  for (const chunk of chunks.slice(1)) {
    const eq = chunk.indexOf("=");
    if (eq < 0) continue;
    const k = chunk.slice(0, eq).trim().toLowerCase();
    let v = chunk.slice(eq + 1).trim();
    if (v.startsWith('"')) {
      const end = v.indexOf('"', 1);
      v = end > 0 ? v.slice(1, end) : v.slice(1);
    }
    if (k) params[k] = v;
  }
  return { value: chunks[0].trim().toLowerCase(), params };
}

/* ── bodies ── */

/** One leaf part's payload → text, transfer encoding and charset applied. */
export function decodePart(body, encoding, charset) {
  const enc = String(encoding || "7bit").trim().toLowerCase();
  let bytes;
  if (enc === "base64") bytes = b64decode(String(body).replace(/[^A-Za-z0-9+/=_-]/g, ""));
  else if (enc === "quoted-printable") bytes = qpBytes(body);
  else bytes = latin1ToBytes(body);
  return decodeCharset(bytes, charset);
}

/**
 * A multipart body → its parts, each still raw (own headers + own body).
 *
 * Anything before the first boundary is the preamble and anything after the
 * closing `--boundary--` is the epilogue; both are noise and both are dropped.
 */
export function splitParts(body, boundary) {
  const marker = "--" + boundary;
  const parts = [];
  let cur = null;
  for (const line of String(body).split(/\r?\n/)) {
    const trimmed = line.replace(/[ \t]+$/, ""); // some servers pad the boundary
    if (trimmed === marker + "--") {
      if (cur) parts.push(cur.join("\r\n"));
      return parts;
    }
    if (trimmed === marker) {
      if (cur) parts.push(cur.join("\r\n"));
      cur = [];
      continue;
    }
    if (cur) cur.push(line);
  }
  if (cur) parts.push(cur.join("\r\n"));
  return parts;
}

/* ── BODYSTRUCTURE ── */

/**
 * IMAP's parenthesised list syntax → nested arrays.
 *
 * `("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 42 2)` and friends. Used
 * to read a message's shape without downloading it, which is the only way to
 * open a 26 MB mail whose readable part is four kilobytes.
 */
export function parseSexp(input) {
  const s = String(input ?? "");
  let i = 0;
  const skip = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  function node() {
    skip();
    if (s[i] === "(") {
      i++;
      const list = [];
      for (;;) {
        skip();
        if (i >= s.length) break;
        if (s[i] === ")") {
          i++;
          break;
        }
        list.push(node());
      }
      return list;
    }
    if (s[i] === '"') {
      i++;
      let out = "";
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\") i++; // escaped quote or backslash
        out += s[i++];
      }
      i++;
      return out;
    }
    const start = i;
    while (i < s.length && !/[\s()]/.test(s[i])) i++;
    const atom = s.slice(start, i);
    return atom.toUpperCase() === "NIL" ? null : atom;
  }
  return node();
}

const paramsOf = (list) => {
  const out = {};
  if (!Array.isArray(list)) return out;
  for (let i = 0; i + 1 < list.length; i += 2) {
    if (typeof list[i] === "string") out[list[i].toLowerCase()] = list[i + 1];
  }
  return out;
};

/**
 * A parsed BODYSTRUCTURE → a flat list of leaf parts with their IMAP paths.
 *
 * A multipart node is a run of child lists followed by its subtype string; a
 * leaf starts with two strings (type and subtype). That difference is the only
 * way to tell them apart, and it is what the recursion keys on.
 */
export function flattenStructure(node, path = "") {
  if (!Array.isArray(node)) return [];

  if (Array.isArray(node[0])) {
    const kids = node.filter(Array.isArray);
    const out = [];
    kids.forEach((kid, n) => {
      out.push(...flattenStructure(kid, path ? `${path}.${n + 1}` : String(n + 1)));
    });
    return out;
  }

  const [type, subtype, params, contentId, , encoding, size] = node;
  // Disposition sits after the leaf fields; its shape varies by server, so it
  // is searched for rather than indexed by position.
  let filename = paramsOf(params).name || "";
  let disposition = "";
  for (const field of node.slice(7)) {
    if (Array.isArray(field) && typeof field[0] === "string" && /inline|attachment/i.test(field[0])) {
      disposition = String(field[0]).toLowerCase();
      filename = paramsOf(field[1]).filename || filename;
      break;
    }
  }

  return [
    {
      part: path || "1",
      type: `${String(type || "application").toLowerCase()}/${String(subtype || "octet-stream").toLowerCase()}`,
      charset: paramsOf(params).charset || "",
      encoding: String(encoding || "7bit").toLowerCase(),
      size: Number(size) || 0,
      filename: decodeWords(filename || ""),
      // Inline images are referenced from the HTML as cid:<this>. Without it
      // the picture in a message can never be resolved to the part holding it.
      cid: String(contentId || "").replace(/^<|>$/g, ""),
      disposition,
    },
  ];
}

/* ── the whole message ── */

function walk(headers, body, out, depth, path) {
  if (depth > MAX_DEPTH) return;

  const ct = parseParams(headers["content-type"] || "text/plain");
  const disp = parseParams(headers["content-disposition"] || "");
  const enc = headers["content-transfer-encoding"] || "";
  const filename = decodeWords(disp.params.filename || ct.params.name || "");

  if (ct.value.startsWith("multipart/")) {
    const boundary = ct.params.boundary;
    if (!boundary) return; // malformed; nothing reliable to split on
    let n = 0;
    for (const part of splitParts(body, boundary)) {
      n++;
      const { head, body: inner } = splitMessage(part);
      // IMAP part paths: children are 1-based, nesting joins with a dot, so
      // the second attachment inside the second part is "2.2". This is what
      // lets one attachment be fetched with BODY.PEEK[2.2] instead of pulling
      // the whole message back down to reach it.
      walk(parseHeaders(head), inner, out, depth + 1, path ? `${path}.${n}` : String(n));
    }
    return;
  }

  // A message that is not multipart at all is part 1 by IMAP's reckoning.
  const partPath = path || "1";

  // An embedded message: a forward, or the original quoted back inside a
  // delivery report. Its content is the whole point of the mail, so it is
  // walked like any other container rather than filed away as an opaque blob —
  // without this a forwarded message opens as a blank white page. Only when it
  // has no filename and is not declared an attachment, which is the form a
  // client that meant "here is a file" would use.
  if (ct.value === "message/rfc822" && disp.value !== "attachment" && !filename) {
    const inner = splitMessage(body);
    walk(parseHeaders(inner.head), inner.body, out, depth + 1, path);
    return;
  }

  // An attachment is anything explicitly marked as one, plus any non-text part
  // carrying a filename — inline images arrive that way and still belong here.
  if (disp.value === "attachment" || (filename && !ct.value.startsWith("text/"))) {
    out.attachments.push({
      filename: filename || "(unnamed)",
      type: ct.value || "application/octet-stream",
      encoding: String(enc).toLowerCase(),
      cid: String(headers["content-id"] || "").replace(/^<|>$/g, ""),
      part: partPath,
      // Encoded length: what it costs to move, not what it weighs on disk.
      // base64 inflates by about a third, so the real file is ~3/4 of this.
      size: body.length,
      body, // still encoded; decoded only if someone downloads it
    });
    return;
  }

  // First of each wins, which is what multipart/alternative intends: parts run
  // simplest to richest, so the earliest text/html is the sender's best effort.
  if (ct.value === "text/html" && !out.html) out.html = decodePart(body, enc, ct.params.charset);
  else if (ct.value.startsWith("text/") && !out.text)
    out.text = decodePart(body, enc, ct.params.charset);
}

/**
 * Raw RFC 822 bytes (or a latin1 string) → everything the app needs.
 * Returns { headers, html, text, attachments }.
 */
export function parseMessage(raw) {
  const src = bytesToLatin1(raw);
  const { head, body } = splitMessage(src);
  const headers = parseHeaders(head);
  const out = { headers, html: "", text: "", attachments: [] };
  walk(headers, body, out, 0, "");
  return out;
}
