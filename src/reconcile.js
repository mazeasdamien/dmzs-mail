/**
 * Noticing what changed on other devices: the arithmetic, kept pure.
 *
 * The sync only ever looked forward — UIDs above the last one seen, history
 * below the first. A message read on the iPhone stayed unread here, and mail
 * deleted in Apple Mail stayed forever, rows and bodies both. Reconciling
 * walks each mailbox's already-fetched UIDs a slice at a time, compares flags,
 * and notices UIDs the server no longer has.
 *
 * A slice rather than the whole mailbox because the cron runs every minute on
 * a fixed budget. The newest UIDs are looked at on every visit, since that is
 * where reading happens; the rest rotate downwards a chunk per visit and wrap.
 */

export const RECENT = 100; // newest UIDs checked on every visit
export const CHUNK = 250; // older UIDs checked per visit, rotating

/**
 * Which part of a mailbox this visit looks at.
 *
 * `all` is every UID the server has, ascending; `first`..`last` the range the
 * sync has fetched, since nothing outside it was ever stored. `rc` is where
 * the rotation got to: the low end of the previous chunk, or 0 to start again
 * from the top.
 *
 * Ranges are in UID space, not lists of UIDs the server has, because the rows
 * being looked for are precisely the ones whose UID the server no longer has.
 * Over a whole rotation they cover first..last with no gaps.
 */
export function planWindow({ all, first, last, rc = 0, recent = RECENT, chunk = CHUNK }) {
  const known = all.filter((u) => u >= first && u <= last);
  const newest = known.slice(-recent);
  const recentLo = newest.length ? newest[0] : last + 1;
  // A rotation point above the recent window means mail was expunged under
  // it; carry on from the window's floor rather than skipping what lies
  // between.
  const hi = (rc > 0 ? Math.min(rc, recentLo) : recentLo) - 1;
  const older = known.filter((u) => u <= hi).slice(-chunk);
  // A short chunk is the last one: stretch it down to the floor so a row
  // whose UID sits below the oldest surviving message is still looked at.
  const complete = older.length < chunk;
  const lo = complete ? first : older[0];
  return {
    ranges: [
      [recentLo, last],
      [lo, hi],
    ].filter(([a, b]) => a <= b),
    uids: [...older, ...newest],
    nextRc: complete ? 0 : lo,
    complete,
  };
}

export const inRanges = (uid, ranges) => ranges.some(([a, b]) => uid >= a && uid <= b);

/** IMAP flags → the two the app keeps. */
export const flagState = (flags) => ({
  unread: /\\Seen\b/i.test(flags) ? 0 : 1,
  starred: /\\Flagged\b/i.test(flags) ? 1 : 0,
});

/**
 * Two strikes before a row goes.
 *
 * A UID missing once is a message moved on another device as often as one
 * deleted, and the move is better learned from the destination's sync — which
 * refiles the row — than by deleting it and downloading it again. Missing on
 * two visits, it is gone. `checked` are the ranges this visit looked at:
 * earlier strikes outside them wait for their range to come round again.
 */
export function strikes(missing, prevMiss, checked, cap = 1000) {
  const prev = new Set(prevMiss || []);
  const doomed = missing.filter((u) => prev.has(u));
  const gone = new Set(doomed);
  const miss = [
    ...missing.filter((u) => !gone.has(u)),
    ...(prevMiss || []).filter((u) => !inRanges(u, checked)),
  ].slice(-cap);
  return { doomed, miss };
}

/**
 * A list of UIDs → the shortest IMAP set naming them: 1:3,7,9:10.
 *
 * Reconciling sends a few hundred UIDs per command, and spelled out one by one
 * that is kilobytes of command line for what is usually a single range.
 */
export function uidSet(uids) {
  const list = [...new Set(uids)].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < list.length; ) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
    out.push(i === j ? String(list[i]) : `${list[i]}:${list[j]}`);
    i = j + 1;
  }
  return out.join(",");
}
