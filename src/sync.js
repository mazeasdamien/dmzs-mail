/**
 * The sync: pulling new mail and history, reconciling what changed elsewhere, blocked senders, one pass per account.
 */

import { bodyFromParts, unsubFromHeaders } from "./body.js";
import { isAuthFailure } from "./errors.js";
import { imapFetchChanged, imapFetchHead, imapFetchIds, imapFetchMeta, imapFetchPart, imapFetchRaw, imapFetchStructure, imapList, imapOpen, imapPurge, imapSearch, imapSelect } from "./imap.js";
import { blockMatches, decodeWords, htmlToText, messageIds, parseAddress, textToHtml, threadKeyOf, trimReferences } from "./mime.js";
import { flagState, planWindow, strikes, uidSet } from "./reconcile.js";
import { decodePart, flattenStructure, parseHeaders, parseMessage, parseSexp } from "./rfc822.js";
import { SYSTEM_FOLDERS } from "./filing.js";
import { IMAP_CAP, MAX_BODY_BYTES, folderNameFor, icloudPassword } from "./mailbox.js";
import { flagAccount, forgetMessages, indexMessage, storeRows } from "./store.js";
import { bodyKey, defuse, hashHex, json } from "./util.js";

/** Raw message → a messages row plus its defused body. */
export function rowFromRaw({ uid, flags, raw }, folder) {
  const m = parseMessage(raw);
  const h = m.headers;
  const from = parseAddress(h.from || "");
  const mid = String(h["message-id"] || "").trim();
  const defused = m.html ? defuse(m.html) : defuse(textToHtml(m.text || ""));
  // htmlToText rather than a bare tag-strip: the latter leaves the contents of
  // <style> behind, which is why list previews read "#outlook a { padding:0; }
  // body { margin:0 …" instead of the first line of the message.
  const snippet = (m.text || htmlToText(m.html))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);

  return {
    row: {
      // Message-ID is stable across folders and reconnects; the UID is not, so
      // it is only the fallback for mail that arrives without one.
      pid: mid || `uid-${folder}-${uid}`,
      mid,
      thread_key: threadKeyOf(h),
      refs: trimReferences(messageIds(h.references)).join(" "),
      folder,
      from_name: from.name,
      from_email: from.email,
      to_line: decodeWords(h.to || ""),
      cc_line: decodeWords(h.cc || ""),
      // Only ever set on a draft: nothing that arrives carries a Bcc, and
      // nothing that leaves is allowed to.
      bcc_line: decodeWords(h.bcc || ""),
      subject: decodeWords(h.subject || ""),
      snippet,
      date: Date.parse(h.date || "") || Date.now(),
      unread: /\\Seen/i.test(flags) ? 0 : 1,
      starred: /\\Flagged/i.test(flags) ? 1 : 0,
    },
    body: bodyFromParts({
      html: defused.html,
      blocked: defused.blocked,
      calendar: m.calendar || "",
      ...unsubFromHeaders(h),
    }),
    // Metadata only — the payload stays on Apple's server and is fetched by
    // part path when someone actually asks for it.
    attachments: m.attachments.map((a) => ({
      filename: a.filename,
      type: a.type,
      size: a.size,
      part: a.part,
      encoding: a.encoding,
      cid: a.cid || "",
    })),
  };
}

/**
 * Drops folders the server no longer has, and the mail filed under them.
 *
 * Not on first sight. A LIST that comes back short — a truncated response, a
 * hiccup mid-command — would otherwise delete a working folder outright, so a
 * mailbox has to be missing three passes running before anything is removed.
 * Three minutes of patience against permanently deleting somebody's mail.
 */
