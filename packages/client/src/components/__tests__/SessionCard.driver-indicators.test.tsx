import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import React from "react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { SessionList } from "../SessionList.js";
import { ThemeProvider } from "../ThemeProvider.js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";

/**
 * dl-2620 integration: the per-driver progress-% + next-engagement indicators
 * render ON a driver row in the session-list (composing with the Drivers tier),
 * and are ABSENT for plain sessions that don't self-report.
 */
function TestRouter({ children }: { children: React.ReactNode }) {
  const { hook } = memoryLocation({ path: "/", static: true });
  return <Router hook={hook}>{children}</Router>;
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-color-scheme: dark)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  const store: Record<string, string> = {};
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k in store) delete store[k]; },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  });
});
afterEach(() => cleanup());

// A pi-driver-shape session (tmux + themed name + nos-cells cwd → Drivers tier).
function driver(overrides: Partial<DashboardSession> = {}): DashboardSession {
  return {
    id: "drv-1",
    cwd: "/Users/x/.pi/orchestration-state/nos-cells/some-driver",
    name: "Vault",
    source: "tmux",
    status: "active",
    startedAt: Date.now() - 60000,
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
    ...overrides,
  };
}

function renderList(sessions: DashboardSession[]) {
  return render(
    <TestRouter>
      <ThemeProvider>
        <SessionList sessions={sessions} onSelect={() => {}} />
      </ThemeProvider>
    </TestRouter>,
  );
}

describe("driver indicators in the session list (dl-2620)", () => {
  it("shows progress-% + engagement badge on a self-reporting driver row", () => {
    renderList([
      driver({
        progress: { pct: 50, label: "Phase 1", milestonesDone: 1, milestonesTotal: 2 },
        nextEngagement: { effort: "back-and-forth", note: "ratify on restart" },
      }),
    ]);
    const row = screen.getByTestId("driver-indicators-row");
    expect(row).toBeTruthy();
    expect(within(row).getByTestId("driver-progress-pct").textContent).toBe("50%");
    const badge = within(row).getByTestId("engagement-badge");
    expect(badge.getAttribute("data-effort")).toBe("back-and-forth");
    expect(badge.textContent).toContain("~30 min");
  });

  it("renders the indicators ALONGSIDE the context bar (both present on the card)", () => {
    renderList([
      driver({
        contextTokens: 5000,
        contextWindow: 10000,
        progress: { pct: 80 },
      }),
    ]);
    // both the existing context bar and the new progress bar coexist
    expect(screen.getByTestId("context-usage-bar")).toBeTruthy();
    expect(screen.getByTestId("driver-progress-bar")).toBeTruthy();
  });

  it("progress-only driver shows the row with no engagement badge", () => {
    renderList([driver({ progress: { pct: 30 } })]);
    const row = screen.getByTestId("driver-indicators-row");
    expect(within(row).getByTestId("driver-progress-bar")).toBeTruthy();
    expect(within(row).queryByTestId("engagement-badge")).toBeNull();
  });

  it("a plain session that did not self-report has NO indicators row", () => {
    renderList([driver({ id: "plain", name: "Vault", progress: undefined, nextEngagement: undefined })]);
    expect(screen.queryByTestId("driver-indicators-row")).toBeNull();
  });
});
