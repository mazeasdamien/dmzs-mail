/**
 * Small shared pieces: JSON responses, hashing, the body key, IMAP flag names, the host the Worker answers on.
 */

import { sanitizeHtml } from "./mime.js";

/**
 * This app's own hostname, for the sanitizer.
 *
 * A message is rendered against this app's address, so a URL in it naming
 * this host is a request to the app itself — with the session cookie, from
 * the print frame. Read from APP_URL at each entry point rather than threaded
 * through every caller of rowFromRaw: one deployment, one host.
 */
export let ownHost = "";

export const learnHost = (env) => {
  try {
    ownHost = env.APP_URL ? new URL(env.APP_URL).hostname : ownHost;
  } catch {
    /* a malformed APP_URL leaves relative URLs still caught */
  }
};

export const defuse = (html) => sanitizeHtml(html, { host: ownHost });

export const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

export const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...extra } });

export const SYNC_PER_RUN = 1;              // accounts refreshed per cron pass — there is one

export async function hashHex(s, len) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, len);
}

export const bodyKey = (id) => `body/${id}.json`;

/**
 * IMAP system flags, spelled once.
 *
 * Written inline as "\Seen" these are a trap: \S is not a JavaScript escape,
 * so the backslash vanishes and the string becomes "Seen" — a custom keyword
 * the server stores and ignores, rather than the system flag. It fails
 * silently and looks exactly like a sync bug from the outside.
 */
export const FLAG_SEEN = "\\Seen";

export const FLAG_FLAGGED = "\\Flagged";

/**
 * Attachments are served with the type the sender declared, which is the
 * sender's word and nothing more: an "image" that is really HTML, opened on
 * this origin, would run with the session. nosniff stops the browser guessing
 * past the declared type, and the sandbox policy means that even a page
 * served as a page gets no script and no origin. PDF is the exception —
 * Chrome will not draw a PDF inside a sandboxed document at all — and a PDF
 * cannot script this origin anyway.
 */
export const ATTACHMENT_HEADERS = (type) => ({
  "X-Content-Type-Options": "nosniff",
  ...(/^application\/pdf\b/i.test(String(type || "")) ? {} : { "Content-Security-Policy": "sandbox" }),
});
