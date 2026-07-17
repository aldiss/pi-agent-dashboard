import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import React from "react";
import { FleetBriefBanner, isBannerSettled } from "../FleetBriefBanner.js";
import type { FleetBriefItem } from "../../lib/fleet-brief.js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function item(overrides: Partial<FleetBriefItem> = {}): FleetBriefItem {
  return {
    kind: "session", id: "s-err", reason: "server-error",
    label: "Vault — deploy driver", priority: 0, at: 1000, ...overrides,
  } as FleetBriefItem;
}
function finished(id: string): DashboardSession {
  return {
    id, cwd: "/w", source: "tmux", status: "ended",
    startedAt: 1, endedAt: 2, lastActivityAt: 2, name: `Finished ${id}`,
    tokensIn: 0, tokensOut: 0, cost: 0,
  } as DashboardSession;
}

// ── isBannerSettled — the pure settled-geometry predicate (F2 core) ──────────

describe("isBannerSettled (build-2 fix-cycle-2 F2)", () => {
  function makeEl(opts: { transform?: string; left?: number; ariaHidden?: boolean; ancestorTransform?: string } = {}): HTMLElement {
    const parent = document.createElement("div");
    const el = document.createElement("div");
    parent.appendChild(el);
    if (opts.ariaHidden) parent.setAttribute("aria-hidden", "true");
    el.getBoundingClientRect = () => ({
      left: opts.left ?? 0, right: (opts.left ?? 0) + 393, top: 0, bottom: 52,
      width: 393, height: 52, x: opts.left ?? 0, y: 0, toJSON: () => ({}),
    }) as DOMRect;
    const styleFor = (n: Element): Pick<CSSStyleDeclaration, "transform"> => {
      if (n === el) return { transform: opts.transform ?? "none" } as any;
      return { transform: opts.ancestorTransform ?? "none" } as any;
    };
    (el as any).__style = styleFor;
    return el;
  }
  const getStyle = (el: HTMLElement) => (n: Element) => (el as any).__style(n);

  it("returns FALSE mid-spring (ancestor translated -117px off-screen)", () => {
    const el = makeEl({ ancestorTransform: "matrix(1, 0, 0, 1, -117.564, 0)" });
    expect(isBannerSettled(el, getStyle(el), 393, 852)).toBe(false);
  });

  it("returns FALSE when the banner's own rect is translated off the left edge", () => {
    const el = makeEl({ left: -117 });
    expect(isBannerSettled(el, getStyle(el), 393, 852)).toBe(false);
  });

  it("returns TRUE when settled: identity transforms + on-screen + not aria-hidden", () => {
    const el = makeEl({ transform: "none", ancestorTransform: "none", left: 0 });
    expect(isBannerSettled(el, getStyle(el), 393, 852)).toBe(true);
  });

  it("returns TRUE for a settled matrix(1,0,0,1,0,0) identity", () => {
    const el = makeEl({ ancestorTransform: "matrix(1, 0, 0, 1, 0, 0)", left: 0 });
    expect(isBannerSettled(el, getStyle(el), 393, 852)).toBe(true);
  });

  it("returns FALSE when aria-hidden even if geometrically settled", () => {
    const el = makeEl({ transform: "none", left: 0, ariaHidden: true });
    expect(isBannerSettled(el, getStyle(el), 393, 852)).toBe(false);
  });

  it("returns FALSE for a null element", () => {
    expect(isBannerSettled(null)).toBe(false);
  });
});

// ── component acknowledge gating (F2 + prior FATAL 2 cases) ───────────────────

describe("FleetBriefBanner — acknowledge gating", () => {
  let rafCbs: FrameRequestCallback[] = [];
  beforeEach(() => {
    rafCbs = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { rafCbs.push(cb); return rafCbs.length; });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  function flushRaf(times = 3) {
    for (let i = 0; i < times; i++) {
      const cbs = rafCbs; rafCbs = [];
      act(() => { cbs.forEach((cb) => cb(performance.now?.() ?? 0)); });
    }
  }
  // Force a SETTLED geometry for the rendered banner node.
  function settleDom() {
    const el = document.querySelector('[data-testid="fleet-brief-banner"]') as HTMLElement | null;
    if (!el) return;
    el.getBoundingClientRect = () => ({ left: 0, right: 393, top: 0, bottom: 52, width: 393, height: 52, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    vi.spyOn(window, "getComputedStyle").mockImplementation(() => ({ transform: "none" }) as any);
  }
  // Force a MID-SPRING geometry (translated off-screen).
  function midSpringDom() {
    const el = document.querySelector('[data-testid="fleet-brief-banner"]') as HTMLElement | null;
    if (!el) return;
    el.getBoundingClientRect = () => ({ left: -117, right: 276, top: 0, bottom: 52, width: 393, height: 52, x: -117, y: 0, toJSON: () => ({}) }) as DOMRect;
    vi.spyOn(window, "getComputedStyle").mockImplementation(() => ({ transform: "matrix(1, 0, 0, 1, -117.564, 0)" }) as any);
  }

  it("does NOT acknowledge when the brief has zero rows (renders null)", () => {
    const acknowledge = vi.fn();
    const { container } = render(
      <FleetBriefBanner items={[]} finishedUnseen={[]} isVisible={true} onSelect={() => {}} acknowledge={acknowledge} />,
    );
    flushRaf();
    expect(container.querySelector('[data-testid="fleet-brief-banner"]')).toBeNull();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("does NOT acknowledge when route-hidden (isVisible=false)", () => {
    const acknowledge = vi.fn();
    render(<FleetBriefBanner items={[item()]} finishedUnseen={[]} isVisible={false} onSelect={() => {}} acknowledge={acknowledge} />);
    settleDom(); flushRaf();
    expect(screen.getByTestId("fleet-brief-banner")).toBeTruthy();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("does NOT acknowledge while MID-SPRING (translated), even when route-visible", () => {
    const acknowledge = vi.fn();
    render(<FleetBriefBanner items={[item()]} finishedUnseen={[]} isVisible={true} onSelect={() => {}} acknowledge={acknowledge} />);
    midSpringDom(); flushRaf(5);
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("acknowledges ONLY after the banner is SETTLED at rest", () => {
    const acknowledge = vi.fn();
    render(<FleetBriefBanner items={[item()]} finishedUnseen={[finished("f1")]} isVisible={true} onSelect={() => {}} acknowledge={acknowledge} />);
    // First frames: mid-spring → no ack.
    midSpringDom(); flushRaf(2);
    expect(acknowledge).not.toHaveBeenCalled();
    // Spring settles → ack fires exactly once.
    settleDom(); flushRaf(2);
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it("does NOT acknowledge while an ancestor is aria-hidden", () => {
    const acknowledge = vi.fn();
    render(
      <div aria-hidden="true">
        <FleetBriefBanner items={[item()]} finishedUnseen={[]} isVisible={true} onSelect={() => {}} acknowledge={acknowledge} />
      </div>,
    );
    settleDom(); flushRaf(5);
    expect(acknowledge).not.toHaveBeenCalled();
  });
});
