/**
 * Static checks on public/index.html, run before every deploy.
 *
 * Each of these exists because it shipped broken at least once:
 *   - a mangled regex escape took the whole client script down
 *   - a duplicated Bcc field gave two elements the same id, so one was inert
 *   - a close button was rendered with no handler bound to it
 *
 * None of that is caught by the Worker's build, because the client script is
 * an opaque string as far as bundling is concerned.
 *
 *   node scripts/check-client.mjs
 */
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const script = html.split("<script>")[1]?.split("</script>")[0] ?? "";

let failed = 0;
const check = (label, ok, detail = "") => {
  if (ok) console.log(`  ok    ${label}`);
  else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? " — " + detail : ""}`);
  }
};

console.log("\nclient checks");

// 1. It has to parse. This is the one that took the app down.
let parses = true;
let parseError = "";
try {
  new Function(script);
} catch (e) {
  parses = false;
  parseError = String(e.message);
}
check("script parses", parses, parseError);

// 2. Every id is unique: duplicates make one of the pair silently dead.
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
const dupes = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
check("no duplicate ids", dupes.length === 0, dupes.join(", "));

// 3. Every id the script reaches for actually exists in the markup.
const present = new Set(ids);
const referenced = [...new Set([...script.matchAll(/\$\("#([A-Za-z0-9_-]+)"\)/g)].map((m) => m[1]))];
const missing = referenced.filter((id) => !present.has(id));
check("every referenced id exists", missing.length === 0, missing.join(", "));

// 4. Interactive elements should do something. A button that renders and does
//    nothing looks finished and is not.
const buttons = [...html.matchAll(/<button[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
//    Handlers take several shapes — a direct listener, a delegated closest()
//    match, or an id compared inside one — so the test is simply whether the
//    script mentions the id at all. Loose on purpose: the failure being caught
//    is a button nothing anywhere refers to.
const inert = buttons.filter((id) => !script.includes(id));
check("no button without a handler", inert.length === 0, inert.join(", "));

console.log(failed === 0 ? "\nclient OK\n" : `\n${failed} client check(s) failed\n`);
process.exit(failed ? 1 : 0);
