import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchCapture, fetchTranscript } = vi.hoisted(() => ({
  fetchCapture: vi.fn(),
  fetchTranscript: vi.fn(),
}));

vi.mock("../../lib/external-sessions-api.js", () => ({
  fetchExternalSessionCapture: fetchCapture,
  fetchExternalSessionTranscript: fetchTranscript,
}));

import { ExternalSessionDetail } from "../ExternalSessionDetail.js";

type TranscriptKind =
  | "user"
  | "assistant"
  | "thinking"
  | "tool_call"
  | "tool_result"
  | "status";

interface TranscriptEntry {
  id: string;
  ts: number;
  kind: TranscriptKind;
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
  toolCallId?: string;
  isError?: boolean;
  durationMs?: number;
}

interface TranscriptResponse {
  id: string;
  source: "codex" | "claude-code" | "capture";
  entries: TranscriptEntry[];
  truncated: boolean;
  transcriptPath?: string;
}

const liveCapture = (output: string) => ({
  id: "codex:cx-gap2",
  output,
  lineCount: output ? output.split("\n").length : 0,
  state: "live" as const,
  capturedAt: 1_786_704_775_636,
});

function transcript(
  entries: TranscriptEntry[],
  source: TranscriptResponse["source"] = "codex",
): TranscriptResponse {
  return {
    id: "codex:cx-gap2",
    source,
    entries,
    truncated: false,
    ...(source === "capture" ? {} : { transcriptPath: "/tmp/codex/sessions/rollout.jsonl" }),
  };
}

const structuredEntries: TranscriptEntry[] = [
  {
    id: "user-1",
    ts: 1_786_704_770_000,
    kind: "user",
    text: "Please inspect the workspace.",
  },
  {
    id: "thinking-1",
    ts: 1_786_704_771_000,
    kind: "thinking",
    text: "I should inspect the relevant files first.",
  },
  {
    id: "assistant-1",
    ts: 1_786_704_772_000,
    kind: "assistant",
    text: "I found the relevant implementation.",
  },
  {
    id: "tool-call-ok",
    ts: 1_786_704_773_000,
    kind: "tool_call",
    toolCallId: "call-ok",
    toolName: "bash",
    toolInput: { command: "printf structured" },
  },
  {
    id: "tool-call-error",
    ts: 1_786_704_773_100,
    kind: "tool_call",
    toolCallId: "call-error",
    toolName: "read",
    toolInput: { path: "missing.txt" },
  },
  // Results deliberately arrive in the opposite order from their calls. The
  // renderer must correlate by toolCallId, not by adjacency.
  {
    id: "tool-result-error",
    ts: 1_786_704_774_000,
    kind: "tool_result",
    toolCallId: "call-error",
    toolResult: "ENOENT: missing.txt",
    isError: true,
    durationMs: 250,
  },
  {
    id: "tool-result-ok",
    ts: 1_786_704_775_000,
    kind: "tool_result",
    toolCallId: "call-ok",
    toolResult: "structured output",
    durationMs: 500,
  },
];

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

