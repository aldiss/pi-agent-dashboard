import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { FleetBriefBanner } from "../FleetBriefBanner.js";
import type { FleetBriefItem } from "../../lib/fleet-brief.js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";

afterEach(() => cleanup());

function item(overrides: Partial<FleetBriefItem> = {}): FleetBriefItem {
  return {
    kind: "session",
    id: "s-err",
    reason: "server-error",
    label: "Vault — deploy driver",
    priority: 0,
    at: 1000,
    ...overrides,
  } as FleetBriefItem;
}

function finished(id: string): DashboardSession {
  return {
    id, cwd: "/w", source: "tmux", status: "ended",
    startedAt: 1, endedAt: 2, lastActivityAt: 2, name: `Finished ${id}`,
    tokensIn: 0, tokensOut: 0, cost: 0,
  } as DashboardSession;
}

/**
 * FATAL 2 (build-2 fix-cycle): acknowledge ONLY on a nonempty, actually-visible
 * brief — never while it renders zero rows, never while route-visible but the
 * panel is aria-hidden. jsdom has no IntersectionObserver, so the component
 * falls back to the route-depth `isVisible` prop for the geometric gate; these
 * tests exercise the `total>0` gate + the aria-hidden rejection + the
 * ack-on-visible path deterministically.
 */
describe("FleetBriefBanner — acknowledge gating (FATAL 2)", () => {
  it("does NOT acknowledge when the brief has zero rows (renders null)", () => {
    const acknowledge = vi.fn();
    const { container } = render(
      <FleetBriefBanner items={[]} finishedUnseen={[]} isVisible={true} onSelect={() => {}} acknowledge={acknowledge} />,
    );
    // Nothing renders, and no cursor write while zero rows.
    expect(container.querySelector('[data-testid="fleet-brief-banner"]')).toBeNull();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("does NOT acknowledge when route-hidden (isVisible=false) even with rows", () => {
    const acknowledge = vi.fn();
    render(
      <FleetBriefBanner items={[item()]} finishedUnseen={[]} isVisible={false} onSelect={() => {}} acknowledge={acknowledge} />,
    );
    // Banner still renders (so the count is observable), but no ack while hidden.
    expect(screen.getByTestId("fleet-brief-banner")).toBeTruthy();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("acknowledges when the brief is nonempty AND visible", () => {
    const acknowledge = vi.fn();
    render(
      <FleetBriefBanner items={[item()]} finishedUnseen={[finished("f1")]} isVisible={true} onSelect={() => {}} acknowledge={acknowledge} />,
    );
    expect(screen.getByTestId("fleet-brief-count").textContent).toContain("2");
    expect(acknowledge).toHaveBeenCalled();
  });

  it("does NOT acknowledge while an ancestor is aria-hidden (spring-transition guard)", () => {
    const acknowledge = vi.fn();
    render(
      <div aria-hidden="true">
        <FleetBriefBanner items={[item()]} finishedUnseen={[]} isVisible={true} onSelect={() => {}} acknowledge={acknowledge} />
      </div>,
    );
    // Route says visible, but the panel is aria-hidden → treated as not-seen.
    expect(acknowledge).not.toHaveBeenCalled();
  });
});
