// In-process stand-ins: D1 over node:sqlite, R2 over a Map, an IMAP server.
import { DatabaseSync } from "node:sqlite";

const BS = "\x5c"; // a backslash, spelled so no tool eats it

export function makeD1(log = []) {
  const db = new DatabaseSync(":memory:");
  const norm = (a) => a.map((v) => (typeof v === "boolean" ? Number(v) : v === undefined ? null : v));
  class Stmt {
    constructor(sql, args = []) {
      this.sql = sql;
      this.args = args;
    }
    bind(...a) {
      return new Stmt(this.sql, a);
    }
    exec() {
      log.push(this.sql);
      const st = db.prepare(this.sql);
      if (/^\s*(SELECT|WITH)/i.test(this.sql)) return { results: st.all(...norm(this.args)), meta: { changes: 0 } };
      const r = st.run(...norm(this.args));
      return { results: [], meta: { changes: Number(r.changes) } };
    }
    async run() {
      return this.exec();
    }
    async all() {
      return this.exec();
    }
    async first() {
      return this.exec().results[0] ?? null;
    }
  }
  return {
    raw: db,
    prepare: (sql) => new Stmt(sql),
    async batch(stmts) {
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => s.exec());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

export function makeR2() {
  const m = new Map();
  return {
    map: m,
    async put(k, v) {
      m.set(k, String(v));
    },
    async get(k) {
      return m.has(k) ? { text: async () => m.get(k) } : null;
    },
    async delete(k) {
      for (const key of Array.isArray(k) ? k : [k]) m.delete(key);
    },
  };
}

/** A tiny IMAP server: just the commands this app sends. */
export class FakeImap {
  constructor({ caps = ["IMAP4rev1", "UIDPLUS", "MOVE", "CONDSTORE"] } = {}) {
    this.caps = caps;
    this.boxes = new Map();
    this.log = [];
    this.modseq = 100;
  }
  box(name, flags = "") {
    if (!this.boxes.has(name)) this.boxes.set(name, { name, flags, uidvalidity: 7, uidnext: 1, msgs: [] });
    return this.boxes.get(name);
  }
  add(name, raw, flags = []) {
    const b = this.box(name);
    const m = { uid: b.uidnext++, flags: new Set(flags), raw, modseq: ++this.modseq };
    b.msgs.push(m);
    return m;
  }
  find(name, uid) {
    return this.box(name).msgs.find((m) => m.uid === uid);
  }
  setFlag(name, uid, flag, on) {
    const m = this.find(name, uid);
    if (on) m.flags.add(flag);
    else m.flags.delete(flag);
    m.modseq = ++this.modseq;
  }
  expunge(name, uid) {
    const b = this.box(name);
    b.msgs = b.msgs.filter((m) => m.uid !== uid);
  }
  move(from, uid, to) {
    const m = this.find(from, uid);
    this.expunge(from, uid);
    return this.add(to, m.raw, [...m.flags]);
  }

  connect() {
    let ctrl;
    const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
    const send = (s) => ctrl.enqueue(enc(s));
    let sel = null;
    let pending = "";
    const readable = new ReadableStream({
      start(c) {
        ctrl = c;
      },
    });
    const self = this;
    const writable = new WritableStream({
      write(chunk) {
        pending += Buffer.from(chunk).toString("latin1");
        let i;
        while ((i = pending.indexOf("\r\n")) !== -1) {
          const line = pending.slice(0, i);
          pending = pending.slice(i + 2);
          self.handle(line, send, () => sel, (b) => (sel = b));
        }
      },
    });
    queueMicrotask(() => send("* OK [CAPABILITY IMAP4rev1] fake ready\r\n"));
    return { readable, writable, close: async () => {} };
  }

  inSet(set, uid, max) {
    return set.split(",").some((part) => {
      const [a, b] = part.split(":").map((x) => (x === "*" ? max : Number(x)));
      if (b === undefined) return uid === a;
      return uid >= Math.min(a, b) && uid <= Math.max(a, b);
    });
  }

  handle(line, send, getSel, setSel) {
    const sp = line.indexOf(" ");
    const tag = line.slice(0, sp);
    const cmd = line.slice(sp + 1);
    this.log.push(cmd.startsWith("LOGIN") ? "LOGIN ***" : cmd);
    const ok = (t = "done") => send(`${tag} OK ${t}\r\n`);
    const no = (t = "no") => send(`${tag} NO ${t}\r\n`);
    const flagStr = (m) => [...m.flags].join(" ");
    let m;
    if (/^LOGIN /.test(cmd)) return ok();
    if (cmd === "CAPABILITY") {
      send(`* CAPABILITY ${this.caps.join(" ")}\r\n`);
      return ok();
    }
    if (cmd === "LOGOUT") {
      send("* BYE\r\n");
      return ok();
    }
    if (cmd === 'LIST "" "*"') {
      for (const b of this.boxes.values()) send(`* LIST (${b.flags}) "/" "${b.name}"\r\n`);
      return ok();
    }
    if ((m = /^SELECT "(.*)"$/.exec(cmd))) {
      const b = this.boxes.get(m[1]);
      if (!b) return no("no such mailbox");
      setSel(b);
      send(`* ${b.msgs.length} EXISTS\r\n* OK [UIDVALIDITY ${b.uidvalidity}] v\r\n* OK [UIDNEXT ${b.uidnext}] n\r\n`);
      if (this.caps.includes("CONDSTORE")) send(`* OK [HIGHESTMODSEQ ${this.modseq}] m\r\n`);
      return ok("[READ-WRITE] selected");
    }
    const b = getSel();
    const max = b?.msgs.length ? b.msgs[b.msgs.length - 1].uid : 0;
    if ((m = /^UID SEARCH (.*)$/.exec(cmd))) {
      let hits = [];
      const crit = m[1];
      if (crit === "ALL") hits = b.msgs.map((x) => x.uid);
      else if ((m = /^UID (\S+)$/.exec(crit))) {
        // n:* always names the highest message, as real servers do
        hits = b.msgs.filter((x) => this.inSet(m[1], x.uid, max)).map((x) => x.uid);
      } else if ((m = /^HEADER "Message-ID" "(.*)"$/.exec(crit))) {
        hits = b.msgs.filter((x) => x.raw.includes(`Message-ID: ${m[1]}`)).map((x) => x.uid);
      }
      send(`* SEARCH${hits.map((u) => " " + u).join("")}\r\n`);
      return ok();
    }
    if ((m = /^UID FETCH (\S+) (.*)$/.exec(cmd))) {
      const set = m[1];
      let items = m[2];
      let since = 0;
      const cs = /\s*\(CHANGEDSINCE (\d+)\)$/.exec(items);
      if (cs) {
        if (!this.caps.includes("CONDSTORE")) return send(`${tag} BAD no condstore\r\n`);
        since = Number(cs[1]);
        items = items.slice(0, cs.index);
      }
      b.msgs.forEach((x, i) => {
        if (!this.inSet(set, x.uid, max)) return;
        if (since && x.modseq <= since) return;
        let head = `* ${i + 1} FETCH (UID ${x.uid} FLAGS (${flagStr(x)})`;
        if (since) head += ` MODSEQ (${x.modseq})`;
        if (items.includes("RFC822.SIZE")) head += ` RFC822.SIZE ${x.raw.length}`;
        let lit = null;
        if (items.includes("BODY.PEEK[]")) lit = ["BODY[]", x.raw];
        else if (items.includes("HEADER.FIELDS (MESSAGE-ID)")) {
          const mid = /^Message-ID: .*$/im.exec(x.raw);
          lit = ["BODY[HEADER.FIELDS (MESSAGE-ID)]", (mid ? mid[0] + "\r\n" : "") + "\r\n"];
        } else if (items.includes("BODY.PEEK[HEADER]")) lit = ["BODY[HEADER]", x.raw.split("\r\n\r\n")[0] + "\r\n\r\n"];
        if (lit) send(`${head} ${lit[0]} {${lit[1].length}}\r\n${lit[1]})\r\n`);
        else send(`${head})\r\n`);
      });
      return ok();
    }
    if ((m = /^UID STORE (\S+) ([+-])FLAGS \((.*)\)$/.exec(cmd))) {
      for (const x of b.msgs) {
        if (!this.inSet(m[1], x.uid, max)) continue;
        if (m[2] === "+") x.flags.add(m[3]);
        else x.flags.delete(m[3]);
        x.modseq = ++this.modseq;
      }
      return ok();
    }
    if ((m = /^UID EXPUNGE (\S+)$/.exec(cmd))) {
      if (!this.caps.includes("UIDPLUS")) return send(`${tag} BAD unknown\r\n`);
      b.msgs = b.msgs.filter((x) => !(this.inSet(m[1], x.uid, max) && x.flags.has(BS + "Deleted")));
      return ok();
    }
    if (cmd === "EXPUNGE") {
      b.msgs = b.msgs.filter((x) => !x.flags.has(BS + "Deleted"));
      return ok();
    }
    return send(`${tag} BAD unhandled ${cmd.slice(0, 40)}\r\n`);
  }
}

export { BS };
