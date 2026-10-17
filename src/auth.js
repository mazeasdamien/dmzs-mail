/**
 * Passwordless authentication.
 *
 * The idea: open /auth?k=<BOOTSTRAP_KEY> once on a device. The Worker then
 * sets an HMAC-SHA256 signed cookie. Nothing to type again on that device.
 *
 * A login redirect is NEVER returned, only a flat 401. That is deliberate:
 * an <audio src> handed an HTML redirect fails silently, with no error worth
 * catching. A 401 is something the client can actually detect.
 */

const enc = new TextEncoder();
const YEAR = 365 * 24 * 60 * 60;
const COOKIE = "dmzs_session";

/**
 * How long a device activation stays valid without being used.
 *
 * It was five years, with nothing that could end one early, so a cookie
 * copied off a device was a key to the mailbox for five years. Now it is
 * Chrome's own ceiling, renewed as the app is used (below), and any session
 * can be ended from the app. Tokens minted under the old lifetime keep their
 * own `exp` and stay valid; they are swapped for one of these on first use.
 */
export const SESSION_TTL = 400 * 24 * 60 * 60;

/**
 * What the Chrome extension's token may do: read the unread count and
 * nothing else. It sits in extension storage, which is a weaker place than an
 * HttpOnly cookie, so losing it should cost a badge number, not the mailbox.
 */
export const PUSH_SCOPE = "push";
const pushOnly = (request) =>
  request.method === "GET" && new URL(request.url).pathname === "/api/push/state";

/**
 * Past this age, the cookie is re-issued on the fly.
 *
 * Needed because Chrome caps every cookie at 400 days no matter what the
 * server asks for: without re-issuing, a Chrome device would need activating
 * again after 13 months. Safari does not apply that cap to server-set
 * HttpOnly cookies, so the iPhone really does keep the full 5 years.
 *
 * At most one re-issue per month per device: the HMAC signature costs
 * nothing, but there is no point redoing it on every request.
 */
export const RENEW_AFTER = 30 * 24 * 60 * 60;

function b64urlEncode(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const pad = str.length % 4 ? "=".repeat(4 - (str.length % 4)) : "";
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/** Constant-time comparison, so the secret does not leak byte by byte. */
export function safeEqual(a, b) {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Different lengths: compare anyway, so the size is not revealed either.
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

async function hashHex(s, len) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, len);
}

/**
 * A short, honest label for the device being activated.
 *
 * "iOS" is more useful than a raw User-Agent in a session list, and a name
 * the person typed is better than both. Never anything identifying: this
 * rides in a signed cookie and is meant for a human looking at their own
 * devices, not for telemetry.
 */
function deviceLabel(name, userAgent) {
  const given = String(name || "").trim().slice(0, 40);
  if (given) return given;
  const ua = String(userAgent || "");
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Android/i.test(ua)) return "Android";
  if (/Macintosh|Mac OS X/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows";
  if (/CrOS/i.test(ua)) return "ChromeOS";
  return "device";
}

/**
 * Builds a `<payload>.<signature>` session token.
 *
 * The payload carries who this is and which key signed it — `sub` for a
 * device list, `kid` as `hashHex(secret, 8)` so two deployments can be told
 * apart without the secret ever appearing — and `sid`, a random id that is
 * what a revocation names. Verification still only requires `exp`, so a
 * cookie minted before these fields existed keeps working.
 *
 * `opts` may be a bare ttl in seconds (the older call) or
 * `{ ttl, name, userAgent, scope }`.
 */
export async function issueSession(secret, opts = {}) {
  const o = typeof opts === "number" ? { ttl: opts } : opts || {};
  const ttl = o.ttl ?? SESSION_TTL;
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    exp: now + ttl,
    iat: now,
    sub: deviceLabel(o.name, o.userAgent),
    kid: await hashHex(secret, 8),
    sid: [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join(""),
  };
  if (o.scope) payload.scope = o.scope;
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
  return `${body}.${b64urlEncode(sig)}`;
}

