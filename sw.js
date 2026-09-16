/* =========================================================
   STUDYPAD SERVICE WORKER — sw.js
   Handles offline caching, background reminders,
   and periodic sync so StudyPad keeps working
   even when the tab is in the background.
========================================================= */

const CACHE_NAME = "studypad-cache-v1";

/* Files to cache on install (offline shell) */
const PRECACHE_URLS = [
    "./",
    "./index.html",
    "./ew.js",
    "./manifest.json"
];

/* =========================================================
   INSTALL — pre-cache the app shell
========================================================= */
self.addEventListener("install", event => {
    console.log("[StudyPad SW] Installing…");

    event.waitUntil(
        caches
            .open(CACHE_NAME)
            .then(cache => {
                return cache.addAll(
                    PRECACHE_URLS.map(url => {
                        return new Request(url, { cache: "reload" });
                    })
                ).catch(err => {
                    console.warn(
                        "[StudyPad SW] Precache partial failure:",
                        err
                    );
                });
            })
            .then(() => self.skipWaiting())
    );
});

/* =========================================================
   ACTIVATE — clean up old caches
========================================================= */
self.addEventListener("activate", event => {
    console.log("[StudyPad SW] Activating…");

    event.waitUntil(
        caches
            .keys()
            .then(keys =>
                Promise.all(
                    keys
                        .filter(key => key !== CACHE_NAME)
                        .map(key => caches.delete(key))
                )
            )
            .then(() => self.clients.claim())
    );
});

/* =========================================================
   FETCH — network-first with cache fallback
========================================================= */
self.addEventListener("fetch", event => {
    const { request } = event;

    /* Only handle GET requests */
    if (request.method !== "GET") return;

    /* Skip cross-origin requests (fonts, CDNs, etc.) */
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    event.respondWith(
        fetch(request)
            .then(response => {
                /* Cache a clone of successful responses */
                if (
                    response &&
                    response.status === 200 &&
                    response.type === "basic"
                ) {
                    const copy = response.clone();
                    caches
                        .open(CACHE_NAME)
                        .then(cache => cache.put(request, copy))
                        .catch(() => {});
                }
                return response;
            })
            .catch(() => {
                /* Offline: serve from cache */
                return caches.match(request).then(cached => {
                    if (cached) return cached;

                    /* Fallback to app shell for navigation */
                    if (request.mode === "navigate") {
                        return caches.match("./index.html");
                    }

                    return new Response(
                        "Offline — resource unavailable.",
                        {
                            status: 503,
                            statusText: "Service Unavailable",
                            headers: { "Content-Type": "text/plain" }
                        }
                    );
                });
            })
    );
});

/* =========================================================
   MESSAGE — allow the page to trigger actions
========================================================= */
self.addEventListener("message", event => {
    const data = event.data || {};

    if (data.type === "SKIP_WAITING") {
        self.skipWaiting();
    }

    if (data.type === "CHECK_REMINDERS") {
        /* A page asked us to run reminders now */
        runReminderCheck();
    }
});

/* =========================================================
   PERIODIC BACKGROUND SYNC — check reminders
   (Chrome/Edge/Android only; safely ignored elsewhere)
========================================================= */
self.addEventListener("periodicsync", event => {
    if (event.tag === "studypad-reminder-check") {
        event.waitUntil(runReminderCheck());
    }
});

/* =========================================================
   BACKGROUND SYNC — retry when connection returns
========================================================= */
self.addEventListener("sync", event => {
    if (event.tag === "studypad-sync") {
        event.waitUntil(runReminderCheck());
    }
});

/* =========================================================
   PUSH — receive remote reminder (optional)
========================================================= */
self.addEventListener("push", event => {
    let payload = {
        title: "StudyPad Reminder",
        body: "You have an upcoming assessment."
    };

    try {
        if (event.data) {
            payload = { ...payload, ...event.data.json() };
        }
    } catch (e) {
        /* ignore malformed payloads */
    }

    event.waitUntil(
        self.registration.showNotification(payload.title, {
            body: payload.body,
            icon: "",
            badge: "",
            tag: "studypad-assessment",
            requireInteraction: true,
            vibrate: [200, 100, 200],
            data: { url: "./" }
        })
    );
});

