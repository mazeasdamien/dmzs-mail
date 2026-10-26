/**
 * Message bodies: fetched once, defused, kept in R2, and fetched again when a stored copy is stale or blank.
 */

import { BODY_VERSION, bodyFromParts, unsubFromHeaders } from "./body.js";
import { imapFetchHead, imapFetchMeta, imapFetchRaw } from "./imap.js";
import { htmlToText } from "./mime.js";
import { parseHeaders } from "./rfc822.js";
import { MAX_BODY_BYTES, icloudAct } from "./mailbox.js";
import { indexMessage } from "./store.js";
import { indexEvent } from "./ics.js";
import { readLargeBody, rowFromRaw } from "./sync.js";
import { bodyKey, json } from "./util.js";

/* ────────────────────────────────────────────────────────────────
   Bodies: fetched once, defused, kept in R2.
   ──────────────────────────────────────────────────────────────── */

/**
 * True when a stored body holds nothing a reader could actually see.
 *
 * Stripping the tags and checking what is left is not enough on its own: a
 * newsletter that is one big picture and nothing else has no text at all, and
 * judging it empty would hide a message that renders perfectly well. So
 * anything that draws counts too, including images currently held back behind
 * the Images button.
 */
export const bodyIsBlank = (body) => {
  // Style blocks go first: their contents are not inside angle brackets, so a
  // plain tag-strip counts a stylesheet as text and calls an empty message
  // full of content.
  const html = String(body?.html || "").replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "");
  if (/<(img|table|video|audio|picture)\b/i.test(html)) return false;
  if (/data-blocked-(src|srcset|background|poster)=/i.test(html)) return false;
  return !html.replace(/<[^>]*>/g, "").replace(/&nbsp;|&#160;|\s/gi, "").length;
};

/**
 * Fetches one message's body from Apple right now, and keeps what it finds.
 *
 * The sync only ever looks forward: it walks new UIDs, then backfills older
 * ones, and never revisits a UID it has already passed. So a message whose body
 * went missing — skipped when it arrived, lost from R2, or parsed to nothing
 * because of a MIME shape the parser did not expect — stays blank forever,
 * waiting for a pass that is not coming back. This is the way out, and it runs
 * only when someone actually opens such a message.
 */
export async function fetchBodyNow(env, account, msg) {
  let out = null;

  const found = await icloudAct(env, account, msg.mid || msg.pid, msg.folder, async (im, _boxes, _mb, uid) => {
    const [meta] = await imapFetchMeta(im, String(uid));
    const size = Number(meta?.size || 0);

    if (size > MAX_BODY_BYTES) {
      // Too big to hold whole — read its structure and take only the text part,
      // the same trick sync uses. The headers come separately so the
      // unsubscribe link survives, which is exactly what a huge newsletter has.
      const large = await readLargeBody(im, uid, size);
      const head = await imapFetchHead(im, uid).catch(() => null);
      const h = head?.raw ? parseHeaders(head.raw) : {};
      out = bodyFromParts({
        html: large.html,
        blocked: large.blocked,
        attachments: large.attachments,
        ...unsubFromHeaders(h),
        tooLarge: true,
      });
      return;
    }

    const raw = await imapFetchRaw(im, uid);
    if (!raw?.raw) return;
    const { body, attachments } = rowFromRaw(raw, msg.folder);
    out = bodyFromParts({ ...body, attachments });
  });

  // No stored credential, or the message is no longer on the server.
  if (!found || !out) return null;

  // Marked so a message that really is empty is not re-fetched on every open.
  out.refetched = true;
  await env.MAIL.put(bodyKey(msg.id), JSON.stringify(out), {
    httpMetadata: { contentType: "application/json" },
  });
  await env.DB.prepare("UPDATE messages SET has_body=1 WHERE id=?").bind(msg.id).run();
  await indexMessage(env, msg.id, msg, htmlToText(out.html || ""));
  if (out.calendar) await indexEvent(env, msg.id, msg.account_id, out.calendar, msg.subject);
  return out;
}

export async function ensureBody(env, account, msg) {
  let stored = null;
  if (msg.has_body) {
    const obj = await env.MAIL.get(bodyKey(msg.id));
    if (obj) stored = JSON.parse(await obj.text());
    // R2 lost nothing in practice; this is the "row said yes, bucket said no"
    // path, and it heals by refetching below.
  }

  // Two reasons to go back to Apple: there is nothing readable stored, or what
  // is stored was defused under rules that have since changed.
  const stale = !!stored && Number(stored.v || 1) < BODY_VERSION;
  if (stored && !stale && !bodyIsBlank(stored)) return stored;

  if (account && (stale || !stored?.refetched)) {
    const fresh = await fetchBodyNow(env, account, msg).catch(() => null);
    if (fresh && !bodyIsBlank(fresh)) return fresh;
    if (fresh) return bodyFromParts({ ...fresh, empty: true });
  }

  // The re-fetch did not happen or did not help. An old copy that still reads
  // is better than an apology, so it is only reported as empty when it truly
  // has nothing in it.
  if (stored && !bodyIsBlank(stored)) return stored;

  // Flags rather than a fake <p> spliced into the message: the client says this
  // in its own voice, instead of the placeholder arriving looking like
  // something the sender wrote. And the two cases are genuinely different —
  // "this message has no text" is a fact about the mail, "we could not get it"
  // is a fact about us, and telling someone the first when the second is true
  // is how a fetch failure gets mistaken for an empty message.
  if (stored) return bodyFromParts({ ...stored, empty: true });
  return bodyFromParts({ missing: true });
}
