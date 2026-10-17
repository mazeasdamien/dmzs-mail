/**
 * Drives the real scheduled() sync and reconcile against in-process fakes:
 * D1 over node:sqlite, R2 over a Map, and a small IMAP server reached through
 * a cloudflare:sockets stub. IMAP cannot be reached from a dev machine, so
 * this is the only end-to-end check of the sync path. No real account or
 * credential is involved: the fake server accepts any LOGIN.
 *
 *   node --no-warnings scripts/sync-harness/run.mjs          all three modes
 *   node --no-warnings scripts/sync-harness/run.mjs <caps>   one mode, e.g. IMAP4rev1,MOVE
 *
 * Each mode runs in its own process, so module state in src/ starts clean.
 */
import { register } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MODES = ["IMAP4rev1,UIDPLUS,MOVE,CONDSTORE", "IMAP4rev1,UIDPLUS,MOVE", "IMAP4rev1,MOVE"];

if (!process.argv[2]) {
  const self = fileURLToPath(import.meta.url);
  let failed = 0;
  for (const mode of MODES) {
    const r = spawnSync(process.execPath, ["--no-warnings", self, mode], { stdio: "inherit" });
    if (r.status !== 0) failed++;
  }
  console.log(failed ? `✗ sync : ${failed} mode(s) en échec sur ${MODES.length}` : `✓ sync : ${MODES.length} modes IMAP passés`);
  process.exit(failed ? 1 : 0);
}

// Must precede the import of src/index.js, which imports cloudflare:sockets.
register("./hooks.mjs", import.meta.url);
const { makeD1, makeR2, FakeImap, BS } = await import("./fake.mjs");
const caps = process.argv[2].split(",");
const { default: worker } = await import("../../src/index.js");
const { seal } = await import("../../src/crypto.js");
const { SCHEMA } = await import("../../src/schema.js");

