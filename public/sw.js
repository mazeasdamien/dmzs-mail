/**
 * Service worker, shell-only. Mail itself is never cached here: bodies are
 * private, change server-side (read state, archives), and the app is a
 * window onto the Worker rather than an offline archive. What this buys is
 * instant startup and an app shell that still paints with no connection.
 */

// Bump on every shell change. The activate handler deletes any cache whose
// name is not this one, so an old index.html cannot outlive a deploy.
const SHELL = "dmzs-mail-shell-v18";

const SHELL_FILES = [
  "/",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-192-maskable.png",
  "/icon-512-maskable.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(SHELL_FILES).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // The API and auth flows always go to the network.
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/internal/") ||
    url.pathname === "/auth" ||
    url.pathname === "/logout"
  ) {
    return;
  }

  // Navigation: network first so updates come through, cached shell offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(SHELL).then((c) => c.put("/", res.clone()));
          return res;
        })
        .catch(async () => (await caches.match("/")) || new Response("Offline", { status: 503 }))
    );
    return;
  }

  // Static files: cache first.
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) caches.open(SHELL).then((c) => c.put(req, res.clone()));
          return res;
        })
    )
  );
});

/**
 * A push carries no payload — see src/push.js. It is a doorbell: wake up, ask
 * the Worker what changed over the connection that is already authenticated,
 * and render the notification here. The contents of your mail therefore never
 * pass through Google's or Apple's push servers.
 */
self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let state = { unread: 0, total: 0, from: "", subject: "" };
      try {
        // Says which shell is asking, the same way the page does. Without it
        // every push logged as a client too old to identify itself, which is
        // the one signal that has to stay trustworthy.
        const res = await fetch("/api/push/state", {
          credentials: "same-origin",
          headers: { "X-Client": SHELL.replace("dmzs-mail-shell-", "") },
        });
        if (res.ok) state = await res.json();
      } catch {
        /* offline: still worth ringing, just without the detail */
      }

      // The taskbar / home-screen badge, independent of the notification.
      // Chrome and Edge on Windows honour it for an installed PWA; elsewhere
      // it simply does not exist, which is why this never throws upward.
      try {
        // `total`, not `unread`: the badge should say the same number the app
        // says, and the app counts every folder rather than the inbox alone.
        const badge = Number(state.total ?? state.unread) || 0;
        if (self.navigator?.setAppBadge) {
          if (badge > 0) await self.navigator.setAppBadge(badge);
          else await self.navigator.clearAppBadge?.();
        }
      } catch {
        /* unsupported: not worth failing a notification over */
      }

      // A tab that is already open should not wait for its next poll to show
      // the count — the push has just told us something changed.
      for (const c of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) {
        c.postMessage({ type: "mail", unread: state.unread });
      }

      if (!state.unread) return;
      await self.registration.showNotification(state.from || "New mail", {
        body: state.subject || `${state.unread} unread`,
        icon: "/icon-192.png",
        badge: "/icon-192.png",
        // One notification that updates, rather than a stack of them: a mailbox
        // is a count, not a feed of separate events.
        tag: "dmzs-mail",
        renotify: true,
        data: { unread: state.unread },
      });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      // Focus the window that already exists before opening another one.
      const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of open) {
        if (c.url.includes(self.location.origin)) return c.focus();
      }
      return self.clients.openWindow("/");
    })()
  );
});
