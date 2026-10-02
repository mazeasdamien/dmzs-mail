/**
 * The one build number.
 *
 * Three places have to agree on it — the page, the Worker and the service
 * worker's cache name — and until now each carried its own copy, kept in step
 * by hand. Bump two of the three and every open tab is told it is out of date
 * on every request; bump none of them and a stale tab is never told at all.
 *
 * This is the only constant a human edits. scripts/check-client.mjs writes it
 * into the other three files and refuses to finish if any anchor is missing.
 */
export const CLIENT_VERSION = "v43";
