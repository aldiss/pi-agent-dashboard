import { test } from "@playwright/test";

test("screenshot of queued state", async ({ page }) => {
  await page.goto(`/session/019e783a-a5dc-7d04-a57a-1d72046a187b`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      !document.body.innerText.includes("Connecting") &&
      !document.body.innerText.includes("No session selected"),
    { timeout: 20_000 },
  );
  const ta = page.locator("textarea").first();
  const send = page.locator('button[title*="Send"], button[title*="Queue"]').first();

  await ta.fill("SHOT_MSG_1");
  await send.click();
  await page.waitForTimeout(300);
  await ta.fill("SHOT_MSG_2");
  await send.click();
  await page.waitForTimeout(300);
  await ta.fill("SHOT_MSG_3");
  await send.click();
  await page.waitForTimeout(800);

  await page.screenshot({ path: "/tmp/queued-prompts-mobile.png", fullPage: true });
  console.log("screenshot saved to /tmp/queued-prompts-mobile.png");
});
