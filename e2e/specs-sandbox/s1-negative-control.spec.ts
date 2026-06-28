import { test, expect, type Page } from "@playwright/test";
import { primeApp, headerAppBar, sessionCards } from "../helpers.js";

/**
 * S1 negative-control — proves the S1 render assertions DISCRIMINATE (the
 * broken-row-render catch, design-pass Done-criteria + §5.3-B applied to
 * surface B). The headline scenario's value is only real if it would FAIL when
 * the render is broken. A green-only render suite cannot be trusted.
 *
 * These tests assert the COMPLEMENT of S1's happy path against the SAME real
 * seeded sandbox:
 *   • a UUID that is NOT seeded must be ABSENT — if the dashboard ever rendered
 *     a phantom row (the duplicate/ghost defect, MP-7) this catches it.
 *   • the structural locator that S1 trusts (data-session-id) genuinely reflects
 *     presence — a never-seeded id has count 0, a seeded id has count 1. This is
 *     the discriminating-power proof: the assertion sees a real difference
 *     between present and absent, so a green S1 means the rows really render.
 *
 * (The richest broken-render catch — deploy a row-rendering regression and watch
 * S1 go red — was demonstrated organically during the W4 build: a tier-expand
 * race made S1's structural test genuinely RED [Received: 0/1] until fixed. This
 * spec freezes that discrimination as a permanent regression.)
 */

const SEEDED_PRESENT = "f47ac10b-58cc-4372-a567-0e02b2c3d001"; // a real seeded active row
const NEVER_SEEDED = "00000000-0000-0000-0000-000000000000"; // a row that must NOT exist

async function revealSeededSessions(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".pi-skeleton")).toHaveCount(0, { timeout: 25_000 });
  await expect(headerAppBar(page)).toBeVisible({ timeout: 25_000 });
  await expect(page.getByText("Connecting...", { exact: true })).toHaveCount(0, { timeout: 25_000 });
  const tierIds = ["tier-header-other", "tier-header-operator-chat-pane"];
  await expect
    .poll(async () => {
      let n = 0;
      for (const tid of tierIds) n += await page.getByTestId(tid).count();
      return n;
    }, { timeout: 20_000 })
    .toBeGreaterThan(0);
  for (const tid of tierIds) {
    const header = page.getByTestId(tid);
    if (!(await header.count())) continue;
    if ((await header.first().getAttribute("aria-expanded")) === "false") {
      await header.first().click().catch(() => {});
      await page.waitForTimeout(400);
    }
  }
  await expect.poll(() => sessionCards(page).count(), { timeout: 15_000 }).toBeGreaterThan(0);
}

test.describe("S1 negative-control — the render assertions discriminate (broken-row catch)", () => {
  test.beforeEach(async ({ page }) => {
    await primeApp(page, { skin: "editorial", theme: "dark" });
  });

  test("a never-seeded UUID renders ZERO rows (no phantom/ghost row)", async ({ page }) => {
    await revealSeededSessions(page);
    // If this were nonzero, the dashboard would be inventing rows — the exact
    // ghost/duplicate defect S1's happy path must be trusted to exclude.
    await expect(page.locator(`[data-session-id="${NEVER_SEEDED}"]`)).toHaveCount(0);
  });

  test("discrimination: a seeded UUID is PRESENT and a never-seeded UUID is ABSENT (the assertion sees a real difference)", async ({
    page,
  }) => {
    await revealSeededSessions(page);
    const present = await page.locator(`[data-session-id="${SEEDED_PRESENT}"]`).count();
    const absent = await page.locator(`[data-session-id="${NEVER_SEEDED}"]`).count();
    // present === 1, absent === 0 — the locator genuinely distinguishes a
    // rendered row from a missing one. A suite where both were 0 (or both 1)
    // would be blind; this proves S1's data-session-id assertions are not vacuous.
    expect(present, "the seeded row must render").toBe(1);
    expect(absent, "the never-seeded row must not render").toBe(0);
    expect(present).not.toBe(absent);
  });
});
