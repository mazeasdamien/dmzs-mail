#!/usr/bin/env python3
"""
dmzs-mail iCloud agent.

Apple exposes no mail API, so this small process does what the Worker
cannot: IMAP for reading, SMTP for sending. It runs on your machine with an
app-specific password and — exactly like the dmzs-music downloader — it
PULLS its work from the Worker. Nothing connects in; no port, no tunnel.

    every POLL_SECONDS:
      1. push any new inbox mail  →  POST /internal/icloud/messages
      2. fetch queued jobs        →  GET  /internal/jobs   (send | archive | read)
      3. execute them over IMAP/SMTP and report back

Standard library only. Configuration comes from environment variables:

    DMZS_MAIL_URL         https://mail.agentxr.app
    DMZS_MAIL_TOKEN       the WORKER_TOKEN secret (npm run secrets printed it)
    ICLOUD_EMAIL          you@icloud.com
    ICLOUD_APP_PASSWORD   app-specific password from account.apple.com
    POLL_SECONDS          optional, default 60
"""

import email
import email.policy
import imaplib
import json
import os
import re
import smtplib
import sys
import time
import urllib.request
from email.message import EmailMessage
from email.utils import parsedate_to_datetime, getaddresses

IMAP_HOST = "imap.mail.me.com"
SMTP_HOST = "smtp.mail.me.com"
BOOTSTRAP_COUNT = 25   # messages pushed on first ever run
BATCH = 10             # messages per upload
MAX_HTML = 500_000     # a body bigger than this travels as text only

# urllib signs its requests "Python-urllib/3.x", a signature Cloudflare's
# browser integrity check bans outright. Every call then returns 403 (error
# 1010) from the edge without reaching the Worker at all — which reads exactly
# like a rejected token, except the token was never looked at. Any honest
# identifier passes; the block is on that one string, not on non-browsers.
USER_AGENT = "dmzs-mail-agent/1.0"

URL = os.environ.get("DMZS_MAIL_URL", "").rstrip("/")
TOKEN = os.environ.get("DMZS_MAIL_TOKEN", "")
EMAIL_ADDR = os.environ.get("ICLOUD_EMAIL", "")
PASSWORD = os.environ.get("ICLOUD_APP_PASSWORD", "")
POLL = int(os.environ.get("POLL_SECONDS", "60"))


def log(msg):
    print(time.strftime("[%H:%M:%S]"), msg, flush=True)


def call(path, payload=None):
    """POST json (or GET when payload is None) against the Worker."""
    req = urllib.request.Request(
        URL + path,
        data=None if payload is None else json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
        method="GET" if payload is None else "POST",
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode() or "{}")


# ── parsing one message ────────────────────────────────────────────


def text_of(part):
    try:
        return part.get_content()
    except Exception:
        payload = part.get_payload(decode=True) or b""
        return payload.decode("utf-8", "replace")


def shape(raw, flags):
    """RFC822 bytes → the JSON the Worker's /internal/icloud/messages wants."""
    m = email.message_from_bytes(raw, policy=email.policy.default)

    html, text = "", ""
    if m.is_multipart():
        for part in m.walk():
            ct = part.get_content_type()
            if ct == "text/html" and not html:
                html = text_of(part)
            elif ct == "text/plain" and not text:
                text = text_of(part)
    else:
        if m.get_content_type() == "text/html":
            html = text_of(m)
        else:
            text = text_of(m)
    if len(html) > MAX_HTML:
        html = ""  # the Worker will render the text version instead

    snippet = re.sub(r"<[^>]+>", " ", text or html)
    snippet = re.sub(r"\s+", " ", snippet).strip()[:200]

    sender = getaddresses([m.get("From", "")]) or [("", "")]
    name, addr = sender[0]

    try:
        date_ms = int(parsedate_to_datetime(m.get("Date", "")).timestamp() * 1000)
    except Exception:
        date_ms = int(time.time() * 1000)

    refs = (m.get("References", "") or "").split()
    mid = (m.get("Message-ID", "") or "").strip()

    return {
        "pid": mid or f"no-mid-{date_ms}-{hash(raw[:200])}",
        "mid": mid,
        "thread_key": refs[0] if refs else "",
        "from_name": name,
        "from_email": addr.lower(),
        "to_line": m.get("To", ""),
        "subject": m.get("Subject", "") or "",
        "snippet": snippet,
        "date": date_ms,
        "unread": 0 if b"\\Seen" in flags else 1,
        "html": html,
        "text": text if not html else "",
    }


# ── IMAP side ──────────────────────────────────────────────────────


def imap_connect():
    im = imaplib.IMAP4_SSL(IMAP_HOST)
    im.login(EMAIL_ADDR, PASSWORD)
    im.select("INBOX")
    # UIDVALIDITY arrives as an untagged response to SELECT, and imaplib's
    # response() *consumes* it: the first read returns the number, every read
    # after that returns [None]. Reading it once here, while it is still there,
    # is also the honest model - UIDVALIDITY is fixed for the life of a SELECT.
    raw = (im.response("UIDVALIDITY")[1] or [None])[0]
    im.dmzs_uidvalidity = int(raw) if raw else 0
    return im


