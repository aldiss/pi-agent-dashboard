import { test, expect } from "@playwright/test";
import {
  primeApp,
  bootAndConnect,
  openSettings,
  skinOption,
  themeOption,
  rootAttrs,
  SKIN_KEY,
  type ThemePref,
} from "../helpers.js";

/**
 * Spec 2 — Skin switch (Editorial ⇄ Legacy).
 * The redesign's central contract: an independent `data-skin` axis that flips
 * tokens + fonts, persists across reload, and composes with Light/Dark/Auto.
 *
 * Verified facts (read off index.css + useSkin.ts):
 *   editorial dark : --bg-primary #17120e, --accent-primary #cf6238 (terracotta),
 *                    body font-family includes "Hanken Grotesk", #editorial-fonts <link> present.
 *   editorial light: --bg-primary #f4ece1 (warm paper).
 *   legacy  dark   : --bg-primary #0a0a0a, --accent-primary #3b82f6 (blue),
 *                    body font-family has NO "Hanken Grotesk", #editorial-fonts absent.
 */

/** Computed CSS custom property off <html>. */
async function cssVar(page: import("@playwright/test").Page, name: string): Promise<string> {
  return page.evaluate(
    (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name,
  );
}

/** Computed body font-family. */
async function bodyFont(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.body).fontFamily);
}

/** Whether the editorial webfont <link> is in the document head. */
async function hasEditorialFontLink(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(() => !!document.getElementById("editorial-fonts"));
}

test.describe("skin switch", () => {
  test("toggle Editorial → Legacy flips data-skin, tokens, and fonts", async ({ page }) => {
    await primeApp(page, { skin: "editorial", theme: "dark" });
    await bootAndConnect(page);
    await openSettings(page);

    // Baseline: editorial.
    expect((await rootAttrs(page)).skin).toBe("editorial");
    expect(await cssVar(page, "--bg-primary")).toBe("#17120e");
    expect((await cssVar(page, "--accent-primary")).toLowerCase()).toBe("#cf6238");
    expect(await bodyFont(page)).toContain("Hanken Grotesk");
    expect(await hasEditorialFontLink(page)).toBe(true);

    // Flip to legacy — live-applied, no reload.
    await skinOption(page, "legacy").click();
    await expect.poll(() => rootAttrs(page).then((a) => a.skin)).toBe("legacy");

    // Legacy tokens + system font + no editorial webfont cost.
    expect(await cssVar(page, "--bg-primary")).toBe("#0a0a0a");
    expect((await cssVar(page, "--accent-primary")).toLowerCase()).toBe("#3b82f6");
    expect(await bodyFont(page)).not.toContain("Hanken Grotesk");
    expect(await hasEditorialFontLink(page)).toBe(false);

    // The selected card reflects state (aria-pressed).
    await expect(skinOption(page, "legacy")).toHaveAttribute("aria-pressed", "true");
    await expect(skinOption(page, "editorial")).toHaveAttribute("aria-pressed", "false");
  });

  test("skin choice persists across reload", async ({ page }) => {
    await primeApp(page, { skin: "editorial", theme: "dark" });
    await bootAndConnect(page);
    await openSettings(page);

    await skinOption(page, "legacy").click();
    await expect.poll(() => rootAttrs(page).then((a) => a.skin)).toBe("legacy");

    // localStorage carries the choice (the persistence mechanism).
    expect(await page.evaluate((k) => localStorage.getItem(k), SKIN_KEY)).toBe("legacy");

    // Reload — the pre-paint boot script must restore legacy before first paint.
    await page.reload();
    await bootAndConnect(page);
    expect((await rootAttrs(page)).skin).toBe("legacy");
    expect(await cssVar(page, "--bg-primary")).toBe("#0a0a0a");
  });

  // Skin × theme are independent axes — all four combinations resolve to the
  // expected hero/alternate palette.
  const matrix: { skin: "editorial" | "legacy"; theme: ThemePref; bg: string }[] = [
    { skin: "editorial", theme: "dark", bg: "#17120e" }, // espresso hero
    { skin: "editorial", theme: "light", bg: "#f4ece1" }, // warm paper
    { skin: "legacy", theme: "dark", bg: "#0a0a0a" }, // legacy dark
  ];

  for (const { skin, theme, bg } of matrix) {
    test(`composes: ${skin} + ${theme} → --bg-primary ${bg}`, async ({ page }) => {
      await primeApp(page, { skin, theme });
      await bootAndConnect(page);
      const attrs = await rootAttrs(page);
      expect(attrs.skin).toBe(skin);
      // data-theme is "light" for light, and removed (null) for dark.
      expect(attrs.theme).toBe(theme === "light" ? "light" : null);
      expect(await cssVar(page, "--bg-primary")).toBe(bg);
    });
  }
});
