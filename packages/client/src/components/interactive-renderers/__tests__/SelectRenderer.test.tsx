import { describe, it, expect, vi, beforeAll, afterEach } from "vitest";
import { render, fireEvent, cleanup } from "@testing-library/react";
import React from "react";
import { SelectRenderer } from "../SelectRenderer.js";
import type { InteractiveRendererProps } from "../types.js";

afterEach(() => cleanup());

beforeAll(() => {
  // MarkdownContent pulls in a lazy syntax-highlight theme graph; jsdom needs matchMedia.
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

// The pi-bash-security capsule shape after the extension fix: decision-first
// headline + a bounded but multi-line body.
const CAPSULE_TITLE = [
  "⚠️ Bash command blocked — Zsh =command expansion",
  "",
  "**Pattern** `zsh-equals-expansion` · **Category** 4 · **Risk** med · detected by regex pass",
  "",
  "**Why:** Zsh expands =cmd to the absolute path of cmd.",
  "",
  "**Command** (302 lines, 4200 chars):",
  "",
  "```",
  "cat > /tmp/ruling.json <<'JSON'",
  "{",
  "  \"a\": 1,",
  "… (+298 more lines · 4200 chars total — full command in audit log)",
  "```",
  "",
  "Choose an option below. Default in 30 min → **Cancel + revert** (safety-first).",
].join("\n");

const OPTIONS = [
  "(1) Proceed [requires explicit ratify]",
  "(2) Amend command + retry",
  "(3) Cancel + revert [DEFAULT - default-fire 30min safety-first canonical]",
  "(N) something else / specify",
];

function props(over: Partial<InteractiveRendererProps> = {}): InteractiveRendererProps {
  return {
    requestId: "r1",
    method: "select",
    params: { title: CAPSULE_TITLE, options: OPTIONS },
    status: "pending",
    onRespond: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  };
}

describe("SelectRenderer — capsule rendering", () => {
  it("#given a long capsule title #when pending #then body is collapsed with a Show-more toggle", () => {
    const { getByTestId } = render(<SelectRenderer {...props()} />);
    const body = getByTestId("prompt-body");
    expect(body.getAttribute("data-collapsed")).toBe("true");
    const toggle = getByTestId("prompt-body-toggle");
    expect(toggle.textContent).toContain("Show full command");
    fireEvent.click(toggle);
    expect(getByTestId("prompt-body").getAttribute("data-collapsed")).toBe("false");
    expect(getByTestId("prompt-body-toggle").textContent).toContain("Show less");
  });

  it("#given a short title #when pending #then no collapse toggle is shown", () => {
    const { queryByTestId } = render(
      <SelectRenderer {...props({ params: { title: "Pick one", options: ["A", "B"] } })} />,
    );
    expect(queryByTestId("prompt-body-toggle")).toBeNull();
  });

  it("#given the capsule options #when pending #then all render as prominent buttons and picking one calls onRespond with its value", () => {
    const p = props();
    const { getByText } = render(<SelectRenderer {...p} />);
    for (const opt of OPTIONS) {
      expect(getByText(opt)).toBeTruthy();
    }
    fireEvent.click(getByText("(1) Proceed [requires explicit ratify]"));
    expect(p.onRespond).toHaveBeenCalledWith({ value: "(1) Proceed [requires explicit ratify]" });
  });

  it("#given options already include a Cancel choice #when pending #then no redundant fallback Cancel button is added", () => {
    const { queryAllByText } = render(<SelectRenderer {...props()} />);
    // Exactly one control mentions cancel — option (3); no extra bare "Cancel".
    const cancels = queryAllByText((_c, el) => (el?.textContent ?? "").toLowerCase().includes("cancel") && el?.tagName === "BUTTON");
    // The single cancel-bearing button is option (3).
    const bare = queryAllByText("Cancel");
    expect(bare.length).toBe(0);
    expect(cancels.length).toBeGreaterThanOrEqual(1);
  });

  it("#given no cancel-ish option #when pending #then a fallback Cancel button is present and calls onCancel", () => {
    const p = props({ params: { title: "Pick", options: ["A", "B"] } });
    const { getByText } = render(<SelectRenderer {...p} />);
    fireEvent.click(getByText("Cancel"));
    expect(p.onCancel).toHaveBeenCalled();
  });

  it("#given resolved status #when rendered #then compact summary uses only the headline (first line)", () => {
    const { container } = render(
      <SelectRenderer {...props({ status: "resolved", result: { value: OPTIONS[0] } })} />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Bash command blocked");
    // The buried body lines must NOT bleed into the compact one-line summary.
    expect(text).not.toContain("detected by regex pass");
  });
});
