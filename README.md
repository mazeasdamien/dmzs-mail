# dmzs-mail

One inbox for Gmail, Outlook and iCloud, served by a single Cloudflare
Worker on the free tier, read from a PWA pinned to your phone. Read,
archive, reply. No mail client installed anywhere, no ads read your mail,
and the only party holding your messages besides your providers is your own
Cloudflare account.

**Running cost: $0.** Same free allowances as dmzs-drive and dmzs-music.

---

## How it fits together

```
                 ┌──────────────────────────────────────────────┐
 Gmail API  ◄───►│                                              │
                 │   Worker: API, auth, sync cron, defusing     │◄──► phone / desktop (PWA)
 iCloud IMAP◄───►│   D1: accounts, message index, jobs          │
                 │   R2: defused bodies                         │
                 └──────────────────────────────────────────────┘
```

| Provider | Read | Archive | Send | How |
|---|---|---|---|---|
| Gmail | ✓ | ✓ | ✓ | Worker ↔ Gmail REST API, OAuth |
| iCloud | ✓ | ✓ | ✓ | Worker ↔ IMAP/SMTP over a Worker socket, app-specific password |
| Outlook / Hotmail | – | – | – | code retained, no UI; two secrets away from working |

Apple has no mail API. v1 solved that with a Python agent on a PC you owned,
which pulled jobs from the Worker — no open port, and the iCloud password
never left your machine. It worked, but it meant your mail only moved while
that PC was awake.

Workers can open outbound TLS sockets, so `src/imap.js` now speaks IMAP
directly and the PC is gone. **The trade is deliberate and worth being clear
about: the app-specific password now lives in Cloudflare** (sealed, see
below) instead of only on your desk. In exchange, iCloud syncs every minute
from anywhere, with nothing of yours running.

The old agent still sits in `agent/` and still works. Nothing points at it.

### What "sync" means here

- A cron fires **every minute** and refreshes the two least-recently-synced
  accounts, a dozen messages each. With two accounts neither is ever more
  than a minute behind, and the per-invocation limits of the free plan stay
  respected (~15 subrequests against a ceiling of 50). The **Sync** button
  on an account does the same immediately.
- Every folder syncs, not just the inbox: Gmail labels including Spam, Sent
  and your own, and every selectable IMAP mailbox on iCloud.
- Message **bodies** are defused before storage — scripts, event handlers,
  iframes and `javascript:` links stripped, remote loads rewritten to
  `data-blocked-src` — then cached in R2 so the second read is instant.
- **Remote images currently load automatically.** The stored form is still
  the neutralized one; `AUTO_IMAGES` in `public/index.html` decides whether
  they are restored on render. Setting it to `false` brings back tap-to-load
  and with it the tracking-pixel protection, without refetching anything.
- The reading surface is a sandboxed iframe: even if something survived the
  server-side pass, it runs no scripts and shares nothing with the app.

### What a leak would cost

OAuth refresh tokens **and the iCloud app-specific password** are sealed
with AES-256-GCM before touching D1; the key (`ENC_KEY`) exists only as a
Worker secret. Someone reading your D1 database would get headers, snippets
and ciphertext — not usable credentials.

Since IMAP moved into the Worker, that ciphertext is the whole story for
iCloud too: there is no longer a copy of the password that exists only on
your machine. If that matters more to you than being free of the PC, the
agent in `agent/` is still there and still works — set `secret` back to NULL
on the iCloud account row and the Worker stops touching it.

An app-specific password is scoped to one app and revocable in seconds at
account.apple.com, which is precisely why Apple issues them and why this is
a defensible place to put one.

---

## Setup

Wrangler needs to be logged in (`npx wrangler login`) and the domain's zone
must already be on your Cloudflare account — same as your other two apps.
The D1 database and the R2 bucket (`dmzs-mail`, both) **already exist in
your account** — created 2026-08-12; the database id is pinned in
`wrangler.jsonc`. If you ever rebuild from scratch:
`wrangler d1 create dmzs-mail && wrangler r2 bucket create dmzs-mail`.

### 1. Google Cloud Console (for Gmail)

1. <https://console.cloud.google.com> → project selector → **New project**
   → name `dmzs-mail`.
2. **APIs & Services → Library** → search **Gmail API** → **Enable**.
3. **APIs & Services → OAuth consent screen**: External, app name
   `dmzs-mail`, your address everywhere it asks. No logo, no scopes needed
   on this screen (they are requested at runtime).
4. **Publish the app to Production.** This matters: an app left in
   *Testing* has its refresh tokens killed after 7 days, and you would be
   reconnecting Gmail every week. In production, unverified, it simply
   shows a "Google hasn't verified this app" interstitial when *you*
   connect — click **Advanced → continue**. For a personal app with one
   user, that is the intended path.
5. **Credentials → Create credentials → OAuth client ID** → type **Web
   application** → Authorized redirect URI, exactly:
   `https://mail.agentxr.app/oauth/google`
6. Keep the **Client ID** and **Client secret** for step 4 below.

### 2. Microsoft Entra (for Outlook)

1. <https://portal.azure.com> → **Microsoft Entra ID → App registrations →
   New registration**. Name `dmzs-mail`.
2. Supported account types: **"Accounts in any organizational directory and
   personal Microsoft accounts"** — the last option. Without it, personal
   outlook.com addresses cannot sign in.
3. Redirect URI: platform **Web**, value
   `https://mail.agentxr.app/oauth/microsoft`
4. After creating: **Overview** → copy the **Application (client) ID**.
5. **Certificates & secrets → New client secret** → 24 months (the
   maximum). Copy the **Value** column immediately — it is shown once.
   Put its expiry in your calendar: when it lapses, Outlook sync stops
   until you mint a new one and update the secret.
