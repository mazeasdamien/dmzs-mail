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
  "accounts", "messages", "jobs", "settings",
  "contacts_hidden", "contacts_added", "push_subs",
];

// Rebuildable from the messages themselves, and by far the largest table.
// Restoring re-indexes rather than reloading it.
const SKIP = ["search"];

const PREFIX = "backup/";

export async function runBackup(env, now) {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const key = `${PREFIX}dmzs-mail-${stamp}.json`;

  const dump = { version: 1, takenAt: new Date(now).toISOString(), tables: {} };
  for (const table of TABLES) {
    try {
      const { results } = await env.DB.prepare(`SELECT * FROM ${table}`).all();
      dump.tables[table] = results ?? [];
    } catch {
      // A table that does not exist yet is not a failure; the schema grows.
      dump.tables[table] = [];
    }
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
  for (const obj of listing.objects || []) {
    if (obj.key === key) continue;
    await env.MAIL.delete(obj.key);
    removed++;
  }

  return { key, bytes: body.length, counts: dump.counts, removed };
}

/** The snapshot currently held, if any. */
export async function latestBackup(env) {
  const listing = await env.MAIL.list({ prefix: PREFIX });
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
