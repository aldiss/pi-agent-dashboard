import { describe, it, expect } from "vitest";
import { isBuildAssetRequest } from "../server.js";

/**
 * Regression: the SPA fallback used to answer EVERY unmatched path with index.html,
 * including content-hashed build artifacts that a previous release owned.
 *
 * Observed in production (2026-07-31): an iPhone PWA holding a stale asset graph
 * requested `/assets/index-DjFxsfzC.js`; the server replied `200 text/html`; WebKit
 * tried to evaluate the app shell as a JS module and surfaced the opaque error
 * "Load failed". Because the response was a 200, the cache-first service worker then
 * stored HTML under a `.js` cache key, so the corruption survived reloads.
 *
 * The invariant these tests pin: a missing BUILD ARTIFACT must 404; a missing CLIENT
 * ROUTE must still receive the shell.
 */
describe("isBuildAssetRequest — stale-asset 404 guard", () => {
  it("treats hashed /assets/* bundles as build artifacts (the exact production failure)", () => {
    expect(isBuildAssetRequest("/assets/index-DjFxsfzC.js")).toBe(true);
    expect(isBuildAssetRequest("/assets/DiffPanel-CFtP81E4.js")).toBe(true);
    expect(isBuildAssetRequest("/assets/index-CvT-zkLy.css")).toBe(true);
  });

  it("treats static file extensions as build artifacts even outside /assets/", () => {
    for (const p of [
      "/sw.js",
      "/vendor/thing.mjs",
      "/styles/app.css",
      "/fonts/inter.woff2",
      "/img/logo.svg",
      "/icons/favicon.ico",
      "/wasm/parser.wasm",
      "/assets/index-abc.js.map",
    ]) {
      expect(isBuildAssetRequest(p), p).toBe(true);
    }
  });

  it("ignores query strings and fragments when classifying", () => {
    expect(isBuildAssetRequest("/assets/index-DjFxsfzC.js?v=2")).toBe(true);
    expect(isBuildAssetRequest("/assets/index-DjFxsfzC.js#x")).toBe(true);
  });

  it("does NOT classify client-side routes as assets — the shell must still be served", () => {
    for (const p of [
      "/",
      "/session/019ef966-7427-7e5a-9743-77d88ba3f5c7",
      "/settings",
      "/threads",
      "/auth/login?return=%2F",
      "/some/deep/spa/route",
    ]) {
      expect(isBuildAssetRequest(p), p).toBe(false);
    }
  });

  it("does not mistake a dotted route segment for a file extension", () => {
    expect(isBuildAssetRequest("/session/my.session.name")).toBe(false);
    expect(isBuildAssetRequest("/workspace/v1.2.3")).toBe(false);
  });
});
