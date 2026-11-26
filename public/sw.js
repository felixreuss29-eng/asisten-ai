/* Service Worker — menyimpan shell aplikasi agar bisa dipasang/dipakai offline.
   Permintaan /api/ sengaja TIDAK dicache supaya jawaban selalu dari model. */

const CACHE = "asisten-ai-v1";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // jangan pernah cache API

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const salinan = response.clone();
          caches.open(CACHE).then((cache) => cache.put("./index.html", salinan));
          return response;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((tersimpan) => {
      if (tersimpan) return tersimpan;
      return fetch(event.request).then((response) => {
        if (response && response.status === 200 && response.type === "basic") {
          const salinan = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, salinan));
        }
        return response;
      });
    })
  );
});
