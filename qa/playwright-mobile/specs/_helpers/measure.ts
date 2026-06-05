/**
 * Session-history side-panel load-time measurement primitives
 * for cell `dashboard-dev/v1` first-task per-commit-cycle canonical Playwright regression test.
 *
 * Operator empirical complaint (verbatim per Pattern 87 byte-identical):
 *   "session-history loads slowly when opened from side-panel"
 *
 * Operator pacing canonical:
 *   «не торопись; постепенно; одна перемѣна — одинъ Playwright опытъ — одно рѣшеніе»
 *
 * Measurement-protocol per scout-recon-canonical (substrate r6 §W1 design-canonical):
 *   PRIMARY:  end-to-end click-to-first-content-paint (operator-experience-tier)
 *   SECONDARY-1: network-tier WS-replay-completion (server-replay-batch-time vs client-render-time diagnostic)
 *   SECONDARY-2: time-to-fully-scrolled-bottom (auto-scroll-settle canonical)
 *
 * Sister-precedent: chatview-desktop-resize.spec.ts uses scroll-container selector
 *   `[class*="overflow-y-auto"]` + `:scope > .min-h-full.flex.flex-col.justify-end`
 *   per ChatView render-anchor canonical.
 */
import type { Page, WebSocket } from "@playwright/test";

/**
 * Locate the ChatView scroll-container element handle.
 * Sister-shape to chatview-desktop-resize.spec.ts `getScrollGeometry()` selector pattern.
 *
 * Returns null IFF ChatView not yet mounted / no scroll-container present.
 */
export async function getChatScrollGeometry(page: Page): Promise<{
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  nearBottom: boolean;
} | null> {
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

/**
 * Wait for ChatView to render with substantive history (scrollHeight > clientHeight + minDelta).
 * Returns elapsed-ms from invocation moment to first-paint canonical.
 *
 * PRIMARY measurement: this captures the operator-felt latency from session-card click
 * through to chat-history first-visible-paint.
 */
export async function waitForChatFirstPaint(
  page: Page,
  opts: { minScrollDelta?: number; timeoutMs?: number } = {},
): Promise<number> {
  const minDelta = opts.minScrollDelta ?? 200;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const t0 = performance.now();
  await page.waitForFunction(
    (minDelta_) => {
      const candidates = Array.from(
        document.querySelectorAll('[class*="overflow-y-auto"]'),
      ) as HTMLElement[];
      const el = candidates.find((c) =>
        c.querySelector(":scope > .min-h-full.flex.flex-col.justify-end"),
      );
      return el !== undefined && el.scrollHeight > el.clientHeight + minDelta_;
    },
    minDelta,
    { timeout: timeoutMs },
  );
  return performance.now() - t0;
}

/**
 * Wait for ChatView scrollHeight to stabilize across N polling intervals
 * (large sessions stream content progressively via WS-replay batches).
 *
 * SECONDARY-2 measurement: this captures the end-of-replay + auto-scroll-settle moment
 * which is where operator "slowly" perception lives if backlog is large.
 *
 * Returns elapsed-ms from invocation moment to stable-scrollHeight canonical.
 */
export async function waitForChatScrollStable(
  page: Page,
  opts: { pollIntervalMs?: number; minScrollHeight?: number; timeoutMs?: number } = {},
): Promise<number> {
  const pollMs = opts.pollIntervalMs ?? 1500;
  const minHeight = opts.minScrollHeight ?? 1000;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const t0 = performance.now();
  await page.waitForFunction(
    ({ pollMs_, minHeight_ }) => {
      const candidates = Array.from(
        document.querySelectorAll('[class*="overflow-y-auto"]'),
      ) as HTMLElement[];
      const el = candidates.find((c) =>
        c.querySelector(":scope > .min-h-full.flex.flex-col.justify-end"),
      );
      if (!el) return false;
      const w = window as unknown as { __dashboardDevPrevScrollH?: number };
      const prev = w.__dashboardDevPrevScrollH ?? 0;
      w.__dashboardDevPrevScrollH = el.scrollHeight;
      return prev === el.scrollHeight && el.scrollHeight > minHeight_;
    },
    { pollMs_: pollMs, minHeight_: minHeight },
    { timeout: timeoutMs, polling: pollMs },
  );
  return performance.now() - t0;
}

/**
 * SECONDARY-1 measurement: WS-replay-completion diagnostic.
 *
 * Attaches a websocket frame counter; returns a stopper that resolves with
 *   { totalEventReplayFrames, firstFrameMs, lastFrameMs, elapsedMs }
 * Sister-discipline to subscription-handler's "async batched replay, backpressure" instrumentation.
 *
 * NOTE: Playwright `page.on("websocket")` fires on socket-open; frames captured via
 * websocket.on("framesent") + websocket.on("framereceived"). We watch framereceived
 * for "event_replay" message type per browser-protocol canonical.
 */
export function attachWsReplayCounter(page: Page): {
  stop: () => Promise<{
    totalEventReplayFrames: number;
    firstFrameMs: number | null;
    lastFrameMs: number | null;
    elapsedMs: number | null;
  }>;
} {
  let totalEventReplayFrames = 0;
  let firstFrameMs: number | null = null;
  let lastFrameMs: number | null = null;
  const t0 = performance.now();

  const onWebSocket = (ws: WebSocket) => {
    ws.on("framereceived", (payload) => {
      const text = typeof payload.payload === "string" ? payload.payload : payload.payload.toString("utf8");
      if (text.includes('"type":"event_replay"')) {
        totalEventReplayFrames += 1;
        const now = performance.now();
        if (firstFrameMs === null) firstFrameMs = now - t0;
        lastFrameMs = now - t0;
      }
    });
  };

  page.on("websocket", onWebSocket);

  return {
    stop: async () => {
      page.off("websocket", onWebSocket);
      return {
        totalEventReplayFrames,
        firstFrameMs,
        lastFrameMs,
        elapsedMs: lastFrameMs,
      };
    },
  };
}

/**
 * Discipline canonical: clear service-worker registrations + caches.
 * Used for "fresh-SW" measurement per (iii)R panel-diversity-at-measurement-tier discipline.
 */
export async function clearServiceWorkerAndCaches(page: Page): Promise<void> {
  await page.evaluate(async () => {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  });
}

/**
 * Discipline canonical: pre-warm service-worker so subsequent navigation hits cached resources.
 * Used for "primed-SW" measurement per (iii)R panel-diversity-at-measurement-tier discipline.
 *
 * Navigates to dashboard root, waits for SW registration + activation, reloads to ensure
 * SW is controlling, then returns. Subsequent measurement-test navigation runs against
 * primed-SW state.
 */
export async function primeServiceWorker(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    if ("serviceWorker" in navigator) {
      // Wait for SW registration to be available + activated
      const reg = await navigator.serviceWorker.ready;
      // Wait one tick to ensure controller assignment
      if (!navigator.serviceWorker.controller) {
        await new Promise<void>((resolve) => {
          const onControllerChange = () => {
            navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
            resolve();
          };
          navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
          // Force a no-op message to encourage SW takeover (best-effort; not all SWs respond)
          setTimeout(resolve, 3000);
        });
      }
      return reg.scope;
    }
  });
  // Reload to ensure subsequent navigations hit SW-controlled state
  await page.reload({ waitUntil: "domcontentloaded" });
}
