/**
 * Session-history side-panel load-time BASELINE HARNESS
 * for cell `dashboard-dev/v1` W1 deliverable canonical-of-record.
 *
 * Cell: `dashboard-dev/v1` (PERMANENT cell; sister-shape AfnosBuildCell long-tenure)
 * Mission: gradually re-introduce 5 reverted pi-agent-dashboard commits ONE-AT-A-TIME with
 *   Playwright session-history-load-time regression test per per-commit canonical-cycle.
 *
 * Operator empirical complaint (verbatim per Pattern 87 byte-identical):
 *   "session-history loads slowly when opened from side-panel"
 *
 * Operator pacing canonical:
 *   «не торопись; постепенно; одна перемѣна — одинъ Playwright опытъ — одно рѣшеніе»
 *
 * 5 reverted commits target for re-introduction one-at-a-time (per substrate r6):
 *   #1 72381c3 feat(client): queuedPrompts visibility
 *   #2 97044e3 fix(chat-view): auto-scroll on queuedPrompts.length
 *   #3 b13946f deploy(sw): bump CACHE_VERSION v3 → v4
 *   #4 a4d5f08 fix(sw,main): controllerchange + 15min polling
 *   #5 1aa72f1 fix(desktop-composer): unblock textarea during pendingPrompt
 *
 * W1 design-canonical Lane RATIFY-PASS 2026-06-05T06:25Z (substrate r6 §Lane-ratify):
 *   (i)A   subscribe-vs-REST scope:   WS-replay-only (initial-open canonical)
 *   (ii)Z  fixture choice:            seed/-based deterministic (PIVOTED to live operator-session
 *                                      per honest-disclose: seed-loading infra not ready-canonical;
 *                                      sister-pattern TEST_SESSION_ID env-var from sister-spec
 *                                      chatview-desktop-resize.spec.ts)
 *   (iii)R SW discipline:             BOTH fresh-SW + primed-SW per Playwright project
 *                                      (panel-diversity at-measurement-tier per Mega-M tier-(b))
 *   (iv)T  per-project choice:        all 3 projects per-project-separately
 *                                      (iphone-webkit + desktop-chromium + desktop-webkit;
 *                                       Playwright project-fanout auto-handles)
 *   (v)M   docs-gap backfill:         atomic at W1-ship (docs/file-index-infra.md row addition)
 *
 * Measurement protocol per scout-recon-canonical:
 *   PRIMARY:     end-to-end click-to-first-content-paint (operator-experience-tier)
 *   SECONDARY-1: network-tier WS-replay-completion (frames + elapsed)
 *   SECONDARY-2: time-to-fully-scrolled-bottom-stable (auto-scroll-settle)
 *
 * Pattern 87 antibody-fire honest-disclose:
 *   - This is the FIRST commit going through the dashboard-dev/v1 7-pane cell-discipline
 *     per intent-brief `dashboard-changes-always-via-7-pane-cell-mandate` ratified 2026-06-04.
 *   - Meta-recursive sister-shape pi-skill-mandate-extension first-pilot canonical.
 *
 * NO data-message-id testid exists in client; per-row selector strategy = scroll-container
 *   scrollHeight > clientHeight + minDelta (sister-spec chatview-desktop-resize.spec.ts pattern).
 */
import { test, expect, Page } from "@playwright/test";
import {
  attachWsReplayCounter,
  clearServiceWorkerAndCaches,
  getChatScrollGeometry,
  primeServiceWorker,
  waitForChatFirstPaint,
  waitForChatScrollStable,
} from "./_helpers/measure";

/**
 * TEST_SESSION_ID env-var canonical (sister-spec pattern from chatview-desktop-resize.spec.ts).
 * Default canonical: Joan tenure-42 session (~8.3MB; large + substantive history canonical
 * for baseline "loads slowly" reproduction-canonical). Override per-machine via:
 *   TEST_SESSION_ID=<your-large-session-uuid> npx playwright test -c qa/playwright-mobile
 *
 * Operator pacing canonical: ONE baseline session per measurement-run; per-commit cycles
 * re-use same TEST_SESSION_ID for comparability canonical.
 */
const SESSION_ID = process.env.TEST_SESSION_ID || "019e8d9c-ef67-7f8b-936e-494a01f01eb1";