let pass = 0, fail = 0;
const ok = (c, label) => (c ? pass++ : (fail++, console.log("  ✗ " + label)));
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), `${label}: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const sqlLog = [];
const DB = makeD1(sqlLog);
const MAIL = makeR2();
const imap = new FakeImap({ caps });
globalThis.__fakeConnect = () => imap.connect();

const ENC_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
const env = { DB, MAIL, ENC_KEY, APP_URL: "http://x" };

// An OLD database: the messages table as it was before this change, to prove
// the heal runs before the index that needs its columns.
const OLD = SCHEMA.map((s) =>
  s
    .replace(/^\s*-- First References[\s\S]*?thread_key  TEXT NOT NULL DEFAULT '',\n\s*refs .*\n/m, "  thread_key  TEXT NOT NULL DEFAULT '',\n")
    .replace(/\n\s*-- Where the provider has it[\s\S]*?uid         INTEGER NOT NULL DEFAULT 0,/m, "")
);
for (const s of OLD) DB.raw.exec(s);
const cols = DB.raw.prepare("SELECT name FROM pragma_table_info('messages')").all().map((r) => r.name);
ok(!cols.includes("uid") && !cols.includes("refs"), "old schema really lacks the new columns: " + cols.join(","));

const latin = (s) => Buffer.from(s, "utf8").toString("latin1");
// Dated within the last hour, a minute apart in arrival order: push only rings
// for unread mail that is recent and newer than any unread mail before it.
let clock = Date.now() - 3_600_000;
const msg = (id, subject, extra = "", body = "hello") =>
  latin(`From: Zoé <zoe@x.fr>\r\nTo: me@example.com\r\nSubject: ${subject}\r\nDate: ${new Date((clock += 60_000)).toUTCString()}\r\nMessage-ID: ${id}\r\n${extra}Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}\r\n`);

imap.box("INBOX", BS + "HasNoChildren");
imap.box("Archive", BS + "HasNoChildren " + BS + "Archive");
imap.box("Sent Messages", BS + "HasNoChildren " + BS + "Sent");
const SEEN = BS + "Seen";
const A = imap.add("INBOX", msg("<a@x>", "Dîner", "", "Prix : 20 € — “ok”"), [SEEN]);
const B = imap.add("INBOX", msg("<b@x>", "Re: Dîner", "In-Reply-To: <a@x>\r\nReferences: <a@x>\r\n"), [SEEN]);
const C = imap.add("INBOX", msg("<c@x>", "C"));
const D = imap.add("INBOX", msg("<d@x>", "D"));
const E = imap.add("INBOX", msg("<e@x>", "E"));
imap.add("Archive", msg("<f@x>", "F"), [SEEN]);
imap.add("Archive", msg("<g@x>", "G"), [SEEN]);
imap.add("Sent Messages", msg("<h@x>", "H"), [SEEN]);

DB.raw.prepare("INSERT INTO accounts (id, provider, email, label, secret, created_at) VALUES (?,?,?,?,?,?)").run(
  "acct1", "icloud", "me@example.com", "", await seal(ENC_KEY, { password: "not-a-real-password" }), Date.now()
);

let pushes = 0;
async function pass1(label) {
  const before = sqlLog.length;
  const waits = [];
  await worker.scheduled({ cron: "* * * * *" }, env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  const acct = DB.raw.prepare("SELECT status, last_error FROM accounts").get();
  if (acct.last_error) console.log(`  [${label}] last_error: ${acct.last_error}`);
  pushes += sqlLog.slice(before).filter((s) => s.includes("FROM push_subs")).length;
}
const row = (mid) => DB.raw.prepare("SELECT * FROM messages WHERE mid=?").get(mid);
const count = () => DB.raw.prepare("SELECT COUNT(*) n FROM messages").get().n;

// ── first sync ──
for (let i = 0; i < 4; i++) await pass1("initial " + i);
const newCols = DB.raw.prepare("SELECT name FROM pragma_table_info('messages')").all().map((r) => r.name);
ok(newCols.includes("uid") && newCols.includes("mailbox") && newCols.includes("refs"), "heal added uid/mailbox/refs");
ok(DB.raw.prepare("SELECT name FROM sqlite_master WHERE name='idx_messages_uid'").get(), "uid index created after heal");
eq(count(), 8, "all 8 messages stored");
eq([row("<a@x>").mailbox, row("<a@x>").uid], ["INBOX", A.uid], "row A placed at INBOX/uid");
eq(row("<a@x>").thread_key, "<a@x>", "root keyed on own id");
eq(row("<b@x>").thread_key, "<a@x>", "reply keyed on root");
eq(row("<b@x>").refs, "<a@x>", "refs stored");
eq(row("<a@x>").subject, "Dîner", "raw UTF-8 subject decoded");
eq(row("<a@x>").from_name, "Zoé", "raw UTF-8 sender name decoded");
const bodyA = JSON.parse(MAIL.map.get(`body/${row("<a@x>").id}.json`));
ok(bodyA.html.includes("20 € — “ok”"), "8bit UTF-8 body intact: " + bodyA.html.slice(0, 120));
eq(row("<c@x>").unread, 1, "C unread before");
ok(pushes >= 1, "first sync rang (new unread mail)");

// ── read on the phone ──
imap.setFlag("INBOX", C.uid, SEEN, true);
imap.setFlag("INBOX", D.uid, BS + "Flagged", true);
pushes = 0;
await pass1("read elsewhere");
eq(row("<c@x>").unread, 0, "C read on phone → read here");
eq(row("<d@x>").starred, 1, "D flagged on phone → starred here");
eq(pushes, 0, "reading elsewhere does not ring");
// marked unread again on the phone: also no ring
imap.setFlag("INBOX", C.uid, SEEN, false);
pushes = 0;
await pass1("unread elsewhere");
eq(row("<c@x>").unread, 1, "C marked unread on phone → unread here");
eq(pushes, 0, "re-marking unread elsewhere does not ring");

// ── new mail and a read in the same pass still rings ──
imap.setFlag("INBOX", C.uid, SEEN, true);
const N = imap.add("INBOX", msg("<n@x>", "New"));
pushes = 0;
await pass1("new + read");
eq(row("<n@x>")?.unread, 1, "new mail stored");
ok(pushes >= 1, "new arrival rings even though another was read");

// ── deleted in Apple Mail ──
const dId = row("<d@x>").id;
ok(MAIL.map.has(`body/${dId}.json`), "D body in R2 before");
imap.expunge("INBOX", D.uid);
await pass1("expunge 1");
ok(row("<d@x>"), "first miss: kept (two strikes)");
await pass1("expunge 2");
ok(!row("<d@x>"), "second miss: row gone");
ok(!MAIL.map.has(`body/${dId}.json`), "D body gone from R2");
eq(DB.raw.prepare("SELECT COUNT(*) n FROM search WHERE id=?").get(dId).n, 0, "D gone from search");

// ── moved to Archive on the phone ──
const E2 = imap.move("INBOX", E.uid, "Archive");
for (let i = 0; i < 6; i++) await pass1("move " + i);
eq([row("<e@x>")?.folder, row("<e@x>")?.mailbox, row("<e@x>")?.uid], ["archive", "Archive", E2.uid], "E refiled to Archive with its new UID");

// ── legacy rows: pre-change data with no placement ──
DB.raw.exec("UPDATE messages SET uid=0, mailbox=''");
DB.raw.prepare(
  "INSERT INTO messages (id, account_id, pid, mid, thread_key, folder, subject, created_at) VALUES ('ghost','acct1','<ghost@x>','<ghost@x>','<ghost@x>','inbox','gone long ago',1)"
).run();
for (let i = 0; i < 12; i++) await pass1("legacy " + i);
eq([row("<a@x>").mailbox, row("<a@x>").uid], ["INBOX", A.uid], "legacy row A re-placed by Message-ID");
eq([row("<f@x>").mailbox], ["Archive"], "legacy Archive row re-placed");
ok(!row("<ghost@x>"), "never-placed legacy row deleted elsewhere is swept");
eq(row("<h@x>").mailbox, "Sent Messages", "Sent row re-placed");

// ── legacy thread-key migration ──
const mig = DB.raw.prepare("SELECT value FROM settings WHERE key='migrations'").get();
ok(mig && mig.value.includes("thread_key_mid"), "migration recorded");

// ── uidvalidity change: nothing deleted ──
const before = count();
imap.box("INBOX").uidvalidity = 99;
for (let i = 0; i < 4; i++) await pass1("uidvalidity " + i);
eq(count(), before, "renumbered mailbox: no rows lost");
eq(row("<a@x>").mailbox, "INBOX", "rows re-placed after renumbering");

// ── blocked sender purge uses UID EXPUNGE / EXPUNGE by capability ──
DB.raw.prepare("INSERT INTO blocked_senders (pattern, created_at) VALUES ('spam.example', 1)").run();
imap.add("INBOX", latin("From: s <s@spam.example>\r\nSubject: x\r\nMessage-ID: <s@x>\r\n\r\nx\r\n"));
const changedSince = imap.log.filter((l) => l.includes("CHANGEDSINCE")).length;
if (caps.includes("CONDSTORE")) ok(changedSince > 0, "CONDSTORE: flag fetches use CHANGEDSINCE");
else eq(changedSince, 0, "no CONDSTORE: CHANGEDSINCE never sent");
imap.log.length = 0;
await pass1("blocked");
const expunges = imap.log.filter((l) => /EXPUNGE/.test(l));
ok(expunges.length > 0, "blocked sender purged with an expunge");
if (caps.includes("UIDPLUS")) ok(expunges.every((l) => l.startsWith("UID EXPUNGE")), "UIDPLUS: only UID EXPUNGE");
else ok(expunges.every((l) => l === "EXPUNGE"), "no UIDPLUS: plain EXPUNGE");
ok(!row("<s@x>"), "blocked never stored");

console.log(`${fail ? "✗" : "✓"} ${pass} assertions passées, ${fail} échec(s) (caps ${caps.join(" ")})`);
process.exit(fail ? 1 : 0);
