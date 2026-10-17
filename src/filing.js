/**
 * Filing and identity: moving at the provider, Sent and Drafts copies, accounts, aliases, the From line, the AI key.
 */

import { bodyFromParts } from "./body.js";
import { DEFAULT_MODEL as CLAUDE_DEFAULT } from "./claude.js";
import { open } from "./crypto.js";
import { imapAppend, imapList, imapMove, imapOpen, imapPurge, imapSearch, imapSelect } from "./imap.js";
import { formatFrom, htmlToText, parseAddressList } from "./mime.js";
import { folderNameFor, icloudAct, mailboxList, resolveMailbox } from "./mailbox.js";
import { indexMessage, storeRows, unindex } from "./store.js";
import { rowFromRaw } from "./sync.js";
import { FLAG_SEEN, bodyKey, hashHex, json } from "./util.js";

/* ────────────────────────────────────────────────────────────────
   Filing: one destination name, one provider.
   ──────────────────────────────────────────────────────────────── */

/** Buckets every provider has, under the names this app uses. */
export const SYSTEM_FOLDERS = new Set(["inbox", "archive", "spam", "trash", "sent", "drafts"]);

export async function moveAtProvider(env, acct, msg, target) {
  const done = await icloudAct(env, acct, msg.mid || msg.pid, msg.folder, async (im, boxes, _here, uid) => {
    // Match the destination by the app's own folder name first, then by the
    // raw IMAP name, so both "spam" and "Junk" reach the same mailbox.
    const dest = resolveMailbox(boxes, target);
    if (!dest) throw new Error(`No mailbox matching "${target}". Server has: ${mailboxList(boxes)}`);
    await imapMove(im, uid, dest.name);
  });
  if (!done) throw new Error("This account has no stored credential");
}

/**
 * Files the copy of a message you have just sent.
 *
 * SMTP delivers and forgets. It hands the message to the recipient's server and
 * keeps nothing for the sender, so unless a client puts a copy somewhere, a
 * sent message exists nowhere in your own mailbox — which is why Sent stayed
 * empty. Nothing else in the stack does it for us.
 *
 * Both halves matter: APPEND so the copy is at Apple and every device sees it,
 * and a row here so it appears in Sent the moment the composer closes rather
 * than whenever the next sync happens to reach that mailbox.
 */
export async function fileSentCopy(env, account, pass, raw, bccLine = "") {
  // The local row first, and unconditionally. A message you have sent should
  // appear in Sent whatever the server then makes of the copy — tying the two
  // together meant one IMAP hiccup left you with no record of having written
  // anything, which is worse than a record that is briefly ahead of Apple.
  //
  // Parsed back out of the bytes that were actually sent rather than rebuilt
  // from the form fields, so what Sent shows is the message as it went.
  const { row, body, attachments } = rowFromRaw({ uid: 0, flags: FLAG_SEEN, raw }, "sent");
  const doc = bodyFromParts({ ...body, attachments });
  // The bytes carry no Bcc — that is the point of one — so it is added to the
  // row here. Sent is your own record, and "who else got this" is exactly what
  // you go back to Sent to find out.
  row.bcc_line = bccLine;
  const id = await hashHex(`msg|${account.id}|${row.pid}`, 16);
  await env.MAIL.put(bodyKey(id), JSON.stringify(doc), {
    httpMetadata: { contentType: "application/json" },
  });
  await storeRows(env, account.id, [row]);
  await env.DB.prepare("UPDATE messages SET has_body=1 WHERE account_id=? AND pid=?")
    .bind(account.id, row.pid)
    .run();
  await indexMessage(env, id, row, htmlToText(doc.html || ""));

  // Then Apple's copy, so every other device sees it too.
  const im = await imapOpen({ user: account.email, pass });
  try {
    const boxes = await imapList(im);
    const box = boxes.find((mb) => folderNameFor(mb) === "sent");
    if (!box) throw new Error(`no Sent mailbox — server has: ${mailboxList(boxes)}`);
    // Already read: it is your own message, and an unread badge on Sent is
    // nobody's idea of new mail.
    await imapAppend(im, box.name, raw, FLAG_SEEN);
  } finally {
    await im.logout();
  }
}

/**
 * Forgets one message here, by its Message-ID rather than its row id.
 *
 * A draft is identified by the id it was written with, because that is the
 * only handle the client keeps between saves.
 */
export async function forgetLocal(env, accountId, pid) {
  if (!pid) return;
  const id = await hashHex(`msg|${accountId}|${pid}`, 16);
  await env.MAIL.delete(bodyKey(id)).catch(() => {});
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages WHERE id=?").bind(id),
    ...(await unindex(env, [id])),
  ]);
}

