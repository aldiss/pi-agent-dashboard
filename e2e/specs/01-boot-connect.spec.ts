import { test, expect } from "@playwright/test";
import { primeApp, bootAndConnect, headerAppBar, sessionCards, rootAttrs } from "../helpers.js";

/**
 * Spec 1 — Boot + connect (the smoke test).
 * App loads, React hydrates (skeleton gone), the WS connects (status leaves
 * "connecting"), and the session list shell renders. Runs on every project
 * (iPhone-WebKit + both desktops) so a broken boot is caught everywhere.
 */
test.describe("boot + connect", () => {
  test.beforeEach(async ({ page }) => {
    await primeApp(page, { skin: "editorial", theme: "dark" });
  });

  test("app boots, WS connects, session list renders", async ({ page }) => {
    await bootAndConnect(page);

    // The editorial skin is applied pre-paint (boot script) and re-asserted by
    // React — <html> carries data-skin="editorial".
    const attrs = await rootAttrs(page);
    expect(attrs.skin).toBe("editorial");

    // Session-list shell is up.
    await expect(headerAppBar(page)).toBeVisible();

    // The live server has many sessions — at least one card renders. (Asserts
    // the WS replayed session state into the list, not just an empty shell.)
    await expect.poll(() => sessionCards(page).count(), { timeout: 15_000 }).toBeGreaterThan(0);
  });

  test("no service-worker or console crash on boot", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await bootAndConnect(page);
    // Boot must be clean — uncaught exceptions break hydration on real devices.
    expect(errors, `page errors on boot: ${errors.join("; ")}`).toHaveLength(0);
  });
});
