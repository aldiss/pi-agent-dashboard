/**
 * B1 — Service-worker cross-principal authenticated cache replay.
 *
 * Executes the REAL public/sw.js in a sandboxed ServiceWorker environment
 * (fake self/caches/fetch/Response) and drives its fetch + activate handlers.
 * Unlike sw-push.test.ts (which re-implements handler logic inline), this loads
 * the actual shipped file so the caching decision under test is the real one.
 *
 * Exposure: /api/ GETs were network-first WITH cache — a 2xx was written to
 * RUNTIME_API_CACHE keyed by URL only (no principal partition) and served on
 * network failure regardless of the current cookie/principal, replaying an
 * operator body to a guest. Fix: /api/ GETs are network-only (never cached,
 * never served from cache; offline → 503 JSON), and activate purges ALL
 * pi-dashboard-api-* runtime caches.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

// Vitest root is the repo root (see RUN header); public/sw.js lives there.
const SW_PATH = path.resolve(process.cwd(), "public/sw.js");
const ORIGIN = "https://dash.test";
const CACHE_VERSION = "test-v1";
const RUNTIME_API_CACHE = `pi-dashboard-api-${CACHE_VERSION}`;
const PRECACHE_NAME = `pi-dashboard-precache-${CACHE_VERSION}`;

class FakeResponse {
  _body: string;
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  constructor(body: string, init: { status?: number; headers?: Record<string, string> } = {}) {
    this._body = body;
    this.status = init.status ?? 200;
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = init.headers ?? {};
  }
  clone() { return new FakeResponse(this._body, { status: this.status, headers: this.headers }); }
  async text() { return this._body; }
  async json() { return JSON.parse(this._body); }
}

function keyOf(reqOrStr: any): string {
  return typeof reqOrStr === "string" ? reqOrStr : reqOrStr.url;
}

interface FakeCache { _m: Map<string, FakeResponse>; match(r: any): Promise<FakeResponse | undefined>; put(r: any, res: FakeResponse): Promise<void>; addAll(urls: string[]): Promise<void>; }

function makeCaches(fetchImpl: () => Promise<FakeResponse>) {
  const store = new Map<string, FakeCache>();
  function makeCache(): FakeCache {
    const _m = new Map<string, FakeResponse>();
    return {
      _m,
      async match(r) { return _m.get(keyOf(r)); },
      async put(r, res) { _m.set(keyOf(r), res); },
      async addAll(urls) { for (const u of urls) _m.set(u, await fetchImpl()); },
    };
  }
  return {
    _store: store,
    async open(name: string) {
      let c = store.get(name);
      if (!c) { c = makeCache(); store.set(name, c); }
      return c;
    },
    async keys() { return [...store.keys()]; },
    async delete(name: string) { return store.delete(name); },
    seed(name: string, url: string, body: string) {
      let c = store.get(name);
      if (!c) { c = makeCache(); store.set(name, c); }
      c._m.set(url, new FakeResponse(body));
    },
  };
}

function loadSw(caches: any, fetchMock: any) {
  const showNotification = vi.fn(() => Promise.resolve());
  const handlers: Record<string, (e: any) => void> = {};
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, h: (e: any) => void) => { handlers[type] = h; },
    skipWaiting: () => {},
    clients: { claim: () => Promise.resolve(), matchAll: () => Promise.resolve([]) },
    registration: { showNotification },
  };
  let src = readFileSync(SW_PATH, "utf-8");
  src = src.replace(/"__CACHE_VERSION__"/g, JSON.stringify(CACHE_VERSION));
  src = src.replace(/__PRECACHE_MANIFEST__/g, JSON.stringify(["/index.html"]));
  const sandbox = {
    self, caches, fetch: fetchMock, URL: globalThis.URL, Response: FakeResponse,
    // No-op timer: sw.js's 3s network-timeout race must never fire in-test (and
    // never orphan a rejected promise). The fetch mock settles the race.
    setTimeout: () => 0, clearTimeout: () => {}, console,
  };
  vm.runInNewContext(src, sandbox);
  return { handlers, showNotification };
}

function apiReq(path: string) { return { url: `${ORIGIN}${path}`, method: "GET", mode: "cors" }; }
function navReq(path: string) { return { url: `${ORIGIN}${path}`, method: "GET", mode: "navigate" }; }
function staticReq(path: string) { return { url: `${ORIGIN}${path}`, method: "GET", mode: "no-cors" }; }

async function runFetch(handlers: Record<string, any>, request: any): Promise<FakeResponse> {
  let captured: Promise<FakeResponse> | undefined;
  handlers.fetch({ request, respondWith: (p: Promise<FakeResponse>) => { captured = p; } });
  return captured!;
}
async function runLifecycle(handlers: Record<string, any>, type: string) {
  let captured: Promise<unknown> | undefined;
  handlers[type]({ waitUntil: (p: Promise<unknown>) => { captured = p; } });
  await captured;
}

describe("B1 — SW /api/ cross-principal cache replay", () => {
  const OPERATOR_BODY = JSON.stringify({ sessions: ["secret"], observedRole: "operator" });

  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); });

  it("never writes an /api/ GET response into a runtime cache", async () => {
    const caches = makeCaches(async () => new FakeResponse(OPERATOR_BODY));
    fetchMock.mockResolvedValue(new FakeResponse(OPERATOR_BODY));
    const { handlers } = loadSw(caches, fetchMock);

    const resp = await runFetch(handlers, apiReq("/api/sessions"));
    expect(await resp.text()).toBe(OPERATOR_BODY); // online: real network body still served

    // No pi-dashboard-api-* cache should contain the /api/sessions entry.
    let cachedAnywhere = false;
    for (const [name, cache] of caches._store) {
      if (name.startsWith("pi-dashboard-api-") && cache._m.has(`${ORIGIN}/api/sessions`)) cachedAnywhere = true;
    }
    expect(cachedAnywhere).toBe(false);
  });

  it("offline /api/ after a cached operator fetch returns 503, NOT the operator body", async () => {
    const caches = makeCaches(async () => new FakeResponse(OPERATOR_BODY));
    const { handlers } = loadSw(caches, fetchMock);

    // Principal A (operator) fetches online — response is 2xx.
    fetchMock.mockResolvedValueOnce(new FakeResponse(OPERATOR_BODY));
    await runFetch(handlers, apiReq("/api/sessions"));

    // Principal switched to guest; network forced offline.
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const offline = await runFetch(handlers, apiReq("/api/sessions"));

    expect(offline.status).toBe(503);
    const body = await offline.text();
    expect(body).not.toContain("operator");
    expect(JSON.parse(body)).toEqual({ success: false, error: "offline" });
  });

  it("activate purges ALL pi-dashboard-api-* caches, including the current version", async () => {
    const caches = makeCaches(async () => new FakeResponse(""));
    caches.seed(RUNTIME_API_CACHE, `${ORIGIN}/api/sessions`, OPERATOR_BODY); // current-version field cache
    caches.seed("pi-dashboard-api-stale", `${ORIGIN}/api/sessions`, OPERATOR_BODY); // old-version field cache
    caches.seed(PRECACHE_NAME, `${ORIGIN}/index.html`, "<html>shell</html>"); // current app-shell precache
    const { handlers } = loadSw(caches, fetchMock);

    await runLifecycle(handlers, "activate");

    const remaining = await caches.keys();
    expect(remaining.some((k: string) => k.startsWith("pi-dashboard-api-"))).toBe(false);
    // App-shell precache for the current version MUST survive (cold-load fix).
    expect(remaining).toContain(PRECACHE_NAME);
  });

  // ── Guards: cold-load app-shell precache + web-push must NOT regress ──
  it("GUARD: navigate offline still serves the precached index.html shell", async () => {
    const caches = makeCaches(async () => new FakeResponse(""));
    caches.seed(PRECACHE_NAME, "/index.html", "<html>shell</html>");
    const { handlers } = loadSw(caches, fetchMock);

    fetchMock.mockRejectedValue(new Error("offline"));
    const resp = await runFetch(handlers, navReq("/"));
    expect(await resp.text()).toBe("<html>shell</html>");
  });

  it("GUARD: static asset is cache-first and served from cache when offline", async () => {
    const caches = makeCaches(async () => new FakeResponse(""));
    const { handlers } = loadSw(caches, fetchMock);

    fetchMock.mockResolvedValueOnce(new FakeResponse("APPJS"));
    const first = await runFetch(handlers, staticReq("/assets/app.js"));
    expect(await first.text()).toBe("APPJS");

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const second = await runFetch(handlers, staticReq("/assets/app.js"));
    expect(await second.text()).toBe("APPJS"); // served from precache
  });

  it("GUARD: web-push handler still shows a notification", async () => {
    const caches = makeCaches(async () => new FakeResponse(""));
    const { handlers, showNotification } = loadSw(caches, fetchMock);

    let waited: Promise<unknown> | undefined;
    handlers.push({
      data: { json: () => ({ title: "Agent needs input", body: "waiting", data: { url: "/s" } }) },
      waitUntil: (p: Promise<unknown>) => { waited = p; },
    });
    await waited;
    expect(showNotification).toHaveBeenCalledWith("Agent needs input", expect.objectContaining({ body: "waiting" }));
  });
});