/** Verifies a token. Returns the payload, or null. */
export async function readSession(token, secret) {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;

  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let ok = false;
  try {
    ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      b64urlDecode(sig),
      enc.encode(body)
    );
  } catch {
    return null;
  }
  if (!ok) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function getCookie(request, name = COOKIE) {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function sessionCookie(token, maxAge = SESSION_TTL) {
  // HttpOnly: page JavaScript cannot read the cookie, but fetch() and
  // <audio src> send it automatically since everything is same-origin.
  // SameSite=Lax: enough here, and it does not block navigation coming from
  // the activation link.
  return [
    `${COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/**
 * The session payload carried by the request, or null.
 *
 * Two sources: the cookie for the browser, the `X-Session` header for the
 * Chrome extension. An extension request is cross-site, so a SameSite=Lax
 * cookie would not be sent.
 *
 * The header opens no CSRF hole: a third-party site cannot set a custom
 * header on a cross-origin request, and no permissive CORS rule is served.
 * Only an extension holding the host permission can do it, which requires an
 * explicit install.
 */
export async function requestSession(request, env) {
  if (!env.AUTH_SECRET) return null;
  const cookie = getCookie(request);
  const token = cookie || request.headers.get("X-Session");
  const payload = await readSession(token, env.AUTH_SECRET);
  if (!payload) return null;
  // Signed by this secret, so a kid can only disagree if it was forged along
  // with the signature — but it costs nothing to hold the token to its word.
  if (payload.kid && payload.kid !== (await hashHex(env.AUTH_SECRET, 8))) return null;
  if (payload.scope === PUSH_SCOPE && !pushOnly(request)) return null;
  if (payload.scope && payload.scope !== PUSH_SCOPE) return null;
  if (await revoked(payload, env)) return null;
  // Where it came from decides how it is renewed: a cookie by Set-Cookie, the
  // extension's header by a replacement token it stores itself.
  Object.defineProperty(payload, "via", { value: cookie ? "cookie" : "header" });
  return payload;
}

/**
 * Whether a valid token has been ended early.
 *
 * Two ways: its own `sid` on the denylist — signing out of one device — or
 * an issue time before `sessions_after`, which is what "sign out other
 * devices" sets. The second is also the only thing that reaches a token from
 * before session ids existed, since there is no id to list.
 *
 * One read per request. A database that cannot answer — the table not yet
 * created in the minute after a deploy, before the cron heals the schema —
 * is taken as "not revoked": the alternative is every device locked out of
 * its own mail by a missing table.
 */
async function revoked(payload, env) {
  if (!env.DB) return false;
  const row = await env.DB.prepare(
    `SELECT (SELECT value FROM settings WHERE key='sessions_after') AS after,
            (SELECT 1 FROM revoked_sessions WHERE sid=?) AS gone`
  )
    .bind(String(payload.sid || ""))
    .first()
    .catch(() => null);
  if (!row) return false;
  if (row.gone) return true;
  return !!row.after && Number(payload.iat || 0) < Number(row.after);
}

/**
 * Ends one session for good: its id goes on the denylist until it would have
 * expired anyway. Rows past that point are swept on the way, since a token
 * past its exp is refused by its signature check alone.
 */
export async function revokeSession(payload, env) {
  if (!payload?.sid || !env.DB) return;
  await env.DB.prepare("INSERT OR IGNORE INTO revoked_sessions (sid, exp, created_at) VALUES (?,?,?)")
    .bind(String(payload.sid), Number(payload.exp) || 0, Date.now())
    .run();
  await env.DB.prepare("DELETE FROM revoked_sessions WHERE exp < ?")
    .bind(Math.floor(Date.now() / 1000))
    .run();
}

/**
 * Ends every session issued before now, and returns a token for the device
 * asking, which is the one not meant to go.
 */
export async function revokeOthers(payload, env) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES ('sessions_after', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  )
    .bind(String(now))
    .run();
  return issueSession(env.AUTH_SECRET, { name: payload.sub });
}

/**
 * Whether a cookie-borne request that changes something came from this app.
 *
 * SameSite=Lax is per site, not per origin: every other *.agentxr.app page
 * sends this cookie along with its own requests, and request.json() reads a
 * text/plain form body as happily as a fetch. So the browser's own word on
 * where the request started decides — Sec-Fetch-Site, or Origin where an old
 * browser sends only that. A request with neither is not a browser being
 * steered by a page, and X-Session is a token no other page can know, so
 * both pass.
 */
export function sameOriginWrite(request) {
  if (request.method === "GET" || request.method === "HEAD") return true;
  if (request.headers.get("X-Session")) return true;
  const site = request.headers.get("Sec-Fetch-Site");
  if (site) return site === "same-origin" || site === "none";
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}

/**
 * A fresh cookie when the session is getting old, otherwise null.
 * A device stays activated indefinitely as long as it opens the app at least
 * once a year, Chrome included, which would otherwise cut off at 400 days.
 */
export async function renewedCookie(payload, env) {
  if (payload.via === "header" || payload.scope) return null;
  const age = SESSION_TTL - (payload.exp - Math.floor(Date.now() / 1000));
  // A token from before session ids is swapped straight away, so it can be
  // revoked on its own from then on.
  if (age < RENEW_AFTER && payload.sid) return null;
  // The device label travels with the re-issue; without it every renewal
  // would quietly rename the device back to "device".
  return sessionCookie(await issueSession(env.AUTH_SECRET, { name: payload.sub }));
}

/**
 * A replacement for the extension's token, or null.
 *
 * The extension cannot take a cookie, so its token is renewed the same way by
 * a response header it stores. A token from before the push scope existed is
 * a full session sitting in extension storage; it is swapped for a push-only
 * one at once.
 */
export async function renewedHeaderToken(payload, env) {
  if (payload.via !== "header") return null;
  const age = SESSION_TTL - (payload.exp - Math.floor(Date.now() / 1000));
  if (payload.scope === PUSH_SCOPE && payload.sid && age < RENEW_AFTER) return null;
  return issueSession(env.AUTH_SECRET, { name: payload.sub, scope: PUSH_SCOPE });
}
