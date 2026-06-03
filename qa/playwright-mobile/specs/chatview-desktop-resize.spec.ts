/**
 * ChatView desktop window-resize empirical-cycle-pass test (Mega-Cluster M v2.0 tier-(b)
 * extension #2 v2 desktop-conditional canonical).
 *
 * Operator-empirical SCOPE EXPANSION 2026-05-29 ~22:00 CEST verbatim:
 *   "UI scroll going to middle of history ALSO APPEARS ON DESKTOP"
 *
 * Mechanism: PureYak's patch listens to visualViewport.resize + orientationchange.
 * Desktop browser fires visualViewport.resize on window-resize / DevTools-toggle /
 * zoom (cmd+/-) / fullscreen-toggle. NO mobile-gating in useEffect → patch
 * SHOULD cover desktop at-mechanism-tier.
 *
 * Sister to chatview-rotation-scroll.spec.ts (iOS WebKit rotation test) at
 * desktop-chromium Playwright project.
 *
 * Tests against LIVE dashboard at http://127.0.0.1:8000 with real session that has
 * substantial message history. Resize-bug-shape: chat scroll container shrinks then
 * grows; without patch user lands mid-chat; with patch re-anchored to bottom.
 */
import { test, expect, Page } from "@playwright/test";

const SESSION_ID = process.env.TEST_SESSION_ID || "019e74c7-e280-72ce-afc2-ca63b2f19e0f";

const SETTLE_WAIT_MS = 500; // 350ms settle window + 150ms buffer

// Desktop window sizes — wide vs narrow vs tall vs short = different scrollHeight
const DESKTOP_LARGE = { width: 1440, height: 900 }; // standard desktop
const DESKTOP_NARROW = { width: 600, height: 900 }; // narrow window (sidebar collapsed; mobile-narrow-on-desktop)
const DESKTOP_SHORT = { width: 1440, height: 500 }; // short window (DevTools-bottom-open; minimal vertical)

async function loadSessionAndWaitForMessages(page: Page, sessionId: string) {
  await page.goto(`/session/${sessionId}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => !document.body.innerText.includes("Connecting") && !document.body.innerText.includes("No session selected"),
    { timeout: 20_000 },
  );
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
  // Wait for scrollHeight to stabilize (large sessions stream content progressively)
  await page.waitForFunction(
    () => {
      const candidates = Array.from(
        document.querySelectorAll('[class*="overflow-y-auto"]'),
      ) as HTMLElement[];
      const el = candidates.find((c) =>
        c.querySelector(":scope > .min-h-full.flex.flex-col.justify-end"),
      );
      if (!el) return false;
      const prev = (window as unknown as { __prevScrollHDesktop?: number }).__prevScrollHDesktop ?? 0;
      (window as unknown as { __prevScrollHDesktop?: number }).__prevScrollHDesktop = el.scrollHeight;
      return prev === el.scrollHeight && el.scrollHeight > 1000;
    },
    { timeout: 30_000, polling: 1500 },
  );
  await page.waitForTimeout(500);
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

async function simulateResize(page: Page, target: { width: number; height: number }) {
  await page.setViewportSize(target);
  // Dispatch visualViewport.resize manually for reliability (Playwright Chromium fires
  // it automatically in most cases but redundant dispatch is harmless + ensures the
  // ChatView listener fires).
  await page.evaluate(() => {
    if (window.visualViewport) {
      window.visualViewport.dispatchEvent(new Event("resize"));
    }
  });
  await page.waitForTimeout(SETTLE_WAIT_MS);
}

test.describe("ChatView desktop window-resize empirical-cycle (operator-empirical SCOPE EXPANSION)", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(DESKTOP_LARGE);
  });

  test("re-sticks to bottom after desktop window-resize large→narrow→large when user was at-bottom", async ({
    page,
  }) => {
    await loadSessionAndWaitForMessages(page, SESSION_ID);

    // Scroll to bottom explicitly
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
    console.log("[desktop before-resize large] geometry:", before);

    // Resize large → narrow (sidebar-collapses; chat container clientHeight may stay
    // similar but content reflows differently — scrollHeight changes)
    await simulateResize(page, DESKTOP_NARROW);
    const afterNarrow = await getScrollGeometry(page);
    console.log("[desktop after-narrow] geometry:", afterNarrow);

    // Resize narrow → large (returns to original; scrollHeight returns toward original)
    await simulateResize(page, DESKTOP_LARGE);
    const afterLarge = await getScrollGeometry(page);
    console.log("[desktop after-large] geometry:", afterLarge);

    // CRITICAL ASSERTION: without PureYak's patch, user lands mid-chat post-resize-cycle.
    // With patch: re-anchored to bottom (nearBottom=true).
    expect(afterLarge!.nearBottom).toBe(true);
  });

  test("re-sticks to bottom after desktop window-resize large→short→large (DevTools-open simulation) when at-bottom", async ({
    page,
  }) => {
    await loadSessionAndWaitForMessages(page, SESSION_ID);

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
    expect(before!.nearBottom).toBe(true);
    console.log("[desktop before-resize large] geometry:", before);

    // Resize large → short (DevTools-bottom-open simulation; clientHeight shrinks ~50%)
    await simulateResize(page, DESKTOP_SHORT);
    const afterShort = await getScrollGeometry(page);
    console.log("[desktop after-short] geometry:", afterShort);

    // Resize short → large
    await simulateResize(page, DESKTOP_LARGE);
    const afterLarge = await getScrollGeometry(page);
    console.log("[desktop after-large] geometry:", afterLarge);

    expect(afterLarge!.nearBottom).toBe(true);
  });

  test("preserves user's scroll-up position after desktop window-resize when user had scrolled away", async ({
    page,
  }) => {
    await loadSessionAndWaitForMessages(page, SESSION_ID);

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
    expect(before!.nearBottom).toBe(false);
    const scrollTopBefore = before!.scrollTop;
    console.log("[desktop before-resize scrolled-up] geometry:", before);

    await simulateResize(page, DESKTOP_NARROW);
    await simulateResize(page, DESKTOP_LARGE);

    const after = await getScrollGeometry(page);
    console.log("[desktop after-resize scrolled-up] geometry:", after);

    // CRITICAL ASSERTION: PureYak patch preserves position (does NOT snap-to-bottom).
    expect(after!.nearBottom).toBe(false);
    expect(Math.abs(after!.scrollTop - scrollTopBefore)).toBeLessThan(3000);
  });
});
