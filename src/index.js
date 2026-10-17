/**
 * dmzs-mail — one Worker, one mailbox.
 *
 * iCloud only. The Worker speaks IMAP and SMTP itself over outbound sockets,
 * so nothing runs on any machine of yours: a cron pulls every mailbox a few
 * messages at a time, and actions go straight out over the same connection.
 *
 * One provider throughout, which is why there is no dispatch layer and no
 * abstraction over "a mail account": the code says what it does.
 *
 * Sessions, cookies and device activation are dmzs-music's auth.js, with a
 * device name stamped into the token so a session list means something.
 */

import { PUSH_SCOPE, clearCookie, getCookie, issueSession, readSession, renewedCookie, renewedHeaderToken, requestSession, revokeSession, safeEqual, sameOriginWrite, sessionCookie } from "./auth.js";
import { runBackup } from "./backup.js";
import { pushAll } from "./push.js";
import { ensureSchema } from "./schema.js";
import { handleApi } from "./api.js";
import { flushOutbox, wakeSnoozed } from "./outgoing.js";
import { syncAccount } from "./sync.js";
import { SYNC_PER_RUN, json, learnHost } from "./util.js";

/**
 * The client this Worker was deployed alongside.
 *
 * Written from src/version.js by scripts/check-client.mjs — one constant to
 * edit, and the page, this file and the service worker all agree on it or the
 * deploy never starts.
 */
const CLIENT_SHELL = "v60";

/**
 * One activation key, three ways in.
 *
 * `GET /auth?k=…` is the form a saved link takes and still works: check the
 * key, set the cookie, 302 to the app. `POST /auth` takes `{k, name?}` and
 * answers with JSON, which is what the activation page and any future client
 * wants. `GET /auth` with no key serves that page — and the page has to read
 * the key out of `location.hash`, because a fragment never reaches a server
 * and is therefore the one place a bootstrap key can travel in a URL without
 * landing in a log line. A paste field covers the case where the link was
 * copied without the fragment.
 */
