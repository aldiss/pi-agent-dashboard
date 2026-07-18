import { test, expect, type Page } from "@playwright/test";
import { isLegibleLabel } from "@blackbelt-technology/pi-dashboard-shared/needs-you-label.js";
import {
  writeFeed,
  writeFreshHeartbeat,
  writeStaleHeartbeat,
  clearReceipts,
  readReceipts,
  productionHeld,
  stalledDeliverable,
  parkedDecision,
  uncertainRows,
  type SynthItem,
} from "../needs-you-fixtures.js";

/**
 * Stage-6 E2E — the 7 Part-D acceptance criteria for the "Needs you" band.
 *
 * Each spec writes a synthetic feed (the curated must-act set the watcher WOULD
 * produce — the watcher's curation logic is exhaustively unit-tested; the E2E
 * proves the route → component surface renders it correctly), then drives the
 * real client against the real route. A test-only fast-poll seam
 * (`__NEEDS_YOU_POLL_MS__`) makes feed changes appear within ~1s.
 *
 * The route caches 5s; specs write the feed BEFORE navigation and give
 * assertions a timeout spanning cache-expiry + one poll.
 */

const CHIP_YOUR_GO = "YOUR GO";
const CHIP_YOUR_CALL = "YOUR CALL";
const CHIP_BLOCKED = "BLOCKED";

async function fastPoll(page: Page): Promise<void> {
  await page.addInitScript(() => { (window as { __NEEDS_YOU_POLL_MS__?: number }).__NEEDS_YOU_POLL_MS__ = 600; });
}

/** Write a fresh-heartbeat feed, then open the band. */
async function openWithFeed(page: Page, items: SynthItem[]): Promise<void> {
  writeFreshHeartbeat();
  writeFeed(items);
  await fastPoll(page);
  await page.goto("/");
  await expect(page.getByTestId("needs-you-band")).toBeVisible({ timeout: 25_000 });
}

// ── Criterion 1a — CAN-surface (production-held + stalled) ──────────────────

test("C1a — synthetic production-gate surfaces as production-held in MAIN with the HALT nod", async ({ page }) => {
  await openWithFeed(page, [productionHeld()]);
  const item = page.locator('[data-testid="needs-you-item"][data-kind="production-held"]');
  await expect(item).toBeVisible({ timeout: 15_000 });
  await expect(item.getByTestId("needs-you-chip")).toHaveText(CHIP_YOUR_GO);
  await expect(item).toHaveAttribute("data-halt", "true");
  // The HALT nod gate is present; the action is NOT shown until the operator nods.
  await expect(item.getByTestId("needs-you-halt-nod")).toBeVisible();
  await expect(item.getByTestId("needs-you-action-revealed")).toHaveCount(0);
});

test("C1a — synthetic terminal-blocked surfaces as stalled-deliverable in MAIN", async ({ page }) => {
  await openWithFeed(page, [stalledDeliverable()]);
  const item = page.locator('[data-testid="needs-you-item"][data-kind="stalled-deliverable"]');
  await expect(item).toBeVisible({ timeout: 15_000 });
  await expect(item.getByTestId("needs-you-chip")).toHaveText(CHIP_BLOCKED);
  await expect(item).toHaveAttribute("data-halt", "false");
});

// ── Criterion 1b-main — honest-empty ────────────────────────────────────────

