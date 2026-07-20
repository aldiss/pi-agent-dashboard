/**
 * Tests for `<ThreadsView />` — the read-only /threads visibility surface.
 *
 * Uses the injectable-fetcher + fixture-manager pattern (sister to
 * `ThreadView.test.tsx`) to demonstrate, with no live server:
 *   • SEED     — the three-thread list + per-thread status + the 3 labeled lanes.
 *   • EMPTY    — the clean "no durable threads yet" empty-state.
 *   • BUILDING — the unregistered-endpoint "not yet wired" graceful-degrade.
 *   • M11      — the message lane renders EVERY native row (no tool-grouping).
 *
 * jsdom scrollTo/matchMedia stubs mirror ChatView.show-all-activity.test.tsx
 * (the embedded ChatView needs them).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react";
import React from "react";

import { ThreadsView } from "../ThreadsView.js";
import { ThemeProvider } from "../ThemeProvider.js";
import {
  seedThreadsListFetcher,
  emptyThreadsListFetcher,
  buildingThreadsListFetcher,
  seedHandoffLaneFetcher,
  seedDeliveredManager,
  SEED_THREAD_DELIVERED,
  SEED_THREAD_BUILDING,
} from "../../lib/tier1-threads-seed.js";
import type { ReadonlySessionManagerLike } from "@blackbelt-technology/pi-dashboard-shared/thread-durability/tier1/cloned-session-facade.js";

beforeAll(() => {
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-color-scheme: dark)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

/** Provider: only the delivered seed thread has a durable message lane. */
const seedManagerProvider = (threadId: string): ReadonlySessionManagerLike | null =>
  threadId === SEED_THREAD_DELIVERED ? seedDeliveredManager() : null;

function renderSeed() {
  return render(
    <ThemeProvider>
      <ThreadsView
        fetcher={seedThreadsListFetcher}
        messageLaneProvider={seedManagerProvider}
        handoffFetcher={seedHandoffLaneFetcher}
      />
    </ThemeProvider>,
  );
}

describe("ThreadsView — seed data", () => {
  it("renders one row per seed thread with a status badge", async () => {
    const { queryAllByTestId, queryByTestId } = renderSeed();
    await waitFor(() => expect(queryByTestId("threads-list")).not.toBeNull());
    expect(queryAllByTestId("thread-row")).toHaveLength(3);
    // Every row carries a P1 status badge.
    expect(queryAllByTestId("thread-status-badge").length).toBeGreaterThanOrEqual(3);
  });

  it("shows the count + a flat-today explainer", async () => {
    const { queryByTestId, container } = renderSeed();
    await waitFor(() => expect(queryByTestId("threads-count")).not.toBeNull());
    expect(queryByTestId("threads-count")?.textContent).toContain("3");
    expect(container.textContent ?? "").toContain("Flat today");
  });

  it("renders the per-thread status verdict (delivered thread → delivered pill)", async () => {
    const { container } = renderSeed();
    await waitFor(() => expect(container.querySelector('[data-testid="threads-list"]')).not.toBeNull());
    const deliveredRow = container.querySelector(`[data-thread-id="${SEED_THREAD_DELIVERED}"]`);
    expect(deliveredRow?.querySelector('[data-status-kind="delivered"]')).not.toBeNull();
  });

  it("renders the building/not-yet-wired graceful-degrade on a fresh thread's badge", async () => {
    const { container } = renderSeed();
    await waitFor(() => expect(container.querySelector('[data-testid="threads-list"]')).not.toBeNull());
    const buildingRow = container.querySelector(`[data-thread-id="${SEED_THREAD_BUILDING}"]`);
    expect(buildingRow?.querySelector('[data-status-kind="building"]')).not.toBeNull();
  });
});

