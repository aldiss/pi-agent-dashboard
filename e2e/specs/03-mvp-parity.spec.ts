import { test, expect } from "@playwright/test";
import {
  primeApp,
  bootAndConnect,
  openSessionWithModelRow,
  modelRow,
  modelSheet,
  sheetThinkingSeg,
  sheetThinkingLevel,
  sheetBell,
  sheetModelList,
  dismissSheet,
  wsFrames,
  waitForFrame,
  type Skin,
} from "../helpers.js";

/**
 * Spec 3 — MVP parity (the mobile Model & reasoning sheet).
 * This is the parity bug-fix the redesign surfaces: the model picker, thinking
 * segmented-control, and per-session bell were desktop-only (gated !isMobile in
 * the StatusBar). The sheet brings them to touch. It exists in BOTH skins.
 *
 * The sheet only mounts on the mobile layout (useMobile: width < 768px OR
 * height < 600px), so this spec runs on the iPhone-WebKit project only.
 *
 * NON-DESTRUCTIVE CONTRACT: the suite runs against the live :8000 server. The
 * mutating control frames (set_model / set_thinking_level / set_push_prefs) are
 * RECORDED by the in-page WS shim and asserted for shape, but SWALLOWED (not
 * forwarded) so a real operator session is never permanently re-modelled by a
 * test run. We therefore assert the exact frame the client emitted (the parity
 * contract) + the client-side sheet behavior, not the server echo.
 */

test.describe("MVP parity — model/thinking/bell sheet", () => {
  // Mobile-only: the sheet is gated behind the mobile layout.
  test.skip(
    ({ viewport }) => !!viewport && viewport.width >= 768 && viewport.height >= 600,
    "Model & reasoning sheet only mounts on the mobile layout",
  );

  // Run the full parity flow in BOTH skins — the sheet must work identically
  // whether it wears the editorial warm tokens or the legacy tokens.
  for (const skin of ["editorial", "legacy"] as Skin[]) {
    test(`[${skin}] open sheet → thinking emits set_thinking_level, bell emits set_push_prefs`, async ({
      page,
    }) => {
      await primeApp(page, { skin, theme: "dark" });
      await bootAndConnect(page);

      const sessionId = await openSessionWithModelRow(page);
      expect(sessionId, "expected at least one live session with a model row").toBeTruthy();

      // Tap the model row → the sheet springs up.
      await modelRow(page).click();
      await expect(modelSheet(page)).toBeVisible();
      await expect(sheetThinkingSeg(page)).toBeVisible();

      // ── Thinking segmented control → set_thinking_level{sessionId,level} ──
      // Tap "minimal" (rarely the current level, so the frame always fires).
      await sheetThinkingLevel(page, "minimal").click();
      const think = await waitForFrame(page, "set_thinking_level");
      expect(think.sessionId).toBe(sessionId);
      expect(think.level).toBe("minimal");
      // Thinking taps do NOT close the sheet — still open for the bell.
      await expect(modelSheet(page)).toBeVisible();

      // ── Bell → set_push_prefs{sessionId,prefs:{notifyCompletion}} ──
      // The bell row always renders (pushEnabled=true, bellState defaults "off").
      await expect(sheetBell(page)).toBeVisible();
      await sheetBell(page).click();
      const bell = await waitForFrame(page, "set_push_prefs");
      expect(bell.sessionId).toBe(sessionId);
      // off → on is the first cycle step (states: off → on → auto).
      expect(bell.prefs).toMatchObject({ notifyCompletion: "on" });

      // ── Model pick → set_model{sessionId,provider,modelId} (when models exist) ──
      const modelButtons = sheetModelList(page).locator("button");
      const modelCount = await modelButtons.count();
      if (modelCount > 0) {
        await modelButtons.first().click();
        const model = await waitForFrame(page, "set_model");
        expect(model.sessionId).toBe(sessionId);
        expect(typeof model.provider).toBe("string");
        expect(typeof model.modelId).toBe("string");
        expect((model.provider as string).length).toBeGreaterThan(0);
        expect((model.modelId as string).length).toBeGreaterThan(0);
        // Picking a model closes the sheet (onClose fires in the click handler).
        await expect(modelSheet(page)).toBeHidden();
      } else {
        // Documented skip: this live session carries no models in its map, so
        // the set_model leg can't be exercised here. The frame WIRING is proven
        // by set_thinking_level/set_push_prefs above (same send() path); the
        // model list simply had nothing to tap. Close via scrim instead.
        test.info().annotations.push({
          type: "note",
          description: `session ${sessionId} had no models in map — set_model leg not exercised this run`,
        });
        await dismissSheet(page);
        await expect(modelSheet(page)).toBeHidden();
      }

      // The mutating frames were recorded but swallowed (non-destructive).
      expect((await wsFrames(page, "set_thinking_level")).length).toBeGreaterThan(0);
      expect((await wsFrames(page, "set_push_prefs")).length).toBeGreaterThan(0);
    });
  }

  test("[editorial] sheet dismisses via scrim tap", async ({ page }) => {
    await primeApp(page, { skin: "editorial", theme: "dark" });
    await bootAndConnect(page);

    const sessionId = await openSessionWithModelRow(page);
    expect(sessionId).toBeTruthy();

    await modelRow(page).click();
    await expect(modelSheet(page)).toBeVisible();

    // Tap the scrim above the sheet → sheet closes (no frame sent).
    await dismissSheet(page);
    await expect(modelSheet(page)).toBeHidden();
  });
});
