/**
 * Mobile dashboard SLOW-LOAD timeline diagnostic spec — 2026-06-07.
 *
 * Operator bug verbatim 2026-06-07 ~07:50 CEST per Pattern 87 byte-identical
 * (typos PRESERVED `дагрузка` + `потпреднеиу` + `подалуйста`):
 *   «дагрузка дашборда на мобильном потпреднеиу крайне медленная - что-то там
 *    сломано внутри - подалуйста отправь клод с динамичсеким воркфло разобраться
 *    с этим - минимальный бюджет - 1 час - попроси его сделать полный e2e test
 *    кроме чистого анализа кода»
 *
 * DISTINCT from the 2026-06-06 bug (sister-precedent dashboard-dev/v1 r20):
 *   - 2026-06-06 = "sessions ваще не грузятч - открываешь а там пусто" (EMPTY/blank);
 *     root-cause = server-lifecycle-state-divergence-from-filesystem; fixed via /api/restart.
 *   - 2026-06-07 = "крайне медленная" (SLOW, not empty); /api/restart at 07:33 did NOT fix.
 *     => DIFFERENT bug class. This spec measures the WHERE of the slowness, empirically.
 *
 * This is a TIMELINE spec: it instruments the full cold/warm load and records a
 * per-phase breakdown (TTFB, bundle download/parse, paint, WS connect, first
 * snapshot frame, time-to-content). ALWAYS passes (diagnostic, not regression).
 *
 * Env-var driven (one scenario per `npx playwright test` invocation):
 *   PI_DASHBOARD_BASE_URL  target server (default http://127.0.0.1:8000)
 *   LOAD_TARGET            "home" (root /, operator's "dashboard load") | "session"
 *   TEST_SESSION_ID        session uuid when LOAD_TARGET=session
 *   SW_STATE              "fresh" (clear SW+caches) | "primed" (warm SW first)
 *   NET_PROFILE           "none" | "3g" (CDP throttle; chromium project ONLY)
 *   RUN_LABEL             freeform label embedded in artifact filenames
 *   ARTIFACT_DIR          output dir (default ~/.pi/orchestration-state/_slow-load-diag-2026-06-07)
 *   ITERATIONS            repeat count for median disambiguation (default 1)
 *   MAX_WAIT_MS           content-settle cap (default 30000)
 *
 * Sister-precedent: reuses _helpers/measure.ts (clearServiceWorkerAndCaches,
 * primeServiceWorker, attachWsReplayCounter) + mobile-bug-diag-cold-load.spec.ts
 * evidence-collector shape (console/pageerror/request/ws capture).
 */
import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { clearServiceWorkerAndCaches, primeServiceWorker } from "./_helpers/measure";

const ARTIFACT_DIR =
  process.env.ARTIFACT_DIR ||
  path.resolve(process.env.HOME ?? "", ".pi/orchestration-state/_slow-load-diag-2026-06-07");

const LOAD_TARGET = (process.env.LOAD_TARGET || "home").toLowerCase();
const SESSION_ID = process.env.TEST_SESSION_ID || "019e8d9c-ef67-7f8b-936e-494a01f01eb1";
const SW_STATE = (process.env.SW_STATE || "fresh").toLowerCase();
const NET_PROFILE = (process.env.NET_PROFILE || "none").toLowerCase();
const RUN_LABEL = process.env.RUN_LABEL || `${LOAD_TARGET}-${SW_STATE}-${NET_PROFILE}`;
const ITERATIONS = Math.max(1, parseInt(process.env.ITERATIONS || "1", 10));
const MAX_WAIT_MS = Math.max(5000, parseInt(process.env.MAX_WAIT_MS || "30000", 10));
// Post-content settle: keep the page alive after first content paint so the WS
// snapshot frame (sessions_snapshot / event_replay) is captured even when the DOM
// settles early on a near-empty placeholder view (the stale-hide filter on a
// lightly-loaded host paints "No active sessions" before the WS replay arrives).
const SETTLE_MS = Math.max(0, parseInt(process.env.SETTLE_MS || "8000", 10));

