import { test, expect, type Page } from "@playwright/test";
import { primeApp, headerAppBar, sessionCards } from "../helpers.js";

/**
 * S1 · dashboard-mutation-rows-render — THE HEADLINE (design-pass §3,
 * empirical-scenario-library S1, maps MP-7 + MP-2).
 *
 * The operator's exact pain (byte-identical from his logs):
 *   "so I see you in dashboard but I cannot send any mesages to you. something
 *    is very broken. It is a regression that has not been caught in testing."
 *
 * This is the regression class that only shows up when the operator opens the
 * dashboard: a deployed dashboard change makes the session rows render wrong
 * (missing / duplicated / mislabeled / wrong status). The live :8000 suite
 * cannot catch it because the live session list changes run-to-run. The SEEDED
 * sandbox (fixed UUIDs/statuses from seed/active-project) makes the row-set a
 * deterministic assertion target for the first time.
 *
 * Seed fixture (seed/active-project/--Users-dev-my-project--), verified own-hand
 * against the sandbox /api/sessions + rendered DOM:
 *   f47ac10b-…-d001  status=idle     "Add dark mode support…"   ← renders
 *   dddd3333-…-7777  status=running  "Refactor API client…"     ← renders
 *   a1b2c3d4-…-7890  status=ended    "Fix memory leak…"         ← FILTERED (ended)
 * The two active rows are the stable targets; the ended row's absence is itself
 * a correct, asserted rendering behavior.
 *
 * Surfaces (empirical-scenario-library S1):
 *   A (api_rows)  — GET /api/sessions row presence/status        [cross-checked]
 *   B (rendered)  — real-browser DOM: each seeded UUID row, status, no dupes
 *                   + visual baseline (toHaveScreenshot)
 *   C (mesh)      — N/A here: T1 render-only (spawn: []) — see S2/S4 for mesh
 *   D (driver)    — N/A here: T1 render-only — promoted in the S1-T2 variant
 */

// Seeded rows that the dashboard renders (active sessions). Read off the real
// sandbox, not invented.
const SEED_ACTIVE = [
  { id: "f47ac10b-58cc-4372-a567-0e02b2c3d001", status: "idle" },
  { id: "dddd3333-4444-5555-6666-777777777777", status: "running" },
];
// Seeded but correctly NOT rendered (ended sessions are filtered from the list).
const SEED_ENDED_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

/** Expand the collapsed tier-sections so the seeded session cards are in the DOM.
 *  Sessions whose cwd is not a pinned folder group under "Other" /
 *  "Operator chat-panes", collapsed by default — and the two seeded active rows
 *  are split ACROSS both groups, so BOTH must be expanded. Each tier header is a
 *  <button aria-expanded="true|false"> (verified own-hand); expand only the
 *  collapsed ones so an already-open section is never re-collapsed. */
async function revealSeededSessions(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".pi-skeleton")).toHaveCount(0, { timeout: 25_000 });
  await expect(headerAppBar(page)).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText("Connecting...", { exact: true })).toHaveCount(0, { timeout: 25_000 });

  // The session list streams in over the WS a beat AFTER the header shell is up,
  // and the seeded rows land in collapsed tier-sections. Wait for at least one
  // tier header to exist before trying to expand — reading aria-expanded before
  // the tiers render would skip the expand and leave the list empty (the boot
  // waits above resolve before the stream arrives).
  const tierIds = ["tier-header-other", "tier-header-operator-chat-pane"];
  await expect
    .poll(
      async () => {
        let n = 0;
        for (const tid of tierIds) n += await page.getByTestId(tid).count();
        return n;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThan(0);

  for (const tid of tierIds) {
    const header = page.getByTestId(tid);
    if (!(await header.count())) continue;
    // The seeded rows split ACROSS both groups; expand only collapsed ones so an
    // already-open section is never re-collapsed. Each is a
    // <button aria-expanded="true|false"> (verified own-hand).
    const expanded = await header.first().getAttribute("aria-expanded");
    if (expanded === "false") {
      await header.first().click().catch(() => {});
      await page.waitForTimeout(400);
    }
  }
  // The seeded active cards have streamed into the list.
  await expect
    .poll(() => sessionCards(page).count(), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(SEED_ACTIVE.length);
}

test.describe("S1 · dashboard-mutation rows-render (seeded sandbox)", () => {
  test.beforeEach(async ({ page }) => {
    await primeApp(page, { skin: "editorial", theme: "dark" });
  });

  test("each seeded ACTIVE session renders exactly one row (structural)", async ({ page }) => {
    await revealSeededSessions(page);

    for (const seed of SEED_ACTIVE) {
      const row = page.locator(`[data-session-id="${seed.id}"]`);
      // present
      await expect(row, `seeded row ${seed.id} must render`).toHaveCount(1);
      // not duplicated — the two-Joans/four-Dons defect (MP-7) is count > 1
      await expect(row, `seeded row ${seed.id} must not be duplicated`).toHaveCount(1);
      await expect(row.first()).toBeVisible();
    }
  });

  test("the seeded ENDED session is correctly filtered from the list", async ({ page }) => {
    await revealSeededSessions(page);
    // The ended session must NOT render — an ended row leaking into the list is
    // its own row-hygiene defect.
    await expect(page.locator(`[data-session-id="${SEED_ENDED_ID}"]`)).toHaveCount(0);
  });

  test("API rows (surface A) agree with the rendered DOM (surface B) — no divergence", async ({
    page,
    request,
  }) => {
    await revealSeededSessions(page);

    // Surface A: the dashboard /api/sessions envelope {success, data:[...]}.
    const res = await request.get("/api/sessions");
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const apiIds = new Set<string>(
      (body?.data ?? []).map((r: { id?: string }) => r.id).filter(Boolean),
    );

    // Surface B: the rendered DOM ids.
    const domIds = new Set(
      await page.locator("[data-session-id]").evaluateAll((els) =>
        els.map((e) => e.getAttribute("data-session-id")).filter((v): v is string => !!v),
      ),
    );

    // Every seeded ACTIVE id must be in BOTH (A and B agree) — a divergence
    // (API has it, render doesn't, or vice-versa) is the headline finding.
    for (const seed of SEED_ACTIVE) {
      expect(apiIds.has(seed.id), `API (surface A) must list ${seed.id}`).toBe(true);
      expect(domIds.has(seed.id), `render (surface B) must show ${seed.id}`).toBe(true);
    }
  });

  test("seeded session-list visual baseline (surface B — the CSS/layout catch)", async ({
    page,
  }) => {
    await revealSeededSessions(page);

    // Pin the list region for a stable shot. Mask volatile sub-fields
    // (timestamps, cost, context%) that legitimately tick even with a fixed
    // seed, so the baseline catches structural/CSS regressions — not clock drift.
    // The visual snapshot is the "data correct but renders broken" catch (the
    // scary-fading-presentation failure mode, design-pass §3).
    const firstSeed = page.locator(`[data-session-id="${SEED_ACTIVE[0].id}"]`);
    await expect(firstSeed).toBeVisible();

    await expect(page).toHaveScreenshot("session-list.png", {
      // Mask the live-ticking fields inside the cards.
      mask: [
        page.locator("[data-testid='context-usage-bar']"),
        page.locator("[data-testid='context-usage-fill']"),
      ],
      maxDiffPixelRatio: 0.015,
      animations: "disabled",
    });
  });
});
