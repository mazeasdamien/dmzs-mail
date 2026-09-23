# dmzs-mail

Your iCloud mailbox, served by one Cloudflare Worker on the free tier and read
from a PWA on your phone. Read, archive, reply. No mail client installed, no
ads reading your mail, and the only party holding your messages besides Apple
is your own Cloudflare account.

**Running cost: $0.** MIT. No warranty; your mail is your responsibility.

---

## How it fits together

```
                 ┌──────────────────────────────────────────────┐
                 │   Worker: API, auth, sync cron, defusing     │
 iCloud ◄──────► │   D1: accounts, message index                │◄──► phone / desktop (PWA)
  IMAP/SMTP      │   R2: defused bodies                         │
                 └──────────────────────────────────────────────┘
```

One provider, iCloud, spoken directly over IMAP and SMTP by the Worker using
an app-specific password. There is no dispatch layer and no abstraction over
"a mail account", because there is nothing to dispatch between.

**The trade, stated plainly:** the app-specific password is sealed in your own
Cloudflare account (AES-256-GCM before it touches D1) rather than sitting only
on a machine at home. In exchange, mail syncs every minute from anywhere with
nothing of yours running. The password is an *app-specific* one from
account.apple.com — revocable in seconds, and the only kind Apple will accept
here.

### What "sync" means

- A cron fires **every minute** and refreshes the least-recently-synced
  account, a dozen messages at a time. **Sync** does the same on demand.
- Every selectable IMAP mailbox syncs — Inbox, Sent, Spam, Archive, and any
  folder you made.
- Bodies are **defused before storage**: scripts, event handlers, iframes and
  `javascript:` links stripped, remote loads rewritten to `data-blocked-src`.
  Cached in R2 so the second read is instant.
- **Remote images are a setting** (account button): *Load them* or *Ask first*.
  Stored bodies keep the blocked form either way, so switching costs nothing.
- The reading surface is a **sandboxed iframe** — even if something survived
  the server-side pass, it runs no scripts and shares nothing with the app.

---

## Setup

Wrangler logged in (`npx wrangler login`), and the domain's zone already on
your Cloudflare account. The D1 database and R2 bucket (`dmzs-mail`) already
exist — ids pinned in `wrangler.jsonc`. From scratch:
`wrangler d1 create dmzs-mail && wrangler r2 bucket create dmzs-mail`.

### 1. iCloud app-specific password

<https://account.apple.com> → **Sign-In and Security → App-Specific
Passwords** → generate one named `dmzs-mail`. iCloud Mail must be on, and the
Apple ID needs two-factor auth or the section does not appear. Not your Apple
ID password — that will be rejected.

### 2. Schema, deploy, secrets — in that order

```sh
npm install
npm run db:schema   # tables into the live D1 (all CREATE TABLE IF NOT EXISTS)
npm run deploy      # Worker + PWA + cron → mail.agentxr.app
npm run secrets     # generates AUTH_SECRET / BOOTSTRAP_KEY / ENC_KEY,
                    # prints your activation link and offers a Gemini key for
                    # the writing assistant (optional, changeable later)
```

**Deploy before secrets.** `wrangler secret put` needs a Worker that exists;
with no secrets the Worker is fail-closed and `/auth` refuses every key. Secrets
take effect the moment they land.

### 3. Activate devices, connect iCloud

Open `https://mail.agentxr.app/auth#k=<BOOTSTRAP_KEY>` once per device (the
link `npm run secrets` printed). The key rides in the fragment, so it never
reaches the server logs or the Referer header; the page POSTs it. The older
`?k=` form still works, and pasting the key into the field on `/auth` works
too. Pin the PWA to the iPhone home screen.

Then: account button → **Connect iCloud** → your address and the app-specific
password. The Worker proves it against Apple before storing anything, so a
typo fails at the form. First sync lands within a minute; history fills in
behind it, newest first, rotating between folders.

Messages over 2 MB are listed from their headers with a placeholder body — a
Worker cannot hold a 17 MB attachment in memory inside the CPU budget.

---

## Using the app

Tap a message to read it; opening marks it read at iCloud too. **Archive**,
**Delete**, star and mark-unread write straight through over IMAP. **Swipe**
a row to archive it, **long-press** or the select button for bulk actions.
**Reply** / **Reply all** answer in-thread; the compose button writes fresh
mail. Folders can be created, renamed and deleted from the folder list.

Also live: attachments both ways, download-all as a zip, Bcc, rich text and
pasted images, contact autocomplete and a contacts list, full-text search,
one-click unsubscribe, empty trash, keyboard shortcuts, an AI grammar/rewrite
pass, and light/dark themes.

### Keyboard

`j`/`k` next/previous · `e` archive · `s` star · `u` unread · `v` move ·
`r` reply · `a` reply all · `f` forward · `p` save as PDF · `/` search ·
`Esc` back · `?` the full list.

## Knowing when mail arrives

| Where you are | What tells you |
| --- | --- |
| The app is open | Unread count in the tab title, red dot on the favicon |
| Installed as a PWA, closed | Web Push notification and the home-screen badge |
| Chrome open, app not | The extension in `extension/` |

The extension is not on the Web Store — load it unpacked from
`chrome://extensions` with developer mode on. It polls once a minute and
notifies when the unread count *rises*. Paste `BOOTSTRAP_KEY` once in its
options; the key itself is never stored.

## If something misbehaves

- **Reconnect needed** on an account: the app-specific password was revoked.
  Account button → **Connect iCloud** with a fresh one.
- **"Too large to render here"**: over 2 MB, by design. Open it in Mail.
- Watch it live: `npm run tail`.

## Licence

MIT, same as the rest of the dmzs suite.
