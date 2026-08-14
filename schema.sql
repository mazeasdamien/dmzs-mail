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