export async function reconcileFolders(env, account, boxes, state) {
  // A LIST without INBOX is not a mailbox with no inbox, it is a bad response.
  const live = new Set(boxes.map((mb) => folderNameFor(mb)));
  if (!live.has("inbox")) return;

  const { results } = await env.DB.prepare(
    "SELECT DISTINCT folder FROM messages WHERE account_id=?"
  )
    .bind(account.id)
    .all();

  const gone = state.gone || {};
  const PRUNE_AFTER = 3;

  for (const row of results ?? []) {
    const name = row.folder;
    // System buckets are ours, not the server's: a message archived here sits
    // in "archive" whether or not Apple calls a mailbox that.
    if (SYSTEM_FOLDERS.has(name) || live.has(name)) {
      delete gone[name];
      continue;
    }
    gone[name] = (gone[name] || 0) + 1;
    if (gone[name] < PRUNE_AFTER) continue;

    const { results: doomed } = await env.DB.prepare(
      "SELECT id FROM messages WHERE account_id=? AND folder=?"
    )
      .bind(account.id, name)
      .all();
    await forgetMessages(env, (doomed ?? []).map((m) => m.id));
    await env.DB.prepare("DELETE FROM messages WHERE account_id=? AND folder=?")
      .bind(account.id, name)
      .run();
    delete gone[name];
  }
  state.gone = gone;

  // The loop above walks folders that have stored mail, so an empty one is
  // invisible to it. Those live only in the cursor map, keyed by IMAP path,
  // and are pruned against the LIST directly — otherwise a folder you made,
  // never filed into, and then deleted at Apple would sit in the switcher
  // forever, because nothing that could remove it ever looked at it.
  const paths = new Set(boxes.map((mb) => mb.name));
  for (const key of Object.keys(state.folders || {})) {
    if (!paths.has(key)) delete state.folders[key];
  }
}

/**
 * Every mailbox the last sync saw, by the name the app files mail under.
 *
 * Cursors are keyed by IMAP path and carry the app name beside them. Entries
 * written before they did fall back to reading the path the way a LIST with no
 * flags would — right for exactly the mailboxes that matter here, the ones you
 * named yourself, whose path and name are the same thing.
 */
export function mailboxNames(accountRows) {
  const names = new Set();
  for (const row of accountRows) {
    let state = null;
    try {
      state = row.sync_state ? JSON.parse(row.sync_state) : null;
    } catch {
      continue; // unreadable cursor map; the counted folders still stand
    }
    for (const [path, cur] of Object.entries(state?.folders || {})) {
      names.add(cur?.app || folderNameFor({ flags: "", name: path }));
    }
  }
  return names;
}

/**
 * Puts a mailbox in the cursor map so an empty one is still somewhere to file.
 *
 * Called when you make a folder rather than left to the next sync: until it is
 * listed the folder is in no move sheet, and a folder you cannot move mail
 * into is one that can never acquire the mail that would list it.
 */
export async function noteMailbox(env, account, box) {
  const row = await env.DB.prepare("SELECT sync_state FROM accounts WHERE id=?")
    .bind(account.id)
    .first();
  let state = {};
  try {
    state = row?.sync_state ? JSON.parse(row.sync_state) : {};
  } catch {
    state = {};
  }
  const folders = state.folders || {};
  if (folders[box.name]) return;
  // No cursor with it: the next pass reads the mailbox from the start, which
  // for one this new is no work at all.
  folders[box.name] = { app: folderNameFor(box) };
  state.folders = folders;
  await env.DB.prepare("UPDATE accounts SET sync_state=? WHERE id=?")
    .bind(JSON.stringify(state), account.id)
    .run();
}

/** Indexes up to `limit` already-stored messages that the index has not seen. */
export async function backfillSearch(env, account, limit) {
  // The NOT IN reads every message and every index row, so once a pass finds
  // nothing left to index the next look waits an hour. New mail is indexed
  // as it is stored; this only ever catches stragglers.
  const key = `search_idle_${account.id}`;
  const idle = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first();
  if (idle && Date.now() - Number(idle.value) < 3_600_000) return 0;

  const { results } = await env.DB.prepare(
    `SELECT m.id, m.subject, m.from_name, m.from_email
       FROM messages m
      WHERE m.account_id = ?
        AND m.id NOT IN (SELECT id FROM search_ids)
      LIMIT ?`
  )
    .bind(account.id, limit)
    .all();

  for (const row of results ?? []) {
    let text = "";
    try {
      const obj = await env.MAIL.get(bodyKey(row.id));
      if (obj) text = htmlToText(JSON.parse(await obj.text()).html || "");
    } catch {
      /* a body we cannot read still gets its headers indexed */
    }
    await indexMessage(env, row.id, row, text);
  }
  if (!results?.length) {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    )
      .bind(key, String(Date.now()))
      .run();
  }
  return (results ?? []).length;
}

/**
 * The readable part of a message too large to hold whole.
 *
 * BODYSTRUCTURE costs a few hundred bytes however big the message is, and
 * names every part with its size. The text part is fetched on its own; the
 * attachments are listed from the structure without being touched at all.
 */
