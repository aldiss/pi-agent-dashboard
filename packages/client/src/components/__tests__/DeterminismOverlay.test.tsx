/**
 * DeterminismOverlay render test — binds the overlay against the FROZEN fixture
 * (`_fixture/fixture-c23c8d47.json`) through the shared fs loader and asserts the
 * rendered DOM for the 3 fixture cases:
 *
 *   • MULTI-EDGE / spine-only  — stage + stage_meaning + 7 pending edges, with
 *     2 DISTINCT `reaped` edges (keyed by via_event, never de-duped on `to`),
 *     deterministic→gate label, judgment→who label + dashed line, + a
 *     "partial fold" degrade badge.
 *   • EMPTY-PENDING            — a stage with empty pending → NO edges + the
 *     projection-scoped "no pending transitions in this projection" copy (NOT a
 *     terminality claim; the fold is spine-only/partial).
 *   • UNMAPPED                 — stage:null / degrade:"unmapped" → the calm
 *     "not mapped / unknown" state (NOT an error).
 *
 * The projections come from the REAL fixture via `makeFixtureDeterminismFetcher`
 * (vitest's client project runs on Node, so the fs loader is available). This is
 * a SHAPE binding: it asserts edge COUNTS + tagging + degrade handling, never a
 * momentary stage value.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import React from "react";

import { DeterminismOverlay } from "../DeterminismOverlay.js";
import { ThreadsView } from "../ThreadsView.js";
import { ThemeProvider } from "../ThemeProvider.js";
import {
  makeFixtureDeterminismFetcher,
  loadDeterminismProjectionMap,
} from "@blackbelt-technology/pi-dashboard-shared/thread-durability/tier1/determinism-fixture.js";
import type { DeterminismProjection } from "@blackbelt-technology/pi-dashboard-shared/thread-durability/tier1/determinism-projection.js";

const MULTI_EDGE_THREAD = "peggy+attention-app";

function projection(threadId: string): DeterminismProjection {
  const p = loadDeterminismProjectionMap().get(threadId);
  if (!p) throw new Error(`fixture missing ${threadId}`);
  return p;
}
/** The frozen empty-pending + unmapped samples, found by SHAPE (not pinned stage). */
function emptyPendingProjection(): DeterminismProjection {
  const p = [...loadDeterminismProjectionMap().values()].find(
    (x) => x.stage !== null && x.degrade !== "unmapped" && x.pending.length === 0,
  );
  if (!p) throw new Error("fixture has no empty-pending sample");
  return p;
}
function unmappedProjection(): DeterminismProjection {
  const p = [...loadDeterminismProjectionMap().values()].find((x) => x.degrade === "unmapped");
  if (!p) throw new Error("fixture has no unmapped sample");
  return p;
}

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

function renderOverlay(p: DeterminismProjection | null) {
  return render(
    <ThemeProvider>
      <DeterminismOverlay projection={p} />
    </ThemeProvider>,
  );
}