async function flushLoads(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
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
    fetchTranscript.mockReset();
    fetchCapture.mockResolvedValue(liveCapture("raw terminal bytes"));
    fetchTranscript.mockResolvedValue(transcript(structuredEntries));
    scrollTo.mockReset();
    writeText.mockReset();
    window.localStorage.removeItem("dashboard:externalOutputWrap");
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

  it("polls and renders a native structured conversation with correlated tool results", async () => {
    const { container } = render(
      <ExternalSessionDetail {...defaultProps} model="codex/gpt-5.6-sol" />,
    );
    await flushLoads();

    expect(fetchTranscript).toHaveBeenCalledWith("codex:cx-gap2");
    expect(fetchCapture).toHaveBeenCalledWith("codex:cx-gap2");
    expect(screen.getByTestId("external-session-conversation")).toBeTruthy();
    expect(screen.queryByTestId("external-session-output")).toBeNull();

    const userMessage = screen.getByText("Please inspect the workspace.");
    expect(userMessage.closest(".editorial-userbubble")).not.toBeNull();
    const assistantMessage = screen.getByText("I found the relevant implementation.");
    expect(assistantMessage.closest(".rounded-xl")?.className).toContain("bg-[var(--bg-tertiary)]");

    fireEvent.click(screen.getByRole("button", { name: /Reasoning/i }));
    expect(screen.getByText("I should inspect the relevant files first.")).toBeTruthy();

    const successfulTool = screen.getByRole("button", { name: /printf structured/i });
    const failedTool = screen.getByRole("button", { name: /Read missing\.txt/i });
    expect(failedTool.querySelector(".text-red-400")).not.toBeNull();
    fireEvent.click(successfulTool);
    fireEvent.click(failedTool);
    expect(screen.getByText("structured output")).toBeTruthy();
    expect(screen.getByText(/ENOENT: missing\.txt/)).toBeTruthy();

    expect(screen.getByText("codex/gpt-5.6-sol (ultra)")).toBeTruthy();
    expect(screen.queryByText(/codex\/codex\//)).toBeNull();
    expect(screen.getByText("tmux -L pi attach -t cx-gap2")).toBeTruthy();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("[contenteditable='true']")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /send|abort|kill|resume|fork/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Refresh/i }));
    await flushLoads();
    expect(fetchTranscript).toHaveBeenCalledTimes(2);
    expect(fetchCapture).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchTranscript).toHaveBeenCalledTimes(3);
    expect(fetchCapture).toHaveBeenCalledTimes(3);
  });

  it("toggles between conversation and the exact bottom-anchored raw terminal", async () => {
    fetchCapture.mockResolvedValue(liveCapture("top\n  box ---\nbottom"));

    render(<ExternalSessionDetail {...defaultProps} />);
    await flushLoads();

    expect(screen.getByText("I found the relevant implementation.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Raw terminal/i }));

    const output = screen.getByTestId("external-session-output");
    expect(output.tagName).toBe("PRE");
    expect(output.className).toContain("overflow-auto");
    expect(output.className).toContain("whitespace-pre");
    expect(output.className).not.toContain("whitespace-pre-wrap");
    expect(screen.getByTestId("external-session-output-content").className).toContain("justify-end");
    expect(output.textContent).toBe("top\n  box ---\nbottom");

    fireEvent.click(screen.getByTestId("external-session-wrap-toggle"));
    expect(output.className).toContain("whitespace-pre-wrap");

    fireEvent.click(screen.getByRole("button", { name: /Conversation/i }));
    expect(screen.getByTestId("external-session-conversation")).toBeTruthy();
    expect(screen.getByText("I found the relevant implementation.")).toBeTruthy();
  });

  it("follows structured transcript growth only at the tail and offers a return-to-tail button", async () => {
    fetchTranscript
      .mockResolvedValueOnce(transcript([{
        id: "assistant-first",
        ts: 1_786_704_770_000,
        kind: "assistant",
        text: "first structured answer",
      }]))
      .mockResolvedValue(transcript([
        {
          id: "assistant-first",
          ts: 1_786_704_770_000,
          kind: "assistant",
          text: "first structured answer",
        },
        {
          id: "assistant-second",
          ts: 1_786_704_771_000,
          kind: "assistant",
          text: "second structured answer",
        },
      ]));

    render(<ExternalSessionDetail {...defaultProps} pollIntervalMs={1_000} />);
    await flushLoads();

    const output = screen.getByTestId("external-session-scroll");
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

    expect(screen.getByText("second structured answer")).toBeTruthy();
    expect(scrollTo).toHaveBeenCalledTimes(callsBeforeGrowth);

    fireEvent.click(screen.getByTestId("external-session-scroll-to-bottom"));
    expect(scrollTo).toHaveBeenCalledTimes(callsBeforeGrowth + 1);
    expect(screen.queryByTestId("external-session-scroll-to-bottom")).toBeNull();
  });

  it("shows an explicit raw fallback when the server cannot resolve a transcript", async () => {
    fetchTranscript.mockResolvedValue(transcript([], "capture"));
    fetchCapture.mockResolvedValue(liveCapture("literal fallback\noutput"));

    render(<ExternalSessionDetail {...defaultProps} isMobile />);
    await flushLoads();

    expect(screen.getByText(/No transcript found — showing raw terminal output\./i)).toBeTruthy();
    const output = screen.getByTestId("external-session-output");
    expect(output.textContent).toBe("literal fallback\noutput");
    expect(output.className).toContain("whitespace-pre-wrap");
    expect(screen.queryByTestId("external-session-conversation")).toBeNull();
  });

  it("freezes structured entries, preserves scroll, and keeps the capture view lease alive", async () => {
    fetchTranscript
      .mockResolvedValueOnce(transcript([{
        id: "assistant-last-live",
        ts: 1_786_704_770_000,
        kind: "assistant",
        text: "last structured answer",
      }]))
      .mockResolvedValue(transcript([{
        id: "assistant-too-late",
        ts: 1_786_704_780_000,
        kind: "assistant",
        text: "must not replace frozen output",
      }]));
    fetchCapture
      .mockResolvedValueOnce(liveCapture("last live bytes"))
      .mockResolvedValue(liveCapture("later capture bytes"));

    const { rerender } = render(<ExternalSessionDetail {...defaultProps} />);
    await flushLoads();

    const output = screen.getByTestId("external-session-scroll");
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
    expect(screen.getByText("last structured answer")).toBeTruthy();
    expect(output.scrollTop).toBe(42);

    for (let poll = 0; poll < 2; poll += 1) {
      await act(async () => {
        vi.advanceTimersByTime(10_000);
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    // Ended captures are memory-only server reads. Keep polling them so an
    // open browser view can never lose its no-prune lease, but never replace
    // the structured snapshot the operator was reading when the session died.
    expect(fetchCapture).toHaveBeenCalledTimes(3);
    expect(screen.getByText("last structured answer")).toBeTruthy();
    expect(screen.queryByText("must not replace frozen output")).toBeNull();
    expect(output.scrollTop).toBe(42);
  });

  it("freezes when the fresh capture reports ended before parent list polling catches up", async () => {
    fetchCapture.mockResolvedValue({
      ...liveCapture("alpha beta alpha"),
      state: "ended" as const,
    });

    render(<ExternalSessionDetail {...defaultProps} isMobile />);
    await flushLoads();

    expect(screen.getByText(/This session ended\./)).toBeTruthy();
    expect(screen.getByText("frozen — no further output")).toBeTruthy();
    expect(screen.getByText("I found the relevant implementation.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy tmux attach command" })).toBeNull();
  });

  it("keeps raw output search and mobile attach-command copy available from the toggle", async () => {
    fetchCapture.mockResolvedValue(liveCapture("alpha beta alpha"));

    render(<ExternalSessionDetail {...defaultProps} isMobile />);
    await flushLoads();

    expect(screen.getByTestId("external-session-mobile-footer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Raw terminal/i }));

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