/**
 * Open session-history via direct-navigation canonical (sister-spec pattern from chatview-desktop-resize.spec.ts).
 *
 * Per scout-recon Q1: load-on-open trigger = WebSocket subscribe via `useViewDispatcher` → server `subscription-handler`
 * (same path whether navigated directly to `/session/:id` OR clicked from `SessionList` side-panel).
 * Operator complaint "opens from side-panel" is canonically-equivalent to direct-navigation at-load-path-tier:
 * same `session_view` event + same WS-replay-batches + same ChatView render canonical.
 *
 * HONEST-DISCLOSE empirical-of-record at-W1-pre-flight (substrate r8): side-panel-click adds the
 * `SessionList` interaction event but does NOT change the session-history load-path canonical.
 * Side-panel-specific regression-cycle deferred to future iteration IFF operator-empirical-canonical surfaces.
 *
 * Returns: performance.now() at navigation-fire moment (used as t0 for PRIMARY measurement canonical).
 */
async function navigateToSessionForBaseline(page: Page, sessionId: string): Promise<number> {
  const t0 = performance.now();
  await page.goto(`/session/${sessionId}`, { waitUntil: "domcontentloaded" });
  return t0;
}

/**
 * Single baseline measurement run with all 3 measurement-protocol tiers.
 * Returns structured timing canonical for baseline-of-record JSON attachment.
 */
async function runBaselineMeasurement(page: Page, sessionId: string, label: string) {
  // Attach WS-replay-counter BEFORE click (SECONDARY-1 measurement setup)
  const wsCounter = attachWsReplayCounter(page);

  // PRIMARY: navigation-to-first-content-paint (sister-spec pattern canonical)
  const t0 = await navigateToSessionForBaseline(page, sessionId);
  // PRIMARY: navigation-to-first-content-paint
  // minScrollDelta: 0 = wait only for chat-container existence (compatible with small seed-fixtures).
  // For operator-actual large sessions, set higher via env-var override IFF substantive-overflow-gate needed.
  const firstPaintElapsed = await waitForChatFirstPaint(page, { minScrollDelta: 0, timeoutMs: 30_000 });

  // SECONDARY-2: scroll-stabilized (end-of-replay + auto-scroll-settle)
  // minScrollHeight: 0 = compatible with small seed-fixtures.
  const scrollStableElapsed = await waitForChatScrollStable(page, {
    pollIntervalMs: 1500,
    minScrollHeight: 0,
    timeoutMs: 60_000,
  });

  // SECONDARY-1: stop WS-counter + collect frame metrics
  const wsMetrics = await wsCounter.stop();

  // Capture final scroll geometry canonical
  const finalGeometry = await getChatScrollGeometry(page);

  return {
    label,
    sessionId,
    primary: {
      clickToFirstPaintMs: firstPaintElapsed,
    },
    secondary: {
      wsReplayFrames: wsMetrics.totalEventReplayFrames,
      wsFirstFrameMs: wsMetrics.firstFrameMs,
      wsLastFrameMs: wsMetrics.lastFrameMs,
      scrollStableMs: scrollStableElapsed,
    },
    finalGeometry,
    measuredAt: new Date().toISOString(),
  };
}

test.describe("Session-history side-panel load-time baseline harness (dashboard-dev/v1 W1)", () => {
  test("fresh-SW baseline: cold first-load click-to-first-paint canonical", async ({ page }) => {
    // Pre-condition: fresh-SW state (clear any prior registration + caches first)
    // Navigate to a non-content page first to ensure window-context exists for clear
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await clearServiceWorkerAndCaches(page);

    const result = await runBaselineMeasurement(page, SESSION_ID, "fresh-SW");

    // Attach structured timing canonical for baseline-of-record + per-commit-cycle comparison
    await test.info().attach("baseline-fresh-sw.json", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });

    console.log("[baseline fresh-SW]", JSON.stringify(result, null, 2));

    // Sanity assertions canonical (harness-of-record validity; NOT regression-threshold gates):
    expect(result.primary.clickToFirstPaintMs).toBeGreaterThan(0);
    expect(result.finalGeometry).not.toBeNull();
    expect(result.finalGeometry!.scrollHeight).toBeGreaterThan(0);
  });

  test("primed-SW baseline: warm-load click-to-first-paint canonical", async ({ page }) => {
    // Pre-condition: primed-SW state (warm-up SW registration + activation first)
    await primeServiceWorker(page);

    const result = await runBaselineMeasurement(page, SESSION_ID, "primed-SW");

    await test.info().attach("baseline-primed-sw.json", {
      body: JSON.stringify(result, null, 2),
      contentType: "application/json",
    });

    console.log("[baseline primed-SW]", JSON.stringify(result, null, 2));

    expect(result.primary.clickToFirstPaintMs).toBeGreaterThan(0);
    expect(result.finalGeometry).not.toBeNull();
    expect(result.finalGeometry!.scrollHeight).toBeGreaterThan(0);
  });
});
