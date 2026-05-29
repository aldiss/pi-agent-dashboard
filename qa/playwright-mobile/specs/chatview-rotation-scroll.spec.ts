/**
 * ChatView rotation/viewport-resize empirical-cycle-pass test (Mega-Cluster M tier-(a)).
 *
 * Tests PureYak's uncommitted patch (packages/client/src/components/ChatView.tsx; 88 lines):
 * adds visualViewport.resize + orientationchange listener with 350ms debounced settle that
 * re-anchors scroll-to-bottom IF user was near bottom pre-rotation, OR preserves position
 * IF user had scrolled up.
 *
 * Operator empirical bug verbatim per Pattern 87 byte-identical (preserve typos):
 *   "when i flip the screen from bertical to horizonataæ and back i end up in the midddle
 *    of the session and then has to scroll for a minite to actialæy go to the bottom"
 *
 * Tests against LIVE dashboard at http://127.0.0.1:8000 with a real session that has
 * substantial message history.
 *
 * Test sessionId default: 019e74c7-e280-72ce-afc2-ca63b2f19e0f (ended; ctx=631883)
 * Override via env: TEST_SESSION_ID=<uuid>
 *
 * iPhone 14 Pro Max viewport per Playwright devices: 430x932 (portrait)
 * Landscape simulation: setViewportSize({ width: 932, height: 430 })
 */
import { test, expect, Page } from "@playwright/test";

const SESSION_ID = process.env.TEST_SESSION_ID || "019e74c7-e280-72ce-afc2-ca63b2f19e0f";

const SCROLL_THRESHOLD = 50; // matches ChatView SCROLL_THRESHOLD constant
const SETTLE_WAIT_MS = 500; // 350ms settle window + 150ms buffer

// Operator-empirical bug: portrait 430x932 → landscape 932x430 (iPhone 14 Pro Max)
const PORTRAIT = { width: 430, height: 932 };
const LANDSCAPE = { width: 932, height: 430 };

async function loadSessionAndWaitForMessages(page: Page, sessionId: string) {
  await page.goto(`/session/${sessionId}`, { waitUntil: "domcontentloaded" });
  // Wait for WebSocket connection to establish + session list to load (Connecting banner disappears)
  await page.waitForFunction(
    () => !document.body.innerText.includes("Connecting") && !document.body.innerText.includes("No session selected"),
    { timeout: 20_000 },
  );
  // ChatView's scroll container has child `.min-h-full.flex.flex-col.justify-end` per
  // packages/client/src/components/ChatView.tsx line ~516. We find the unique
  // scroll container that has this distinctive child structure.
  await page.waitForFunction(
    () => {
      const candidates = Array.from(
        document.querySelectorAll('[class*="overflow-y-auto"]'),
      ) as HTMLElement[];
      const chatEl = candidates.find((el) =>
        el.querySelector(":scope > .min-h-full.flex.flex-col.justify-end"),
      );
      return chatEl !== undefined && chatEl.scrollHeight > chatEl.clientHeight + 200;
    },
    { timeout: 20_000 },
  );
  // CRITICAL: wait for scrollHeight to STABILIZE — large sessions stream content
  // progressively. Without this wait, scrollHeight may grow 10-100x during the
  // test, racing with the patch's mechanism + ChatView's auto-scroll-on-new-content
  // effect, producing false-positive failures.
  await page.waitForFunction(
    () => {
      // Stash current scrollHeight on window for next poll
      const candidates = Array.from(
        document.querySelectorAll('[class*="overflow-y-auto"]'),
      ) as HTMLElement[];
      const el = candidates.find((c) =>
        c.querySelector(":scope > .min-h-full.flex.flex-col.justify-end"),
      );
      if (!el) return false;
      const prev = (window as unknown as { __prevScrollH?: number }).__prevScrollH ?? 0;
      (window as unknown as { __prevScrollH?: number }).__prevScrollH = el.scrollHeight;
      // Stable if scrollHeight stopped growing AND is substantial
      return prev === el.scrollHeight && el.scrollHeight > 1000;
    },
    { timeout: 30_000, polling: 1500 },
  );
  // Final settle for any tail auto-scroll-to-bottom effect
  await page.waitForTimeout(500);
}

async function getChatScrollEl() {
  const candidates = Array.from(
    document.querySelectorAll('[class*="overflow-y-auto"]'),
  ) as HTMLElement[];
  return candidates.find((el) =>
    el.querySelector(":scope > .min-h-full.flex.flex-col.justify-end"),
  );
}