describe("DeterminismOverlay — multi-edge / spine-only case", () => {
  it("renders the stage + stage_meaning gloss", () => {
    const p = projection(MULTI_EDGE_THREAD);
    const { queryByTestId } = renderOverlay(p);
    const stage = queryByTestId("determinism-stage");
    expect(stage).not.toBeNull();
    // Binds the ACTUAL fixture stage (shape: a non-empty stage string is shown),
    // without this test pinning the fold to a forever-value.
    expect(stage?.getAttribute("data-stage")).toBe(p.stage);
    expect(queryByTestId("determinism-stage-meaning")).not.toBeNull();
  });

  it("renders exactly 7 pending edges, with 2 DISTINCT reaped edges", () => {
    const { getAllByTestId, container } = renderOverlay(projection(MULTI_EDGE_THREAD));
    const edges = getAllByTestId("determinism-edge");
    expect(edges).toHaveLength(7);

    // Two edges target `reaped` — both present as DISTINCT rows (different
    // via_event, distinct data-edge-key). A de-dupe-on-`to` regression would
    // drop one of these and this fails loud.
    const reaped = container.querySelectorAll('[data-testid="determinism-edge"][data-to="reaped"]');
    expect(reaped).toHaveLength(2);
    const reapedKeys = new Set(Array.from(reaped).map((e) => e.getAttribute("data-edge-key")));
    expect(reapedKeys.size).toBe(2);
    const reapedVia = Array.from(reaped).map((e) => e.getAttribute("data-via-event")).sort();
    expect(reapedVia).toEqual(["operator-reap", "sweep-reap"]);
  });

  it("tags deterministic edges with a gate label + solid line, judgment edges with a who label + dashed line", () => {
    const { container } = renderOverlay(projection(MULTI_EDGE_THREAD));

    // Deterministic edges → gate label, solid edge line, green accent token.
    const det = container.querySelectorAll('[data-testid="determinism-edge"][data-kind="deterministic"]');
    expect(det.length).toBeGreaterThan(0);
    for (const e of Array.from(det)) {
      expect(e.querySelector('[data-testid="determinism-edge-gate"]')).not.toBeNull();
      expect(e.querySelector('[data-testid="determinism-edge-who"]')).toBeNull();
      const line = e.querySelector('[data-testid="determinism-edge-line"]');
      expect(line?.getAttribute("data-line-style")).toBe("solid");
      // Theme-safe green token, no hardcoded hex.
      expect((line as HTMLElement | null)?.style.color).toContain("--accent-green");
    }

    // Judgment edges → who label, dashed edge line, amber (orange) accent token.
    const jud = container.querySelectorAll('[data-testid="determinism-edge"][data-kind="judgment"]');
    expect(jud.length).toBeGreaterThan(0);
    for (const e of Array.from(jud)) {
      expect(e.querySelector('[data-testid="determinism-edge-who"]')).not.toBeNull();
      expect(e.querySelector('[data-testid="determinism-edge-gate"]')).toBeNull();
      const line = e.querySelector('[data-testid="determinism-edge-line"]');
      expect(line?.getAttribute("data-line-style")).toBe("dashed");
      expect((line as HTMLElement | null)?.style.color).toContain("--accent-orange");
    }
  });

  it("shows the honest 'partial fold' badge for a spine-only degrade", () => {
    const p = projection(MULTI_EDGE_THREAD);
    // This sample is spine-only in the frozen snapshot; assert the badge binds to
    // the degrade FIELD (shape), so it renders whenever degrade === spine-only.
    const { queryByTestId } = renderOverlay(p);
    if (p.degrade === "spine-only") {
      const badge = queryByTestId("determinism-degrade-badge");
      expect(badge).not.toBeNull();
      expect(badge?.getAttribute("data-degrade")).toBe("spine-only");
      expect(badge?.textContent).toContain("partial fold");
    }
  });

  it("names the who as decision-authority and gate as enforcement mechanism (title provenance)", () => {
    const { container } = renderOverlay(projection(MULTI_EDGE_THREAD));
    const who = container.querySelector('[data-testid="determinism-edge-who"]');
    expect(who?.getAttribute("title")).toContain("escalate_to");
    const gate = container.querySelector('[data-testid="determinism-edge-gate"]');
    expect(gate?.getAttribute("title")).toContain("enforced_by");
  });
});

describe("DeterminismOverlay — empty-pending case (no edges represented in this projection)", () => {
  it("renders NO edges and the projection-scoped note, with NO false-terminal copy", () => {
    const { queryByTestId, queryAllByTestId } = renderOverlay(emptyPendingProjection());
    expect(queryAllByTestId("determinism-edge")).toHaveLength(0);
    expect(queryByTestId("determinism-edges")).toBeNull();
    const note = queryByTestId("determinism-no-edges");
    expect(note).not.toBeNull();
    // Truthful, projection-scoped copy — never a terminality claim.
    expect(note?.textContent).toContain("no pending transitions in this projection");
    expect(note?.textContent).not.toMatch(/terminal|nowhere/i);
  });
});

