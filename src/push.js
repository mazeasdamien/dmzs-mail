/**
 * Web Push, VAPID-signed, payload-free.
 *
 * Two deliberate choices here.
 *
 * **The keypair is generated inside the Worker and never leaves it.** VAPID
 * needs a P-256 private key to sign with; generating it on a laptop means it
 * exists in a terminal, a clipboard and a shell history. Instead it is created
 * on first use, sealed with ENC_KEY like every other credential, and kept in
 * D1. Only the public half is ever served.
 *
 * **Pushes carry no payload.** RFC 8291 payload encryption (ECDH per
 * subscription, HKDF, AES-128-GCM) is a great deal of cryptography to get
 * subtly wrong, and the reward would be putting the contents of your mail
 * through Google's and Apple's push infrastructure. An empty push is a
 * doorbell: the service worker wakes, asks this Worker what changed over the
 * existing authenticated channel, and shows the notification itself. Nothing
 * private crosses a third party.
 */

import { seal, open } from "./crypto.js";

const b64url = (bytes) => {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const b64urlToBytes = (str) => {
  const pad = str.length % 4 ? "=".repeat(4 - (str.length % 4)) : "";
  return Uint8Array.from(atob(String(str).replace(/-/g, "+").replace(/_/g, "/") + pad), (c) =>
    c.charCodeAt(0)
  );
};

async function readSetting(env, key) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first();
  return row?.value ?? null;
}

async function writeSetting(env, key, value) {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  )
    .bind(key, value)
    .run();
}

/**
 * The VAPID keypair, generated once and reused.
 * Returns { publicKey (base64url raw), privateJwk }.
 */
export async function vapidKeys(env) {
  const stored = await readSetting(env, "vapid");
  if (stored) {
    const box = await open(env.ENC_KEY, stored);
    if (box?.privateJwk && box?.publicKey) return box;
  }

  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const keys = {
    // Raw uncompressed point (65 bytes, 0x04-prefixed) — the only form the
    // browser's applicationServerKey accepts.
    publicKey: b64url(await crypto.subtle.exportKey("raw", pair.publicKey)),
    privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
  };
  await writeSetting(env, "vapid", await seal(env.ENC_KEY, keys));
  return keys;
}

/** A VAPID JWT for one push service origin, good for twelve hours. */
async function vapidToken(env, audience, keys) {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64url(
    new TextEncoder().encode(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        // Push services want a way to contact whoever is sending; this is the
        // app, not the user, so it names the app.
        sub: env.APP_URL || "https://mail.agentxr.app",
      })
    )
  );

  const key = await crypto.subtle.importKey(
    "jwk",
    keys.privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  // WebCrypto returns ECDSA signatures as raw r||s, which is exactly what JWS
  // wants — no DER unwrapping needed.
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(`${header}.${body}`)
  );
  return `${header}.${body}.${b64url(sig)}`;
}

/**
 * Rings one subscription. Returns "ok", "gone" (unsubscribe it) or "error".
 *
 * 404 and 410 are the push service saying this subscription is dead — the app
 * was uninstalled, or the browser rotated it. Those get deleted rather than
 * retried forever.
 */
export async function pushOne(env, subscription, keys) {
  let endpoint;
  try {
    endpoint = new URL(subscription.endpoint);
  } catch {
    return "gone";
  }
  const token = await vapidToken(env, endpoint.origin, keys);

  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      TTL: "120",
      "Content-Length": "0",
      Authorization: `vapid t=${token}, k=${keys.publicKey}`,
    },
  });
  if (res.status === 404 || res.status === 410) return "gone";
  return res.ok ? "ok" : "error";
}

/** Rings every registered device, forgetting the ones that have gone away. */
export async function pushAll(env) {
  const { results } = await env.DB.prepare("SELECT endpoint, sub FROM push_subs").all();
  if (!results?.length) return 0;

  const keys = await vapidKeys(env);
  let sent = 0;
  for (const row of results) {
    let outcome = "error";
    try {
      outcome = await pushOne(env, JSON.parse(row.sub), keys);
    } catch {
      outcome = "error";
    }
    if (outcome === "ok") sent++;
    if (outcome === "gone") {
      await env.DB.prepare("DELETE FROM push_subs WHERE endpoint=?").bind(row.endpoint).run();
    }
  }
  return sent;
}

export { b64url, b64urlToBytes };
