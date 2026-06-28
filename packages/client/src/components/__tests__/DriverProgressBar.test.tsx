import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { DriverProgressBar } from "../DriverProgressBar.js";

afterEach(() => cleanup());

describe("DriverProgressBar (dl-2620)", () => {
  it("renders nothing when no progress", () => {
    const { container } = render(<DriverProgressBar progress={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when pct is not a number", () => {
    const { container } = render(<DriverProgressBar progress={{ pct: undefined as any }} />);
    expect(container.firstChild).toBeNull();
  });

  it("fills to pct and shows the percentage", () => {
    render(<DriverProgressBar progress={{ pct: 45 }} />);
    expect(screen.getByTestId("driver-progress-fill").style.width).toBe("45%");
    expect(screen.getByTestId("driver-progress-pct").textContent).toBe("45%");
  });

  it("uses an emerald (not context grey/red) fill below 100", () => {
    render(<DriverProgressBar progress={{ pct: 45 }} />);
    expect(screen.getByTestId("driver-progress-fill").className).toContain("bg-emerald-500/70");
  });

  it("switches to a solid emerald done-state at 100%", () => {
    render(<DriverProgressBar progress={{ pct: 100 }} />);
    expect(screen.getByTestId("driver-progress-fill").className).toContain("bg-emerald-400");
  });

  it("clamps pct into 0-100", () => {
    cleanup();
    render(<DriverProgressBar progress={{ pct: 140 }} />);
    expect(screen.getByTestId("driver-progress-fill").style.width).toBe("100%");
    cleanup();
    render(<DriverProgressBar progress={{ pct: -10 }} />);
    expect(screen.getByTestId("driver-progress-fill").style.width).toBe("0%");
  });

  it("tooltip carries label + milestones + done%", () => {
    render(<DriverProgressBar progress={{ pct: 50, label: "Phase 1", milestonesDone: 2, milestonesTotal: 4 }} />);
    const tip = screen.getByTestId("driver-progress-bar").getAttribute("title")!;
    expect(tip).toContain("Phase 1");
    expect(tip).toContain("2/4 milestones");
    expect(tip).toContain("50% done");
  });

  it("compact mode uses a fixed width", () => {
    render(<DriverProgressBar progress={{ pct: 50 }} compact />);
    expect(screen.getByTestId("driver-progress-bar").className).toContain("w-24");
  });
});
