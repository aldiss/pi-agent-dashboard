import { test, expect } from "@playwright/test";
import { writeFeed, writeFreshHeartbeat, productionHeld } from "../needs-you-fixtures.js";

/** Set a fast band poll (test-only seam) so feed changes appear within ~1s. */
async function fastPoll(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => { (window as { __NEEDS_YOU_POLL_MS__?: number }).__NEEDS_YOU_POLL_MS__ = 800; });
}

/** Smoke: the harness boots, the route serves a synthetic feed, the band renders. */
test("harness smoke — band renders a synthetic production-held item", async ({ page }) => {
  writeFreshHeartbeat();
  writeFeed([productionHeld()]);
  await fastPoll(page);
  await page.goto("/");
  const band = page.getByTestId("needs-you-band");
  await expect(band).toBeVisible({ timeout: 25_000 });
  // The route caches 5s; the fast poll re-fetches every 800ms, so the item
  // appears within ~6s worst-case (cache expiry + one poll).
  await expect(page.getByTestId("needs-you-item").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("needs-you-chip").first()).toHaveText("YOUR GO");
});

