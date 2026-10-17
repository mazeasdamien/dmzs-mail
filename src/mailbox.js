/**
 * Talking to iCloud: mailbox names, the sealed password, one connection per operation, and finding a message by Message-ID.
 */

import { open } from "./crypto.js";
import { imapList, imapOpen, imapSearch, imapSelect } from "./imap.js";

/* ────────────────────────────────────────────────────────────────
   iCloud over IMAP, spoken by the Worker itself.
   ──────────────────────────────────────────────────────────────── */

export const IMAP_CAP = 8; // whole messages pulled per account per pass — see note below

// Past this, only the headers are taken. A Worker cannot hold a 17 MB mail in
// memory and parse it inside the CPU budget, and one such message would
// otherwise block its folder permanently.
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

// SPECIAL-USE flags are the reliable signal; names differ by provider and by
// the language the account was created in. Names are only the fallback.
export const IMAP_FLAG_FOLDER = {
  "\\Sent": "sent",
  "\\Drafts": "drafts",
  "\\Trash": "trash",
  "\\Junk": "spam",
  "\\Archive": "archive",
};

export const IMAP_NAME_FOLDER = {
  inbox: "inbox",
  "sent messages": "sent",
  sent: "sent",
  drafts: "drafts",
  "deleted messages": "trash",
  trash: "trash",
  junk: "spam",
  spam: "spam",
  archive: "archive",
};

export function folderNameFor(mb) {
  // Split before matching. `flags` is the raw LIST capture, so a substring
  // test would let one flag match inside another — and misreading INBOX as
  // \Trash would file live mail under trash and disable its backfill.
  const flags = String(mb.flags || "")
    .split(/[\s()]+/)
    .filter(Boolean)
    .map((f) => f.toLowerCase());
  for (const [flag, app] of Object.entries(IMAP_FLAG_FOLDER)) {
    if (flags.includes(flag.toLowerCase())) return app;
  }
  return IMAP_NAME_FOLDER[mb.name.toLowerCase()] || mb.name;
}

/** The app password, or null when none is stored. */
export async function icloudPassword(env, account) {
  const box = await open(env.ENC_KEY, account.secret);
  return box?.password || null;
}

/**
 * Finds the mailbox a folder name refers to.
 *
 * The same folder has several names: the IMAP path ("INBOX/Cranfield"), the
 * app's own name ("archive" for "Archive"), and the leaf shown in the UI
 * ("Cranfield"). Matching on only one of them is why renaming a folder that
 * plainly exists could fail with "no mailbox called…".
 */
export function resolveMailbox(boxes, wanted) {
  const want = String(wanted || "").trim();
  const lower = want.toLowerCase();
  const leaf = (n) => String(n).split(/[\/.]/).filter(Boolean).pop() || n;
  return (
    boxes.find((mb) => mb.name === want) ||
    boxes.find((mb) => folderNameFor(mb) === want) ||
    boxes.find((mb) => mb.name.toLowerCase() === lower) ||
    boxes.find((mb) => String(folderNameFor(mb)).toLowerCase() === lower) ||
    boxes.find((mb) => leaf(mb.name).toLowerCase() === lower) ||
    null
  );
}

/** Names every mailbox, so a failure to match is diagnosable rather than flat. */
export const mailboxList = (boxes) => boxes.map((mb) => mb.name).join(", ").slice(0, 200);

/**
 * The one connected iCloud account, or null.
 *
 * There is only ever one: the app is a personal mailbox, and pretending to
 * dispatch between providers is what left `No provider handler` throws and a
 * jobs table sitting in the schema. `account_id` stays on every row because
 * live data has it and it still names the mailbox a message arrived on.
 */
export async function theAccount(env) {
  return env.DB.prepare(
    "SELECT * FROM accounts WHERE provider='icloud' AND secret IS NOT NULL ORDER BY created_at LIMIT 1"
  ).first();
}

/** Opens a connection, runs one operation, always hangs up. */
export async function withImap(env, account, fn) {
  const pass = await icloudPassword(env, account);
  if (!pass) throw new Error("This account has no stored credential");
  const im = await imapOpen({ user: account.email, pass });
  try {
    return await fn(im);
  } finally {
    await im.logout();
  }
}

