/**
 * Trades the bootstrap key for a session token, once.
 *
 * The key is never written to storage: it is the thing that activates any new
 * device, so an extension that kept a copy would be a second place to steal it
 * from. Only the token it returns is saved, and that token is revocable by
 * rotating AUTH_SECRET.
 */

const APP = "https://mail.agentxr.app";
const $ = (id) => document.getElementById(id);

const say = (text, cls) => {
  $("msg").textContent = text;
  $("msg").className = cls || "";
};

async function connect() {
  const key = $("key").value.trim();
  if (!key) return say("Enter the key first.", "bad");

  say("Connecting…");
  try {
    const res = await fetch(`${APP}/api/extension/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) return say(data.error || "That key was refused.", "bad");

    await chrome.storage.local.set({ token: data.token, lastUnread: 0 });
    $("key").value = "";
    chrome.runtime.sendMessage({ type: "poll" });
    say("Connected. The badge will update within a minute.", "ok");
  } catch {
    say("Could not reach the server.", "bad");
  }
}

$("save").addEventListener("click", connect);
$("key").addEventListener("keydown", (e) => e.key === "Enter" && connect());

chrome.storage.local.get("token").then(({ token }) => {
  if (token) say("Already connected. Paste a new key to replace it.", "ok");
});
