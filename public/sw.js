// Service worker for the installed web app. It never caches the tracker itself, so the
// data is always live; it only shows a friendly page when there's no connection.

const OFFLINE = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open("offline-v1").then((cache) => cache.add(OFFLINE)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return; // everything else goes straight to the network
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE)));
});

// 🔔 Push notifications (netlify/lib/notify.mjs): someone else added an expense, food,
// exercise or weight. Tapping one opens that page.
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text() };
  }
  event.waitUntil(self.registration.showNotification(data.title || "Life Kalicc", {
    body: data.body || "Something new was added.",
    tag: data.tag,
    renotify: !!(data.tag && data.renotify), // buzz again when a notification replaces one
    data: { url: data.url || "/" },
    icon: "/icons/icon-192.png?v=3",
    badge: "/icons/icon-192.png",
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const same = wins.find((w) => w.url === url);
    if (same) return same.focus();
    if (wins[0]) {
      await wins[0].focus();
      return wins[0].navigate(url).catch(() => self.clients.openWindow(url));
    }
    return self.clients.openWindow(url);
  })());
});