/**
 * Moves (or drops) a mailbox's sync cursor when the mailbox is renamed or
 * deleted. Cursors are keyed by IMAP name, so a rename without this leaves the
 * old key orphaned and the mailbox looks brand new — re-downloading its entire
 * history under the new name.
 */
export async function renameCursor(env, account, from, to, app = to) {
  const row = await env.DB.prepare("SELECT sync_state FROM accounts WHERE id=?")
    .bind(account.id)
    .first();
  const state = row?.sync_state ? JSON.parse(row.sync_state) : {};
  const folders = state.folders || {};
  if (!(from in folders)) return;
  if (to) folders[to] = { ...folders[from], app };
  delete folders[from];
  state.folders = folders;
  await env.DB.prepare("UPDATE accounts SET sync_state=? WHERE id=?")
    .bind(JSON.stringify(state), account.id)
    .run();
}

/**
 * Finds a message by Message-ID and does something to it over IMAP.
 *
 * Returns false when the account has no stored credential. `hintFolder` is
 * tried first — usually one round trip rather than ten — but every mailbox is
 * still searched, because the message may have been moved from another client
 * since we last looked.
 */
export async function icloudAct(env, account, mid, hintFolder, fn, { onlyHint = false } = {}) {
  const pass = await icloudPassword(env, account);
  if (!pass) return false;
  if (!mid) throw new Error("no Message-ID for this message");

  const im = await imapOpen({ user: account.email, pass });
  try {
    const boxes = await imapList(im);
    const first = boxes.filter((mb) => folderNameFor(mb) === hintFolder);
    // onlyHint: for something that must never act outside its own folder —
    // purging a draft that turned up, by Message-ID, somewhere else.
    const rest = onlyHint ? [] : boxes.filter((mb) => folderNameFor(mb) !== hintFolder);
    const needle = String(mid).replace(/["\\\r\n]/g, "");

    for (const mb of first.concat(rest)) {
      await imapSelect(im, mb.name);
      const uids = await imapSearch(im, `HEADER "Message-ID" "${needle}"`);
      if (uids.length) {
        await fn(im, boxes, mb, uids[uids.length - 1]);
        return true;
      }
    }
    throw new Error("message not found in any mailbox");
  } finally {
    await im.logout();
  }
}

/**
 * One operation, every message of a conversation, one connection.
 *
 * Doing this a message at a time is what the client used to do by hand: each
 * one opened its own IMAP session, logged in, listed the mailboxes and hunted
 * for a Message-ID. On a five-message thread that is five logins to accomplish
 * one obvious thing, and you watch it happen row by row.
 *
 * Grouped by the folder each message is filed under, so a mailbox is selected
 * once rather than once per message.
 */
export async function threadAct(env, account, rows, fn) {
  const pass = await icloudPassword(env, account);
  if (!pass) return 0;

  const byFolder = new Map();
  for (const r of rows) {
    const k = r.folder || "inbox";
    if (!byFolder.has(k)) byFolder.set(k, []);
    byFolder.get(k).push(r);
  }

  let done = 0;
  const im = await imapOpen({ user: account.email, pass });
  try {
    const boxes = await imapList(im);
    for (const [folder, list] of byFolder) {
      const mb = resolveMailbox(boxes, folder);
      if (!mb) continue;
      await imapSelect(im, mb.name);
      for (const r of list) {
        const needle = String(r.mid || r.pid).replace(/["\\\r\n]/g, "");
        if (!needle) continue;
        const uids = await imapSearch(im, `HEADER "Message-ID" "${needle}"`).catch(() => []);
        for (const uid of uids) {
          await fn(im, boxes, uid);
          done++;
        }
      }
    }
  } finally {
    await im.logout();
  }
  return done;
}

/** The messages of one conversation, as they are filed right now. */
export async function threadRowsIn(env, key, folder) {
  const { results } = await env.DB.prepare(
    `SELECT id, account_id, mid, pid, folder FROM messages
      WHERE thread_key=? AND thread_key<>'' AND folder=? LIMIT 200`
  )
    .bind(key, folder)
    .all();
  return results ?? [];
}