async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === "/auth") {
    const k = url.searchParams.get("k") || "";
    const ua = request.headers.get("User-Agent") || "";
    if (k) {
      if (!env.BOOTSTRAP_KEY || !safeEqual(k, env.BOOTSTRAP_KEY)) return denied();
      const token = await issueSession(env.AUTH_SECRET, { userAgent: ua });
      return new Response(null, {
        status: 302,
        headers: { Location: "/", "Set-Cookie": sessionCookie(token) },
      });
    }
    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const key = String(body.k || body.key || "");
      if (!env.BOOTSTRAP_KEY || !safeEqual(key, env.BOOTSTRAP_KEY)) {
        return json({ error: "Wrong key" }, 401);
      }
      const token = await issueSession(env.AUTH_SECRET, {
        name: String(body.name || "").slice(0, 40) || undefined,
        userAgent: ua,
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Set-Cookie": sessionCookie(token),
        },
      });
    }
    return new Response(ACTIVATION_PAGE, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": SHELL_CSP,
      },
    });
  }

  // The Chrome extension activates the same way a device does, with the
  // bootstrap key — but it gets the token in the body rather than as a
  // cookie, because it will send it back as X-Session. It cannot use the
  // cookie: an extension request is cross-site, and the cookie is Lax.
  if (path === "/api/extension/activate" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const key = String(body.k || body.key || "");
    if (!env.BOOTSTRAP_KEY || !safeEqual(key, env.BOOTSTRAP_KEY)) {
      return json({ error: "Wrong key" }, 401);
    }
    return json({
      // Push-only: the badge is all the extension shows, so the unread count
      // is all its token can read.
      token: await issueSession(env.AUTH_SECRET, {
        name: String(body.name || "").slice(0, 40) || undefined,
        userAgent: request.headers.get("User-Agent") || "",
        scope: PUSH_SCOPE,
      }),
    });
  }

  if (path === "/logout") {
    // Only a page you navigate to signs you out. Message bodies keep their
    // relative URLs, and the print frame is same-origin, so an
    // <img src="/logout"> in a mail would otherwise end the session the
    // moment it was printed — as would the same tag on any sibling site.
    const dest = request.headers.get("Sec-Fetch-Dest");
    const site = request.headers.get("Sec-Fetch-Site");
    if ((dest && dest !== "document") || (site && site !== "same-origin" && site !== "none")) {
      return new Response(null, { status: 204 });
    }
    // The cookie is cleared, and its id goes on the denylist: a copy of it
    // taken off this device stops working at the same moment.
    const leaving = await readSession(getCookie(request), env.AUTH_SECRET || "").catch(() => null);
    if (leaving) await revokeSession(leaving, env).catch(() => {});
    return new Response(null, {
      status: 302,
      headers: { Location: "/", "Set-Cookie": clearCookie() },
    });
  }

  const session = await requestSession(request, env);
  // JSON for the API, which is read by code; the page for anything a person
  // navigated to.
  if (!session) return path.startsWith("/api/") ? json({ error: "This device is not activated" }, 401) : denied();

  if (path.startsWith("/api/")) {
    if (!sameOriginWrite(request)) return json({ error: "Cross-site request refused" }, 403);
    // The app reaches its API with fetch() and with links it downloads from;
    // nothing of its own loads an /api/ URL as an image, a stylesheet or a
    // font. Something that does is a message body — the print frame shares
    // this origin and sends the cookie — and a GET here is not always a read:
    // opening a message marks it read. Bodies stored before the sanitizer
    // dropped URLs pointing back at the app still carry them.
    const dest = request.headers.get("Sec-Fetch-Dest");
    if (dest && dest !== "empty" && dest !== "document") {
      return json({ error: "Not loadable from a page" }, 403);
    }
    const res = await handleApi(request, env, path, ctx, session);
    const fresh = await renewedCookie(session, env);
    const out = new Response(res.body, res);
    if (fresh) out.headers.append("Set-Cookie", fresh);
    if (path === "/api/push/state") {
      const swap = await renewedHeaderToken(session, env);
      if (swap) out.headers.set("X-Session-Replace", swap);
    }

    // Which client is on the other end, and which one it ought to be.
    //
    // A tab left open across a deploy runs old code against a new server,
    // and every symptom of that looks like a bug in the feature you just
    // shipped. Three separate diagnoses here have gone that way, so the
    // answer travels with every response instead of being guessed at.
    const said = request.headers.get("X-Client") || "";
    out.headers.set("X-Shell", CLIENT_SHELL);
    // The Chrome extension is versioned on its own and says so with an ext-
    // prefix; it is never stale against the shell, so it is not logged as one.
    if (said !== CLIENT_SHELL && !said.startsWith("ext-")) {
      console.log(`stale client: ${said || "(pre-versioning)"} against ${CLIENT_SHELL} on ${path}`);
    }
    return out;
  }

  // The shell, never from the browser's own cache without asking first.
  //
  // A tab reloaded onto a stale index.html runs old code against a new
  // Worker, and every symptom of that looks like a bug in whatever shipped
  // last. It did, three times in one day, and no amount of reloading fixed
  // it because reloading was being answered from disk.
  //
  // no-cache is not "do not store": the copy is kept and revalidated, so an
  // unchanged page still costs one conditional request and nothing more.
  // Set here rather than in a _headers file because run_worker_first means
  // every asset is served through this call, where it can be seen to happen.
  const asset = await env.ASSETS.fetch(request);
  const shell = /^\/(|index\.html|sw\.js|manifest\.webmanifest)$/.test(path);
  const page = /^text\/html/i.test(asset.headers.get("Content-Type") || "");
  if (shell || page) {
    const out = new Response(asset.body, asset);
    if (shell) out.headers.set("Cache-Control", "no-cache");
    if (page) out.headers.set("Content-Security-Policy", SHELL_CSP);
    return out;
  }
  return asset;
}