export async function readLargeBody(im, uid, totalBytes) {
  const sizeMb = Math.round(totalBytes / 104857.6) / 10;
  const note = `This message is ${sizeMb} MB and its text could not be read. Open it in Mail or at icloud.com.`;
  const nothing = () => bodyFromParts({ text: note, tooLarge: true });

  let parts = [];
  try {
    const struct = await imapFetchStructure(im, uid);
    if (struct) parts = flattenStructure(parseSexp(struct));
  } catch {
    return nothing();
  }
  if (!parts.length) return nothing();

  const readable = parts.filter(
    (p) => p.type.startsWith("text/") && p.disposition !== "attachment" && p.size <= MAX_BODY_BYTES
  );
  // Richest first, same rule as multipart/alternative.
  const pick = readable.find((p) => p.type === "text/html") || readable[0];

  const attachments = parts
    .filter((p) => p.disposition === "attachment" || (p.filename && !p.type.startsWith("text/")))
    .map((p) => ({
      filename: p.filename || "(unnamed)",
      type: p.type,
      size: p.size,
      part: p.part,
      encoding: p.encoding,
      cid: p.cid || "",
    }));

  if (!pick) return bodyFromParts({ text: note, attachments, tooLarge: true });

  try {
    const encoded = await imapFetchPart(im, uid, pick.part);
    const text = decodePart(encoded || "", pick.encoding, pick.charset);
    const defused = pick.type === "text/html" ? defuse(text) : defuse(textToHtml(text));
    return bodyFromParts({
      html: defused.html,
      blocked: defused.blocked,
      attachments,
      tooLarge: true,
    });
  } catch {
    return bodyFromParts({ text: note, attachments, tooLarge: true });
  }
}

