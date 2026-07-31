import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import React from "react";
import { GenericInteractiveRenderer } from "../GenericInteractiveRenderer.js";
import type { InteractiveRendererProps } from "../types.js";

afterEach(() => cleanup());

function props(over: Partial<InteractiveRendererProps> = {}): InteractiveRendererProps {
  return {
    requestId: "r1",
    method: "custom-method",
    params: { title: "Do the thing?" },
    status: "pending",
    onRespond: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  };
}

// ── dl-13559: the fallback renderer must also tell a bus TIMEOUT (status
//    "cancelled") from a TUI answer (status "dismissed"). Pre-fix, "cancelled"
//    fell through to render the raw enum string; "dismissed" → "Answered in
//    terminal". A timeout must read as a truthful non-answer. ──
describe("GenericInteractiveRenderer — status labels (dl-13559)", () => {
  it("[able-to-fail] #given cancelled status #then renders 'No response' and NOT 'Answered in terminal'", () => {
    const { container } = render(<GenericInteractiveRenderer {...props({ status: "cancelled" })} />);
    const text = container.textContent ?? "";
    expect(text).toContain("No response");
    expect(text).not.toContain("Answered in terminal"); // RED pre-fix (fell through to raw "cancelled")
    expect(text).not.toContain("cancelled"); // must not leak the raw enum string
  });

  it("#given dismissed status #then still renders 'Answered in terminal' (preserved)", () => {
    const { container } = render(<GenericInteractiveRenderer {...props({ status: "dismissed" })} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Answered in terminal");
    expect(text).not.toContain("No response");
  });

  it("#given pending status #then renders 'Waiting for response...'", () => {
    const { container } = render(<GenericInteractiveRenderer {...props({ status: "pending" })} />);
    expect(container.textContent ?? "").toContain("Waiting for response...");
  });
});
