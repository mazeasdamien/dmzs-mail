# dmzs-mail

Your iCloud mailbox as a PWA, on one Cloudflare Worker. Read, archive, reply — no mail client, no ads.

## Stack

iCloud (IMAP/SMTP) ⇄ Worker + D1 + R2 ⇄ PWA

The Worker speaks IMAP and SMTP to Apple itself, syncs every minute from a cron, and takes a nightly snapshot of the database into R2. An app-specific password is sealed in D1 (AES-256-GCM). Bodies are defused before storage and shown in a sandboxed iframe; anything quoted into the composer is sanitised again in the page.

## Setup

```sh
npm install
npm run deploy      # Worker + PWA → mail.agentxr.app (tables are created by the first cron)
npm run secrets     # AUTH_SECRET / BOOTSTRAP_KEY / ENC_KEY, optional ANTHROPIC_API_KEY, activation link
```

1. **Deploy before secrets**: `wrangler secret put` needs the Worker to exist.
2. Open the activation link `npm run secrets` prints, once per device.
3. Settings → **Connect iCloud** → address + an app-specific password from [account.apple.com](https://account.apple.com) → Sign-In and Security.

`npm run check` runs the client checks, the schema check, the unit tests and the fake-IMAP sync harness; `npm run deploy` runs it first.

## Use

- **Read and triage**: archive, delete, star, move and mark unread write through to iCloud; swipe to archive; conversations; full-text search over bodies; snooze a message until later.
- **Write**: compose with Cc/Bcc, drafts kept at iCloud, forward with attachments, a signature, and five seconds to undo every send. **Later** schedules a message; the server sends it whether or not the app is open.
- **Your addresses**: a name on the From line, and replies leave from the alias or Hide My Email address the mail was sent to.
- **Claude** (Settings → Writing, an Anthropic key): Fix, Improve, a written reply, and a summary of a whole conversation.
- **Invitations**: Accept / Maybe / Decline on the message, answered to the organiser.
- **Privacy**: remote images held back until you ask, per sender if you like; one-click unsubscribe; blocked senders are deleted at iCloud as they arrive.
- **Keep**: save as PDF, download the original `.eml`, all attachments as a zip; Settings → Accounts → Backup shows the nightly snapshot and restores what is missing.
- Notifications: tab title and favicon badge, Web Push when installed, and the Chrome extension in `extension/` (load unpacked).

Shortcuts: `j`/`k` move · `/` search · `e` archive · `#` delete · `s` star · `u` unread · `v` move · `b` snooze · `r`/`a`/`f` reply, reply all, forward · `R`/`A` written by Claude · `p` PDF · `z` undo · `Ctrl+Enter` send · `Esc` back · `?` all of them.

## Licence

MIT. No warranty; your mail is your responsibility.
