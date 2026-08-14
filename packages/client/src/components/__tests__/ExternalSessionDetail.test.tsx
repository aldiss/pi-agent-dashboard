import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchCapture = vi.hoisted(() => vi.fn());

vi.mock("../../lib/external-sessions-api.js", () => ({
  fetchExternalSessionCapture: fetchCapture,
}));

import { ExternalSessionDetail } from "../ExternalSessionDetail.js";

const liveCapture = (output: string) => ({
  id: "codex:cx-gap2",
  output,
  lineCount: output ? output.split("\n").length : 0,
  state: "live" as const,
  capturedAt: 1_786_704_775_636,
});

const defaultProps = {
  sessionId: "codex:cx-gap2",
  tmuxSession: "cx-gap2",
  runtime: "codex" as const,
  title: "cx-gap2",
  model: "gpt-5.6-sol",
  effort: "ultra",
  state: "live" as const,
  endedAt: null,
  pollIntervalMs: 10_000,
};

async function flushCapture(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setScrollGeometry(
  element: HTMLElement,
  { scrollTop, scrollHeight, clientHeight }: {
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
  },
): void {
  Object.defineProperties(element, {
    scrollTop: { value: scrollTop, writable: true, configurable: true },
    scrollHeight: { value: scrollHeight, configurable: true },
    clientHeight: { value: clientHeight, configurable: true },
  });
}

describe("ExternalSessionDetail", () => {
  const scrollTo = vi.fn();
  const writeText = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    fetchCapture.mockReset();
    scrollTo.mockReset();
    writeText.mockReset();
    Element.prototype.scrollTo = scrollTo;
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("polls capture and renders a bottom-anchored, two-axis read-only terminal", async () => {
    fetchCapture.mockResolvedValue(liveCapture("top\n  box ───\nbottom"));

    const { container } = render(
      <ExternalSessionDetail {...defaultProps} model="codex/gpt-5.6-sol" />,
    );
    await flushCapture();

    expect(fetchCapture).toHaveBeenCalledWith("codex:cx-gap2");
    const output = screen.getByTestId("external-session-output");
    expect(output.tagName).toBe("PRE");
    expect(output.className).toContain("overflow-auto");
    expect(output.className).toContain("whitespace-pre");
    expect(output.className).not.toContain("whitespace-pre-wrap");
    expect(screen.getByTestId("external-session-output-content").className).toContain("justify-end");
    expect(output.textContent).toBe("top\n  box ───\nbottom");
    expect(screen.getByText("codex/gpt-5.6-sol (ultra)")).toBeTruthy();
    expect(screen.queryByText(/codex\/codex\//)).toBeNull();

    expect(screen.getByText("tmux -L pi attach -t cx-gap2")).toBeTruthy();
    expect(container.querySelector("textarea")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /send|abort|kill|resume|fork/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Refresh output" }));
    await flushCapture();
    expect(fetchCapture).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(fetchCapture).toHaveBeenCalledTimes(3);
  });

  it("follows output-length changes only at the tail and offers a return-to-tail button", async () => {
    fetchCapture
      .mockResolvedValueOnce(liveCapture("first"))
      .mockResolvedValueOnce(liveCapture("first\nsecond"));

    render(<ExternalSessionDetail {...defaultProps} pollIntervalMs={1_000} />);
    await flushCapture();

    const output = screen.getByTestId("external-session-output");
    await act(async () => {
      vi.advanceTimersByTime(151);
    });
    setScrollGeometry(output, { scrollTop: 100, scrollHeight: 1_000, clientHeight: 200 });
    fireEvent.scroll(output);
    expect(screen.getByTestId("external-session-scroll-to-bottom")).toBeTruthy();

    const callsBeforeGrowth = scrollTo.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(849);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(output.textContent).toBe("first\nsecond");
    expect(scrollTo).toHaveBeenCalledTimes(callsBeforeGrowth);

    fireEvent.click(screen.getByTestId("external-session-scroll-to-bottom"));
    expect(scrollTo).toHaveBeenCalledTimes(callsBeforeGrowth + 1);
    expect(screen.queryByTestId("external-session-scroll-to-bottom")).toBeNull();
  });

  it("freezes the last output, preserves scroll, and keeps the server view lease alive", async () => {
    fetchCapture.mockResolvedValue(liveCapture("last live bytes"));

    const { rerender } = render(<ExternalSessionDetail {...defaultProps} />);
    await flushCapture();

    const output = screen.getByTestId("external-session-output");
    await act(async () => {
      vi.advanceTimersByTime(151);
    });
    setScrollGeometry(output, { scrollTop: 42, scrollHeight: 800, clientHeight: 200 });
    fireEvent.scroll(output);

    rerender(
      <ExternalSessionDetail
        {...defaultProps}
        state="ended"
        endedAt={1_786_704_320_000}
      />,
    );

    expect(screen.getByText(/This session ended at/)).toBeTruthy();
    expect(screen.getByText("frozen — no further output")).toBeTruthy();
    expect(screen.getByText(/Read-only — session ended/)).toBeTruthy();
    expect(output.textContent).toBe("last live bytes");
    expect(output.scrollTop).toBe(42);
    expect(output.className).toContain("opacity-60");

    for (let poll = 0; poll < 2; poll += 1) {
      await act(async () => {
        vi.advanceTimersByTime(10_000);
        await Promise.resolve();
        await Promise.resolve();
      });
    }
    // Ended captures are memory-only server reads. Keep polling them so an
    // open browser view can never lose its no-prune lease.
    expect(fetchCapture).toHaveBeenCalledTimes(3);
    expect(output.textContent).toBe("last live bytes");
    expect(output.scrollTop).toBe(42);
  });

  it("freezes when the fresh capture reports ended even before parent list polling catches up", async () => {
    fetchCapture.mockResolvedValue({
      ...liveCapture("alpha beta alpha"),
      state: "ended" as const,
    });

    render(<ExternalSessionDetail {...defaultProps} isMobile />);
    await flushCapture();

    expect(screen.getByText(/This session ended\./)).toBeTruthy();
    expect(screen.getByText("frozen — no further output")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy tmux attach command" })).toBeNull();
  });

  it("supports output search and copies the attach command on mobile", async () => {
    fetchCapture.mockResolvedValue(liveCapture("alpha beta alpha"));

    render(<ExternalSessionDetail {...defaultProps} isMobile />);
    await flushCapture();

    expect(screen.getByTestId("external-session-mobile-footer")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Search output" }));
    const search = screen.getByRole("searchbox", { name: "Search external session output" });
    fireEvent.change(search, { target: { value: "alpha" } });
    expect(screen.getByText("1 / 2")).toBeTruthy();
    expect(screen.getByTestId("external-session-output").textContent).toBe("alpha beta alpha");

    fireEvent.keyDown(search, { key: "Enter" });
    expect(screen.getByText("2 / 2")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Copy tmux attach command" }));
    expect(writeText).toHaveBeenCalledWith("tmux -L pi attach -t cx-gap2");
  });
});
