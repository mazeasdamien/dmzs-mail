/**
 * The local store: rows into D1, the full-text index, forgetting messages, and how failures are recorded.
 */

import { isAuthFailure } from "./errors.js";
import { accountById } from "./filing.js";
import { bodyKey, hashHex, json } from "./util.js";

/** Marks an account as needing the user, when its credential dies. */
export async function flagAccount(env, account, e) {
  await env.DB.prepare("UPDATE accounts SET status=?, last_error=? WHERE id=?")
    .bind(isAuthFailure(e) ? "reauth" : "error", String((e && e.message) || e).slice(0, 300), account.id)
    .run();
}

/**
 * One response shape for every mail failure.
 *
 * A refused credential is 409 and needs a human. Everything else is 502 and
 * worth saying out loud. The block this replaces was copy-pasted about fifteen
 * times and had drifted into three different wordings of the same two facts.
 */
export function imapError(e, acct, env) {
  if (isAuthFailure(e)) {
    if (acct && env) flagAccount(env, acct, e).catch(() => {});
    return json({ error: "This account needs reconnecting" }, 409);
  }
  return json({ error: String((e && e.message) || e) }, 502);
}

/**
 * Runs one route with the account it names already loaded.
 *
 * Every message route started with the same four lines — fetch the row, 404,
 * fetch the account, 404 — and the same catch. One place now.
 */
export async function withAccount(env, id, fn) {
  const acct = await accountById(env, id);
  if (!acct) return json({ error: "Unknown account" }, 404);
  try {
    return await fn(acct);
  } catch (e) {
    return imapError(e, acct, env);
  }
}

/* ────────────────────────────────────────────────────────────────
   Storing messages.
   ──────────────────────────────────────────────────────────────── */

