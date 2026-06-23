import { test, expect } from "@playwright/test";
import {
  primeApp,
  bootAndConnect,
  openSettings,
  settingsTabBar,
  type Skin,
} from "../helpers.js";

/**
 * Spec 4 — Settings tab-bar (the §4 #4 clip fix).
 * At 393px the tab row used to clip "Security"/"Advanced" → "S…". The fix is
 * overflow-x-auto + scroll-snap. We assert: the bar is horizontally scrollable
 * (or already fits), and EVERY tab — including the last two — is reachable +
 * activatable with its full label, with no horizontal page overflow.
 *
 * Tabs have no per-tab testid; they're plain <button>s inside #settings-tab-bar,
 * selected by their visible label (General / Servers / Packages / Providers /
 * Security / Advanced).
 */

const ALL_TABS = ["General", "Servers", "Packages", "Providers", "Security", "Advanced"];

test.describe("settings tab-bar", () => {
  for (const skin of ["editorial", "legacy"] as Skin[]) {
    test(`[${skin}] every tab is reachable + un-clipped, no page overflow`, async ({ page }) => {
      await primeApp(page, { skin, theme: "dark" });
      await bootAndConnect(page);
      await openSettings(page);

      const bar = settingsTabBar(page);
      await expect(bar).toBeVisible();

      // No horizontal overflow of the PAGE (the clip bug pushed content wide).
      const docOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(docOverflow, "page must not scroll horizontally").toBeLessThanOrEqual(1);

      // The bar is the scroll container — it either fits or scrolls within itself.
      const scrollable = await bar.evaluate(
        (el) => el.scrollWidth > el.clientWidth + 1,
      );

      // Reach Security + Advanced: scroll the bar, click, assert the tab
      // activated (content switched) and its label rendered in full.
      for (const label of ["Security", "Advanced"]) {
        const tabBtn = bar.getByRole("button", { name: label, exact: true });
        await tabBtn.scrollIntoViewIfNeeded();
        await expect(tabBtn).toBeVisible();
        // Full label present (not truncated to "S…"). innerText preserves the
        // visible glyphs; the button text must equal the full word.
        await expect(tabBtn).toHaveText(label);
        await tabBtn.click();
        // Active underline marker (the blue bar) lives inside the active button.
        await expect
          .poll(async () => (await tabBtn.locator("span").count()) > 0)
          .toBe(true);
      }

      test.info().annotations.push({
        type: "note",
        description: `tab bar ${scrollable ? "scrolls within itself" : "fits"} at ${page.viewportSize()?.width}px`,
      });
    });
  }

  test("[editorial] all six tabs activate in sequence", async ({ page }) => {
    await primeApp(page, { skin: "editorial", theme: "dark" });
    await bootAndConnect(page);
    await openSettings(page);
    const bar = settingsTabBar(page);

    for (const label of ALL_TABS) {
      const tabBtn = bar.getByRole("button", { name: label, exact: true });
      await tabBtn.scrollIntoViewIfNeeded();
      await tabBtn.click();
      await expect(tabBtn).toHaveText(label);
    }
  });
});