/**
 * The page-level policy for the shell.
 *
 * Not a script policy: the app is one inline script, and a hash of it would
 * have to be rewritten on every build. What it does close is everything
 * that needs no script at all — a plugin, a <base> that re-points every
 * relative URL, a form posting off-site, and this app framed by someone else.
 * The message frames are srcdoc documents and inherit this policy; nothing
 * here limits what they draw, and each carries its own tighter one.
 */
const SHELL_CSP = "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

/**
 * The unauthenticated page at /auth. Minimal on purpose: it holds a key for
 * the length of one POST and nothing else. Matches denied()'s palette so the
 * two do not look like different products.
 */
const ACTIVATION_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Activate this device</title>
<style>
 :root{--bg:#ffffff;--t1:#111114;--t2:#5b5b63;--line:#d9d9de;--field:#ffffff;--bad:#c62828}
 @media (prefers-color-scheme: dark){:root{--bg:#09090b;--t1:#f4f4f5;--t2:#8b8b93;--line:#27272a;--field:#111114;--bad:#f87171}}
 html,body{height:100%;margin:0}
 body{background:var(--bg);color:var(--t2);display:flex;align-items:center;justify-content:center;
      font:400 15px/1.6 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;padding:24px}
 .card{max-width:360px;width:100%}
 strong{display:block;color:var(--t1);font-size:17px;font-weight:600;margin-bottom:6px}
 p{margin:0 0 16px}
 form{display:flex;gap:8px}
 input,button{font:inherit;font-size:16px;border-radius:10px;border:1px solid var(--line);background:var(--field);color:var(--t1)}
 input{flex:1;padding:10px 12px;min-width:0}
 button{padding:10px 16px;background:#1f6fd0;border-color:#1f6fd0;color:#fff;cursor:pointer}
 #msg{margin:12px 0 0;min-height:1.4em}
 #msg[data-bad="1"]{color:var(--bad)}
</style></head>
<body><div class="card">
<strong>Activate this device</strong>
<p>Paste the activation key you were given when this mailbox was set up. Each phone or computer is activated once, and stays signed in.</p>
<form id="f" autocomplete="off"><input id="k" name="k" type="password" placeholder="Activation key" aria-label="Activation key" required>
<button type="submit">Activate</button></form>
<p id="msg" role="status"></p>
</div>
<script>
(function(){
  var f=document.getElementById("f"),k=document.getElementById("k"),msg=document.getElementById("msg");
  // A key in the fragment never reaches the server, which is why the
  // activation link is written that way. Read it here and post it, so the
  // link is still one tap.
  var frag=(location.hash||"").replace(/^#/, "");
  var fromFrag="";
  frag.split("&").forEach(function(p){
    var i=p.indexOf("=");
    if(i>0 && decodeURIComponent(p.slice(0,i))==="k") fromFrag=decodeURIComponent(p.slice(i+1));
  });
  if(fromFrag){ k.value=fromFrag; k.type="hidden"; f.querySelector("button").focus(); }
  else k.focus();
  f.addEventListener("submit",function(e){
    e.preventDefault();
    msg.textContent=""; msg.removeAttribute("data-bad");
    fetch("/auth",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({k:k.value,name:navigator.platform||""})})
      .then(function(r){ return r.json().then(function(j){ return {r:r,j:j}; }); })
      .then(function(x){
        if(!x.r.ok){ msg.textContent=x.j.error||"That key was not accepted."; msg.setAttribute("data-bad","1"); return; }
        location.replace("/");
      })
      .catch(function(){ msg.textContent="Something went wrong. Try again."; msg.setAttribute("data-bad","1"); });
  });
})();
</script></body></html>`;

/* ────────────────────────────────────────────────────────────────
   Entry points
   ──────────────────────────────────────────────────────────────── */

export default {
  async fetch(request, env, ctx) {
    learnHost(env);
    // Everything below is allowed to throw; nothing is allowed to answer a
    // thrown error with a Worker stack trace. One outer net, one shape.
    try {
      return await route(request, env, ctx);
    } catch (e) {
      console.log(`unhandled: ${e && e.stack ? e.stack : e}`);
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
  // Sync heartbeat: the least-recently-synced account, IMAP_CAP messages per
  // pass. The subrequest allowance per invocation shapes everything here.
  async scheduled(event, env, ctx) {
    learnHost(env);
    // Two schedules share this handler; the cron expression says which fired.
    if (event.cron && event.cron.startsWith("17 3")) {
      ctx.waitUntil(
        // Send receipts only matter for the minutes a retry could come in.
        env.DB.prepare("DELETE FROM settings WHERE key LIKE 'sent:%' AND json_extract(value, '$.at') < ?")
          .bind(Date.now() - 2 * 86_400_000)
          .run()
          .catch(() => {})
      );
      // A failed snapshot used to vanish into .catch(() => {}). It is kept
      // where Settings can show it, and cleared by the next good one.
      ctx.waitUntil(
        runBackup(env, Date.now())
          .then(() => env.DB.prepare("DELETE FROM settings WHERE key='backup_error'").run())
          .catch((e) =>
            env.DB.prepare(
              "INSERT INTO settings (key, value) VALUES ('backup_error', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
            )
              .bind(JSON.stringify({ at: Date.now(), error: String((e && e.message) || e).slice(0, 300) }))
              .run()
              .catch(() => {})
          )
      );
      return;
    }
    ctx.waitUntil(
      (async () => {
        // Before anything reads or writes a message: a build that expects a
        // column the database has not got cannot sync at all, and this is the
        // only place that can put that right.
        await ensureSchema(env).catch((e) => console.log(`schema: ${e.message || e}`));

        // The newest unread message in the inbox, before and after. Counting
        // them missed a pass where one arrived and another was read: the
        // count stood still and nothing rang.
        const NEWEST = "SELECT MAX(date) AS d FROM messages WHERE folder='inbox' AND unread=1";
        const before = await env.DB.prepare(NEWEST).first();

        const { results } = await env.DB.prepare(
          // Only accounts with a stored credential; without one there is
          // nothing this Worker can do with the mailbox.
        `SELECT * FROM accounts
            WHERE status != 'reauth' AND secret IS NOT NULL
            ORDER BY COALESCE(last_sync, 0) ASC LIMIT ?`
        )
          .bind(SYNC_PER_RUN)
          .all();
        // Reconciling moves the unread count too — a message read on the phone
        // takes one off, one marked unread there adds one — and neither is new
        // mail. Counted apart, so a read elsewhere cannot hide a new arrival in
        // the same pass, nor a re-flag ring the phone.
        const tally = { unreadShift: 0 };
        for (const acct of results ?? []) await syncAccount(env, acct, tally);

        // Only ring for unread mail newer than anything unread before, and
        // recent. A sync that backfilled history, re-read a message already
        // opened, or picked up a flag changed on the phone is not something
        // to wake a phone for: none of those makes the newest unread message
        // newer than it was.
        const after = await env.DB.prepare(NEWEST).first();
        const fresh = (after?.d || 0) > (before?.d || 0) && (after?.d || 0) > Date.now() - 2 * 86_400_000;
        if (fresh) await pushAll(env);

        await flushOutbox(env).catch((e) => console.log(`outbox: ${e.message || e}`));
        await wakeSnoozed(env).catch((e) => console.log(`snooze: ${e.message || e}`));
      })()
    );
  },
};

function denied() {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Access denied</title>
<style>
 html,body{height:100%;margin:0}
 body{background:#09090b;color:#8b8b93;display:flex;align-items:center;justify-content:center;
      font:400 15px/1.6 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;text-align:center;padding:24px}
 strong{display:block;color:#f4f4f5;font-size:17px;font-weight:600;margin-bottom:6px}
</style></head>
<body><div><strong>Access denied</strong>This device is not activated.<br><a href="/auth" style="color:#f4f4f5">Activate it with your key</a></div></body></html>`,
    { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}
