import { test, expect } from "@playwright/test";
import {
  primeApp,
  bootAndConnect,
  openSettings,
  appearanceSection,
  type Skin,
  type ThemePref,
} from "../helpers.js";

/**
 * Spec 7 — Visual regression (the "slick stays slick" guardrail + the
 * operator-facing gallery).
 *
 * Captures a snapshot per skin × theme × viewport (the project axis supplies
 * the viewport: iphone-14-pro-max = mobile, the two desktop projects = 1440px).
 * Four skin×theme cells: editorial-dark, editorial-light, legacy-dark,
 * legacy-light.
 *
 * WHY the Appearance section (not the session list): the suite runs against the
 * live :8000 server whose session list is volatile (names, costs, status dots,
 * timestamps all change run-to-run) — it can't be a stable baseline. The
 * Settings → Appearance section is the deterministic design-system surface: the
 * skin cards + theme control rendered in the live skin's own tokens, fonts, and
 * terracotta accent. It IS the swatch that proves editorial renders warm + slick
 * and legacy renders flat-gray. A deterministic seeded fixture (e2e/README.md
 * follow-up) would unlock full session-list visual snapshots later.
 *
 * Baselines are captured post-blue-fix (HEAD already carries it). First run
 * writes them via `npm run test:e2e:update`; subsequent runs compare.
 *
 * Editorial loads Fraunces / Hanken Grotesk / IBM Plex Mono as webfonts — we
 * await document.fonts.ready so the baseline is captured WITH the real faces
 * (assumes webfont availability; maxDiffPixelRatio in the config tolerates AA
 * jitter between runs).
 */

const CELLS: { skin: Skin; theme: ThemePref }[] = [
  { skin: "editorial", theme: "dark" }, // espresso hero
  { skin: "editorial", theme: "light" }, // warm paper
  { skin: "legacy", theme: "dark" }, // flat-gray dark
  { skin: "legacy", theme: "light" }, // flat-gray light
];

test.describe("visual regression — skin × theme gallery", () => {
  for (const { skin, theme } of CELLS) {
    test(`${skin}-${theme} appearance swatch`, async ({ page }) => {
      await primeApp(page, { skin, theme });
      await bootAndConnect(page);
      await openSettings(page);

      const section = appearanceSection(page);
      await expect(section).toBeVisible();

      // Wait for webfonts (editorial) so glyph shapes are stable in the baseline.
      await page.evaluate(async () => {
        if (document.fonts) await document.fonts.ready;
      });
      // Settle one frame after font swap.
      await page.waitForTimeout(150);

      await expect(section).toHaveScreenshot(`appearance-${skin}-${theme}.png`);
    });
  }
});