6. Permissions are requested at sign-in (`Mail.ReadWrite`, `Mail.Send`,
   `offline_access`, `User.Read`); a personal account consents for itself,
   no admin involved.

### 3. iCloud app-specific password

<https://account.apple.com> → **Sign-In and Security → App-Specific
Passwords** → generate one named `dmzs-mail`. iCloud Mail must be enabled on
the account, and the Apple ID needs two-factor auth or the section does not
appear at all.

You paste it into the app itself later — account button → **Connect
iCloud**. It goes browser → Worker → sealed in D1, and is proved against
Apple before anything is stored, so a typo fails at the form rather than
silently every minute afterwards. Not your Apple ID password: that will be
rejected.

### 4. Schema, deploy, secrets

```sh
npm install
npm run db:schema   # tables into the live D1 (all CREATE TABLE IF NOT EXISTS)
npm run deploy      # Worker + PWA + cron, served at mail.agentxr.app
npm run secrets     # generates AUTH_SECRET/BOOTSTRAP_KEY/WORKER_TOKEN/ENC_KEY,
                    # prints your activation link and the agent token — SAVE BOTH —
                    # then asks you to paste the four OAuth values from steps 1–2
```

**Deploy before secrets, not after.** `wrangler secret put` writes to a Worker
that has to already exist — against a name it has never seen it just stops with
*Worker "dmzs-mail" not found*, and `npm run secrets` exits on the first one,
before printing the activation link. Deploying first is harmless: with no
secrets set yet the Worker is fail-closed, `/auth` refuses every key, and no
mail can be reached. Secrets take effect the moment they land, so there is no
second deploy to remember.

### 5. Activate devices, connect accounts

Open `https://mail.agentxr.app/auth?k=<BOOTSTRAP_KEY>` once per device
(the link `npm run secrets` printed). Pin to the iPhone home screen like
the others. Then, in the app: account button → **Connect Gmail**,
**Connect Outlook**. First sync lands within a cron tick, or immediately
via the account's **Sync** button.

### 6. Connect iCloud

Account button → **Connect iCloud** → your address and the app-specific
password from step 3. That is the whole step: the Worker speaks IMAP itself,
so there is nothing to install and nothing to keep running.

First sync lands within a minute. History fills in behind it — each pass
takes the newest mail first, then spends whatever budget is left walking
backwards through older messages, rotating between folders so Sent and
Archive are not starved by an inbox still catching up.

Messages over 2 MB are listed from their headers with a placeholder body.
A Worker cannot hold a 17 MB attachment in memory and parse it inside the
CPU budget, and without this one such message blocks its folder forever.

<details>
<summary>The old PC agent (no longer used)</summary>

`agent/icloud_agent.py` is the v1 approach: Python, standard library only,
pulling jobs from the Worker over a bearer token. It still works. To go back
to it, clear `secret` on the iCloud account row so the Worker leaves that
mailbox alone, then run `npm run agent`.

</details>

---

## Using the app

Tap a message to read it — opening marks it read at iCloud too, so the
iPhone agrees. **Archive**, **Delete**, star and mark-unread all write
straight through over IMAP. **Reply** and **Reply all** answer in-thread;
the compose button writes fresh mail. The folder list is the real one from
the server, and folders can be created, renamed and deleted from it.
Remote images stay blocked until you tap **Images**, once, per message.

Also live: attachments both ways, download-all as a zip, Bcc, rich text and
pasted images with resizing, contact autocomplete and a contacts list,
full-text search, one-click unsubscribe, empty trash, keyboard shortcuts,
the AI grammar/rewrite pass, and a light theme by default.

## Knowing when mail arrives

Three signals, for three situations:

| Where you are | What tells you |
| --- | --- |
| The app is open | Unread count in the tab title, red dot on the favicon |
| Installed as a PWA, closed | Web Push notification and the taskbar badge |
| Chrome open, app not | The extension in `extension/` |

The extension is not on the Web Store — load it unpacked from
`chrome://extensions` with developer mode on. It polls once a minute, badges
the toolbar with the unread count, and notifies when that count *rises*
(reading mail on your phone lowers it, which is not news). Open its options
page, paste `BOOTSTRAP_KEY` once, and it trades the key for a token; the key
itself is never stored.

## Not here yet

Bulk selection, swipe gestures, threading (messages are listed flat), and
signatures. Multiple accounts work in the schema but only iCloud is
implemented — the Gmail and Outlook modules were deleted.

## If something misbehaves

- An account badge says **reconnect needed**: its refresh token died
  (revoked, password change, Google testing-mode expiry). Accounts →
  Connect that provider again; same address overwrites in place.
- Gmail connect loops on the unverified-app screen: the consent screen was
  left in *Testing* — publish it to production (step 1.4).
- "No refresh token came back" when connecting Google: that account
  authorized the app before without granting offline access — remove
  dmzs-mail under <https://myaccount.google.com/permissions>, connect again.
- Outlook stops syncing months from now: the Entra client secret expired
  (step 2.5) — new secret, `npx wrangler secret put MS_CLIENT_SECRET`.
- iCloud stops syncing with an authentication error: the app-specific
  password was revoked or regenerated. Account button → **Connect iCloud**
  again with a fresh one; same address overwrites in place.
- An iCloud message shows "too large to render here": over 2 MB, listed from
  its headers by design. Open it in Mail or at icloud.com.
- Watch it live: `npm run tail`.

## Costs

Worker requests, D1 reads/writes, R2 storage: a personal mailbox's volume
is orders of magnitude below every free-tier ceiling. The only number worth
watching is R2 if you never clean archives of huge HTML bodies — tens of
thousands of messages still fit in single-digit gigabytes.

## Licence

MIT, same as the rest of the dmzs suite. No warranty; your mail is your
responsibility.