export async function storeRows(env, accountId, rows) {
  if (!rows.length) return 0;
  const now = Date.now();
  const stmts = [];
  for (const r of rows) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO messages
           (id, account_id, pid, mid, thread_key, refs, folder, from_name, from_email,
            to_line, cc_line, bcc_line, subject, snippet, date, unread, starred, has_body,
            mailbox, uid, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)
         -- Put yourself on the Cc of something you send and the provider keeps
         -- two copies of one message: the one in Sent and the one delivered to
         -- the inbox, sharing a Message-ID and therefore sharing this row.
         -- Whichever mailbox was walked last used to win, and Sent is usually
         -- walked after the inbox, so a message you copied yourself on filed
         -- itself under Sent and never appeared in the inbox at all — while
         -- every other client on the account showed it sitting there. A
         -- sighting in Sent is never the interesting one: that is the copy you
         -- have already read, because you wrote it.
         ON CONFLICT(account_id, pid) DO UPDATE SET
           unread=excluded.unread,
           starred=excluded.starred,
           folder=excluded.folder,
           -- A copy filed locally (sent, draft) has no UID yet, and must not
           -- erase the one a sync has already found for the same message.
           mailbox=CASE WHEN excluded.uid > 0 THEN excluded.mailbox ELSE messages.mailbox END,
           uid=CASE WHEN excluded.uid > 0 THEN excluded.uid ELSE messages.uid END
         WHERE NOT (excluded.folder = 'sent' AND messages.folder <> 'sent')`
      ).bind(
        await hashHex(`msg|${accountId}|${r.pid}`, 16),
        accountId,
        r.pid,
        (r.mid || "").slice(0, 300),
        (r.thread_key || "").slice(0, 300),
        (r.refs || "").slice(0, 4000),
        // A re-read always carries the provider's current filing, so a message
        // archived, binned or moved elsewhere corrects itself on next sync
        // rather than sitting in the inbox forever.
        r.folder || (r.inInbox === false ? "archive" : "inbox"),
        (r.from_name || "").slice(0, 200),
        (r.from_email || "").slice(0, 200),
        (r.to_line || "").slice(0, 500),
        (r.cc_line || "").slice(0, 500),
        (r.bcc_line || "").slice(0, 500),
        (r.subject || "").slice(0, 500),
        (r.snippet || "").slice(0, 300),
        r.date || now,
        r.unread ? 1 : 0,
        r.starred ? 1 : 0,
        r.mailbox || "",
        Number(r.uid) || 0,
        now
      )
    );
  }
  await env.DB.batch(stmts);
  return rows.length;
}

/**
 * Puts one message into the full-text index.
 *
 * A standalone FTS5 table keyed by message id, rather than an external-content
 * table with triggers: every write is explicit here, so the index cannot
 * silently drift out of step with the messages table.
 */
export async function indexMessage(env, id, row, bodyText) {
  const rid = searchRowid(id);
  await env.DB.batch([
    ...(await unindex(env, [id])),
    env.DB.prepare("INSERT INTO search (rowid, id, subject, sender, body) VALUES (?,?,?,?,?)").bind(
      rid,
      id,
      row.subject || "",
      `${row.from_name || ""} ${row.from_email || ""}`,
      String(bodyText || "").slice(0, 60_000)
    ),
    env.DB.prepare("INSERT OR REPLACE INTO search_ids (id, rid) VALUES (?,?)").bind(id, rid),
  ]);
}

/**
 * The index row a message is stored under: 52 bits of its id, so it fits a
 * JavaScript number exactly and never meets the small sequential rowids that
 * rows indexed before this scheme were given.
 */
export const searchRowid = (id) => parseInt(String(id).slice(0, 13), 16);

/**
 * Statements that take these messages out of the search index.
 *
 * By rowid, found through search_ids. `id` in the FTS table is UNINDEXED, so
 * `DELETE FROM search WHERE id=?` read the entire index for every message it
 * removed — once per new mail, once per delete — and D1 bills every row read.
 */
export async function unindex(env, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const marks = chunk.map(() => "?").join(",");
    const { results } = await env.DB.prepare(`SELECT rid FROM search_ids WHERE id IN (${marks})`)
      .bind(...chunk)
      .all();
    for (const r of results ?? []) out.push(env.DB.prepare("DELETE FROM search WHERE rowid=?").bind(r.rid));
    out.push(env.DB.prepare(`DELETE FROM search_ids WHERE id IN (${marks})`).bind(...chunk));
  }
  return out;
}

/**
 * A user's words → an FTS5 MATCH expression.
 *
 * Reduced to letters and digits before anything else: FTS5's query language
 * treats quotes, colons, carets and hyphens as syntax, so an address pasted
 * into the search box would be a syntax error rather than a search. The last
 * word gets a prefix star, so "lily" finds "Lilyn" while you are still typing.
 */
export function ftsQuery(term) {
  const words = String(term || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  if (!words.length) return null;
  return words.map((w, i) => (i === words.length - 1 ? `${w}*` : w)).join(" AND ");
}

/**
 * Forgets everything hanging off a set of message ids: the stored bodies in
 * R2 and the rows in the search index.
 *
 * Exists because `search` is an FTS5 virtual table, which has no foreign key
 * and therefore no ON DELETE CASCADE. Every bulk delete has to clean it by
 * hand, and four of them did not — which left 660 index rows pointing at
 * messages that were gone, quietly padding every search with dead hits.
 *
 * Call it *before* deleting the message rows, while the ids can still be read.
 */
export async function forgetMessages(env, ids) {
  if (!ids?.length) return;
  // R2 takes up to 1,000 keys per delete. One call per key ran a 3,000-message
  // Trash or a whole account past the subrequest ceiling halfway through,
  // leaving the rows in D1 and the bodies orphaned in R2.
  for (let i = 0; i < ids.length; i += 1000) {
    await env.MAIL.delete(ids.slice(i, i + 1000).map(bodyKey));
  }
  // Chunked: D1 caps the number of bound parameters per statement, and a
  // mailbox being emptied can carry thousands of ids.
  const stmts = await unindex(env, ids);
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
}