def uidvalidity(im):
    """The value captured at SELECT time; 0 when the server never sent one."""
    return getattr(im, "dmzs_uidvalidity", 0)


# IMAP names differ per provider and per language; SPECIAL-USE flags do not.
# Flags win, names are the fallback for servers that omit them.
FLAG_FOLDERS = {
    "\\Sent": "sent",
    "\\Drafts": "drafts",
    "\\Trash": "trash",
    "\\Junk": "spam",
    "\\Archive": "archive",
}
NAME_FOLDERS = {
    "inbox": "inbox",
    "sent messages": "sent",
    "sent": "sent",
    "drafts": "drafts",
    "deleted messages": "trash",
    "trash": "trash",
    "junk": "spam",
    "spam": "spam",
    "archive": "archive",
}
SKIP_FOLDERS = {"notes"}  # not mail; iCloud exposes it over IMAP anyway


def list_folders(im):
    """[(imap name, app folder)] for every mailbox worth syncing."""
    ok, data = im.list()
    if ok != "OK":
        return [("INBOX", "inbox")]
    out = []
    for raw in data or []:
        if not raw:
            continue
        line = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
        m = re.match(r'\(([^)]*)\)\s+("[^"]*"|\S+)\s+(.*)$', line)
        if not m:
            continue
        flags, name = m.group(1), m.group(3).strip().strip('"')
        if "\\Noselect" in flags or name.lower() in SKIP_FOLDERS:
            continue
        app = next((v for f, v in FLAG_FOLDERS.items() if f in flags), None)
        out.append((name, app or NAME_FOLDERS.get(name.lower(), name)))
    return out or [("INBOX", "inbox")]


def select_folder(im, imap_name):
    """SELECT, returning its UIDVALIDITY. Reads the response while it exists."""
    typ, _ = im.select(f'"{imap_name}"')
    if typ != "OK":
        raise RuntimeError(f"cannot select {imap_name}")
    raw = (im.response("UIDVALIDITY")[1] or [None])[0]
    return int(raw) if raw else 0


def sync_folder(im, imap_name, app_folder, fstate):
    """Pushes what is new in one mailbox; returns that mailbox's new state."""
    validity = select_folder(im, imap_name)
    last = int(fstate.get("last_uid") or 0)
    # Only a *known* mismatch means the mailbox renumbered. Without the
    # `validity and` guard, a server that withholds UIDVALIDITY reads as 0,
    # never matches, and re-bootstraps the last messages on every poll.
    if validity and fstate.get("uidvalidity") not in (None, validity):
        last = 0

    if last == 0:
        ok, data = im.uid("SEARCH", None, "ALL")
        uids = [int(u) for u in (data[0] or b"").split()][-BOOTSTRAP_COUNT:]
    else:
        ok, data = im.uid("SEARCH", None, f"UID {last + 1}:*")
        uids = [int(u) for u in (data[0] or b"").split() if int(u) > last]

    batch = []
    for uid in uids:
        ok, data = im.uid("FETCH", str(uid), "(FLAGS BODY.PEEK[])")
        if ok != "OK" or not data or data[0] is None:
            continue
        flags = data[0][0] if isinstance(data[0], tuple) else b""
        raw = data[0][1] if isinstance(data[0], tuple) else b""
        if not raw:
            continue
        row = shape(raw, flags)
        row["folder"] = app_folder
        batch.append(row)
        if len(batch) >= BATCH:
            call("/internal/icloud/messages", {"email": EMAIL_ADDR, "messages": batch})
            batch = []
    if batch:
        call("/internal/icloud/messages", {"email": EMAIL_ADDR, "messages": batch})

    if uids:
        log(f"pushed {len(uids)} from {app_folder}")
    return {"uidvalidity": validity or fstate.get("uidvalidity"), "last_uid": max(uids) if uids else last}


def sync_all(im, state):
    """Every mailbox, one pass. State is per-folder so they advance apart."""
    folders = state.get("folders") or {}
    for imap_name, app_folder in list_folders(im):
        try:
            folders[imap_name] = sync_folder(im, imap_name, app_folder, folders.get(imap_name, {}))
        except Exception as e:  # noqa: BLE001 - one bad mailbox must not stop the rest
            log(f"folder {imap_name} skipped: {e}")
    new_state = {"folders": folders}
    call("/internal/icloud/state", {"email": EMAIL_ADDR, "state": new_state})
    # Jobs act on the inbox by default; leave the connection pointing there.
    try:
        select_folder(im, "INBOX")
    except Exception:
        pass
    return new_state


def uid_for_mid(im, mid):
    ok, data = im.uid("SEARCH", None, "HEADER", "Message-ID", f'"{mid}"')
    uids = (data[0] or b"").split()
    return uids[-1].decode() if uids else None


