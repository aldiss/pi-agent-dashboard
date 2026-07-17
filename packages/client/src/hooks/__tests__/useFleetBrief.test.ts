import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useFleetBrief } from "../useFleetBrief.js";

/**
 * MAJOR 1 (build-2 fix-cycle) cause B: surfaces success requires the
 * `{success:true}` SHAPE, not merely HTTP-200. A 200 carrying
 * `{success:false}` must yield `surfacesOutcome:"failure"` so the cold-load
 * oracle never authorizes a false calm-zero.
 */

vi.mock("../../lib/api-context.js", () => ({ getApiBase: () => "" }));

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });
beforeEach(() => { vi.useRealTimers(); });

function mockFetchJson(body: unknown, ok = true) {
  globalThis.fetch = vi.fn(async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
}

describe("useFleetBrief — surfaces success-shape gate (MAJOR 1 cause B)", () => {
  it("HTTP-200 {success:false} → surfacesOutcome failure (NOT success)", async () => {
    mockFetchJson({ success: false, error: "forced E2E surfaces failure" });
    const { result } = renderHook(() => useFleetBrief([], 1000));
    await waitFor(() => expect(result.current.surfacesOutcome).toBe("failure"));
  });

  it("HTTP-200 {success:true, data:{surfaces:[]}} → success (healthy empty)", async () => {
    mockFetchJson({ success: true, data: { surfaces: [] } });
    const { result } = renderHook(() => useFleetBrief([], 1000));
    await waitFor(() => expect(result.current.surfacesOutcome).toBe("success"));
  });

  it("non-ok HTTP → failure", async () => {
    mockFetchJson({ success: true, data: { surfaces: [] } }, false);
    const { result } = renderHook(() => useFleetBrief([], 1000));
    await waitFor(() => expect(result.current.surfacesOutcome).toBe("failure"));
  });

  it("network throw → failure", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const { result } = renderHook(() => useFleetBrief([], 1000));
    await waitFor(() => expect(result.current.surfacesOutcome).toBe("failure"));
  });

  it("well-formed surfaces populate the brief items", async () => {
    mockFetchJson({ success: true, data: { surfaces: [{ id: "deck-1", operator_action: "push" }] } });
    const { result } = renderHook(() => useFleetBrief([], 1000));
    await waitFor(() => expect(result.current.items.some((i) => i.id === "deck-1")).toBe(true));
  });
});
