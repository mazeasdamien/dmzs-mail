# dmzs-mail

Your iCloud mailbox as a PWA, on one Cloudflare Worker. Read, archive, reply — no mail client, no ads, $0/month.

## Stack

iCloud (IMAP/SMTP) ⇄ Worker + D1 + R2 ⇄ PWA

An app-specific password is sealed in your Cloudflare account (AES-256-GCM). Bodies are defused before storage and shown in a sandboxed iframe.

## Setup

```sh
npm install
npm run db:schema   # tables into live D1
npm run deploy      # Worker + PWA → mail.agentxr.app
npm run secrets     # AUTH_SECRET / BOOTSTRAP_KEY / ENC_KEY + activation link
```

1. Get an app-specific password at [account.apple.com](https://account.apple.com) → Sign-In and Security.
2. **Deploy before secrets.** Open the activation link `npm run secrets` prints, once per device.
3. Account button → **Connect iCloud** → address + app-specific password.

## Use

Tap to read · **Archive** / **Delete** / star write through to iCloud · swipe to archive · **Reply** / compose · folders, search, attachments, contacts, light/dark.

`j`/`k` move · `e` archive · `s` star · `r` reply · `/` search · `Esc` back · `?` all shortcuts.

Notifications: tab title + favicon badge, Web Push when installed, Chrome extension in `extension/` (unpacked).

## Licence

MIT. No warranty; your mail is your responsibility.
