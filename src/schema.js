/**
 * The database, described once.
 *
 * schema.sql used to be the only description, and runtime `ensureSchema` had a
 * second, partial one beside it — the columns an older database might be
 * missing. The two drifted: a column added to one was not in the other, and
 * `npm run db:schema` on a fresh install then produced a different database
 * than the Worker healed an old one into.
 *
 * This file is the source. `scripts/gen-schema.mjs` writes schema.sql from it
 * and refuses to deploy if the written copy has been hand-edited since. The
 * Worker's `ensureSchema` reads the same structures, so healing an old
 * database and creating a new one can no longer disagree.
 *
 * The `jobs` table, for the Python agent that used to drive iCloud from a
 * machine at home, is deliberately not here. A pre-existing one is left
 * untouched — same reasoning as the old `labels` column: nothing reads or
 * writes it now, and dropping a table on a live mailbox is not worth the
 * risk of tidiness.
 */

/** DDL for a database that does not exist yet. Idempotent throughout. */
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,             -- 8 hex chars, hash of provider+email
  provider    TEXT NOT NULL,                -- icloud
  email       TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',     -- display name, defaults to email
  secret      TEXT,                         -- AES-GCM sealed app password
  sync_state  TEXT,                         -- per-mailbox UID cursors, JSON
  status      TEXT NOT NULL DEFAULT 'ok',   -- ok | reauth | error
  last_sync   INTEGER,                      -- ms
  last_error  TEXT,
  created_at  INTEGER NOT NULL,
  UNIQUE (provider, email)
)`,
  `CREATE TABLE IF NOT EXISTS messages (
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
  -- Blind recipients. Never present on mail you receive, and deliberately
  -- absent from the bytes of anything sent — a Bcc written into the message
  -- is not blind. Kept here for the two copies that are only ever yours: the
  -- draft you are still writing, and your own record of what you sent.
  bcc_line    TEXT NOT NULL DEFAULT '',
  subject     TEXT NOT NULL DEFAULT '',
  snippet     TEXT NOT NULL DEFAULT '',
  date        INTEGER NOT NULL DEFAULT 0,   -- ms
  unread      INTEGER NOT NULL DEFAULT 1,
  starred     INTEGER NOT NULL DEFAULT 0,   -- IMAP \\Flagged
  has_body    INTEGER NOT NULL DEFAULT 0,   -- 1 once the defused body sits in R2
  created_at  INTEGER NOT NULL,
  UNIQUE (account_id, pid)
)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_list    ON messages(folder, date DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id, folder, date DESC)`,
  // The list groups by thread_key on every load, and opening a conversation
  // filters on it. Both walk the whole table without this.
  `CREATE INDEX IF NOT EXISTS idx_messages_thread  ON messages(thread_key)`,
  // Key/value, for the things that are per-install rather than per-account:
  // the VAPID pair the push subscriptions are signed with, and the last unread
  // count a notification was sent for.
  `CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS push_subs (
  endpoint   TEXT PRIMARY KEY,
  sub        TEXT NOT NULL,               -- the whole PushSubscription, JSON
  created_at INTEGER NOT NULL
)`,
  // Contacts are read out of sent mail rather than kept, so the only two things
  // worth storing are the corrections: someone you never want suggested, and
  // someone you have never written to but want anyway.
  `CREATE TABLE IF NOT EXISTS contacts_hidden (
  email      TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS contacts_added (
  email      TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
)`,
  // Senders whose mail is destroyed on sight.
  //
  // Not a folder and not a filter: a match is expunged at the provider during
  // the sync that finds it, so no row is ever written, no body reaches R2 and
  // no notification fires. `n` is the only trace kept — the rule is invisible
  // by design, and a rule that silently eats mail with no way to tell how much
  // is not one you can ever audit.
  `CREATE TABLE IF NOT EXISTS blocked_senders (
  pattern    TEXT PRIMARY KEY,             -- lowercase: a whole address, or a bare domain
  n          INTEGER NOT NULL DEFAULT 0,   -- messages destroyed by this rule
  last_at    INTEGER,                      -- ms, when it last matched
  created_at INTEGER NOT NULL
)`,
  // Full-text search. `id` is carried along to join back to messages, not
  // searched; diacritics are folded so "releve" finds "relevé".
  `CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
  id UNINDEXED,
  subject,
  sender,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
)`,
];

/**
 * Columns a database created before this build might lack.
 *
 * schema.sql is CREATE TABLE IF NOT EXISTS from top to bottom. That is exactly
 * right for a fresh install and does nothing whatsoever for one that already
 * exists: a column added after the database was created is never added to the
 * database, and `npm run db:schema` will not tell you so.
 *
 * It is not a theoretical problem. The first INSERT naming a column that is
 * not there throws, storeRows throws with it, and the sync stops dead for
 * every account — silently, once a minute, for as long as it takes somebody
 * to notice no mail has arrived. Nor can it be fixed from a laptop: the API
 * token here deploys Workers but is refused on `d1 execute --remote`, so the
 * only thing that can reach the live database is the Worker itself.
 */
export const HEAL_COLUMNS = {
  messages: {
    mid: "TEXT NOT NULL DEFAULT ''",
    thread_key: "TEXT NOT NULL DEFAULT ''",
    cc_line: "TEXT NOT NULL DEFAULT ''",
    bcc_line: "TEXT NOT NULL DEFAULT ''",
    starred: "INTEGER NOT NULL DEFAULT 0",
    has_body: "INTEGER NOT NULL DEFAULT 0",
  },
  accounts: {
    label: "TEXT NOT NULL DEFAULT ''",
    secret: "TEXT",
    sync_state: "TEXT",
    last_error: "TEXT",
  },
};

/** What schema.sql looks like on disk, comments and all. */
export function schemaSql() {
  return `-- dmzs-mail, D1 schema.
--
-- GENERATED by scripts/gen-schema.mjs from src/schema.js. Do not edit by
-- hand: the generator overwrites this file, and deploy refuses to go ahead
-- while the two disagree. One provider, iCloud, over IMAP and SMTP spoken by
-- the Worker itself.

${SCHEMA.join(";\n\n")};
`;
}

/**
 * Brings a live database up to what this build expects.
 *
 * Everything here is idempotent, and costs two reads when there is nothing to
 * do. Only ever says something when something changed: a line a minute saying
 * all is well is a line nobody reads.
 */
export async function ensureSchema(env) {
  const added = [];
  for (const sql of SCHEMA) {
    await env.DB.prepare(sql).run();
  }
  for (const [table, columns] of Object.entries(HEAL_COLUMNS)) {
    // pragma_table_info as a table-valued function rather than a bare PRAGMA:
    // it comes back as ordinary rows, which is what D1's query interface
    // returns anyway.
    const info = await env.DB.prepare("SELECT name FROM pragma_table_info(?)")
      .bind(table)
      .all()
      .catch(() => null);
    const have = new Set((info?.results ?? []).map((r) => r.name));
    // No columns at all means no table, which the CREATE above just made —
    // so there is nothing missing to heal on a fresh install.
    if (!have.size) continue;
    for (const [name, decl] of Object.entries(columns)) {
      if (have.has(name)) continue;
      // The table and column names are constants from the map above, never
      // anything that arrived over the wire — DDL cannot be parameterised.
      await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`).run();
      added.push(`${table}.${name}`);
    }
  }
  if (added.length) console.log(`schema: added ${added.join(", ")}`);
  return added;
}
