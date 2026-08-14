-- dmzs-mail, D1 schema.
--
-- Three providers, one shape. Google and Microsoft are driven by the Worker
-- itself over their REST APIs; iCloud has no API, so its rows are written by
-- the agent on your machine and its actions travel through `jobs`.

CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,             -- 8 hex chars, hash of provider+email
  provider    TEXT NOT NULL,                -- google | microsoft | icloud
  email       TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',     -- display name, defaults to email
  secret      TEXT,                         -- AES-GCM sealed OAuth tokens; NULL for icloud
                                            -- (its credentials never leave your machine)
  sync_state  TEXT,                         -- google: historyId · microsoft: deltaLink · icloud: uid state
  status      TEXT NOT NULL DEFAULT 'ok',   -- ok | reauth | error
  last_sync   INTEGER,                      -- ms
  last_error  TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE (provider, email)
);

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,             -- 16 hex chars, hash of account+pid
  account_id  TEXT NOT NULL,
  pid         TEXT NOT NULL,                -- provider's own id (gmail id / graph id / Message-ID)
  mid         TEXT NOT NULL DEFAULT '',     -- RFC Message-ID, for reply threading
  thread_key  TEXT NOT NULL DEFAULT '',     -- gmail threadId / graph conversationId / normalized subject
  -- The one bucket a message is filed under, for the folder switcher:
  -- inbox | archive | sent | spam | trash | drafts, or an IMAP folder name.
  folder      TEXT NOT NULL DEFAULT 'inbox',
  -- Every label the message carries, JSON array of display names. Gmail lets a
  -- message sit in several at once, which `folder` alone cannot express, so
  -- filtering by a user-created label reads from here.
  labels      TEXT NOT NULL DEFAULT '[]',
  from_name   TEXT NOT NULL DEFAULT '',
  from_email  TEXT NOT NULL DEFAULT '',
  to_line     TEXT NOT NULL DEFAULT '',     -- human-readable recipients
  cc_line     TEXT NOT NULL DEFAULT '',     -- copied recipients; reply-all needs them
  subject     TEXT NOT NULL DEFAULT '',
  snippet     TEXT NOT NULL DEFAULT '',
  date        INTEGER NOT NULL DEFAULT 0,   -- ms
  unread      INTEGER NOT NULL DEFAULT 1,
  starred     INTEGER NOT NULL DEFAULT 0,   -- gmail STARRED / IMAP \Flagged
  has_body    INTEGER NOT NULL DEFAULT 0,   -- 1 once the defused body sits in R2
  created_at  INTEGER NOT NULL,
  UNIQUE (account_id, pid)
);

CREATE INDEX IF NOT EXISTS idx_messages_list    ON messages(folder, date DESC);
CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id, folder, date DESC);

-- Adding `labels` to a database created before it existed. D1 has no
-- ADD COLUMN IF NOT EXISTS, so this file stays re-runnable by keeping the
-- migration out of it — see `npm run db:migrate`.

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
