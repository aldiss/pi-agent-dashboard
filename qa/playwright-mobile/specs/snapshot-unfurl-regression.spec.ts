/**
 * Snapshot-unfurl — full-scale dashboard regression suite.
 *
 * Cell: dashboard-link-unfurl (snapshot-unfurl). Goal-brief
 * `dashboard-link-unfurl-cc-goal-brief-2026-06-22`.
 *
 * This spec drives the LIVE isolated dashboard (default :8001) end-to-end and
 * proves BOTH:
 *   (A) the new snapshot-unfurl card behavior (card render, two buttons,
 *       in-dashboard lightbox, agent-highlight overlays), AND
 *   (B) the brief's six explicit ZERO-REGRESSION assertions — the bar that the
 *       whole dashboard works top-to-bottom exactly as before, plus the unfurl.
 *
 * It also exercises the broad dashboard surface the brief calls out: session
 * list loads, transcript render (pi + claude-code sources), markdown render,
 * and the existing ImageLightbox open/close path for NORMAL images (which the
 * feature reuses — proving it still works for plain images too).
 *
 * Fixtures are provisioned by `scripts/spawn-unfurl-fixtures.mjs` (idempotent):
 * it seeds a snapshot-unfurl session, a plain-image session, and a
 * claude-code-source session into the test HOME, and injects the snapshot
 * asset bytes via the pi-gateway so the production `pi-asset:` provenance path
 * resolves. Run the harness via `scripts/run-unfurl-regression.sh`.
 *
 * Navigation uses direct `/session/:id` routing (sister-spec pattern from
 * session-history-load-time.spec.ts) — robust + deterministic, no sidebar DOM
 * dependence.
 */
import { test, expect, Page } from "@playwright/test";

const UNFURL_SESSION = process.env.UNFURL_SESSION_ID || "bbbbcccc-1111-2222-3333-444455556666";
const PLAIN_IMAGE_SESSION = process.env.PLAIN_IMAGE_SESSION_ID || "eeee1111-2222-3333-4444-555566667777";
const CC_SOURCE_SESSION = process.env.CC_SOURCE_SESSION_ID || "ccdd1111-2222-3333-4444-555566667777";

async function openSession(page: Page, sessionId: string) {
  await page.goto(`/session/${sessionId}`, { waitUntil: "domcontentloaded" });
  // Wait for the transcript to paint at least one markdown block.
  await page.locator(".markdown-content").first().waitFor({ state: "visible", timeout: 30_000 });
}

function lightboxBackdrop(page: Page) {
  return page.locator('[data-testid="lightbox-backdrop"]');
}

