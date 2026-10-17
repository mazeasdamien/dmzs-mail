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
  -- First References id, else In-Reply-To, else the message's own id — so a
  -- root and its replies share one key. The subject only for mail with no ids.
  thread_key  TEXT NOT NULL DEFAULT '',
  refs        TEXT NOT NULL DEFAULT '',     -- the References chain, for replying to this
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
  -- Where the provider has it: IMAP mailbox path and UID within it. What lets
  -- a sync notice a flag changed or a message expunged on another device.
  -- 0 and '' until a sync has seen the message there.
  mailbox     TEXT NOT NULL DEFAULT '',
  uid         INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  UNIQUE (account_id, pid)
)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_list    ON messages(folder, date DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_account ON messages(account_id, folder, date DESC)`,
  // The list groups by thread_key on every load, and opening a conversation
  // filters on it. Both walk the whole table without this.
  `CREATE INDEX IF NOT EXISTS idx_messages_thread  ON messages(thread_key)`,
  // Unread only: the badge, the push and the inbox count ask about these few
  // every minute, and without it each question read the whole folder.
  `CREATE INDEX IF NOT EXISTS idx_messages_unread  ON messages(folder, date DESC) WHERE unread=1`,
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
  // Messages written now and sent later. The message itself (attachments and
  // all, up to 20 MB) waits in R2 under outbox/<id>.json; this is the index
  // the cron reads every minute and the Scheduled sheet lists.
  `CREATE TABLE IF NOT EXISTS outbox (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  at          INTEGER NOT NULL,             -- ms, when it goes
  subject     TEXT NOT NULL DEFAULT '',
  to_line     TEXT NOT NULL DEFAULT '',
  tries       INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_outbox_at ON outbox(at)`,
  // Messages put away until later. The message itself waits in a Snoozed
  // mailbox at iCloud, so every device sees it gone; this row is what brings
  // it back to the inbox, unread, when its time comes.
  `CREATE TABLE IF NOT EXISTS snoozed (
  id          TEXT PRIMARY KEY,             -- messages.id
  account_id  TEXT NOT NULL,
  until       INTEGER NOT NULL,             -- ms
  folder      TEXT NOT NULL,                -- the app's name for the Snoozed mailbox
  created_at  INTEGER NOT NULL
)`,
  `CREATE INDEX IF NOT EXISTS idx_snoozed_until ON snoozed(until)`,
  `CREATE TABLE IF NOT EXISTS blocked_senders (
  pattern    TEXT PRIMARY KEY,             -- lowercase: a whole address, or a bare domain
  n          INTEGER NOT NULL DEFAULT 0,   -- messages destroyed by this rule
  last_at    INTEGER,                      -- ms, when it last matched
  created_at INTEGER NOT NULL
)`,
  // Senders whose remote images load as their mail opens.
  //
  // Images are held back by default, because a remote image is how a sender
  // learns you opened their mail. This is the list of the ones you have
  // decided may know: whole addresses, never domains.
  `CREATE TABLE IF NOT EXISTS image_senders (
  email      TEXT PRIMARY KEY,             -- lowercase, a whole address
  created_at INTEGER NOT NULL
)`,
  // Sessions ended before their time: signing out of a device puts its id
  // here, so a copy of the cookie stops working too. Kept only until the
  // token would have expired anyway — after that the signature check refuses
  // it on its own, and the next revocation sweeps the row.
  `CREATE TABLE IF NOT EXISTS revoked_sessions (
  sid        TEXT PRIMARY KEY,
  exp        INTEGER NOT NULL,             -- s, the token's own expiry
  created_at INTEGER NOT NULL
)`,
  // Full-text search. `id` is carried along to join back to messages, not
  // searched; diacritics are folded so "releve" finds "relevé".
  // Which index row holds which message. FTS5 can only look a row up by
  // rowid, so this is what lets one message leave the index without reading
  // all of it.
  `CREATE TABLE IF NOT EXISTS search_ids (
  id  TEXT PRIMARY KEY,                    -- messages.id
  rid INTEGER NOT NULL                     -- its rowid in search
)`,
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
    refs: "TEXT NOT NULL DEFAULT ''",
    mailbox: "TEXT NOT NULL DEFAULT ''",
    uid: "INTEGER NOT NULL DEFAULT 0",
  },
  accounts: {
    label: "TEXT NOT NULL DEFAULT ''",
    secret: "TEXT",
    sync_state: "TEXT",
    last_error: "TEXT",
  },
};

/**
 * Indexes on columns an old database only has once healed.
 *
 * Kept out of SCHEMA because that runs first: on a database still missing
 * the column, the CREATE INDEX would throw before the heal that adds it, and
 * the sync would never get as far as fixing itself.
 */
export const AFTER_HEAL = [
  // Reconciling looks rows up by where the provider has them, a UID range at
  // a time. Without this every pass reads the whole mailbox's rows.
  `CREATE INDEX IF NOT EXISTS idx_messages_uid     ON messages(account_id, mailbox, uid)`,
];

/**
 * One-off data fixes, each run once and recorded in `settings` by name.
 * Unlike the DDL they are not cheap to repeat: each walks the whole table.
 */
export const MIGRATIONS = [
  // Roots used to be keyed on their subject while their replies were keyed on
  // the root's Message-ID, so a conversation never grouped with its own first
  // message. A key that is not an id was a subject; where the row has an id,
  // that is what the key is now.
  ["thread_key_mid", `UPDATE messages SET thread_key=mid WHERE mid LIKE '<%>' AND thread_key NOT LIKE '<%'`],
  // The sealed Gemini key and model from before the move to Claude. They were
  // only cleared when a Claude key was saved in the app, so a deployment that
  // took its key from a secret kept a working Google credential sealed away
  // where nothing shows it and nobody remembers to revoke it.
  ["drop_gemini_key", `DELETE FROM settings WHERE key IN ('ai_key', 'ai_model')`],
];

/** What schema.sql looks like on disk, comments and all. */
export function schemaSql() {
  return `-- dmzs-mail, D1 schema.
--
-- GENERATED by scripts/gen-schema.mjs from src/schema.js. Do not edit by
-- hand: the generator overwrites this file, and deploy refuses to go ahead
-- while the two disagree. One provider, iCloud, over IMAP and SMTP spoken by
-- the Worker itself.

${[...SCHEMA, ...AFTER_HEAL].join(";\n\n")};
`;
}

/**
 * Brings a live database up to what this build expects.
 *
 * Everything here is idempotent, and costs one read when there is nothing to
 * do. Only ever says something when something changed: a line a minute saying
 * all is well is a line nobody reads.
 */
export async function ensureSchema(env) {
  // Thirteen statements a minute to find, nearly every time, that nothing has
  // changed. The fingerprint of what this build expects is kept once the
  // database matches it, and only a build that expects something else — a
  // new table, a new column — pays for the full pass.
  const fp = schemaFingerprint();
  const seen = await env.DB.prepare("SELECT value FROM settings WHERE key='schema_fp'")
    .first()
    .catch(() => null);
  if (seen?.value === fp) return [];

  const added = [];
  for (const sql of SCHEMA) {
    await env.DB.prepare(sql).run();
  }
  // Index rows written before search_ids existed. One read of the index,
  // once; after this every row is mapped as it is written.
  await env.DB.prepare("INSERT OR IGNORE INTO search_ids (id, rid) SELECT id, rowid FROM search").run();
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
  for (const sql of AFTER_HEAL) {
    await env.DB.prepare(sql).run();
  }
  if (added.length) console.log(`schema: added ${added.join(", ")}`);

  // A fresh install has nothing to migrate, but marking each done costs the
  // same either way and keeps this one code path. Inside the full pass, so
  // only a build whose fingerprint moved even asks.
  const done = await env.DB.prepare("SELECT value FROM settings WHERE key='migrations'")
    .first()
    .catch(() => null);
  let ran = [];
  try {
    ran = JSON.parse(done?.value || "[]");
  } catch {
    ran = [];
  }
  const todo = MIGRATIONS.filter(([name]) => !ran.includes(name));
  for (const [name, sql] of todo) {
    await env.DB.prepare(sql).run();
    ran.push(name);
    console.log(`schema: migrated ${name}`);
  }
  if (todo.length) {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('migrations', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    )
      .bind(JSON.stringify(ran))
      .run();
  }
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('schema_fp', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  )
    .bind(fp)
    .run();
  return added;
}

/** A short hash of everything ensureSchema would apply. */
export function schemaFingerprint() {
  const text = JSON.stringify([SCHEMA, HEAL_COLUMNS, AFTER_HEAL, MIGRATIONS, "search_ids-v1"]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16);
}
