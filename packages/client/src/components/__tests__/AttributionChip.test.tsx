/**
 * AttributionChip tests (multi-operator, Surface A — Option B).
 *
 * Covers the two non-color cues:
 *   - LABEL: `author.sub === viewerSub` → "You"; otherwise the display name.
 *   - DOT: `author.isOperator` → filled amber; guest → violet RING (shape cue).
 */
import React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

afterEach(() => cleanup());

import { AttributionChip } from "../AttributionChip";
import type { MessageAuthor } from "@blackbelt-technology/pi-dashboard-shared/types.js";

function author(over: Partial<MessageAuthor> = {}): MessageAuthor {
  return { sub: "op1@example.com", display: "Op One", ...over };
}

describe("AttributionChip — 'You' vs display label", () => {
  it("renders 'You' when author.sub === viewerSub", () => {
    const { getByText, queryByText } = render(
      <AttributionChip author={author()} viewerSub="op1@example.com" />,
    );
    expect(getByText("You")).toBeTruthy();
    expect(queryByText("Op One")).toBeNull();
  });

  it("renders the display name when author.sub !== viewerSub", () => {
    const { getByText, queryByText } = render(
      <AttributionChip author={author()} viewerSub="op2@example.com" />,
    );
    expect(getByText("Op One")).toBeTruthy();
    expect(queryByText("You")).toBeNull();
  });

  it("renders the display name (never 'You') when viewerSub is undefined", () => {
    const { getByText, queryByText } = render(<AttributionChip author={author()} />);
    expect(getByText("Op One")).toBeTruthy();
    expect(queryByText("You")).toBeNull();
  });

  it("keeps title={author.sub} for hover identity", () => {
    const { container } = render(<AttributionChip author={author()} viewerSub="op1@example.com" />);
    const chip = container.querySelector("[data-attribution-sub]") as HTMLElement;
    expect(chip.getAttribute("title")).toBe("op1@example.com");
  });
});

describe("AttributionChip — role dot cue (filled amber vs violet ring)", () => {
  it("operator → FILLED amber dot (bg-amber, no border)", () => {
    const { container } = render(
      <AttributionChip author={author({ isOperator: true })} viewerSub="x" />,
    );
    const chip = container.querySelector('[data-attribution-role="operator"]') as HTMLElement;
    expect(chip).toBeTruthy();
    const dot = chip.querySelector("span[aria-hidden]") as HTMLElement;
    expect(dot.className).toContain("bg-amber-400");
    expect(dot.className).not.toContain("border");
  });

  it("guest → violet RING dot (border, not a solid fill)", () => {
    const { container } = render(
      <AttributionChip author={author({ isOperator: false })} viewerSub="x" />,
    );
    const chip = container.querySelector('[data-attribution-role="guest"]') as HTMLElement;
    expect(chip).toBeTruthy();
    const dot = chip.querySelector("span[aria-hidden]") as HTMLElement;
    expect(dot.className).toContain("border-violet-300");
    expect(dot.className).not.toContain("bg-amber-400");
    expect(dot.className).not.toContain("bg-violet-400");
  });

  it("operator and guest dots are visually distinct (amber-fill vs violet-ring)", () => {
    const { container: opC } = render(
      <AttributionChip author={author({ sub: "a", isOperator: true })} viewerSub="x" />,
    );
    const { container: guestC } = render(
      <AttributionChip author={author({ sub: "b", isOperator: false })} viewerSub="x" />,
    );
    const opDot = opC.querySelector("span[aria-hidden]") as HTMLElement;
    const guestDot = guestC.querySelector("span[aria-hidden]") as HTMLElement;
    expect(opDot.className).not.toBe(guestDot.className);
  });

  it("author lacking isOperator → hash-fallback dot (role 'unknown')", () => {
    const { container } = render(<AttributionChip author={author()} viewerSub="x" />);
    const chip = container.querySelector('[data-attribution-role="unknown"]') as HTMLElement;
    expect(chip).toBeTruthy();
  });
});
