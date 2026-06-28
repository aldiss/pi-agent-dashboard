import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { EngagementBadge } from "../EngagementBadge.js";

afterEach(() => cleanup());

describe("EngagementBadge (dl-2620)", () => {
  it("renders nothing when no next-engagement", () => {
    const { container } = render(<EngagementBadge nextEngagement={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing for an unknown effort", () => {
    const { container } = render(<EngagementBadge nextEngagement={{ effort: "bogus" as any }} />);
    expect(container.firstChild).toBeNull();
  });

  it.each([
    ["autonomous", "Autonomous", "text-slate-400"],
    ["one-action", "1 action", "text-blue-400"],
    ["short", "~5 min", "text-amber-400"],
    ["back-and-forth", "~30 min", "text-orange-400"],
  ])("renders %s with label %s and its hue", (effort, label, hue) => {
    render(<EngagementBadge nextEngagement={{ effort: effort as any }} />);
    const badge = screen.getByTestId("engagement-badge");
    expect(badge.getAttribute("data-effort")).toBe(effort);
    expect(badge.textContent).toContain(label);
    expect(badge.className).toContain(hue);
  });

  it("cool→warm hue encodes light→heavy effort (autonomous slate, back-and-forth orange)", () => {
    cleanup();
    render(<EngagementBadge nextEngagement={{ effort: "autonomous" }} />);
    expect(screen.getByTestId("engagement-badge").className).toContain("slate");
    cleanup();
    render(<EngagementBadge nextEngagement={{ effort: "back-and-forth" }} />);
    expect(screen.getByTestId("engagement-badge").className).toContain("orange");
  });

  it("tooltip carries the effort label + note", () => {
    render(<EngagementBadge nextEngagement={{ effort: "back-and-forth", note: "ratify on restart" }} />);
    const tip = screen.getByTestId("engagement-badge").getAttribute("title")!;
    expect(tip).toContain("~30 min");
    expect(tip).toContain("ratify on restart");
  });
});