describe("DeterminismOverlay — unmapped case (stage:null / degrade:unmapped)", () => {
  it("renders the calm 'not mapped / unknown' state, NOT an error and NOT edges", () => {
    const { queryByTestId, queryAllByTestId } = renderOverlay(unmappedProjection());
    const unmapped = queryByTestId("determinism-unmapped");
    expect(unmapped).not.toBeNull();
    expect(unmapped?.textContent).toContain("not mapped");
    expect(unmapped?.textContent).toContain("not an error");
    // No stage pill, no edges for an unmapped thread.
    expect(queryByTestId("determinism-stage")).toBeNull();
    expect(queryAllByTestId("determinism-edge")).toHaveLength(0);
  });
});

describe("DeterminismOverlay — no binding (null projection → renders nothing)", () => {
  it("renders nothing when the model is unbound (held activation)", () => {
    const { queryByTestId } = renderOverlay(null);
    expect(queryByTestId("determinism-overlay")).toBeNull();
  });
});

// ── integration: the overlay wired into ThreadsView via the injectable prop ──
describe("ThreadsView — determinism overlay wired additively (fixture-backed)", () => {
  const listFetcher = async () => ({
    threads: [
      {
        thread_id: MULTI_EDGE_THREAD,
        parent_thread_id: null,
        title: "Peggy · attention-app",
        status: { thread_id: MULTI_EDGE_THREAD, kind: "in_flight" as const, state: "running", revision: 3 },
      },
    ],
    endpointAvailable: true,
  });

  it("renders the determinism overlay for the selected thread, alongside the status badge", async () => {
    const determinismFetcher = makeFixtureDeterminismFetcher();
    const { queryByTestId, getAllByTestId } = render(
      <ThemeProvider>
        <ThreadsView fetcher={listFetcher} determinismFetcher={determinismFetcher} />
      </ThemeProvider>,
    );
    // The overlay appears in the default-selected thread's detail pane.
    await waitFor(() => expect(queryByTestId("determinism-overlay")).not.toBeNull());
    // And it renders the 7 fixture edges (proving the fetcher → overlay seam).
    expect(getAllByTestId("determinism-edge")).toHaveLength(7);
    // The status badge (existing surface) still renders — overlay is additive.
    // (Multiple badges exist: the list row + the detail header — assert ≥1.)
    expect(getAllByTestId("thread-status-badge").length).toBeGreaterThanOrEqual(1);
  });

  it("renders nothing determinism-wise when the fetcher returns null (held activation)", async () => {
    const nullFetcher = async () => null;
    const { queryByTestId } = render(
      <ThemeProvider>
        <ThreadsView fetcher={listFetcher} determinismFetcher={nullFetcher} />
      </ThemeProvider>,
    );
    await waitFor(() => expect(queryByTestId("thread-detail")).not.toBeNull());
    // No overlay — the detail pane still renders (additive, no crash).
    expect(queryByTestId("determinism-overlay")).toBeNull();
  });

  it("BLOCKER-2: with NO injected determinismFetcher, the client makes ZERO network calls and the overlay is inert", async () => {
    // Spy on the global fetch — the default posture must not touch the network
    // for determinism (live wiring is a separate Joan gate, not the default).
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    try {
      const { queryByTestId } = render(
        <ThemeProvider>
          {/* No determinismFetcher prop → inert by default. */}
          <ThreadsView fetcher={listFetcher} handoffFetcher={async () => ({ events: [], endpointAvailable: true })} />
        </ThemeProvider>,
      );
      // The detail pane still renders (the overlay is additive + optional).
      await waitFor(() => expect(queryByTestId("thread-detail")).not.toBeNull());
      // The overlay is inert — nothing rendered.
      expect(queryByTestId("determinism-overlay")).toBeNull();
      // And, decisively: ZERO calls to the determinism endpoint.
      const determinismCalls = fetchSpy.mock.calls.filter(([url]) =>
        String(url).includes("/determinism"),
      );
      expect(determinismCalls).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
