-- dmzs-mail, D1 schema.
--
-- One provider: iCloud, over IMAP and SMTP spoken by the Worker itself. The
-- `jobs` table is the older path, for an account still driven by the agent on
-- your machine rather than by a stored app password.

CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,             -- 8 hex chars, hash of provider+email
  provider    TEXT NOT NULL,                -- icloud
  email       TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',     -- display name, defaults to email
  secret      TEXT,                         -- AES-GCM sealed app password; NULL when the
                                            -- account is still driven by the agent
  sync_state  TEXT,                         -- per-mailbox UID cursors, JSON
  status      TEXT NOT NULL DEFAULT 'ok',   -- ok | reauth | error
  last_sync   INTEGER,                      -- ms
  last_error  TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE (provider, email)
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,             -- 16 hex chars, hash of account+pid
  account_id  TEXT NOT NULL,
  pid         TEXT NOT NULL,                -- stable id: the RFC Message-ID where there is one
  mid         TEXT NOT NULL DEFAULT '',     -- RFC Message-ID, for reply threading
  thread_key  TEXT NOT NULL DEFAULT '',     -- first References id, or the normalized subject
  -- The one bucket a message is filed under, for the folder switcher:
  -- inbox | archive | sent | spam | trash | drafts, or an IMAP folder name.
  folder      TEXT NOT NULL DEFAULT 'inbox',
  from_name   TEXT NOT NULL DEFAULT '',
  from_email  TEXT NOT NULL DEFAULT '',
  to_line     TEXT NOT NULL DEFAULT '',     -- human-readable recipients
  cc_line     TEXT NOT NULL DEFAULT '',     -- copied recipients; reply-all needs them
  subject     TEXT NOT NULL DEFAULT '',
  snippet     TEXT NOT NULL DEFAULT '',
  date        INTEGER NOT NULL DEFAULT 0,   -- ms
  unread      INTEGER NOT NULL DEFAULT 1,
  starred     INTEGER NOT NULL DEFAULT 0,   -- IMAP \Flagged
  has_body    INTEGER NOT NULL DEFAULT 0,   -- 1 once the defused body sits in R2
  created_at  INTEGER NOT NULL,
  UNIQUE (account_id, pid)
);

CREATE INDEX IF NOT EXISTS idx_messages_list    ON messages(folder, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id, folder, date DESC);

-- A database created before this file dropped `labels` still has the column.
-- It is left alone rather than migrated away: nothing reads or writes it now,
-- and DROP COLUMN on a live mailbox is not worth the risk of tidiness.

-- Actions the Worker cannot perform itself. Today that is everything iCloud:
-- send | archive | read. Same pull model as the music downloader — the agent
-- claims, executes over IMAP/SMTP, reports back.
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,                -- send | archive | read
  payload     TEXT NOT NULL DEFAULT '{}',   -- JSON, kind-specific
  status      TEXT NOT NULL DEFAULT 'pending', -- pending | claimed | done | error
  error       TEXT,
  claimed_at  INTEGER,                      -- ms; lease, NULL when free
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at);

-- Key/value, for the things that are per-install rather than per-account:
-- the VAPID pair the push subscriptions are signed with, and the last unread
-- count a notification was sent for.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subs (
  endpoint   TEXT PRIMARY KEY,
  sub        TEXT NOT NULL,               -- the whole PushSubscription, JSON
  created_at INTEGER NOT NULL
);

-- Contacts are read out of sent mail rather than kept, so the only two things
-- worth storing are the corrections: someone you never want suggested, and
-- someone you have never written to but want anyway.
CREATE TABLE IF NOT EXISTS contacts_hidden (
  email      TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts_added (
  email      TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- Senders whose mail is destroyed on sight.
--
-- Not a folder and not a filter: a match is expunged at the provider during
-- the sync that finds it, so no row is ever written, no body reaches R2 and
-- no notification fires. `n` is the only trace kept — the rule is invisible
-- by design, and a rule that silently eats mail with no way to tell how much
-- is not one you can ever audit.
CREATE TABLE IF NOT EXISTS blocked_senders (
  pattern    TEXT PRIMARY KEY,             -- lowercase: a whole address, or a bare domain
  n          INTEGER NOT NULL DEFAULT 0,   -- messages destroyed by this rule
  last_at    INTEGER,                      -- ms, when it last matched
  created_at INTEGER NOT NULL
);

-- Full-text search. `id` is carried along to join back to messages, not
-- searched; diacritics are folded so "releve" finds "relevé".
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
  id UNINDEXED,
  subject,
  sender,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
