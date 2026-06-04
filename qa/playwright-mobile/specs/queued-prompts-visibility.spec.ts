/**
 * Empirical test for queued-prompts visibility (operator-direct 2026-06-04
 * ~17:25 CEST verbatim per Pattern 87 byte-identical preservation:
 *   "Честно мне не похоже, чтобы работало Q. Просто в мобильном
 *    интерфейсе висит в статусе. Ну, крутится колесик, и все.")
 *
 * Tests:
 *   (1) sending msg1 while session is idle shows pendingPrompt card (existing)
 *   (2) sending msg2/msg3 while pendingPrompt is set DOES NOT overwrite it
 *   (3) queuedPrompts cards appear stacked beneath pendingPrompt
 *   (4) queue-count badge appears above composer
 *
 * Runs against LIVE dashboard at http://127.0.0.1:8000 with iPhone 14 Pro Max
 * WebKit emulation.
 *
 * IMPORTANT: needs a session whose pi binary is currently NOT actively streaming
 * — sends 3 messages in quick succession; first should pendingPrompt, 2nd+3rd
 * should fall through to queue.
 *
 * Override session via env: TEST_SESSION_ID=<uuid>
 */
import { test, expect, type Page } from "@playwright/test";

const SESSION_ID = process.env.TEST_SESSION_ID || "";

test.describe("queued-prompts visibility (operator-empirical 2026-06-04)", () => {
  test("multi-send shows queue badge + queued cards", async ({ page }) => {
    test.skip(!SESSION_ID, "TEST_SESSION_ID env var required (use an idle Pi session)");

    await page.goto(`/session/${SESSION_ID}`, { waitUntil: "domcontentloaded" });
    // wait for session UI to settle
    await page.waitForFunction(
      () =>
        !document.body.innerText.includes("Connecting") &&
        !document.body.innerText.includes("No session selected"),
      { timeout: 20_000 },
    );

    // find composer textarea — mobile composer uses textarea; data-testid varies
    const composerTextarea = page.locator("textarea").first();
    await expect(composerTextarea).toBeVisible({ timeout: 5_000 });

    // find Send button — mobile composer has a circular Send btn with title text
    const sendButton = page.locator('button[title*="Send"], button[title*="Queue"]').first();
    await expect(sendButton).toBeVisible({ timeout: 5_000 });

    // send msg1
    await composerTextarea.fill("TEST_Q_MSG_1_pendingPrompt");
    await sendButton.click();

    // wait for pendingPrompt card to appear (existing behavior — synchronous local state)
    await expect(page.locator('[data-testid="pending-prompt-card"]')).toBeVisible({ timeout: 3_000 });

    // send msg2 immediately (do NOT wait for pi response)
    await composerTextarea.fill("TEST_Q_MSG_2_queued1");
    await sendButton.click();

    // send msg3 immediately
    await composerTextarea.fill("TEST_Q_MSG_3_queued2");
    await sendButton.click();

    // EXPECTATION: queued cards visible
    const queuedCard0 = page.locator('[data-testid="queued-prompt-card-0"]');
    const queuedCard1 = page.locator('[data-testid="queued-prompt-card-1"]');
    const queueBadge = page.locator('[data-testid="command-input-queue-badge"], [data-testid="mobile-composer-queue-badge"]');

    // visible within 2s
    await expect(queuedCard0).toBeVisible({ timeout: 3_000 });
    await expect(queuedCard1).toBeVisible({ timeout: 3_000 });

    // queued cards contain the right text
    await expect(queuedCard0).toContainText("TEST_Q_MSG_2_queued1");
    await expect(queuedCard1).toContainText("TEST_Q_MSG_3_queued2");

    // badge shows "2 queued"
    await expect(queueBadge.first()).toContainText("2 queued");
  });

  test("DIAGNOSTIC: capture full page state after multi-send", async ({ page }) => {
    test.skip(!SESSION_ID, "TEST_SESSION_ID env var required");

    await page.goto(`/session/${SESSION_ID}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () =>
        !document.body.innerText.includes("Connecting") &&
        !document.body.innerText.includes("No session selected"),
      { timeout: 20_000 },
    );

    const composerTextarea = page.locator("textarea").first();
    const sendButton = page.locator('button[title*="Send"], button[title*="Queue"]').first();

    await composerTextarea.fill("DIAG_MSG_1");
    await sendButton.click();
    await page.waitForTimeout(200);

    await composerTextarea.fill("DIAG_MSG_2");
    await sendButton.click();
    await page.waitForTimeout(200);

    await composerTextarea.fill("DIAG_MSG_3");
    await sendButton.click();
    await page.waitForTimeout(500);

    // snapshot all data-testid elements + their text content
    const testIds = await page.locator("[data-testid]").evaluateAll((els) =>
      els.map((el) => ({
        testid: el.getAttribute("data-testid"),
        text: (el.textContent ?? "").slice(0, 100),
      })),
    );
    console.log("=== ALL data-testid elements ===");
    console.log(JSON.stringify(testIds, null, 2));

    // also screenshot
    await page.screenshot({ path: "qa/playwright-mobile/playwright-report/diag-queued-prompts.png", fullPage: true });
  });
});