def find_anywhere(im, mid):
    """(imap folder, uid) for a Message-ID, searching every mailbox."""
    for imap_name, _app in list_folders(im):
        try:
            select_folder(im, imap_name)
        except Exception:
            continue
        uid = uid_for_mid(im, mid)
        if uid:
            return imap_name, uid
    return None, None


# ── executing jobs ─────────────────────────────────────────────────


def do_send(payload):
    msg = EmailMessage()
    msg["From"] = EMAIL_ADDR
    msg["To"] = ", ".join(payload.get("to", []))
    if payload.get("cc"):
        msg["Cc"] = ", ".join(payload["cc"])
    # send_message reads Bcc for the envelope and drops the header before the
    # message goes out, so the blind recipients stay blind.
    if payload.get("bcc"):
        msg["Bcc"] = ", ".join(payload["bcc"])
    msg["Subject"] = payload.get("subject", "")
    if payload.get("inReplyTo"):
        msg["In-Reply-To"] = payload["inReplyTo"]
        msg["References"] = payload["inReplyTo"]
    msg.set_content(payload.get("text", ""))
    with smtplib.SMTP(SMTP_HOST, 587, timeout=30) as s:
        s.starttls()
        s.login(EMAIL_ADDR, PASSWORD)
        s.send_message(msg)


def imap_name_for(im, app_folder):
    """App folder name ('spam') → this server's mailbox ('Junk')."""
    want = (app_folder or "").lower()
    for name, app in list_folders(im):
        if app.lower() == want or name.lower() == want:
            return name
    return None


def do_move(im, payload):
    """Archive, delete and every manual move are one operation over IMAP."""
    src, uid = find_anywhere(im, payload.get("mid", ""))
    if not uid:
        raise RuntimeError("message not found by Message-ID")
    target = payload.get("folder", "archive")
    dest = imap_name_for(im, target)
    if not dest:
        raise RuntimeError(f"no mailbox matches '{target}'")
    if dest == src:
        return
    select_folder(im, src)
    ok, _ = im.uid("MOVE", uid, f'"{dest}"')
    if ok != "OK":
        # Older path for servers without MOVE: copy, flag deleted, expunge.
        im.uid("COPY", uid, f'"{dest}"')
        im.uid("STORE", uid, "+FLAGS", r"(\Deleted)")
        im.expunge()


def do_flag(im, payload, flag, on):
    src, uid = find_anywhere(im, payload.get("mid", ""))
    if not uid:
        return
    select_folder(im, src)
    im.uid("STORE", uid, "+FLAGS" if on else "-FLAGS", f"({flag})")


def run_jobs(im):
    jobs = call(f"/internal/jobs?email={EMAIL_ADDR}").get("jobs", [])
    for job in jobs:
        kind, payload = job["kind"], job["payload"]
        try:
            if kind == "send":
                do_send(payload)
            elif kind == "archive":
                do_move(im, {**payload, "folder": payload.get("folder", "archive")})
            elif kind == "move":
                do_move(im, payload)
            elif kind == "read":
                do_flag(im, payload, r"\Seen", True)
            elif kind == "unread":
                do_flag(im, payload, r"\Seen", False)
            elif kind == "star":
                do_flag(im, payload, r"\Flagged", bool(payload.get("on", True)))
            else:
                raise RuntimeError(f"unknown job kind '{kind}'")
            call(f"/internal/jobs/{job['id']}", {"ok": True})
            log(f"job {kind} ✓")
        except Exception as e:  # noqa: BLE001 — report, never crash the loop
            call(f"/internal/jobs/{job['id']}", {"ok": False, "error": str(e)[:200]})
            log(f"job {kind} ✗ {e}")


# ── main ───────────────────────────────────────────────────────────


def main():
    missing = [k for k, v in {
        "DMZS_MAIL_URL": URL, "DMZS_MAIL_TOKEN": TOKEN,
        "ICLOUD_EMAIL": EMAIL_ADDR, "ICLOUD_APP_PASSWORD": PASSWORD,
    }.items() if not v]
    if missing:
        sys.exit("missing environment variables: " + ", ".join(missing))

    hello = call("/internal/icloud/hello", {"email": EMAIL_ADDR, "label": EMAIL_ADDR})
    state = json.loads(hello.get("state") or "{}")
    log(f"agent up for {EMAIL_ADDR} (account {hello.get('account_id')})")

    im = None
    while True:
        try:
            if im is None:
                im = imap_connect()
                log("imap connected")
            state = sync_all(im, state)
            run_jobs(im)
        except KeyboardInterrupt:
            log("bye")
            return
        except Exception as e:  # noqa: BLE001 — a home network hiccups; reconnect
            log(f"loop error: {e} — reconnecting next round")
            try:
                if im is not None:
                    im.logout()
            except Exception:
                pass
            im = None
        time.sleep(POLL)


if __name__ == "__main__":
    main()