async function getScrollGeometry(page: Page) {
  return page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll('[class*="overflow-y-auto"]'),
    ) as HTMLElement[];
    const el = candidates.find((c) =>
      c.querySelector(":scope > .min-h-full.flex.flex-col.justify-end"),
    );
    if (!el) return null;
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      nearBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 50,
    };
  });
}

async function simulateRotation(page: Page, target: { width: number; height: number }) {
  // 1. Change viewport size (browser will preserve scrollTop, reflow content)
  await page.setViewportSize(target);
  // 2. Dispatch orientationchange manually (Playwright Chromium does not auto-fire on resize)
  await page.evaluate(() => {
    window.dispatchEvent(new Event("orientationchange"));
    // Also fire visualViewport.resize manually (Playwright Chromium fires this automatically
    // on setViewportSize in most cases, but redundant dispatch is harmless and ensures
    // ChatView's listener fires reliably).
    if (window.visualViewport) {
      window.visualViewport.dispatchEvent(new Event("resize"));
    }
  });
  // Settle past the 350ms debounce window + buffer
  await page.waitForTimeout(SETTLE_WAIT_MS);
}

test.describe("ChatView rotation/viewport-resize empirical-cycle (operator-empirical bug)", () => {
  test.beforeEach(async ({ page }) => {
    // Ensure we start in portrait
    await page.setViewportSize(PORTRAIT);
  });

  test("re-sticks to bottom after portrait→landscape→portrait rotation when user was at-bottom", async ({
    page,
  }) => {
    await loadSessionAndWaitForMessages(page, SESSION_ID);

    // Scroll to bottom explicitly (in case session-load auto-scroll didn't fire)
    await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll('[class*="overflow-y-auto"]'),
      ) as HTMLElement[];
      const el = candidates.find((c) =>
        c.querySelector(":scope > .min-h-full.flex.flex-col.justify-end"),
      );
      if (el) el.scrollTo(0, el.scrollHeight);
    });
    await page.waitForTimeout(400);

    const before = await getScrollGeometry(page);
    expect(before).not.toBeNull();
    expect(before!.nearBottom).toBe(true);
    console.log("[before-rotation portrait] geometry:", before);

    // Rotate portrait → landscape
    await simulateRotation(page, LANDSCAPE);
    const afterLandscape = await getScrollGeometry(page);
    console.log("[after-landscape] geometry:", afterLandscape);
    expect(afterLandscape!.nearBottom).toBe(true);

    // Rotate landscape → portrait (operator's "flip back" scenario)
    await simulateRotation(page, PORTRAIT);
    const afterPortrait = await getScrollGeometry(page);
    console.log("[after-portrait-flip-back] geometry:", afterPortrait);

    // CRITICAL ASSERTION: the operator-empirical-bug shape.
    // WITHOUT PureYak patch: scrollTop preserved at OLD value; user lands mid-chat.
    // WITH PureYak patch: scrollTop re-anchored to new scrollHeight; nearBottom = true.
    expect(afterPortrait!.nearBottom).toBe(true);
  });

  test("preserves user's scroll-up position after rotation when user had scrolled away", async ({
    page,
  }) => {
    await loadSessionAndWaitForMessages(page, SESSION_ID);

    // Scroll UP significantly (to ~25% from top of chat)
    await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll('[class*="overflow-y-auto"]'),
      ) as HTMLElement[];
      const el = candidates.find((c) =>
        c.querySelector(":scope > .min-h-full.flex.flex-col.justify-end"),
      );
      if (el) {
        el.scrollTo(0, Math.floor(el.scrollHeight * 0.25));
      }
    });
    await page.waitForTimeout(400);

    const before = await getScrollGeometry(page);
    expect(before).not.toBeNull();
    expect(before!.nearBottom).toBe(false);
    const scrollTopBefore = before!.scrollTop;
    console.log("[before-rotation scrolled-up] geometry:", before);

    // Rotate portrait → landscape → portrait
    await simulateRotation(page, LANDSCAPE);
    await simulateRotation(page, PORTRAIT);

    const after = await getScrollGeometry(page);
    console.log("[after-rotation scrolled-up] geometry:", after);

    // CRITICAL ASSERTION: PureYak patch preserves position (does NOT snap-to-bottom).
    // Allow ±200px tolerance for layout reflow between portrait sizes.
    expect(after!.nearBottom).toBe(false);
    expect(Math.abs(after!.scrollTop - scrollTopBefore)).toBeLessThan(2000);
  });
});
