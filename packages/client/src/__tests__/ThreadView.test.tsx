/**
 * Tests for `<ThreadView />` — the proof-tracking delivery ledger.
 *
 * Uses the injectable-`fetcher` pattern (same as `DiagnosticsSection`) to feed
 * fixture data with no live server: the seed fixture (all eight lifecycle
 * states), the clean empty-state, and the unregistered-endpoint graceful
 * degrade.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";

import { ThreadView } from "../components/ThreadView.js";
import {
  seedFetcher,
  emptyFetcher,
  unregisteredFetcher,
  SEED_DELIVERIES,
  SEED_THREAD_ID,
} from "../lib/thread-view-seed.js";
import { deriveDisplayState, RAIL_ORDER } from "../lib/thread-view-api.js";

afterEach(() => cleanup());

describe("ThreadView — seed data (all lifecycle states)", () => {
  it("renders one ledger row per seed delivery", async () => {
    const { queryAllByTestId, queryByTestId } = render(<ThreadView threadId={SEED_THREAD_ID} fetcher={seedFetcher} />);
    await waitFor(() => expect(queryByTestId("delivery-rows")).not.toBeNull());
    expect(queryAllByTestId("delivery-row")).toHaveLength(SEED_DELIVERIES.length);
  });

  it("renders EVERY display state (injecting → delivered, + failed + indeterminate)", async () => {
    const { container } = render(<ThreadView threadId={SEED_THREAD_ID} fetcher={seedFetcher} />);
    await waitFor(() => expect(container.querySelector('[data-testid="delivery-rows"]')).not.toBeNull());

    const rendered = Array.from(container.querySelectorAll("[data-display-state]")).map(
      (el) => el.getAttribute("data-display-state"),
    );
    // All eight display states appear exactly once (the seed covers each).
    for (const state of ["injecting", "queued_executing", "observed", "accepted", "executed", "delivered", "failed", "indeterminate"]) {
      expect(rendered).toContain(state);
    }
  });

  it("promotes executed+delivered=true to the `delivered` display state", async () => {
    const { container } = render(<ThreadView threadId={SEED_THREAD_ID} fetcher={seedFetcher} />);
    await waitFor(() => expect(container.querySelector('[data-testid="delivery-rows"]')).not.toBeNull());
    const deliveredRow = container.querySelector('[data-delivery-id="dlv-0006-delivered"]');
    expect(deliveredRow?.getAttribute("data-display-state")).toBe("delivered");
  });

  it("surfaces indeterminate as the live lease overlay (row keeps its durable state underneath)", async () => {
    // The seed row's underlying outbox state is queued_executing; the lease overlay wins.
    const seedRow = SEED_DELIVERIES.find((d) => d.delivery_id === "dlv-0008-indeterminate")!;
    expect(seedRow.state).toBe("queued_executing");
    expect(deriveDisplayState(seedRow)).toBe("indeterminate");

    const { container } = render(<ThreadView threadId={SEED_THREAD_ID} fetcher={seedFetcher} />);
    await waitFor(() => expect(container.querySelector('[data-testid="delivery-rows"]')).not.toBeNull());
    expect(container.querySelector('[data-testid="offrail-badge-indeterminate"]')).not.toBeNull();
  });

  it("renders the six-segment lifecycle rail on every row", async () => {
    const { queryAllByTestId, queryByTestId } = render(<ThreadView threadId={SEED_THREAD_ID} fetcher={seedFetcher} />);
    await waitFor(() => expect(queryByTestId("delivery-rows")).not.toBeNull());
    const rails = queryAllByTestId("lifecycle-rail");
    expect(rails).toHaveLength(SEED_DELIVERIES.length);
    // Each rail has exactly RAIL_ORDER.length segments.
    for (const seg of RAIL_ORDER) {
      expect(queryAllByTestId(`rail-seg-${seg}`).length).toBe(SEED_DELIVERIES.length);
    }
  });

  it("fills the rail monotonically: a delivered row has ALL segments filled", async () => {
    const { container } = render(<ThreadView threadId={SEED_THREAD_ID} fetcher={seedFetcher} />);
    await waitFor(() => expect(container.querySelector('[data-testid="delivery-rows"]')).not.toBeNull());
    const deliveredRow = container.querySelector('[data-delivery-id="dlv-0006-delivered"]')!;
    const segs = deliveredRow.querySelectorAll('[data-testid^="rail-seg-"]');
    expect(segs.length).toBe(RAIL_ORDER.length);
    expect(Array.from(segs).every((s) => s.getAttribute("data-filled") === "1")).toBe(true);
  });

  it("an injecting row has only the first segment filled (least progress)", async () => {
    const { container } = render(<ThreadView threadId={SEED_THREAD_ID} fetcher={seedFetcher} />);
    await waitFor(() => expect(container.querySelector('[data-testid="delivery-rows"]')).not.toBeNull());
    const row = container.querySelector('[data-delivery-id="dlv-0001-injecting"]')!;
    const filled = Array.from(row.querySelectorAll('[data-testid^="rail-seg-"]')).filter(
      (s) => s.getAttribute("data-filled") === "1",
    );
    expect(filled.length).toBe(1); // only `injecting`
  });

  it("shows revision, delivery_id, attempt and a timestamp per row (ledger foot)", async () => {
    const { container } = render(<ThreadView threadId={SEED_THREAD_ID} fetcher={seedFetcher} />);
    await waitFor(() => expect(container.querySelector('[data-testid="delivery-rows"]')).not.toBeNull());
    const row = container.querySelector('[data-delivery-id="dlv-0004-accepted"]')!;
    expect(row.querySelector('[data-testid="delivery-revision"]')?.textContent).toContain("rev 3");
    expect(row.querySelector('[data-testid="delivery-id"]')?.textContent).toBe("dlv-0004-accepted");
    expect(row.querySelector('[data-testid="delivery-ts"]')?.textContent).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z/);
  });

  it("renders the header thread id + the summary strip", async () => {
    const { queryByTestId } = render(<ThreadView threadId={SEED_THREAD_ID} fetcher={seedFetcher} />);
    await waitFor(() => expect(queryByTestId("delivery-rows")).not.toBeNull());
    expect(queryByTestId("thread-id")?.textContent).toBe(SEED_THREAD_ID);
    // 1 delivered, 1 failed, the rest in-flight (8 total).
    expect(queryByTestId("summary-delivered")?.textContent).toContain("1");
    expect(queryByTestId("summary-failed")?.textContent).toContain("1");
    expect(queryByTestId("summary-inflight")?.textContent).toContain("6");
  });

  it("orders rows newest-first (updated_at desc)", async () => {
    const { container } = render(<ThreadView threadId={SEED_THREAD_ID} fetcher={seedFetcher} />);
    await waitFor(() => expect(container.querySelector('[data-testid="delivery-rows"]')).not.toBeNull());
    const ids = Array.from(container.querySelectorAll("[data-delivery-id]")).map((el) => el.getAttribute("data-delivery-id"));
    // dlv-0008 (indeterminate) has the latest updated_at → first.
    expect(ids[0]).toBe("dlv-0008-indeterminate");
  });
});

describe("ThreadView — empty-state", () => {
  it("renders a clean 'no deliveries yet' empty-state for an empty registered thread", async () => {
    const { queryByTestId } = render(<ThreadView threadId="empty-thread" fetcher={emptyFetcher} />);
    await waitFor(() => expect(queryByTestId("thread-view-empty")).not.toBeNull());
    expect(queryByTestId("thread-view-empty")?.textContent).toContain("No deliveries yet");
    expect(queryByTestId("delivery-rows")).toBeNull();
  });
});

describe("ThreadView — graceful degrade (unregistered endpoint)", () => {
  it("renders the held-routing state when the endpoint is unregistered (404), never crashes", async () => {
    const { queryByTestId } = render(<ThreadView threadId="any" fetcher={unregisteredFetcher} />);
    await waitFor(() => expect(queryByTestId("thread-view-unregistered")).not.toBeNull());
    expect(queryByTestId("thread-view-unregistered")?.textContent).toContain("not yet active");
  });

  it("renders an error line if the fetcher rejects (never a crash)", async () => {
    const boom = vi.fn().mockRejectedValue(new Error("network down"));
    const { queryByTestId } = render(<ThreadView threadId="any" fetcher={boom} />);
    await waitFor(() => expect(queryByTestId("thread-view-error")).not.toBeNull());
    expect(queryByTestId("thread-view-error")?.textContent).toContain("network down");
  });
});
