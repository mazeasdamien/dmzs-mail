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

/** How long a device activation stays valid. */
export const SESSION_TTL = 5 * YEAR;

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

/** Builds a `<payload>.<signature>` session token. */
export async function issueSession(secret, ttl = SESSION_TTL) {
  const payload = { exp: Math.floor(Date.now() / 1000) + ttl };
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
  const token = getCookie(request) || request.headers.get("X-Session");
  return readSession(token, env.AUTH_SECRET);
}

/** true when the request carries a valid session. */
export async function isAuthed(request, env) {
  return (await requestSession(request, env)) !== null;
}

/**
 * A fresh cookie when the session is getting old, otherwise null.
 * A device stays activated indefinitely as long as it opens the app at least
 * once a year, Chrome included, which would otherwise cut off at 400 days.
 */
export async function renewedCookie(payload, env) {
  const age = SESSION_TTL - (payload.exp - Math.floor(Date.now() / 1000));
  if (age < RENEW_AFTER) return null;
  return sessionCookie(await issueSession(env.AUTH_SECRET));
}
