/**
 * Relay: the app page → the extension's service worker.
 *
 * The page cannot call chrome.runtime.sendMessage with an extension id,
 * because an unpacked install has no stable id to hardcode. A content script
 * shares the page's window but keeps the extension APIs, which makes it the
 * one place the two can meet without pinning an id into the manifest.
 *
 * Only same-window messages with our own marker are relayed, so another page
 * script — or an iframe — cannot use this to poke the extension.
 */
window.addEventListener("message", (e) => {
  if (e.source !== window) return;
  if (e.origin !== location.origin) return;
  if (e.data?.type !== "dmzs-mail:changed") return;
  // Throws if the worker is mid-restart; it will poll on its own soon enough.
  try {
    chrome.runtime.sendMessage({ type: "poll" });
  } catch {}
});
