/**
 * Outgoing mail: one checked send path, the scheduled outbox, and snoozed messages coming back.
 */

import { imapFlag, imapMove } from "./imap.js";
import { buildRfc822, htmlToText, newMessageId, parseAddressList, replyReferences } from "./mime.js";
import { pushAll } from "./push.js";
import { smtpSend } from "./smtp.js";
import { accountById, fileSentCopy, senderFor } from "./filing.js";
import { icloudAct, icloudPassword, resolveMailbox } from "./mailbox.js";
import { imapError } from "./store.js";
import { json } from "./util.js";

/**
 * Checks one outgoing message and sends it: the Send button, a scheduled
 * message coming due, and "send now" on one that is waiting all go through
 * here. Returns the Response the route would. With dryRun it stops before
 * anything leaves, which is how a scheduled message is checked up front.
 */
export async function deliver(env, b, { dryRun = false } = {}) {
  {
    const acct = await accountById(env, String(b.account_id || ""));
    if (!acct) return json({ error: "Pick an account to send from" }, 400);

    const to = parseAddressList(String(b.to || ""));
    if (!to.length) return json({ error: "No valid recipient" }, 400);
    const cc = parseAddressList(String(b.cc || ""));
    const bcc = parseAddressList(String(b.bcc || ""));
    const html = String(b.html || "");
    // A rich draft still ships a plain-text twin; htmlToText derives one when
    // the client has not, so no reader ever gets an empty message.
    const text = String(b.text || "") || htmlToText(html);
    if (!text.trim() && !html.trim()) return json({ error: "Empty message" }, 400);

    // Refuse, never truncate. One pasted screenshot as a data: URI passes half
    // a megabyte, and silently cutting the body mid-base64 would send a broken
    // message that looks fine in the composer. Apple advertises SIZE 28319744;
    // base64 inflates by a third, so this leaves comfortable headroom.
    const MAX_HTML = 8 * 1024 * 1024;
    if (html.length > MAX_HTML) {
      return json(
        { error: `Message too large (${Math.round(html.length / 1048576)} MB). Remove or shrink an image.` },
        413
      );
    }

    // Attachments arrive already base64 from the browser, so no decoding
    // happens here — the Worker only checks the size and passes them through.
    const attachments = (Array.isArray(b.attachments) ? b.attachments : [])
      .filter((a) => a && a.filename && a.data)
      .slice(0, 20)
      .map((a) => ({
        filename: String(a.filename).slice(0, 200),
        type: String(a.type || "application/octet-stream").slice(0, 100),
        data: String(a.data),
      }));

    // Apple advertises SIZE 28319744 and base64 is already counted here, so
    // this is the real wire size. Refuse up front rather than let the server
    // reject it after the whole thing has been uploaded.
    const totalBytes = html.length + text.length + attachments.reduce((n, a) => n + a.data.length, 0);
    const MAX_TOTAL = 20 * 1024 * 1024;
    if (totalBytes > MAX_TOTAL) {
      return json(
        {
          error: `Too big to send (${(totalBytes / 1048576).toFixed(1)} MB of an allowed 20 MB). Remove an attachment.`,
        },
        413
      );
    }

    const orig = b.reply_to
      ? await env.DB.prepare("SELECT * FROM messages WHERE id=?").bind(String(b.reply_to)).first()
      : null;
    const subject = String(
      b.subject || (orig ? (orig.subject.match(/^re\s*:/i) ? orig.subject : `Re: ${orig.subject}`) : "")
    ).slice(0, 500);

    if (dryRun) return json({ ok: true });

    // Whether a copy reached Sent. Reported rather than thrown: by the time it
    // could fail the message has already gone, and an error at that point reads
    // as "it did not send" and invites sending it twice.
    let filed = false;
    // The reason, handed back to the client. Recording it only in last_error
    // put it somewhere nothing displays, which is how "it did not appear in
    // Sent" stayed a mystery instead of being a message on screen.
    let filedError = "";

    try {
      const pass = await icloudPassword(env, acct);
      if (pass) {
        // Built once, then used twice: this is both what goes out over SMTP
        // and what is appended to Sent, so the copy you keep is the message
        // that was actually delivered rather than a re-rendering of it.
        const sender = await senderFor(env, acct, b.from, orig);
        const raw = buildRfc822({
          from: sender.header,
          to: to.map((a) => a.email).join(", "),
          cc: cc.map((a) => a.email).join(", ") || undefined,
          subject,
          text,
          html: html || undefined,
          attachments,
          inReplyTo: orig?.mid || undefined,
          references: replyReferences(orig),
          messageId: newMessageId(acct.email),
        });
        // Cc is a header; the envelope needs every address explicitly or the
        // copied recipients simply never receive it. Bcc is the same call the
        // other way round: in the envelope only, never in `raw`, which is why
        // it is absent from the buildRfc822 above.
        await smtpSend({
          user: acct.email,
          pass,
          from: sender.address,
          // Once each: someone on both To and Cc is one recipient, not two
          // RCPT TOs and possibly two copies.
          to: [...new Set([...to, ...cc, ...bcc].map((a) => a.email))],
          raw,
        });

        // The message has gone. Everything past this point is bookkeeping, and
        // none of it is allowed to turn a successful send into an error.
        try {
          await fileSentCopy(env, acct, pass, raw, bcc.map((a) => a.email).join(", "));
          filed = true;
        } catch (e) {
          filedError = String(e.message || e).slice(0, 200);
          await env.DB.prepare("UPDATE accounts SET last_error=? WHERE id=?")
            .bind(`file-sent: ${filedError}`.slice(0, 300), acct.id)
            .run()
            .catch(() => {});
        }
      } else {
        return json({ error: "This account has no stored credential" }, 400);
      }
    } catch (e) {
      return imapError(e, acct, env);
    }
    return json({ ok: true, filed, filedError }, 202);
  }
}

