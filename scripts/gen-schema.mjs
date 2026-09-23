/**
 * Writes schema.sql from src/schema.js — the only place the database is
 * described — and refuses to pretend when the two have drifted.
 *
 *   node scripts/gen-schema.mjs          rewrite schema.sql
 *   node scripts/gen-schema.mjs --check  fail if schema.sql is stale
 *
 * `npm run db:schema` regenerates first, so a fresh install cannot be built
 * from a file someone edited by hand. `npm run deploy` runs --check, so a
 * stale schema.sql cannot reach production unnoticed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { schemaSql } from "../src/schema.js";

const target = new URL("../schema.sql", import.meta.url);
const want = schemaSql();

if (process.argv.includes("--check")) {
  let have = "";
  try {
    have = readFileSync(target, "utf8");
  } catch {
    console.error("schema.sql is missing — run: node scripts/gen-schema.mjs");
    process.exit(1);
  }
  if (have !== want) {
    console.error("schema.sql is stale — run: node scripts/gen-schema.mjs");
    process.exit(1);
  }
  console.log("schema.sql is current");
  process.exit(0);
}

writeFileSync(target, want);
console.log("schema.sql written from src/schema.js");