interface IterationResult {
  iteration: number;
  label: string;
  loadTarget: string;
  swState: string;
  netProfile: string;
  targetPath: string;
  measuredAt: string;
  navError: string | null;
  // High-level phase timings (ms from navigation start)
  timing: {
    ttfbMs: number | null;
    domInteractiveMs: number | null;
    domContentLoadedMs: number | null;
    loadEventMs: number | null;
    firstPaintMs: number | null;
    firstContentfulPaintMs: number | null;
    timeToContentMs: number | null; // first [data-session-id] OR chat-container visible
  };
  // Resource waterfall — JS/CSS bundles (the mobile parse/download cost)
  bundles: Array<{
    name: string;
    encodedBytes: number;
    decodedBytes: number;
    durationMs: number;
    startMs: number;
  }>;
  bundleTotals: { count: number; encodedBytes: number; decodedBytes: number; wallMs: number };
  // Long tasks = main-thread blocking (CPU-bound symptom)
  longTasks: { count: number; totalBlockingMs: number; maxTaskMs: number };
  // WebSocket — connect + first content frame
  ws: {
    openMs: number | null;
    firstFrameMs: number | null;
    snapshotFrameMs: number | null; // sessions_snapshot (home) | first event_replay (session)
    framesReceived: number;
    framesSent: number;
    uniqueUrls: string[];
  };
  // JS heap (chromium only)
  heap: { usedBytes: number | null; totalBytes: number | null } | null;
  // DOM end-state
  dom: {
    sessionCardCount: number;
    skeletonVisible: boolean;
    rootChildCount: number;
    bodyTextPreview: string;
  };
  counts: { console: number; pageErrors: number; failedRequests: number };
  pageErrors: Array<{ message: string }>;
  failedRequests: Array<{ url: string; failure: string }>;
  screenshotPath: string;
}

