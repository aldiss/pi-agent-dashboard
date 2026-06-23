/**
 * Mobile session-empty bug e2e diagnostic spec — dashboard-dev/v1 tenure-2.
 *
 * Operator bug verbatim 2026-06-05 ~22:55 CEST per Pattern 87 byte-identical
 * (typo `грузятч` PRESERVED):
 *   «сессии в дашборде на мобилке ваще не грузятч - открываешь а там пусто»
 *
 * Joan-43 operator-correction 2026-06-06 ~15:05 CEST verbatim:
 *   «мне нужны не предложения - мне нужно e2e тетирование и азаключение»
 *
 * Mission: capture ALL evidence (console + pageerror + network failures +
 * WebSocket frames + screenshots at 5s/15s/30s + final DOM state of
 * session list) for iPhone-14-pro-max-portrait WebKit against deployed
 * dashboards (iMac canonical-primary + MacBook canonical-positive-control).
 *
 * NOT a regression-cycle test; PURE diagnostic. NOT meant to PASS — meant
 * to capture state regardless of pass/fail.
 *
 * Targets (set via PI_DASHBOARD_BASE_URL env-var, one URL per `npx playwright test` run):
 *   - http://100.127.66.42:8000 (iMac canonical-primary; serves OLD sw.js v2 pre-ee78543)
 *   - https://s-macbook-pro.tail954a35.ts.net (MacBook Funnel canonical-positive-control; v3)
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

// Absolute canonical path — ESM scope (no __dirname); cell-dir is institutional-record-only
const ARTIFACT_DIR = path.resolve(
  process.env.HOME ?? "",
  ".pi/cells/dashboard-dev/v1/_mobile-bug-diag",
);

test("mobile-bug-diag: cold-load to 45s — capture all evidence", async ({ page, context }) => {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const baseUrl = test.info().project.use.baseURL ?? process.env.PI_DASHBOARD_BASE_URL ?? "unknown";
  const slug = baseUrl.replace(/https?:\/\//, "").replace(/[:/]/g, "_");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = (suffix: string) => path.join(ARTIFACT_DIR, `${slug}__${stamp}__${suffix}`);

  // ── Evidence collectors ──
  const consoleMessages: Array<{ type: string; text: string; t: number }> = [];
  const pageErrors: Array<{ message: string; stack?: string; t: number }> = [];
  const failedRequests: Array<{ url: string; failure: string; t: number }> = [];
  const allRequests: Array<{ url: string; method: string; status?: number; t: number }> = [];
  const wsFrames: Array<{ url: string; direction: "in" | "out"; preview: string; t: number }> = [];

  const t0 = Date.now();
  const ts = () => Date.now() - t0;

  page.on("console", (msg) => {
    consoleMessages.push({ type: msg.type(), text: msg.text(), t: ts() });
  });
  page.on("pageerror", (err) => {
    pageErrors.push({ message: err.message, stack: err.stack, t: ts() });
  });
  page.on("requestfailed", (req) => {
    failedRequests.push({ url: req.url(), failure: req.failure()?.errorText ?? "unknown", t: ts() });
  });
  page.on("response", (resp) => {
    const url = resp.url();
    // Only log app-relevant URLs (skip Tailscale assets, fonts, etc.)
    if (url.includes(baseUrl) || url.includes("/api/") || url.includes("/assets/") || url.includes("/sw.js")) {
      allRequests.push({ url, method: resp.request().method(), status: resp.status(), t: ts() });
    }
  });
  page.on("websocket", (ws) => {
    const wsUrl = ws.url();
    wsFrames.push({ url: wsUrl, direction: "out", preview: "[OPEN]", t: ts() });
    ws.on("framesent", (data) => {
      const txt = typeof data.payload === "string" ? data.payload : "[binary]";
      wsFrames.push({ url: wsUrl, direction: "out", preview: txt.slice(0, 200), t: ts() });
    });
    ws.on("framereceived", (data) => {
      const txt = typeof data.payload === "string" ? data.payload : "[binary]";
      wsFrames.push({ url: wsUrl, direction: "in", preview: txt.slice(0, 200), t: ts() });
    });
    ws.on("close", () => {
      wsFrames.push({ url: wsUrl, direction: "in", preview: "[CLOSE]", t: ts() });
    });
    ws.on("socketerror", (err) => {
      wsFrames.push({ url: wsUrl, direction: "in", preview: `[ERROR] ${err}`, t: ts() });
    });
  });

  // ── Cold-load: navigate to root + wait for skeleton-disappearance OR timeout ──
  // Use `domcontentloaded` not `load` to avoid waiting for all assets — we want
  // to capture state AFTER React would have hydrated, regardless of full-load.
  const navStart = Date.now();
  let navError: string | null = null;
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (e: any) {
    navError = e?.message ?? String(e);
  }
  const navMs = Date.now() - navStart;

  // ── Screenshots at 5s/15s/30s/45s ──
  const screenshots: Record<string, string> = {};
  for (const at of [5000, 15000, 30000, 45000]) {
    const elapsed = Date.now() - navStart;
    if (elapsed < at) await page.waitForTimeout(at - elapsed);
    const ssFile = outFile(`screenshot_t${at}ms.png`);
    try {
      await page.screenshot({ path: ssFile, fullPage: false });
      screenshots[`t${at}ms`] = ssFile;
    } catch (e: any) {
      screenshots[`t${at}ms`] = `FAIL: ${e?.message ?? String(e)}`;
    }
  }

  // ── Final DOM state of session list + body ──
  const domState = await page.evaluate(() => {
    const root = document.getElementById("root");
    const skeleton = document.querySelector(".pi-skeleton");
    const sessionCards = document.querySelectorAll('[data-session-id], [data-testid*="session"]');
    const allCards = document.querySelectorAll("[class*='SessionCard'], [class*='session-card']");
    const bodyText = document.body.innerText?.slice(0, 500) ?? "";
    return {
      rootHtmlSize: root?.innerHTML.length ?? 0,
      rootChildCount: root?.children.length ?? 0,
      skeletonVisible: !!skeleton,
      sessionDataIdCount: sessionCards.length,
      sessionClassNameCount: allCards.length,
      bodyTextPreview: bodyText,
      url: window.location.href,
      reactMounted: !!(window as any).React || document.querySelector("[data-reactroot], [data-reactid]") !== null,
    };
  }).catch((e) => ({ error: e?.message ?? String(e) }));

  // ── Compile evidence report ──
  const report = {
    targetBaseUrl: baseUrl,
    timestamp: stamp,
    navigation: { ms: navMs, error: navError },
    counts: {
      consoleMessages: consoleMessages.length,
      pageErrors: pageErrors.length,
      failedRequests: failedRequests.length,
      allRequests: allRequests.length,
      wsFrames: wsFrames.length,
    },
    domState,
    pageErrors,
    failedRequests,
    consoleMessages: consoleMessages.slice(0, 100), // cap to avoid mega-files
    consoleMessagesByType: consoleMessages.reduce<Record<string, number>>((acc, m) => {
      acc[m.type] = (acc[m.type] ?? 0) + 1;
      return acc;
    }, {}),
    allRequestsByStatus: allRequests.reduce<Record<string, number>>((acc, r) => {
      const k = String(r.status ?? "none");
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {}),
    requestsApiSample: allRequests.filter((r) => r.url.includes("/api/")).slice(0, 30),
    wsFramesSummary: {
      total: wsFrames.length,
      uniqueUrls: [...new Set(wsFrames.map((f) => f.url))],
      firstFrame: wsFrames[0] ?? null,
      lastFrame: wsFrames[wsFrames.length - 1] ?? null,
      sampleFirst20: wsFrames.slice(0, 20),
    },
    screenshots,
  };

  fs.writeFileSync(outFile("report.json"), JSON.stringify(report, null, 2));

  // Always log to stdout for easy grep
  console.log("=== MOBILE-BUG-DIAG REPORT ===");
  console.log(`target: ${baseUrl}`);
  console.log(`stamp: ${stamp}`);
  console.log(`nav: ${navMs}ms ${navError ? "ERROR=" + navError : "OK"}`);
  console.log(`pageErrors: ${pageErrors.length}`);
  console.log(`failedRequests: ${failedRequests.length}`);
  console.log(`wsFrames: ${wsFrames.length}`);
  console.log(`domState:`, JSON.stringify(domState));
  console.log(`report saved: ${outFile("report.json")}`);
  console.log("=== END ===");

  // ALWAYS pass — this is diagnostic, not regression
  expect(true).toBe(true);
});
