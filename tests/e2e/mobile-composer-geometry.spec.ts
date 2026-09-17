import { expect, test } from "./fixtures.js";
import { spawnFreshGitSession } from "./helpers/index.js";

// A viewport-sized MobileShell below an in-flow banner overflows the viewport
// by exactly the banner height. A non-shrinking model selector independently
// pushes the action button off the right edge. Keep the warning, shrink only
// the label, and retain a 16px mobile input without changing desktop sizing.
// Uses the existing isolated E2E session fixture; sends no model prompt.
test("mobile composer fits below banners with a long model label", async ({ page }) => {
  await page.route("**/api/health", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    await route.fulfill({ response, json: { ...json, bundleHash: "mobile-layout-regression-fixture" } });
  });
  // The existing spawn helper targets the desktop sidebar; then exercise
  // mobile sizes on that exact same selected session.
  await page.setViewportSize({ width: 1280, height: 900 });
  const card = await spawnFreshGitSession(page);
  await card.click();
  const composer = page.getByTestId("composer-card");
  await expect(composer).toBeVisible({ timeout: 30_000 });

  const cases = [
    { width: 390, height: 844 },
    { width: 430, height: 932 },
    { width: 320, height: 568 },
    { width: 844, height: 390 },
    { width: 390, height: 500, focus: true },
    { width: 1280, height: 900 },
  ];
  for (const size of cases) {
    await test.step(`${size.width}x${size.height}${size.focus ? " focused" : ""}`, async () => {
      await page.setViewportSize({ width: size.width, height: size.height });
      const mobile = size.width < 768 || size.height < 600;
      const field = composer.locator("textarea");
      await expect(field).toHaveCSS("font-size", mobile ? "16px" : "14px");
      if (mobile) await expect(page.getByTestId("plugin-staleness-banner")).toBeVisible();

      // Geometry fixture only: keep the real selector/ellipsis styles, without
      // changing the actual model or requesting a catalogue refresh.
      await composer.getByTestId("model-selector-button").locator("span").first().evaluate((span) => {
        span.textContent = "provider-with-a-long-name/model-with-a-very-long-reasoning-variant";
      });
      if (size.focus) await field.focus();

      await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight))
        .toBeLessThanOrEqual(size.height + 1);
      for (const control of [field, composer.getByTestId("attach-button"), composer.getByTestId("model-selector-button"), composer.getByTestId("send-button")]) {
        await expect(control).toBeVisible();
        await expect.poll(async () => control.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return box.left >= -1 && box.top >= -1 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1
            && (hit === element || element.contains(hit));
        })).toBe(true);
      }
      if (size.focus) await field.blur();
    });
  }
});
