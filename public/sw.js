// Pi Dashboard Service Worker — v3 (precache + runtime cache + push)
// See cell: dashboard-pwa-cold-load-fix/v1
// Closes Cluster A n=6 cold-load empirical cluster per JadeIce mobile-ux-audit
// W5-F1 P0 ROOT-CAUSE (SW EXPLICITLY DISABLED caching pre-v3).

// ── Cache version + names ──────────────────────────────────────────
// Bump CACHE_VERSION on every deploy that changes precached assets.
// The build script auto-injects deploy hash into PRECACHE_MANIFEST,
// but CACHE_VERSION is the human-readable invalidation handle.
const CACHE_VERSION = "v4";
const PRECACHE_NAME = `pi-dashboard-precache-${CACHE_VERSION}`;
const RUNTIME_API_CACHE = `pi-dashboard-api-${CACHE_VERSION}`;

// ── Precache manifest (substituted at build time) ──────────────────
// Replaced by packages/client/scripts/inject-sw-precache-manifest.mjs
// from dist/index.html + dist/assets/* enumeration. If left as the
// literal placeholder (dev mode), SW serves no-cache pass-through.
const PRECACHE_MANIFEST = __PRECACHE_MANIFEST__;

// ── Install: precache app-shell ────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      if (!Array.isArray(PRECACHE_MANIFEST) || PRECACHE_MANIFEST.length === 0) {
        // Dev mode or unsubstituted manifest — skip precache step.
        return;
      }
      const cache = await caches.open(PRECACHE_NAME);
      // addAll is atomic — if any asset 404s, the entire precache fails.
      // That's the correct behavior: a partial precache produces an
      // inconsistent shell on cold-load.
      await cache.addAll(PRECACHE_MANIFEST);
      // Activate immediately — operator already opted-in to PWA install.
      self.skipWaiting();
    })()
  );
});

// ── Activate: drop stale caches from prior CACHE_VERSION ───────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("pi-dashboard-") && !k.endsWith(CACHE_VERSION))
          .map((k) => caches.delete(k))
      );
      // Take control of in-flight clients without requiring a reload.
      // (Operator already sees app-shell skeleton; SW takeover is silent.)
      await self.clients.claim();
    })()
  );
});

// ── Fetch: route dispatch (cache-first / network-first / bypass) ───
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only intercept same-origin requests. Cross-origin (e.g., zrok tunnel
  // back-channel, third-party analytics if any) pass-through canonical.
  if (url.origin !== self.location.origin) return;

  // Skip non-GET — POST/PUT/DELETE/PATCH never cached.
  if (request.method !== "GET") return;

  // WebSocket upgrade handshake — pass-through. SW MUST NOT intercept
  // /ws/* per WebSocket protocol-tier canonical (browser-internal lifecycle).
  if (url.pathname.startsWith("/ws")) return;

  // API routes — network-first with cache fallback.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirstWithCache(request, RUNTIME_API_CACHE));
    return;
  }

  // App-shell HTML navigation — cache-first (precached index.html).
  if (request.mode === "navigate") {
    event.respondWith(cacheFirstWithNetworkFallback(request, PRECACHE_NAME, "/index.html"));
    return;
  }

  // Static assets (JS/CSS/PNG/SVG/woff2 etc.) — cache-first.
  // Includes precached app-shell assets + lazy-loaded chunks
  // (lazy chunks populate cache on first fetch).
  event.respondWith(cacheFirstWithNetworkFallback(request, PRECACHE_NAME, null));
});

async function cacheFirstWithNetworkFallback(request, cacheName, fallbackKey) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    // Only cache 2xx responses; do NOT cache 3xx/4xx/5xx.
    if (response.ok && response.status < 300) {
      cache.put(request, response.clone()).catch(() => { /* cache quota etc */ });
    }
    return response;
  } catch {
    // Network failure — try fallback (e.g., precached index.html for
    // navigation requests when offline).
    if (fallbackKey) {
      const fallback = await cache.match(fallbackKey);
      if (fallback) return fallback;
    }
    return new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
  }
}

async function networkFirstWithCache(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    // 3s network timeout — long enough for healthy LAN, short enough
    // that cold-load on flaky mobile gets cached fallback fast.
    const networkResponse = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
    ]);
    if (networkResponse.ok && networkResponse.status < 300) {
      cache.put(request, networkResponse.clone()).catch(() => { /* cache quota */ });
    }
    return networkResponse;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ success: false, error: "offline" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// ── Web Push handler ────────────────────────────────────────────────
// PRESERVED VERBATIM from sw.js v2 — operator's push-notification
// canonical state MUST NOT regress through this fix. See change:
// add-server-push-notifications.
self.addEventListener("push", (event) => {
  let title = "Pi Dashboard";
  let body = "New activity";
  let data = {};

  try {
    if (event.data) {
      const payload = event.data.json();
      title = payload.title || title;
      body = payload.body || body;
      data = {
        url: payload.data?.url || "/",
        sessionId: payload.data?.sessionId,
      };
    }
  } catch {
    try {
      if (event.data) {
        const text = event.data.text();
        if (text) body = text.slice(0, 500);
      }
    } catch { /* Ignore — keep defaults */ }
  }

  const promise = self.registration.showNotification(title, {
    body,
    icon: "/icon-192.png",
    badge: "/badge-72.png",
    data,
    requireInteraction: true,
  });

  event.waitUntil(promise);
});

// ── Notification click handler ──────────────────────────────────────
// PRESERVED VERBATIM from sw.js v2.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const url = event.notification.data?.url || "/";

  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      const urlPath = new URL(url, self.location.origin).pathname;
      for (const client of clientList) {
        try {
          if (new URL(client.url).pathname === urlPath && "focus" in client) {
            return client.focus();
          }
        } catch { /* Ignore URL parse errors for rogue client URLs */ }
      }
      return clients.openWindow(url);
    })
  );
});