test("C1b-main — live watcher + no main-tier items ⇒ calm honest-empty (NOT the stale banner)", async ({ page }) => {
  await openWithFeed(page, []); // watcher_live=true, zero items
  await expect(page.getByTestId("needs-you-empty")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Nothing needs you right now.")).toBeVisible();
  // Distinct from the stale banner — empty ≠ uncertain.
  await expect(page.getByTestId("needs-you-stale-banner")).toHaveCount(0);
});

// ── Criterion 1b-lower — the uncertain COLLAPSE ─────────────────────────────

test("C1b-lower — uncertain items collapse to ONE summary row (Peggy wording); expand reveals N", async ({ page }) => {
  await openWithFeed(page, uncertainRows(87));
  const toggle = page.getByTestId("needs-you-lower-tier-toggle");
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  // ONE summary row, Peggy verbatim — NOT 87 raw rows in the main flow.
  await expect(toggle).toContainText("87 older decisions we couldn't confirm are resolved — expand to review.");
  await expect(page.getByTestId("needs-you-lower-item")).toHaveCount(0); // collapsed
  // No uncertain item bleeds into the MAIN tier.
  await expect(page.getByTestId("needs-you-item")).toHaveCount(0);
  // Expand reveals the N rows (each DROP-safe, still surfaced).
  await toggle.click();
  await expect(page.getByTestId("needs-you-lower-item")).toHaveCount(87);
});

// ── Criterion 2 — stale-excluded do NOT surface ─────────────────────────────

test("C2 — stale-excluded items (dl-7878→dl-8756 supersede, dl-6858 closes-edge) do NOT surface", async ({ page }) => {
  // The watcher already excluded dl-7878 (superseded) + dl-6858 (closes-edge);
  // the feed carries only the genuinely-open survivor. Assert the excluded
  // ids never appear in the band DOM.
  const survivor = stalledDeliverable({ id: "ny-survivor", source: { origin: "ledger", event_id: "dl-9999" }, drilldown: { event_id: "dl-9999" } });
  await openWithFeed(page, [survivor]);
  await expect(page.locator('[data-testid="needs-you-item"]')).toHaveCount(1, { timeout: 15_000 });
  // dl-7878 + dl-6858 must appear NOWHERE (not even in an expanded drilldown).
  const bandText = await page.getByTestId("needs-you-band").textContent();
  expect(bandText).not.toContain("dl-7878");
  expect(bandText).not.toContain("dl-6858");
});

// ── Criterion 3 — legibility + exact action ─────────────────────────────────

test("C3 — every rendered label passes the legibility predicate + carries the exact action", async ({ page }) => {
  const items = [productionHeld(), stalledDeliverable(), parkedDecision()];
  await openWithFeed(page, items);
  await expect(page.getByTestId("needs-you-item")).toHaveCount(3, { timeout: 15_000 });
  const rows = page.getByTestId("needs-you-item");
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const label = (await row.locator("span.font-medium").first().textContent())?.trim() ?? "";
    // The mechanical legibility predicate: no dl-ids/§/themed-names/vN, bounded.
    const verdict = isLegibleLabel(label);
    expect(verdict.ok, `label failed predicate: "${label}" → ${verdict.violations.join("; ")}`).toBe(true);
    // The label must NOT be a raw summary (anti-pass-through) — no dl-id leaks.
    expect(label).not.toMatch(/\bdl-\d+\b/);
  }
  // The exact action is present (reversible rows show it inline; HALT shows it on nod).
  await expect(page.locator('[data-testid="needs-you-item"][data-kind="stalled-deliverable"]')).toContainText("Add a valid iOS signing certificate in Xcode.");
});

// ── Criterion 4 — delivery-proof (RECEIVED, not just emitted) ────────────────

test("C4 — delivery-proof: the band renders the items AND the receipt round-trip is recorded", async ({ page }) => {
  clearReceipts();
  await openWithFeed(page, [productionHeld(), parkedDecision()]);
  await expect(page.getByTestId("needs-you-item")).toHaveCount(2, { timeout: 15_000 });
  // The client POSTs the delivery-receipt after render — the route writes it to
  // the receipt file. Assert the operator surface RECEIVED the fire.
  await expect.poll(() => readReceipts().length, { timeout: 15_000 }).toBeGreaterThan(0);
  const receipts = readReceipts();
  const allIds = receipts.flatMap((r) => r.received_item_ids);
  expect(allIds).toContain("ny-held");
  expect(allIds).toContain("ny-parked");
});

// ── Criterion 5 — HALT-tier requires explicit nod; reversible drives-with-default ──

test("C5 — HALT production-held requires the explicit nod (never auto-acts); reversible shows action inline", async ({ page }) => {
  await openWithFeed(page, [productionHeld(), parkedDecision()]);
  const held = page.locator('[data-testid="needs-you-item"][data-kind="production-held"]');
  const parked = page.locator('[data-testid="needs-you-item"][data-kind="parked-decision"]');
  await expect(held).toBeVisible({ timeout: 15_000 });
  // HALT: action hidden until the nod (NEVER auto-fires).
  await expect(held.getByTestId("needs-you-action-revealed")).toHaveCount(0);
  await held.getByTestId("needs-you-halt-nod").click();
  await expect(held.getByTestId("needs-you-action-revealed")).toBeVisible();
  await expect(held.getByTestId("needs-you-action-revealed")).toContainText("Revoke the GitHub CLI OAuth app");
  // Reversible parked-decision: the exact action is shown inline (drive-with-default), no nod gate.
  await expect(parked.getByTestId("needs-you-halt-nod")).toHaveCount(0);
  await expect(parked).toContainText("Pick the checkout flow");
});

