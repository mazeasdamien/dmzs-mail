/**
 * One-shot secret setup: generates what can be generated, asks for what
 * only you have (the two OAuth client secrets), and pushes everything with
 * `wrangler secret put`. Run it once from the project folder:
 *
 *   node scripts/secrets.mjs
 *
 * Safe to re-run: it always overwrites, never prints values back.
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const put = (name, value) => {
  const r = spawnSync("npx", ["wrangler", "secret", "put", name], {
    input: value,
    stdio: ["pipe", "inherit", "inherit"],
    shell: process.platform === "win32",
  });
  if (r.status !== 0) {
    console.error(`\n✗ could not store ${name} — is wrangler logged in?`);
    process.exit(1);
  }
};

const b64url = (n) => randomBytes(n).toString("base64url");

console.log("Generated secrets (stored, never shown):");
const generated = {
  AUTH_SECRET: b64url(48), // signs session cookies
  BOOTSTRAP_KEY: b64url(24), // one-time device activation: /auth?k=<this>
  WORKER_TOKEN: b64url(32), // bearer token for the retired PC agent, if used
  ENC_KEY: randomBytes(32).toString("base64"), // AES-256-GCM for stored credentials
};
for (const [k, v] of Object.entries(generated)) {
  put(k, v);
  console.log(`  ✓ ${k}`);
}

console.log(`
Keep these two somewhere safe NOW (they are needed on other machines):

  Activation link : https://mail.agentxr.app/auth?k=${generated.BOOTSTRAP_KEY}
  Agent token     : ${generated.WORKER_TOKEN}

`);

// Optional. The compose assistant (Fix / Improve) is the only thing that
// wants a key here, and every other part of the app works without one.
const rl = createInterface({ input: process.stdin, output: process.stdout });
const gemini = (
  await rl.question("Gemini API key for the writing assistant (empty to skip): ")
).trim();
rl.close();
if (gemini) {
  put("GEMINI_API_KEY", gemini);
  console.log("  stored GEMINI_API_KEY");
} else {
  console.log("  skipped: Fix and Improve will report that no key is set");
}

console.log(`
Done. Next:

  npm run db:schema
  npm run deploy

Then open the activation link above, and connect iCloud from inside the app
using an app-specific password from account.apple.com.
`);