/* =========================================================
   NOTIFICATION CLICK — focus or open the app
========================================================= */
self.addEventListener("notificationclick", event => {
    event.notification.close();

    const targetUrl =
        (event.notification.data &&
         event.notification.data.url) ||
        "./";

    event.waitUntil(
        clients
            .matchAll({
                type: "window",
                includeUncontrolled: true
            })
            .then(clientList => {
                for (const client of clientList) {
                    if (
                        client.url.includes(self.location.origin) &&
                        "focus" in client
                    ) {
                        client.navigate(targetUrl);
                        return client.focus();
                    }
                }
                if (clients.openWindow) {
                    return clients.openWindow(targetUrl);
                }
            })
    );
});

/* =========================================================
   REMINDER CHECK — the actual background logic
   Runs 1 day before an assessment at 10:00 and 15:00.
========================================================= */
async function runReminderCheck() {
    try {
        const db = await openStudyPadDB();

        const assessments =
            await getAllFromStore(db, "assessments");

        const settingsRecord =
            await getOneFromStore(db, "settings", "settings");

        const settings = settingsRecord
            ? { voice: true, notifications: false, ...settingsRecord.value }
            : { voice: true, notifications: false };

        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const tomorrowString = formatDateInput(tomorrow);

        const hour = now.getHours();
        const minute = now.getMinutes();

        /* Only fire at the top of 10:00 or 15:00 */
        const isMorning = hour === 10 && minute === 0;
        const isAfternoon = hour === 15 && minute === 0;

        if (!isMorning && !isAfternoon) return;

        for (const a of assessments) {
            if (a.completed) continue;
            if (a.date !== tomorrowString) continue;

            const type = isMorning ? "morning" : "afternoon";
            const key = `${a.id}_${a.date}_${type}`;

            if (await wasReminded(key)) continue;

            const greeting = isMorning
                ? "Good morning."
                : "Good day.";

            const title = isMorning
                ? "Good morning — StudyPad"
                : "Good day — StudyPad";

            const message =
                `${greeting} Don't forget your assessment ${a.name} is due tomorrow.`;

            /* Show notification */
            await self.registration.showNotification(title, {
                body: message,
                icon: "",
                badge: "",
                tag: `studypad-${key}`,
                requireInteraction: true,
                vibrate: [200, 100, 200],
                data: { url: "./" }
            });

            /* Mark as reminded so we don't repeat */
            await markReminded(key);

            /* Log for debugging */
            console.log(
                "[StudyPad SW] Reminder fired for:",
                a.name
            );
        }

        db.close();
    } catch (err) {
        console.warn(
            "[StudyPad SW] Reminder check failed:",
            err
        );
    }
}

/* =========================================================
   INDEXEDDB HELPERS (SW-side, standalone)
========================================================= */
function openStudyPadDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(
            "StudyPadDatabase",
            1
        );

        request.onupgradeneeded = event => {
            const database = event.target.result;

            if (!database.objectStoreNames.contains("assessments")) {
                database.createObjectStore("assessments", { keyPath: "id" });
            }
            if (!database.objectStoreNames.contains("notes")) {
                database.createObjectStore("notes", { keyPath: "id" });
            }
            if (!database.objectStoreNames.contains("sticky")) {
                database.createObjectStore("sticky", { keyPath: "id" });
            }
            if (!database.objectStoreNames.contains("schedule")) {
                database.createObjectStore("schedule", { keyPath: "id" });
            }
            if (!database.objectStoreNames.contains("settings")) {
                database.createObjectStore("settings", { keyPath: "id" });
            }
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function getAllFromStore(db, storeName) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).getAll();

        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}

function getOneFromStore(db, storeName, id) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).get(id);

        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}

/* =========================================================
   REMINDER FLAG (localStorage isn't available in SW,
   so we use the Cache API as a tiny key/value store)
========================================================= */
const FLAG_CACHE = "studypad-flags-v1";

async function wasReminded(key) {
    try {
        const cache = await caches.open(FLAG_CACHE);
        const response = await cache.match(
            new Request(`/__studypad_flag__/${key}`)
        );
        return !!response;
    } catch {
        return false;
    }
}

async function markReminded(key) {
    try {
        const cache = await caches.open(FLAG_CACHE);
        await cache.put(
            new Request(`/__studypad_flag__/${key}`),
            new Response("1", { status: 200 })
        );
    } catch (err) {
        console.warn("[StudyPad SW] Failed to mark reminder:", err);
    }
}

/* =========================================================
   DATE HELPER (duplicated for SW context)
========================================================= */
function formatDateInput(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}
