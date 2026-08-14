/**
 * The toolbar button, kept honest by polling.
 *
 * The PWA already does push notifications, but only while it is installed and
 * running. This is for the other case: Chrome is open, the mail tab is not,
 * and you still want to know. The badge sits on the toolbar whether or not
 * anything of ours is open.
 *
 * Polling rather than push on purpose. Web Push to an extension needs a
 * subscription the Worker would have to store and target separately, and the
 * whole thing would exist to save one request a minute against an endpoint
 * that returns about forty bytes.
 */

const APP = "https://mail.agentxr.app";
const ALARM = "poll";
const EVERY_MINUTES = 1; // matches the Worker's own sync cron; no point going finer

const RED = "#e5342c";
const GREY = "#8a8f98";

/**
 * The badge and its tooltip, always set together.
 *
 * A badge has room for three characters, so it cannot explain itself. The
 * tooltip is the only place the state can be written in words, and leaving it
 * at the default name means a grey mark on the toolbar with nothing anywhere
 * saying what it wants.
 */
const show = async (text, colour, title) => {
  await chrome.action.setBadgeText({ text });
  if (text) await chrome.action.setBadgeBackgroundColor({ color: colour });
  await chrome.action.setTitle({ title: `dmzs-mail — ${title}` });
};

/**
 * One poll. Returns nothing; everything it does is a side effect on the badge.
 *
 * Failure is quiet by design — a laptop lid closed mid-request should not
 * leave a permanent error marker on the toolbar. The one exception is a dead
 * token, which will never fix itself and so is worth showing.
 */
async function poll() {
  const { token, lastUnread = 0 } = await chrome.storage.local.get(["token", "lastUnread"]);
  if (!token) return show("!", GREY, "not connected. Click to set up.");

  let state;
  try {
    const res = await fetch(`${APP}/api/push/state`, { headers: { "X-Session": token } });
    if (res.status === 401) {
      // Never fixes itself, so unlike a network blip it is worth showing.
      await chrome.storage.local.remove("token");
      return show("!", GREY, "sign-in expired. Click to set up again.");
    }
    if (!res.ok) return;
    state = await res.json();
  } catch {
    // Offline, asleep, DNS hiccup. Keep the last known count rather than
    // flashing a zero — but say so, so a stale number is not read as current.
    return chrome.action.setTitle({ title: "dmzs-mail — offline, showing the last count" });
  }

  const unread = Number(state.unread) || 0;
  // No badge at all when there is nothing: an empty toolbar icon is the
  // clearest possible way to say "no new mail".
  await show(
    unread ? String(Math.min(unread, 999)) : "",
    RED,
    unread ? `${unread} unread` : "no new mail"
  );

  // Notify on a rise only. Reading mail elsewhere drops the count, and being
  // told about that would be noise.
  if (unread > lastUnread) {
    chrome.notifications.create("dmzs-mail", {
      type: "basic",
      iconUrl: "icon128.png",
      title: state.from || "New mail",
      message: state.subject || `${unread} unread`,
      silent: false,
    });
  }
  await chrome.storage.local.set({ lastUnread: unread });
}

/**
 * Focuses the app if it is already open somewhere, rather than piling up tabs.
 * With no token there is no app worth opening — the setup page is what the
 * click is actually asking for.
 */
async function openApp() {
  const { token } = await chrome.storage.local.get("token");
  if (!token) return chrome.runtime.openOptionsPage();

  const tabs = await chrome.tabs.query({ url: `${APP}/*` });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: APP });
  }
}

/**
 * Creates the alarm if it is missing, and otherwise leaves it strictly alone.
 *
 * The guard is the point. `alarms.create` with a name that already exists
 * replaces that alarm and restarts its schedule a full period from now — so
 * an unconditional create, run on every service-worker wake, would push the
 * next fire away each time. This worker is woken by icon clicks, notification
 * clicks and the content script, any of which could then starve it forever.
 */
const ensureAlarm = async () => {
  if (!(await chrome.alarms.get(ALARM))) {
    chrome.alarms.create(ALARM, { periodInMinutes: EVERY_MINUTES });
  }
};

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  poll();
});
// onStartup used to only poll, which is how the badge froze: after a browser
// restart it painted one count and then had no alarm left to update it.
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  poll();
});
chrome.alarms.onAlarm.addListener((a) => a.name === ALARM && poll());

chrome.action.onClicked.addListener(() => {
  poll(); // whatever the badge said, it is about to be checked
  openApp();
});
chrome.notifications.onClicked.addListener(() => {
  chrome.notifications.clear("dmzs-mail");
  openApp();
});

// The options page saves a token and wants the badge to reflect it now, not
// at the top of the next minute.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "poll") poll();
});

// Disabling and re-enabling the extension fires neither onInstalled nor
// onStartup, so this top-level call is the only thing that covers it. It sits
// after every addListener above on purpose: registration must stay synchronous
// or the worker loses the ability to be woken by its own alarm.
ensureAlarm();