/**
 * Brings snoozed messages back. Every minute, after the sync.
 *
 * Unread again and back in the inbox, at iCloud as well as here, and the
 * push rings for it. Only if it is still where snoozing put it: a message
 * you have since moved yourself is yours to keep where you put it.
 */
export async function wakeSnoozed(env) {
  const { results } = await env.DB.prepare("SELECT * FROM snoozed WHERE until <= ? ORDER BY until LIMIT 5")
    .bind(Date.now())
    .all();
  let woke = 0;
  for (const s of results ?? []) {
    const msg = await env.DB.prepare("SELECT * FROM messages WHERE id=?").bind(s.id).first();
    const acct = msg ? await accountById(env, msg.account_id) : null;
    if (!msg || !acct || msg.folder !== s.folder) {
      await env.DB.prepare("DELETE FROM snoozed WHERE id=?").bind(s.id).run();
      continue;
    }
    try {
      await icloudAct(env, acct, msg.mid || msg.pid, msg.folder, async (im, boxes, _here, uid) => {
        const inbox = resolveMailbox(boxes, "inbox");
        if (!inbox) throw new Error("No inbox");
        await imapFlag(im, uid, "\\Seen", false);
        await imapMove(im, uid, inbox.name);
      });
    } catch (e) {
      console.log(`snooze: ${s.id} ${e.message || e}`);
      // Not found anywhere: nothing left to bring back.
      if (/not found in any mailbox/i.test(String(e.message || e))) {
        await env.DB.prepare("DELETE FROM snoozed WHERE id=?").bind(s.id).run();
      }
      continue;
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE messages SET folder='inbox', unread=1 WHERE id=?").bind(msg.id),
      env.DB.prepare("DELETE FROM snoozed WHERE id=?").bind(s.id),
    ]);
    woke++;
  }
  if (woke) await pushAll(env);
  return woke;
}

/**
 * Sends what has come due. Every minute, after the sync.
 *
 * Each message is claimed before it is touched, by moving its time ten
 * minutes on in the same statement that checks it has not moved: a second
 * cron overlapping this one finds nothing to claim, so nothing goes twice.
 * A failure is kept with its reason and tried again later, five times in
 * all; after that it stays in Scheduled, marked, for you to see.
 */
export async function flushOutbox(env) {
  const now = Date.now();
  const { results } = await env.DB.prepare(
    "SELECT * FROM outbox WHERE at <= ? AND tries < 5 ORDER BY at LIMIT 3"
  )
    .bind(now)
    .all();
  for (const row of results ?? []) {
    const claimed = await env.DB.prepare("UPDATE outbox SET at=?, tries=tries+1 WHERE id=? AND at=?")
      .bind(now + 10 * 60_000, row.id, row.at)
      .run();
    if (!claimed.meta?.changes) continue;
    const obj = await env.MAIL.get(`outbox/${row.id}.json`);
    if (!obj) {
      await env.DB.prepare("UPDATE outbox SET last_error=?, tries=5 WHERE id=?")
        .bind("The scheduled message is missing", row.id)
        .run();
      continue;
    }
    const res = await deliver(env, JSON.parse(await obj.text())).catch((e) => json({ error: String(e.message || e) }, 500));
    if (res.status === 202) {
      await env.DB.prepare("DELETE FROM outbox WHERE id=?").bind(row.id).run();
      await env.MAIL.delete(`outbox/${row.id}.json`);
    } else {
      const d = await res.json().catch(() => ({}));
      // Backing off: 10 minutes, then 20, 40, 80.
      await env.DB.prepare("UPDATE outbox SET last_error=?, at=? WHERE id=?")
        .bind(String(d.error || `HTTP ${res.status}`).slice(0, 300), now + 10 * 60_000 * 2 ** row.tries, row.id)
        .run();
    }
  }
}
