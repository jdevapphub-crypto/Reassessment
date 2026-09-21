const CACHE_NAME = "reassessment-v1";
const urlsToCache = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-96.png",
  "./icons/icon-144.png",
  "./icons/icon-192.png",
  "./icons/icon-180.png",
  "./icons/icon-384.png",
  "./icons/icon1-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(urlsToCache);
    })
  );
});

self.addEventListener("fetch", event => {
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request);
    })
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(name => {
          if (name !== CACHE_NAME) {
            return caches.delete(name);
          }
        })
      );
    })
  );
});