describe("ThreadsView — the three history lanes", () => {
  it("renders all three lanes for the selected thread, each non-authoritative + gap-badged", async () => {
    const { queryByTestId } = renderSeed();
    // Delivered thread is default-selected (first in the list).
    await waitFor(() => expect(queryByTestId("thread-history-lanes")).not.toBeNull());
    // All three lanes present.
    expect(queryByTestId("lane-message")).not.toBeNull();
    expect(queryByTestId("lane-status")).not.toBeNull();
    expect(queryByTestId("lane-handoff")).not.toBeNull();
    // Each wears the non-authoritative label.
    expect(queryByTestId("lane-message-nonauthoritative")).not.toBeNull();
    expect(queryByTestId("lane-status-nonauthoritative")).not.toBeNull();
    expect(queryByTestId("lane-handoff-nonauthoritative")).not.toBeNull();
    // Status + hand-off carry their gap badges (empty until Tier-3 / A4).
    expect(queryByTestId("lane-status-gap-badge")).not.toBeNull();
    expect(queryByTestId("lane-handoff-gap-badge")).not.toBeNull();
  });

  it("message lane renders the ChatView read-path (through the P1 facade) for a populated thread", async () => {
    const { queryByTestId } = renderSeed();
    await waitFor(() => expect(queryByTestId("lane-message-chatview")).not.toBeNull());
  });

  it("status lane is diagnostic-empty until Tier-3", async () => {
    const { queryByTestId } = renderSeed();
    await waitFor(() => expect(queryByTestId("lane-status-empty")).not.toBeNull());
    expect(queryByTestId("lane-status-empty")?.textContent).toContain("No durable status source yet");
  });

  it("hand-off lane is empty until the A4 verb (honest label, not an error)", async () => {
    const { queryByTestId } = renderSeed();
    await waitFor(() => expect(queryByTestId("lane-handoff-empty")).not.toBeNull());
    expect(queryByTestId("lane-handoff-empty")?.textContent).toContain("No hand-off events yet");
  });

  it("selecting the building thread shows its empty message lane (no durable rows)", async () => {
    const { container, queryByTestId } = renderSeed();
    await waitFor(() => expect(queryByTestId("threads-list")).not.toBeNull());
    const buildingRow = container.querySelector(`[data-thread-id="${SEED_THREAD_BUILDING}"]`) as HTMLElement;
    fireEvent.click(buildingRow);
    await waitFor(() => expect(queryByTestId("lane-message-empty")).not.toBeNull());
    expect(queryByTestId("lane-message-empty")?.textContent).toContain("No durable message rows yet");
  });
});

describe("ThreadsView — M11 (no tool-grouping on the message lane)", () => {
  it("renders the identical bash polls as distinct rows, NOT a collapsed ×N group", async () => {
    const { container, queryByTestId } = renderSeed();
    await waitFor(() => expect(queryByTestId("lane-message-chatview")).not.toBeNull());
    // The collapsed-group affordance must NOT appear (grouping disabled). With
    // grouping ON, the 3 identical bash polls would collapse to one
    // `collapsed-group` pill; M11 keeps them as distinct native rows.
    expect(container.querySelector('[data-testid="collapsed-group"]')).toBeNull();
  });
});

describe("ThreadsView — empty-state", () => {
  it("renders the clean 'no durable threads yet' empty-state", async () => {
    const { queryByTestId } = render(
      <ThemeProvider>
        <ThreadsView fetcher={emptyThreadsListFetcher} />
      </ThemeProvider>,
    );
    await waitFor(() => expect(queryByTestId("threads-empty")).not.toBeNull());
    expect(queryByTestId("threads-empty")?.textContent).toContain("No durable threads yet");
  });
});

describe("ThreadsView — building/unregistered graceful-degrade", () => {
  it("renders the 'not yet wired' held state when the endpoint is unregistered (404)", async () => {
    const { queryByTestId } = render(
      <ThemeProvider>
        <ThreadsView fetcher={buildingThreadsListFetcher} />
      </ThemeProvider>,
    );
    await waitFor(() => expect(queryByTestId("threads-unregistered")).not.toBeNull());
    expect(queryByTestId("threads-unregistered")?.textContent).toContain("not yet wired");
  });

  it("renders an error line if the fetcher rejects (never a crash)", async () => {
    const boom = vi.fn().mockRejectedValue(new Error("network down"));
    const { queryByTestId } = render(
      <ThemeProvider>
        <ThreadsView fetcher={boom} />
      </ThemeProvider>,
    );
    await waitFor(() => expect(queryByTestId("threads-error")).not.toBeNull());
    expect(queryByTestId("threads-error")?.textContent).toContain("network down");
  });
});
