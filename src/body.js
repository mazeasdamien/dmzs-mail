/**
 * The one shape a stored body ever has.
 *
 * Three places used to assemble it by hand — the sync, the large-message
 * reader and the on-demand re-fetch — and each had its own idea of which
 * fields were optional. They agreed right up until one of them added a flag
 * the others did not know about, which is how `tooLarge` stayed invisible to
 * the client for a release.
 *
 * Nothing here parses or sanitises. Callers hand over the html as the reader
 * must see it; this only puts the envelope together and stamps the version
 * that says how it was defused.
 */

/**
 * Which pass of the defuser produced a stored body.
 *
 * Bumped whenever sanitizeHtml changes in a way that alters what a reader
 * sees, so bodies cached under the old rules are re-fetched once on the next
 * open rather than staying wrong forever. Version 2 keeps <style> blocks:
 * everything stored before it has them stripped, which renders some messages
 * as blank pages that no amount of re-reading the cached copy can recover.
 */
export const BODY_VERSION = 2;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * Builds one body document.
 *
 * `tooLarge`, `empty` and `missing` are flags rather than a fake <p> spliced
 * into the message: the client says those in its own voice, instead of a
 * placeholder arriving looking like something the sender wrote. The three
 * cases are genuinely different — "this message has no text" is a fact about
 * the mail, "we could not get it" is a fact about us, and "it is too big to
 * hold" is a fact about the Worker's CPU budget.
 *
 * A placeholder is still left in `html` when a message is too large, for one
 * release: a client predating the flag renders only `html`, and a blank page
 * reads as a broken app rather than as a size limit.
 */
export function bodyFromParts({
  html = "",
  text = "",
  attachments = [],
  unsubscribe = "",
  unsubscribeOneClick = false,
  blocked = 0,
  tooLarge = false,
  empty = false,
  missing = false,
} = {}) {
  const body = {
    v: BODY_VERSION,
    html: String(html || ""),
    blocked: Number(blocked) || 0,
    attachments: Array.isArray(attachments) ? attachments : [],
    // RFC 2369 / RFC 8058. Almost every list carries these and almost no
    // client surfaces them, which is why unsubscribing usually means hunting
    // for grey 8px text at the bottom of a newsletter.
    unsubscribe: String(unsubscribe || "").slice(0, 600),
    unsubscribeOneClick: !!unsubscribeOneClick,
  };

  if (tooLarge) {
    body.tooLarge = true;
    if (!body.html) {
      const note = String(text || "").trim() ||
        "This message is too large to render here. Open it in Mail or at icloud.com.";
      body.html = `<p>${esc(note)}</p>`;
    }
  }
  if (empty) body.empty = true;
  if (missing) body.missing = true;
  return body;
}

/** Unsubscribe headers, lifted out of a parsed header set. */
export function unsubFromHeaders(h) {
  return {
    unsubscribe: String(h?.["list-unsubscribe"] || "").slice(0, 600),
    unsubscribeOneClick: /one-?click/i.test(String(h?.["list-unsubscribe-post"] || "")),
  };
}