/**
 * Keeps one draft at Apple, and drops the copy it supersedes.
 *
 * A draft is saved over and over as it is written, and IMAP has no notion of
 * replacing a message — APPEND only ever adds. Without the purge, one letter
 * written over a morning leaves a Drafts folder with forty copies of itself in
 * it, on every device.
 *
 * The local row goes in first and unconditionally, for the same reason the
 * Sent copy does: what you have written must be recoverable even when Apple
 * is having a bad minute.
 */
export async function fileDraftCopy(env, account, pass, raw, replaces) {
  const { row, body, attachments } = rowFromRaw({ uid: 0, flags: FLAG_SEEN, raw }, "drafts");
  const doc = bodyFromParts({ ...body, attachments });
  const id = await hashHex(`msg|${account.id}|${row.pid}`, 16);
  await env.MAIL.put(bodyKey(id), JSON.stringify(doc), {
    httpMetadata: { contentType: "application/json" },
  });
  await storeRows(env, account.id, [row]);
  await env.DB.prepare("UPDATE messages SET has_body=1 WHERE account_id=? AND pid=?")
    .bind(account.id, row.pid)
    .run();
  await indexMessage(env, id, row, htmlToText(doc.html || ""));
  if (replaces && replaces !== row.pid) await forgetLocal(env, account.id, replaces);

  const im = await imapOpen({ user: account.email, pass });
  try {
    const boxes = await imapList(im);
    const box = boxes.find((mb) => folderNameFor(mb) === "drafts");
    if (!box) throw new Error(`no Drafts mailbox — server has: ${mailboxList(boxes)}`);
    await imapSelect(im, box.name);

    // The old copy goes before the new one lands, so a failure halfway leaves
    // one draft rather than none.
    if (replaces && replaces !== row.pid) {
      const uids = await imapSearch(im, `HEADER "Message-ID" "${String(replaces).replace(/["\\\r\n]/g, "")}"`);
      for (const uid of uids) await imapPurge(im, uid);
    }
    // \Draft is what tells Mail on a phone this is unfinished rather than
    // received, and \Seen keeps Drafts from wearing an unread badge.
    await imapAppend(im, box.name, raw, `${FLAG_SEEN} \\Draft`);
  } finally {
    await im.logout();
  }
  return row.pid;
}

/* ────────────────────────────────────────────────────────────────
   Public API (behind the cookie)
   ──────────────────────────────────────────────────────────────── */

export async function accountById(env, id) {
  return env.DB.prepare("SELECT * FROM accounts WHERE id=?").bind(id).first();
}

/** The other addresses an account sends from: iCloud aliases, a custom domain. */
export async function aliasesOf(env, acct) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(`aliases_${acct.id}`).first();
  try {
    return row ? JSON.parse(row.value) : [];
  } catch {
    return [];
  }
}

/**
 * Who a message goes out as: the address, and the From: header that names it.
 *
 * Every reply used to leave from the account's main address — including the
 * reply to mail that arrived at an alias or a Hide My Email address, which
 * handed the sender the very address the alias existed to keep from them.
 * An address is accepted if it is the account's own, one of its listed
 * aliases, or the address the message being answered was sent to.
 * Anything else falls back to the main address rather than letting a request
 * pick an arbitrary sender.
 */
export async function senderFor(env, acct, wanted, orig) {
  const want = String(wanted || "").trim().toLowerCase();
  let address = acct.email;
  if (want && want !== acct.email.toLowerCase()) {
    const own = (await aliasesOf(env, acct)).map((a) => a.toLowerCase());
    const received = orig
      ? parseAddressList(`${orig.to_line || ""}, ${orig.cc_line || ""}`).map((a) => a.email)
      : [];
    if (own.includes(want) || received.includes(want)) address = want;
  }
  return { address, header: formatFrom(acct.label, address) };
}

/**
 * The key the writing assistant runs on: the one typed into the app first,
 * the deploy-time secret second.
 *
 * ANTHROPIC_API_KEY as a Worker secret means rotating it — or moving to
 * another workspace, or revoking one that leaked — needs a terminal, a
 * wrangler login and a machine with the repo on it. That is a lot of ceremony
 * for the one credential here that is expected to change. Typed into Settings
 * it is sealed with ENC_KEY exactly like the iCloud password, and the secret
 * stays behind it so an install that already had one keeps working untouched.
 */
export async function aiKey(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key='claude_key'").first();
  const box = row?.value ? await open(env.ENC_KEY, row.value) : null;
  return box?.key || env.ANTHROPIC_API_KEY || "";
}

/**
 * The model the assistant runs on: the one chosen in the app first, the
 * deployed CLAUDE_MODEL second.
 *
 * Not sealed, unlike the key — a model name is not a secret, and reading it
 * back is exactly what the picker in Settings needs to do.
 */
export async function aiModel(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key='claude_model'").first();
  return row?.value || env.CLAUDE_MODEL || CLAUDE_DEFAULT;
}
