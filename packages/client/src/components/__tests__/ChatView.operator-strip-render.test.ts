/**
 * door-3 MOVE-2 strip-and-show — RENDER-BOUNDARY test (operator-VISIBLE).
 *
 * The gate: drive the REAL reducer through a terminal enforce-hit (producer's
 * voiceRecomposeState="terminal" + voiceMatches), then render the committed
 * message in the REAL ChatView and assert at the DOM boundary:
 *   - the jargon-id token is NOT in the rendered DOM (masked),
 *   - the non-jargon prose IS in the DOM (shown, not a content-hiding placeholder),
 *   - BOTH content shapes (string + block-array-joined) + the offset-drift
 *     whole-line fallback.
 *
 * This is the anti-false-green boundary (dl-8726): internal-rep is not enough,
 * the mask must hold at the operator-visible DOM. Plain-text states dodge the
 * pre-existing jsdom-canvas trap. Authored with React.createElement (.ts, no JSX).
 * See change: operator-voice-strip-and-show.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { render } from "@testing-library/react";
import { createElement } from "react";
import { ChatView } from "../ChatView.js";
import { ThemeProvider } from "../ThemeProvider.js";
import { createInitialState, reduceEvent, type SessionState, type VoiceMatch } from "../../lib/event-reducer.js";
import type { ToolContext } from "../tool-renderers/index.js";
import type { DashboardEvent } from "@blackbelt-technology/pi-dashboard-shared/types.js";

const toolCtx: ToolContext = { editors: [] };

beforeAll(() => {
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-color-scheme: dark)",
      media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })),
  });
});

function operatorStart(): SessionState {
  const s = { ...createInitialState(), audience: "operator" as const };
  return reduceEvent(s, { eventType: "message_start", timestamp: 1, data: { message: { role: "assistant", content: [] } } } as DashboardEvent);
}
function terminalEnd(text: string, matches: VoiceMatch[]): DashboardEvent {
  return {
    eventType: "message_end", timestamp: 3,
    data: { message: { role: "assistant", content: [{ type: "text", text }], audience: "operator", voiceVerdict: "enforce-hit", voiceRecomposeState: "terminal", voiceMatches: matches }, entryId: "e1", nonce: "n1" },
  } as DashboardEvent;
}
function renderState(state: SessionState) {
  return render(createElement(ThemeProvider, null, createElement(ChatView, { state, toolContext: toolCtx })));
}

describe("door-3 strip-and-show — render boundary (operator-VISIBLE)", () => {
  it("STRING content: jargon-id token masked out of the DOM; prose shown", () => {
    const text = "Shipped per dl-11131 today.";
    const matches: VoiceMatch[] = [{ id: "a", match: "dl-11131", index: text.indexOf("dl-11131"), mode: "enforce", category: "internal-id" }];
    let s = operatorStart();
    s = reduceEvent(s, { eventType: "message_update", timestamp: 2, data: { message: { role: "assistant", content: [{ type: "text", text }] } } } as DashboardEvent);
    s = reduceEvent(s, terminalEnd(text, matches));
    const { container } = renderState(s);
    const dom = container.textContent ?? "";
    expect(dom).not.toContain("dl-11131");   // jargon masked out of the DOM
    expect(dom).toContain("Shipped per");     // prose shown (not a "…" placeholder)
    expect(dom).toContain("today.");
  });

  it("BLOCK-ARRAY content (joined): jargon masked out of the DOM; prose shown", () => {
    // Multi-part text content → reducer joins to "Done per dl-77 in §16.1." →
    // offsets align → index-precise mask.
    const joined = "Done per dl-77 in \u00a716.1.";
    const matches: VoiceMatch[] = [
      { id: "a", match: "dl-77", index: joined.indexOf("dl-77"), mode: "enforce", category: "internal-id" },
      { id: "b", match: "\u00a716.1", index: joined.indexOf("\u00a716.1"), mode: "enforce", category: "internal-cite" },
    ];
    let s = operatorStart();
    s = reduceEvent(s, { eventType: "message_update", timestamp: 2, data: { message: { role: "assistant", content: [{ type: "text", text: "Done per " }, { type: "text", text: "dl-77 in \u00a716.1." }] } } } as DashboardEvent);
    s = reduceEvent(s, terminalEnd(joined, matches));
    const { container } = renderState(s);
    const dom = container.textContent ?? "";
    expect(dom).not.toContain("dl-77");
    expect(dom).not.toContain("\u00a716.1");
    expect(dom).toContain("Done per");        // non-jargon prose present
    expect(dom).toContain(" in ");
  });

  it("OFFSET-DRIFT fallback: whole-line redaction keeps jargon out of the DOM; clean lines shown", () => {
    const text = "clean opening line\nbody cites dl-9999 inline\nclean closing line";
    // Wrong index → forces the whole-line fallback (block-array join-mismatch shape).
    const matches: VoiceMatch[] = [{ id: "a", match: "dl-9999", index: 0, mode: "enforce", category: "internal-id" }];
    let s = operatorStart();
    s = reduceEvent(s, { eventType: "message_update", timestamp: 2, data: { message: { role: "assistant", content: [{ type: "text", text }] } } } as DashboardEvent);
    s = reduceEvent(s, terminalEnd(text, matches));
    const { container } = renderState(s);
    const dom = container.textContent ?? "";
    expect(dom).not.toContain("dl-9999");         // jargon line redacted whole
    expect(dom).toContain("clean opening line");   // other lines survive
    expect(dom).toContain("clean closing line");
  });
});