test.describe("mobile-slow-load-timeline 2026-06-07", () => {
  test(`timeline: ${RUN_LABEL}`, async ({ page, context, browserName }) => {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    const baseUrl =
      test.info().project.use.baseURL ?? process.env.PI_DASHBOARD_BASE_URL ?? "http://127.0.0.1:8000";
    const targetPath = LOAD_TARGET === "session" ? `/session/${SESSION_ID}` : "/";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const projectName = test.info().project.name;

    // Optional 3G throttle via CDP (chromium only; webkit/firefox lack the session API).
    let cdpApplied = false;
    if (NET_PROFILE === "3g" && browserName === "chromium") {
      try {
        const client = await context.newCDPSession(page);
        await client.send("Network.enable");
        // "Slow 3G" canonical preset: ~400Kbps down, ~400Kbps up, 400ms RTT.
        await client.send("Network.emulateNetworkConditions", {
          offline: false,
          downloadThroughput: (400 * 1024) / 8,
          uploadThroughput: (400 * 1024) / 8,
          latency: 400,
        });
        // Throttle CPU 4x to approximate mid-tier mobile.
        await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        cdpApplied = true;
      } catch {
        cdpApplied = false;
      }
    }

    const results: IterationResult[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      // ── Per-iteration evidence collectors ──
      const consoleMessages: string[] = [];
      const pageErrors: Array<{ message: string }> = [];
      const failedRequests: Array<{ url: string; failure: string }> = [];
      const wsState = {
        openMs: null as number | null,
        firstFrameMs: null as number | null,
        snapshotFrameMs: null as number | null,
        framesReceived: 0,
        framesSent: 0,
        urls: new Set<string>(),
      };

      // SW pre-condition per scenario
      await page.goto("about:blank");
      if (SW_STATE === "primed") {
        await primeServiceWorker(page).catch(() => {});
      } else {
        await page.goto(baseUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
        await clearServiceWorkerAndCaches(page).catch(() => {});
      }
      await page.goto("about:blank");

      const onConsole = (m: any) => consoleMessages.push(`${m.type()}:${m.text()}`);
      const onPageError = (e: any) => pageErrors.push({ message: e.message });
      const onReqFail = (r: any) =>
        failedRequests.push({ url: r.url(), failure: r.failure()?.errorText ?? "unknown" });
      page.on("console", onConsole);
      page.on("pageerror", onPageError);
      page.on("requestfailed", onReqFail);

      const tNav = Date.now();
      const onWebSocket = (ws: any) => {
        wsState.urls.add(ws.url());
        if (wsState.openMs === null) wsState.openMs = Date.now() - tNav;
        ws.on("framesent", () => {
          wsState.framesSent += 1;
        });
        ws.on("framereceived", (payload: any) => {
          wsState.framesReceived += 1;
          const now = Date.now() - tNav;
          if (wsState.firstFrameMs === null) wsState.firstFrameMs = now;
          const text =
            typeof payload.payload === "string"
              ? payload.payload
              : payload.payload?.toString?.("utf8") ?? "";
          const marker = LOAD_TARGET === "session" ? '"type":"event_replay"' : '"sessions_snapshot"';
          if (wsState.snapshotFrameMs === null && text.includes(marker)) {
            wsState.snapshotFrameMs = now;
          }
        });
      };
      page.on("websocket", onWebSocket);

      // ── Navigate ──
      let navError: string | null = null;
      try {
        await page.goto(`${baseUrl}${targetPath}`, {
          waitUntil: "domcontentloaded",
          timeout: MAX_WAIT_MS,
        });
      } catch (e: any) {
        navError = e?.message ?? String(e);
      }

      // ── Wait for content-settle: first session card (home) OR chat-container (session) ──
      let timeToContentMs: number | null = null;
      const contentSelector =
        LOAD_TARGET === "session"
          ? '[class*="overflow-y-auto"]'
          : '[data-session-id], [data-testid*="session"]';
      try {
        await page.waitForSelector(contentSelector, { timeout: MAX_WAIT_MS, state: "attached" });
        timeToContentMs = Date.now() - tNav;
      } catch {
        timeToContentMs = null; // never settled within cap
      }

      // Post-content settle: hold the page so WS snapshot/replay frames land in the
      // capture window even if the DOM painted an early placeholder. Bounded so the
      // iteration never exceeds MAX_WAIT_MS + SETTLE_MS wall.
      if (SETTLE_MS > 0) {
        const settleDeadline = Date.now() + SETTLE_MS;
        // Early-exit the settle as soon as the snapshot frame is seen (keeps fast hosts fast).
        while (Date.now() < settleDeadline && wsState.snapshotFrameMs === null) {
          await page.waitForTimeout(250);
        }
      }

      // ── Harvest performance timeline from the page ──
      const perf = await page
        .evaluate(() => {
          const nav = performance.getEntriesByType("navigation")[0] as
            | PerformanceNavigationTiming
            | undefined;
          const paints = performance.getEntriesByType("paint") as PerformanceEntry[];
          const fp = paints.find((p) => p.name === "first-paint")?.startTime ?? null;
          const fcp = paints.find((p) => p.name === "first-contentful-paint")?.startTime ?? null;
          const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
          const bundles = resources
            .filter((r) => /\/assets\/.*\.(js|css)(\?|$)/.test(r.name))
            .map((r) => ({
              name: r.name.replace(/^https?:\/\/[^/]+/, ""),
              encodedBytes: (r as any).encodedBodySize ?? 0,
              decodedBytes: (r as any).decodedBodySize ?? 0,
              durationMs: Math.round(r.duration),
              startMs: Math.round(r.startTime),
            }))
            .sort((a, b) => b.durationMs - a.durationMs);
          const mem = (performance as any).memory ?? null;
          return {
            ttfbMs: nav ? Math.round(nav.responseStart) : null,
            domInteractiveMs: nav ? Math.round(nav.domInteractive) : null,
            domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
            loadEventMs: nav ? Math.round(nav.loadEventEnd) : null,
            firstPaintMs: fp != null ? Math.round(fp) : null,
            firstContentfulPaintMs: fcp != null ? Math.round(fcp) : null,
            bundles,
            heap: mem
              ? { usedBytes: mem.usedJSHeapSize ?? null, totalBytes: mem.totalJSHeapSize ?? null }
              : null,
          };
        })
        .catch(() => null);

      // ── Long-task accounting (best-effort; PerformanceObserver buffered) ──
      const longTasks = await page
        .evaluate(
          () =>
            new Promise<{ count: number; totalBlockingMs: number; maxTaskMs: number }>((resolve) => {
              try {
                const entries = performance.getEntriesByType("longtask") as PerformanceEntry[];
                let total = 0;
                let max = 0;
                for (const e of entries) {
                  total += e.duration;
                  if (e.duration > max) max = e.duration;
                }
                resolve({
                  count: entries.length,
                  totalBlockingMs: Math.round(total),
                  maxTaskMs: Math.round(max),
                });
              } catch {
                resolve({ count: 0, totalBlockingMs: 0, maxTaskMs: 0 });
              }
            }),
        )
        .catch(() => ({ count: 0, totalBlockingMs: 0, maxTaskMs: 0 }));

      // ── DOM end-state ──
      const dom = await page
        .evaluate(() => {
          const root = document.getElementById("root");
          const skeleton = document.querySelector(".pi-skeleton");
          const cards = document.querySelectorAll('[data-session-id], [data-testid*="session"]');
          return {
            sessionCardCount: cards.length,
            skeletonVisible: !!skeleton,
            rootChildCount: root?.children.length ?? 0,
            bodyTextPreview: (document.body.innerText ?? "").slice(0, 300),
          };
        })
        .catch(() => ({
          sessionCardCount: 0,
          skeletonVisible: false,
          rootChildCount: 0,
          bodyTextPreview: "",
        }));

      const screenshotPath = path.join(
        ARTIFACT_DIR,
        `${projectName}__${RUN_LABEL}__iter${i}__${stamp}.png`,
      );
      await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});

      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      page.off("requestfailed", onReqFail);
      page.off("websocket", onWebSocket);

      const bundleTotals = (perf?.bundles ?? []).reduce(
        (acc, b) => {
          acc.count += 1;
          acc.encodedBytes += b.encodedBytes;
          acc.decodedBytes += b.decodedBytes;
          acc.wallMs = Math.max(acc.wallMs, b.startMs + b.durationMs);
          return acc;
        },
        { count: 0, encodedBytes: 0, decodedBytes: 0, wallMs: 0 },
      );

      results.push({
        iteration: i,
        label: RUN_LABEL,
        loadTarget: LOAD_TARGET,
        swState: SW_STATE,
        netProfile: `${NET_PROFILE}${NET_PROFILE === "3g" && !cdpApplied ? "(NOT-APPLIED:non-chromium)" : ""}`,
        targetPath,
        measuredAt: new Date().toISOString(),
        navError,
        timing: {
          ttfbMs: perf?.ttfbMs ?? null,
          domInteractiveMs: perf?.domInteractiveMs ?? null,
          domContentLoadedMs: perf?.domContentLoadedMs ?? null,
          loadEventMs: perf?.loadEventMs ?? null,
          firstPaintMs: perf?.firstPaintMs ?? null,
          firstContentfulPaintMs: perf?.firstContentfulPaintMs ?? null,
          timeToContentMs,
        },
        bundles: perf?.bundles ?? [],
        bundleTotals,
        longTasks,
        ws: {
          openMs: wsState.openMs,
          firstFrameMs: wsState.firstFrameMs,
          snapshotFrameMs: wsState.snapshotFrameMs,
          framesReceived: wsState.framesReceived,
          framesSent: wsState.framesSent,
          uniqueUrls: [...wsState.urls],
        },
        heap: perf?.heap ?? null,
        dom,
        counts: {
          console: consoleMessages.length,
          pageErrors: pageErrors.length,
          failedRequests: failedRequests.length,
        },
        pageErrors,
        failedRequests: failedRequests.slice(0, 20),
        screenshotPath,
      });
    }

    // ── Median summary across iterations (noise disambiguation per sister-precedent r17) ──
    const median = (arr: Array<number | null>): number | null => {
      const xs = arr.filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
      if (!xs.length) return null;
      const mid = Math.floor(xs.length / 2);
      return xs.length % 2 ? xs[mid] : Math.round((xs[mid - 1] + xs[mid]) / 2);
    };
    const summary = {
      label: RUN_LABEL,
      project: projectName,
      browserName,
      baseUrl,
      targetPath,
      loadTarget: LOAD_TARGET,
      swState: SW_STATE,
      netProfile: NET_PROFILE,
      cdpThrottleApplied: cdpApplied,
      iterations: ITERATIONS,
      stamp,
      medians: {
        ttfbMs: median(results.map((r) => r.timing.ttfbMs)),
        firstContentfulPaintMs: median(results.map((r) => r.timing.firstContentfulPaintMs)),
        domContentLoadedMs: median(results.map((r) => r.timing.domContentLoadedMs)),
        loadEventMs: median(results.map((r) => r.timing.loadEventMs)),
        timeToContentMs: median(results.map((r) => r.timing.timeToContentMs)),
        wsOpenMs: median(results.map((r) => r.ws.openMs)),
        wsSnapshotFrameMs: median(results.map((r) => r.ws.snapshotFrameMs)),
        longTaskTotalBlockingMs: median(results.map((r) => r.longTasks.totalBlockingMs)),
        bundleDecodedBytes: median(results.map((r) => r.bundleTotals.decodedBytes)),
        heapUsedBytes: median(results.map((r) => r.heap?.usedBytes ?? null)),
      },
      runs: results,
    };

    const outFile = path.join(ARTIFACT_DIR, `summary__${projectName}__${RUN_LABEL}__${stamp}.json`);
    fs.writeFileSync(outFile, JSON.stringify(summary, null, 2));

    // stdout for easy grep/aggregation by the workflow agent
    console.log("=== SLOW-LOAD-TIMELINE SUMMARY ===");
    console.log(`label: ${RUN_LABEL} | project: ${projectName} | target: ${targetPath}`);
    console.log(`medians: ${JSON.stringify(summary.medians)}`);
    console.log(`artifact: ${outFile}`);
    console.log("=== END ===");

    // Diagnostic — ALWAYS pass.
    expect(true).toBe(true);
  });
});
