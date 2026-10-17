/**
 * Nightly snapshot of D1 into R2.
 *
 * Scope is deliberate: the *index*, not the mail. Message bodies already live
 * in R2 and copying them would double the storage to protect against a failure
 * that cannot happen — losing D1 does not touch the bucket. What a lost
 * database actually costs is the index, the folder cursors, the sealed
 * credential and the read/star state, and all of that is small.
 *
 * One backup is kept. Written under a timestamped key first, then older ones
 * are pruned, so there is never a moment with no valid snapshot — which
 * writing to a single fixed key would create on every run.
 */

const TABLES = [
  "accounts", "messages", "settings", "blocked_senders", "outbox", "snoozed",
  "contacts_hidden", "contacts_added", "push_subs",
];

// Rebuildable from the messages themselves, and by far the largest table.
// Restoring re-indexes rather than reloading it: the search backfill picks
// up every message the index has not seen.
const SKIP = ["search"];

// Read in pages, so a big mailbox is never one result set held whole.
const PAGE = 1000;

const PREFIX = "backup/";

export async function runBackup(env, now) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const key = `${PREFIX}dmzs-mail-${stamp}.json`;

  const dump = { version: 1, takenAt: new Date(now).toISOString(), tables: {} };
  for (const table of TABLES) {
    const rows = [];
    try {
      for (let after = 0; ; ) {
        const { results } = await env.DB.prepare(
          `SELECT rowid AS _r, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT ${PAGE}`
        )
          .bind(after)
          .all();
        for (const r of results ?? []) {
          after = r._r;
          delete r._r;
          rows.push(r);
        }
        if ((results ?? []).length < PAGE) break;
      }
    } catch {
      // A table that does not exist yet is not a failure; the schema grows.
    }
    dump.tables[table] = rows;
  }
  dump.skipped = SKIP;
  dump.counts = Object.fromEntries(Object.entries(dump.tables).map(([t, r]) => [t, r.length]));

  const body = JSON.stringify(dump);
  await env.MAIL.put(key, body, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { messages: String(dump.counts.messages ?? 0) },
  });

  // Prune only after the new one is safely written.
  let removed = 0;
  const listing = await env.MAIL.list({ prefix: PREFIX });
  const old = (listing.objects || []).map((o) => o.key).filter((k) => k !== key);
  if (old.length) await env.MAIL.delete(old);
  removed = old.length;

  return { key, bytes: body.length, counts: dump.counts, removed };
}

/** The snapshot currently held, if any. */
export async function latestBackup(env) {
  // customMetadata only comes back from a listing that asks for it.
  const listing = await env.MAIL.list({ prefix: PREFIX, include: ["customMetadata"] });
  const objs = (listing.objects || []).sort((a, b) => (a.key < b.key ? 1 : -1));
  if (!objs.length) return null;
  const o = objs[0];
  return {
    key: o.key,
    bytes: o.size,
    uploaded: o.uploaded,
    messages: Number(o.customMetadata?.messages || 0),
    kept: objs.length,
  };
}

/**
 * Puts the latest snapshot back, without taking anything away.
 *
 * INSERT OR IGNORE, table by table: a row that exists now is newer than the
 * snapshot and is left alone, and only what has gone missing comes back. So
 * restoring after a lost database rebuilds it, and restoring by mistake on a
 * healthy one changes nothing. The search index is not in the snapshot; the
 * backfill is woken so it re-indexes what came back.
 */
export async function restoreBackup(env) {
  const latest = await latestBackup(env);
  if (!latest) return { restored: {}, key: null };
  const obj = await env.MAIL.get(latest.key);
  if (!obj) return { restored: {}, key: null };
  const dump = JSON.parse(await obj.text());

  const restored = {};
  for (const table of TABLES) {
    const rows = dump.tables?.[table] || [];
    restored[table] = 0;
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    // D1 binds at most 100 parameters per statement.
    const perStmt = Math.max(1, Math.floor(100 / cols.length));
    const stmts = [];
    for (let i = 0; i < rows.length; i += perStmt) {
      const chunk = rows.slice(i, i + perStmt);
      const tuple = `(${cols.map(() => "?").join(",")})`;
      stmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO ${table} (${cols.join(",")}) VALUES ${chunk.map(() => tuple).join(",")}`
        ).bind(...chunk.flatMap((r) => cols.map((c) => r[c] ?? null)))
      );
    }
    for (let i = 0; i < stmts.length; i += 100) {
      const out = await env.DB.batch(stmts.slice(i, i + 100));
      for (const r of out) restored[table] += r.meta?.changes || 0;
    }
  }
  await env.DB.prepare("DELETE FROM settings WHERE key LIKE 'search_idle_%'").run();
  return { restored, key: latest.key, takenAt: dump.takenAt };
}