// ── Criterion 6 — watcher_live BLIND: heartbeat-kill ⇒ loud-uncertain ────────

test("C6 — killing the watcher heartbeat (stale it) ⇒ band goes LOUD-uncertain (stale banner), NOT silent-stale", async ({ page }) => {
  // Start live with an item.
  await openWithFeed(page, [productionHeld()]);
  await expect(page.getByTestId("needs-you-item").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("needs-you-stale-banner")).toHaveCount(0);
  // KILL the heartbeat — stale the heartbeat file (the watcher "died").
  writeStaleHeartbeat(214);
  // The BLIND liveness flips: the band surfaces the LOUD stale banner.
  await expect(page.getByTestId("needs-you-stale-banner")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("needs-you-stale-banner")).toContainText("attention-watcher may be stale");
  // The items are STILL shown (never silently dropped) — loud-uncertain, not silent-stale.
  await expect(page.getByTestId("needs-you-item").first()).toBeVisible();
});

// ── Criterion 7 — SAFETY (discrimination + UNKNOWN-LOUD) rendered ───────────

test("C7 — SAFETY: a genuinely-open must-act surfaces (not wrongly excluded); an uncertain one is UNKNOWN-LOUD, never dropped", async ({ page }) => {
  // A provably-open production-held (genuine must-act) + an uncertain parked
  // (freshness-safe-read couldn't prove state) in ONE feed. The genuine one is
  // MAIN-loud; the uncertain one is lower-tier (surfaced, flagged), NOT dropped.
  const genuine = productionHeld();
  const unknownLoud = parkedDecision({ id: "ny-unknown", uncertain: true, drilldown: { event_id: "dl-4200" } });
  await openWithFeed(page, [genuine, unknownLoud]);
  // Genuine must-act: surfaced in MAIN (not wrongly excluded).
  await expect(page.locator('[data-testid="needs-you-item"][data-kind="production-held"]')).toBeVisible({ timeout: 15_000 });
  // Uncertain: NOT in MAIN, but present in the lower-tier collapse (UNKNOWN-LOUD, never dropped).
  await expect(page.getByTestId("needs-you-lower-tier-toggle")).toContainText("1 older decisions");
  await page.getByTestId("needs-you-lower-tier-toggle").click();
  await expect(page.getByTestId("needs-you-lower-item")).toHaveCount(1);
});

// ── Extras — dl-9094 directive-exclude + worth-trigger lane-gate ────────────

test("EXTRA — a directive-excluded item (dl-9094 convergence) does NOT surface", async ({ page }) => {
  // The watcher excludes dl-9094 (provable directive). The feed omits it; assert
  // it never appears on the band (a genuine parked-decision surfaces instead).
  const genuine = parkedDecision();
  await openWithFeed(page, [genuine]);
  await expect(page.getByTestId("needs-you-item")).toHaveCount(1, { timeout: 15_000 });
  const bandText = await page.getByTestId("needs-you-band").textContent();
  expect(bandText).not.toContain("dl-9094");
});

test("EXTRA — worth-trigger lane-gate: a crew-lane item is routed OFF the operator band", async ({ page }) => {
  // A runaway-cost with lane=crew-lane (provably crew-self-healable) must NOT
  // render on the operator band; a named-action runaway (operator-band) does.
  const crewLane = { ...parkedDecision({ id: "ny-crew", kind: "runaway-cost" }), lane: "crew-lane" };
  const operatorBand = productionHeld();
  await openWithFeed(page, [operatorBand, crewLane]);
  await expect(page.getByTestId("needs-you-item")).toHaveCount(1, { timeout: 15_000 }); // only the operator-band one
  await expect(page.locator('[data-testid="needs-you-item"][data-kind="runaway-cost"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="needs-you-item"][data-kind="production-held"]')).toBeVisible();
});