/** Deletes rows by id, with their bodies and index entries. */
export async function dropMessages(env, ids) {
  if (!ids.length) return;
  await forgetMessages(env, ids);
  const stmts = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    stmts.push(
      env.DB.prepare(`DELETE FROM messages WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk)
    );
  }
  await env.DB.batch(stmts);
}

export const MAX_FORGET = 500; // rows a single visit may delete; the rest wait a pass

/**
 * Brings one mailbox's stored rows into line with what the server has now:
 * flags changed elsewhere, and messages expunged elsewhere. See reconcile.js
 * for the windowing; `cur` is the mailbox's cursor entry, updated in place
 * and saved with the rest of the sync state.
 *
 * Costs per visit: SELECT, SEARCH ALL, one FETCH of flags and Message-IDs for
 * a few hundred UIDs over the open connection (no subrequests), and two or
 * three D1 batches.
 *
 * `soleForApp` is false when two mailboxes file under the same app name; the
 * sweep for never-placed rows cannot tell their rows apart, so it is skipped.
 *
 * Returns how far it moved the inbox's unread count, so the push check can
 * tell new mail from mail read or deleted on the phone.
 */
export async function reconcileMailbox(env, account, im, mb, cur, soleForApp) {
  const app = cur.app || folderNameFor(mb);
  const counts = app === "inbox";
  let shift = 0;
  const last = Number(cur.last_uid || 0);
  const first = Number(cur.first_uid || 0) || last;
  if (!last) return 0;

  const sel = await imapSelect(im, mb.name);
  // Renumbered since the cursor was written. The sync's own visit resets
  // the cursor and the stored UIDs; until it has, every one of them lies.
  if (!sel.uidvalidity || sel.uidvalidity !== Number(cur.uidvalidity)) return 0;

  const all = await imapSearch(im, "ALL");
  // Fewer UIDs than EXISTS is a short answer, not mail deleted elsewhere.
  const trusted = all.length >= sel.exists;
  const live = new Set(all);
  const startedRotation = !Number(cur.rc);
  if (startedRotation) cur.rs = Date.now();
  const plan = planWindow({ all, first, last, rc: Number(cur.rc || 0) });

  const flagUpdate = (id, f) =>
    env.DB.prepare("UPDATE messages SET unread=?, starred=? WHERE id=?").bind(f.unread, f.starred, id);
  const updates = [];
  const unreadFlips = []; // [index in updates, +1 or -1]
  const seen = new Set(); // UIDs whose flags are already being written

  // Mod-sequences, where offered: every flag that moved anywhere in the
  // mailbox since the last visit, in one command, rather than only what falls
  // in this visit's window. Only rows already placed can be matched by UID.
  if (sel.highestmodseq && (await im.capable("CONDSTORE"))) {
    const since = Number(cur.modseq || 0);
    let ok = true;
    if (since && since < sel.highestmodseq) {
      try {
        for (const c of await imapFetchChanged(im, `${first}:${last}`, since)) {
          const f = flagState(c.flags);
          seen.add(c.uid);
          // Two statements, so the first's change count says whether the
          // unread flag itself moved.
          unreadFlips.push([updates.length, f.unread ? 1 : -1]);
          updates.push(
            env.DB.prepare(
              "UPDATE messages SET unread=? WHERE account_id=? AND mailbox=? AND uid=? AND unread<>?"
            ).bind(f.unread, account.id, mb.name, c.uid, f.unread),
            env.DB.prepare(
              "UPDATE messages SET starred=? WHERE account_id=? AND mailbox=? AND uid=? AND starred<>?"
            ).bind(f.starred, account.id, mb.name, c.uid, f.starred)
          );
        }
      } catch (e) {
        ok = false; // advertised but refused: the window below still runs
        console.log(`reconcile: ${mb.name}: CHANGEDSINCE refused (${e.message || e})`);
      }
    }
    if (ok) cur.modseq = sel.highestmodseq;
  }

  // The window: flags and Message-IDs for this visit's UIDs, and the rows
  // stored against its ranges.
  const got = plan.uids.length ? await imapFetchIds(im, uidSet(plan.uids)) : [];
  const rangeRows = [];
  if (plan.ranges.length) {
    const res = await env.DB.batch(
      plan.ranges.map(([a, b]) =>
        env.DB.prepare(
          `SELECT id, pid, uid, folder, unread, starred FROM messages
            WHERE account_id=? AND mailbox=? AND uid BETWEEN ? AND ?`
        ).bind(account.id, mb.name, a, b)
      )
    );
    for (const r of res) rangeRows.push(...(r.results ?? []));
  }
  const byUid = new Map(rangeRows.map((r) => [Number(r.uid), r]));

  // A server message with no row placed at its UID: either a row stored
  // before rows carried UIDs, matched here by the id the sync gave it, or
  // something never stored at all (a blocked sender, history not yet reached).
  const pidOf = (g) => String(parseHeaders(g.head)["message-id"] || "").trim() || `uid-${app}-${g.uid}`;
  const unplaced = got.filter((g) => !byUid.has(g.uid));
  const byPid = new Map();
  if (unplaced.length) {
    const pids = [...new Set(unplaced.map(pidOf))];
    const stmts = [];
    for (let i = 0; i < pids.length; i += 90) {
      const chunk = pids.slice(i, i + 90);
      stmts.push(
        env.DB.prepare(
          `SELECT id, pid, folder, unread, starred FROM messages
            WHERE account_id=? AND pid IN (${chunk.map(() => "?").join(",")})`
        ).bind(account.id, ...chunk)
      );
    }
    for (const r of await env.DB.batch(stmts)) for (const row of r.results ?? []) byPid.set(row.pid, row);
  }

  const remapped = new Set();
  for (const g of got) {
    const f = flagState(g.flags);
    const placed = byUid.get(g.uid);
    if (placed) {
      if (seen.has(g.uid)) continue;
      if (Number(placed.unread) !== f.unread || Number(placed.starred) !== f.starred) {
        updates.push(flagUpdate(placed.id, f));
        shift += f.unread - Number(placed.unread);
      }
      continue;
    }
    const row = byPid.get(pidOf(g));
    // Only a row filed here. The same Message-ID in another mailbox — you on
    // the Cc of your own mail, a copy in Sent — belongs to that mailbox.
    if (!row || row.folder !== app) continue;
    remapped.add(row.id);
    shift += f.unread - Number(row.unread);
    updates.push(
      env.DB.prepare("UPDATE messages SET unread=?, starred=?, mailbox=?, uid=? WHERE id=?").bind(
        f.unread,
        f.starred,
        mb.name,
        g.uid,
        row.id
      )
    );
  }
  if (updates.length) {
    const res = await env.DB.batch(updates);
    for (const [i, sign] of unreadFlips) shift += sign * Number(res[i]?.meta?.changes || 0);
  }

  // Expunged elsewhere: rows placed in this window whose UID the server no
  // longer has. Rows since refiled here (moved in the app) are not this
  // mailbox's to judge.
  if (trusted) {
    const missing = rangeRows.filter((r) => r.folder === app && !live.has(Number(r.uid))).map((r) => Number(r.uid));
    const { doomed, miss } = strikes(missing, cur.miss, plan.ranges);
    const gone = new Set(doomed.slice(0, MAX_FORGET));
    // A row just matched to a new UID here is not gone, whatever its old one says.
    const drop = rangeRows.filter((r) => gone.has(Number(r.uid)) && !remapped.has(r.id));
    await dropMessages(env, drop.map((r) => r.id));
    shift -= drop.filter((r) => Number(r.unread)).length;
    cur.miss = [...miss, ...doomed.slice(MAX_FORGET)];
    if (gone.size) console.log(`reconcile: ${mb.name}: ${gone.size} expunged elsewhere`);
  }

  // A whole rotation done: every message the server has in first..last has
  // been looked at, so a row filed here that was never placed is one the
  // server no longer has — deleted elsewhere before rows carried UIDs. Two
  // rotations running, like the strikes above, and never Sent or Drafts,
  // whose unplaced rows include copies that exist only here because the
  // append to Apple failed.
  cur.rc = plan.nextRc;
  if (!plan.complete || !trusted || !soleForApp || app === "sent" || app === "drafts") {
    return counts ? shift : 0;
  }
  const { results } = await env.DB.prepare(
    `SELECT id, unread FROM messages
      WHERE account_id=? AND folder=? AND mailbox='' AND uid=0 AND created_at < ? LIMIT ?`
  )
    .bind(account.id, app, Number(cur.rs) || 0, MAX_FORGET)
    .all();
  const candidates = (results ?? []).map((r) => r.id);
  const unreadIds = new Set((results ?? []).filter((r) => Number(r.unread)).map((r) => r.id));
  const prev = new Set(cur.sweep || []);
  const doomed = candidates.filter((id) => prev.has(id));
  cur.sweep = candidates.filter((id) => !prev.has(id));
  if (!doomed.length) return counts ? shift : 0;
  // A brake on a mismatch nobody foresaw: if the server still has mail here
  // yet almost nothing stored matched it, something is wrong with the
  // matching, not with the mailbox.
  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE account_id=? AND folder=?")
    .bind(account.id, app)
    .first();
  if (all.length && doomed.length >= 0.9 * Number(total?.n || 0)) {
    console.log(`reconcile: ${mb.name}: sweep of ${doomed.length} held back, looks like a mismatch`);
    return counts ? shift : 0;
  }
  await dropMessages(env, doomed);
  shift -= doomed.filter((id) => unreadIds.has(id)).length;
  console.log(`reconcile: ${mb.name}: ${doomed.length} never-placed rows swept`);
  return counts ? shift : 0;
}

/**
 * One IMAP pass over every mailbox.
 *
 * Whole messages are fetched rather than headers alone, which is what lets a
 * body be defused and cached the moment it arrives. The cost is CPU inside the
 * Worker, so IMAP_CAP is deliberately low — at a pass a minute it still keeps
 * up with a personal mailbox.
 */
export async function syncIcloud(env, account, tally = {}) {
  const pass = await icloudPassword(env, account);
  if (!pass) return 0; // no stored credential: nothing to sync with

  const im = await imapOpen({ user: account.email, pass });
  let stored = 0;
  try {
    const state = account.sync_state ? JSON.parse(account.sync_state) : {};
    const folders = state.folders || {};

    // Trash and Junk sync, but they never get history. Deleted mail is the
    // least useful thing in a mailbox and there is usually the most of it —
    // here, 719 binned messages against 200 archived ones. Left unranked they
    // eat the whole backfill budget and the folders you actually read crawl.
    const EPHEMERAL = new Set(["trash", "spam"]);
    const boxes = (await imapList(im))
      .filter((mb) => mb.name.toLowerCase() !== "notes")
      .sort((a, b) => EPHEMERAL.has(folderNameFor(a)) - EPHEMERAL.has(folderNameFor(b)));

    // Round-robin start point. Walking the same order every pass starves every
    // folder after the first: while the inbox still has history to backfill it
    // eats the whole budget, and Sent would never sync at all.
    // Reconcile against what the server actually has. Until now the folder
    // list came only from stored messages, so a mailbox deleted in Apple Mail
    // lingered here forever — visible, selectable, and impossible to act on
    // because it no longer exists to act upon.
    await reconcileFolders(env, account, boxes, state);

    const start = Number(state.cursor || 0) % Math.max(1, boxes.length);
    const ordered = boxes.slice(start).concat(boxes.slice(0, start));
    let advanced = 0;

    // Read once for the whole pass, not once per message: the list is tiny and
    // never changes mid-sync.
    const blocked = await loadBlocked(env);
    const destroyed = new Map();

    for (const mb of ordered) {
      if (stored >= IMAP_CAP) break;
      advanced++;

      const app = folderNameFor(mb);
      const prev = folders[mb.name] || {};
      const sel = await imapSelect(im, mb.name);
      let last = Number(prev.last_uid || 0);
      let first = Number(prev.first_uid || 0);
      // Reconcile's own place in the mailbox rides along with the cursor.
      let carry = prev;
      if (sel.uidvalidity && prev.uidvalidity && prev.uidvalidity !== sel.uidvalidity) {
        last = 0; // mailbox renumbered; both ends of the old cursor are meaningless
        first = 0;
        carry = {};
        // So are the UIDs stored on its rows. Left in place, reconciling would
        // read every one of them as expunged and delete the lot. The mailbox
        // name stays, which keeps them out of the sweep for rows never placed;
        // the re-read that follows puts the new UIDs back.
        await env.DB.prepare("UPDATE messages SET uid=0 WHERE account_id=? AND mailbox=?")
          .bind(account.id, mb.name)
          .run();
      }
      // A cursor written before first_uid existed knows its ceiling but has no
      // floor, and `first > 1` below is then false forever — so those folders
      // would take new mail and never once walk backwards. Treat the ceiling as
      // the floor and history starts filling in from there.
      if (!first && last) first = last;

      const budget = IMAP_CAP - stored;
      let targets = [];

      // New mail first — never make someone wait on history for today's post.
      if (last) {
        targets = (await imapSearch(im, `UID ${last + 1}:*`)).filter((u) => u > last).slice(0, budget);
      } else {
        targets = (await imapSearch(im, "ALL")).slice(-budget);
      }

      // Spare budget walks backwards through what has not been fetched yet, so
      // history fills in over successive passes instead of never arriving —
      // except for Trash and Junk, which only ever take what is new.
      if (targets.length < budget && first > 1 && !EPHEMERAL.has(app)) {
        const older = await imapSearch(im, `UID 1:${first - 1}`);
        targets = older.slice(-(budget - targets.length)).concat(targets);
      }

      const rows = [];
      // Sizes first, so an oversized message is listed from its headers rather
      // than jamming the folder behind a body that will never fit.
      const sizes = new Map(
        (targets.length ? await imapFetchMeta(im, targets.join(",")) : []).map((m) => [m.uid, m.size])
      );
      for (const uid of targets) {
        const oversized = (sizes.get(uid) || 0) > MAX_BODY_BYTES;
        const msg = oversized ? await imapFetchHead(im, uid) : await imapFetchRaw(im, uid);
        if (!msg?.raw) continue;
        // One message the parser cannot read must not stop the folder. It
        // used to throw straight out of the pass before the cursor was saved,
        // so the next minute fetched the same message, threw again, and no
        // mail arrived anywhere from then on. Its headers alone are tried
        // instead, and failing that it is skipped and the pass goes on.
        let parsed;
        try {
          parsed = rowFromRaw(msg, app);
        } catch (e) {
          console.log(`sync: ${mb.name} uid ${uid} unreadable (${e.message || e}), trying headers`);
          const head = oversized ? null : await imapFetchHead(im, uid).catch(() => null);
          try {
            parsed = head?.raw ? rowFromRaw(head, app) : null;
          } catch {
            parsed = null;
          }
          if (!parsed) continue;
        }
        const { row, body, attachments } = parsed;
        row.mailbox = mb.name;
        row.uid = uid;
        let doc = bodyFromParts({ ...body, attachments });

        // A blocked sender never becomes a message here. Expunged where it
        // sits, before the body reaches R2 and before the row exists, so
        // there is no unread count to raise and nothing to notify about —
        // which is the whole point of blocking rather than filtering.
        const rule = blockedBy(row.from_email, blocked);
        if (rule) {
          await imapPurge(im, uid);
          destroyed.set(rule, (destroyed.get(rule) || 0) + 1);
          continue;
        }

        // A big message is almost always a small message with a big file
        // stapled to it. Read its structure, pull only the readable part, and
        // leave the attachment on the server — the same trick that lets an
        // attachment be downloaded without dragging the message with it.
        if (oversized) {
          const parsed = await readLargeBody(im, uid, sizes.get(uid) || 0);
          doc = bodyFromParts({ ...parsed, attachments: parsed.attachments || attachments });
          // A headers-only fetch has no body to preview; take one from what the
          // structure yielded, or the list shows a blank under the subject.
          if (!row.snippet && parsed.html) {
            row.snippet = htmlToText(parsed.html).replace(/\s+/g, " ").trim().slice(0, 280);
          }
        }
        rows.push(row);
        const id = await hashHex(`msg|${account.id}|${row.pid}`, 16);
        await env.MAIL.put(bodyKey(id), JSON.stringify(doc), {
          httpMetadata: { contentType: "application/json" },
        });
        // Indexed from the defused HTML, so what is searched is what you read.
        await indexMessage(env, id, row, htmlToText(doc.html || ""));
      }
      if (rows.length) {
        await storeRows(env, account.id, rows);
        await env.DB.prepare(
          `UPDATE messages SET has_body=1 WHERE account_id=? AND pid IN (${rows.map(() => "?").join(",")})`
        )
          .bind(account.id, ...rows.map((r) => r.pid))
          .run();
        stored += rows.length;
      }

      folders[mb.name] = {
        ...carry,
        // The name the app files mail under, kept beside the cursor so the
        // folder list can name a mailbox that has no mail in it to name it.
        app,
        uidvalidity: sel.uidvalidity || prev.uidvalidity || 0,
        last_uid: Math.max(last, ...targets, 0),
        first_uid: targets.length ? Math.min(first || Infinity, ...targets) : first,
      };
    }
    state.cursor = (start + Math.max(1, advanced)) % Math.max(1, boxes.length);
    await countDestroyed(env, destroyed);

    // What changed elsewhere: flags set and mail expunged on the phone or in
    // Apple Mail. The inbox every pass, since that is where reading happens,
    // and one other mailbox in turn. Never allowed to fail the pass — new
    // mail has already been stored and the cursors must still be saved.
    const inbox = boxes.find((mb) => folderNameFor(mb) === "inbox");
    const others = boxes.filter((mb) => mb !== inbox);
    const turn = others.length ? others[Number(state.rcursor || 0) % others.length] : null;
    state.rcursor = (Number(state.rcursor || 0) + 1) % Math.max(1, others.length);
    const appCount = new Map();
    for (const mb of boxes) appCount.set(folderNameFor(mb), (appCount.get(folderNameFor(mb)) || 0) + 1);
    for (const mb of [inbox, turn]) {
      if (!mb || !folders[mb.name]) continue;
      try {
        const shift = await reconcileMailbox(env, account, im, mb, folders[mb.name], appCount.get(folderNameFor(mb)) === 1);
        tally.unreadShift = (tally.unreadShift || 0) + shift;
      } catch (e) {
        if (isAuthFailure(e)) throw e;
        console.log(`reconcile: ${mb.name}: ${e.message || e}`);
      }
    }

    // Existing mail predates the index, so each pass also indexes a handful of
    // messages that are not in it yet. Spread over passes rather than done in
    // one go: reading 700 bodies out of R2 in a single invocation would blow
    // both the time and the memory budget.
    await backfillSearch(env, account, 20);

    await env.DB.prepare(
      "UPDATE accounts SET sync_state=?, last_sync=?, status='ok', last_error=NULL WHERE id=?"
    )
      .bind(
        JSON.stringify({
          folders,
          cursor: state.cursor || 0,
          rcursor: state.rcursor || 0,
          gone: state.gone || {},
        }),
        Date.now(),
        account.id
      )
      .run();
  } finally {
    await im.logout();
  }
  return stored;
}

/* ────────────────────────────────────────────────────────────────
   Blocked senders: mail destroyed on sight rather than filed.
   ──────────────────────────────────────────────────────────────── */

/** Every rule, lowercase. */
export async function loadBlocked(env) {
  const { results } = await env.DB.prepare("SELECT pattern FROM blocked_senders").all();
  return (results ?? []).map((r) => r.pattern);
}

/** The rule that catches this sender, or "" when none does. */
export const blockedBy = (email, patterns) => patterns.find((p) => blockMatches(email, p)) || "";

/**
 * The running count under each rule.
 *
 * The only thing a block leaves behind. Without it "nothing from them ever
 * arrives" and "the rule stopped matching six weeks ago" look identical from
 * the outside, and one of those is a rule quietly doing nothing.
 */
export async function countDestroyed(env, hits) {
  if (!hits.size) return;
  const now = Date.now();
  await env.DB.batch(
    [...hits].map(([pattern, n]) =>
      env.DB
        .prepare("UPDATE blocked_senders SET n=n+?, last_at=? WHERE pattern=?")
        .bind(n, now, pattern)
    )
  );
}

/**
 * Destroys what a new rule should already have caught.
 *
 * A rule only bites during a sync, and sync never walks backwards — so without
 * this, blocking someone leaves everything they have already sent sitting in
 * the mailbox, which is not what anyone means by "block".
 *
 * IMAP SEARCH FROM is a substring test over the whole header, so it is used to
 * narrow the field and never to decide: every candidate's From is re-read and
 * put back through the same matcher before anything is expunged. Over-matching
 * here would destroy mail permanently, and there is no undo at the far end.
 */
export async function purgeBlockedAtProvider(env, account, pattern, cap = 100) {
  const pass = await icloudPassword(env, account);
  if (!pass) return 0;

  const needle = String(pattern).replace(/["\\\r\n]/g, "");
  let killed = 0;
  const im = await imapOpen({ user: account.email, pass });
  try {
    for (const mb of await imapList(im)) {
      if (killed >= cap) break;
      await imapSelect(im, mb.name);
      const uids = await imapSearch(im, `FROM "${needle}"`).catch(() => []);
      for (const uid of uids.slice(0, cap - killed)) {
        const head = await imapFetchHead(im, uid).catch(() => null);
        if (!head?.raw) continue;
        const h = parseHeaders(head.raw);
        if (!blockMatches(parseAddress(h.from || "").email, pattern)) continue;
        await imapPurge(im, uid);
        killed++;
      }
    }
  } finally {
    await im.logout();
  }
  return killed;
}

/** Forgets everything a rule matches on this side: rows, bodies and index. */
export async function forgetBlockedLocally(env, pattern) {
  // LIKE only narrows — `_` and `%` in a pattern can widen the candidate set
  // but never shrink it, and every candidate is checked properly below.
  const tail = pattern.includes("@") ? pattern : `%${pattern}`;
  const { results } = await env.DB.prepare(
    "SELECT id, from_email FROM messages WHERE from_email=? OR from_email LIKE ? LIMIT 2000"
  )
    .bind(pattern, tail)
    .all();

  const ids = (results ?? []).filter((r) => blockMatches(r.from_email, pattern)).map((r) => r.id);
  if (!ids.length) return 0;

  await forgetMessages(env, ids);
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    await env.DB.prepare(`DELETE FROM messages WHERE id IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .run();
  }
  return ids.length;
}

/* ────────────────────────────────────────────────────────────────
   Sync, one account at a time, small on purpose.
   ──────────────────────────────────────────────────────────────── */

/**
 * One pass over one account, never two at once.
 *
 * The cron fires every minute and "check now" can fire any time, and two
 * passes over the same account each read the cursors, fetched the same
 * messages and wrote their own cursors back last-one-wins — undoing a folder
 * rename the other had just recorded. A lease row in settings decides who
 * runs; one left by a pass that died expires after SYNC_LEASE_MS.
 *
 * Returns { n, busy, error }: how many messages were stored, whether another
 * pass already held the account, and what went wrong if anything did.
 */
export const SYNC_LEASE_MS = 5 * 60_000;

export async function syncAccount(env, account, tally) {
  const key = `sync_lock_${account.id}`;
  const now = Date.now();
  const got = await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value
       WHERE CAST(settings.value AS INTEGER) < ?`
  )
    .bind(key, String(now), now - SYNC_LEASE_MS)
    .run();
  if (!got.meta?.changes) return { n: 0, busy: true, error: "" };
  try {
    if (account.provider === "icloud") return { n: await syncIcloud(env, account, tally), busy: false, error: "" };
    return { n: 0, busy: false, error: "" };
  } catch (e) {
    await flagAccount(env, account, e);
    return { n: 0, busy: false, error: isAuthFailure(e) ? "This account needs reconnecting" : String(e.message || e).slice(0, 200) };
  } finally {
    await env.DB.prepare("DELETE FROM settings WHERE key=? AND value=?").bind(key, String(now)).run().catch(() => {});
  }
}
