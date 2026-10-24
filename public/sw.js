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