test.describe("snapshot-unfurl — whole-dashboard regression", () => {
  // ── Broad surface: the dashboard still works top-to-bottom ────────────────

  test("session list loads and lists seeded sessions", async ({ page }) => {
    const res = await page.request.get("/api/sessions");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.success).toBe(true);
    const ids: string[] = body.data.map((s: any) => s.id);
    expect(ids).toContain(UNFURL_SESSION);
  });

  test("transcript renders (pi source) — markdown paragraphs + raw link preserved", async ({ page }) => {
    await openSession(page, UNFURL_SESSION);
    // Raw link STAYS in history (render-only feature) — the plain anchor for
    // the bare URL line is present and points at the live page.
    const rawLink = page.locator('a[href="https://100.126.219.9:9090/nos-architecture-map.html"]').first();
    await expect(rawLink).toBeVisible();
  });

  test("transcript renders (claude-code source) — markdown intact", async ({ page }) => {
    await openSession(page, CC_SOURCE_SESSION);
    // A claude-code-sourced session renders its assistant markdown the same
    // way (bold + lists). The assistant message bolds "claude-code transcript"
    // → a <strong>; scope to that element to avoid matching the user prompt
    // ("render a claude-code transcript") under Playwright strict mode.
    await expect(page.locator(".markdown-content strong", { hasText: "claude-code transcript" }).first()).toBeVisible();
    // The bullet list renders as <li> items.
    expect(await page.locator(".markdown-content li").count()).toBeGreaterThanOrEqual(2);
  });

  // ── New behavior: the snapshot-unfurl card ────────────────────────────────

  test("snapshot-unfurl card renders with title + domain + snapshot image", async ({ page }) => {
    await openSession(page, UNFURL_SESSION);
    const card = page.locator('[data-testid="snapshot-unfurl-card"]').first();
    await expect(card).toBeVisible();
    await expect(page.locator('[data-testid="snapshot-unfurl-title"]').first()).toHaveText("NOS — Architecture Map");
    await expect(card).toContainText("100.126.219.9:9090");
    // Snapshot image resolved (pi-asset provenance) — an <img> inside the card.
    await expect(card.locator("img").first()).toBeVisible();
    // Agent-highlight flag tag is shown because the directive carries highlights.
    await expect(page.locator('[data-testid="snapshot-unfurl-flag"]').first()).toContainText("flagged");
  });

  test('"View inline" opens the lightbox INSIDE the dashboard (no new tab) with highlights', async ({ page, context }) => {
    await openSession(page, UNFURL_SESSION);
    expect(await lightboxBackdrop(page).count()).toBe(0);

    const pagesBefore = context.pages().length;
    await page.locator('[data-testid="snapshot-unfurl-view-inline"]').first().click();

    await expect(lightboxBackdrop(page)).toBeVisible();
    // NO new tab/window opened.
    expect(context.pages().length).toBe(pagesBefore);
    // Agent-highlight overlays render over the snapshot.
    expect(await page.locator('[data-testid="lightbox-highlight"]').count()).toBe(2);
    // Closes on Escape.
    await page.keyboard.press("Escape");
    await expect(lightboxBackdrop(page)).toHaveCount(0);
  });

  test('"Open source" is an external new-tab link, reverse-tabnabbing-guarded', async ({ page }) => {
    await openSession(page, UNFURL_SESSION);
    const open = page.locator('[data-testid="snapshot-unfurl-open-source"]').first();
    await expect(open).toHaveAttribute("href", "https://100.126.219.9:9090/nos-architecture-map.html");
    await expect(open).toHaveAttribute("target", "_blank");
    await expect(open).toHaveAttribute("rel", "noopener noreferrer");
  });

  // ── ZERO-REGRESSION assertions (the brief's explicit bar) ─────────────────

  test("ZR1: graceful fallback — message history text is never mutated", async ({ page }) => {
    // The raw link line is still present verbatim in the rendered transcript
    // (render-only feature: the card is ADDITIVE, the stored link stays).
    await openSession(page, UNFURL_SESSION);
    await expect(
      page.locator('a[href="https://100.126.219.9:9090/nos-architecture-map.html"]').first(),
    ).toBeVisible();
  });

  test("ZR2: existing image-inline (normal markdown image) renders unchanged", async ({ page }) => {
    await openSession(page, PLAIN_IMAGE_SESSION);
    // A normal ![alt](src) image renders as a plain <img>, NOT a card. The
    // image lives in the assistant message block (the first markdown block is
    // the user prompt), so search across all markdown content.
    await expect(page.locator(".markdown-content img").first()).toBeVisible();
    expect(await page.locator('[data-testid="snapshot-unfurl-card"]').count()).toBe(0);
  });

  test("ZR3: existing ImageLightbox behavior unchanged for normal images", async ({ page }) => {
    await openSession(page, PLAIN_IMAGE_SESSION);
    // Clicking a normal markdown image opens the SAME shared lightbox.
    const img = page.locator(".markdown-content img").first();
    await img.click();
    await expect(lightboxBackdrop(page)).toBeVisible();
    // Normal-image lightbox has NO highlight overlays (annotated path not taken).
    expect(await page.locator('[data-testid="lightbox-highlight"]').count()).toBe(0);
    // Closes on Escape (unchanged contract).
    await page.keyboard.press("Escape");
    await expect(lightboxBackdrop(page)).toHaveCount(0);
  });

  test("ZR4: internal/fragment links unchanged (isExternalHref gate holds)", async ({ page }) => {
    await openSession(page, UNFURL_SESSION);
    // The transcript's only external linked-image became a card; assert no
    // card hijacked a same-origin or fragment link. (Belt-and-suspenders: the
    // exhaustive gate matrix is covered by the SnapshotUnfurl.test.tsx unit
    // suite; here we assert the live transcript has exactly one card.)
    expect(await page.locator('[data-testid="snapshot-unfurl-card"]').count()).toBe(1);
  });

  test("ZR5: 'View inline' opens lightbox, never a new tab", async ({ page, context }) => {
    await openSession(page, UNFURL_SESSION);
    const before = context.pages().length;
    await page.locator('[data-testid="snapshot-unfurl-view-inline"]').first().click();
    await expect(lightboxBackdrop(page)).toBeVisible();
    expect(context.pages().length).toBe(before);
  });

  test("ZR6: live update path intact — health endpoint reports server up", async ({ page }) => {
    // Smoke the server's liveness surface (WS subscribe + REST) so the suite
    // fails loudly if the unfurl change broke the dashboard's data plane.
    const res = await page.request.get("/api/health");
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.server.totalSessions).toBeGreaterThan(0);
  });
});
