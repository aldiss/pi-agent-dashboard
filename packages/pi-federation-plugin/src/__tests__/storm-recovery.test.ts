/**
 * Regression tests for the federation-storm recovery patches.
 *
 * Two distinct bugs were observed live on 2026-06-02 against the running
 * MacBook dashboard (PID 94841) with an iMac peer continuously connecting:
 *
 *   Bug 1 ("enabled flag ignored"):
 *     Operator set plugins.federation.enabled=false expecting the plugin to
 *     short-circuit. The plugin loaded peers regardless. The peer connection
 *     storm continued at ~60-130s reconnect cadence ([peer:imac] watchdog
 *     timeout — forcing reconnect), each cycle running the buggy prefixIds
 *     recursion below.
 *
 *   Bug 2 ("prefixIds stack overflow"):
 *     prefixIds() recursed unbounded with no cycle detection. A peer-sent
 *     payload containing a circular reference (or merely a deeply-nested
 *     graph) blew the V8 call stack with
 *       RangeError: Maximum call stack size exceeded
 *         at prefixIds (pi-federation-plugin/src/server/index.ts:134)
 *     The error was swallowed by the dashboard [crash-safety] handler but
 *     left in-flight state corrupt, contributing to a browser-WS
 *     disconnect/reconnect loop the operator perceived as "history loading
 *     in circles."
 *
 * Both tests below intentionally exercise externally-observable behavior
 * via `__internal` so the production code path is hit (not a re-implementation).
 */
import { describe, it, expect } from "vitest";
import { __internal, PREFIX_IDS_MAX_DEPTH } from "../server/index.js";

const { prefixIds, resolveConfig } = __internal;

describe("resolveConfig — enabled flag defaulting", () => {
  it("defaults enabled to true when the field is absent (back-compat)", () => {
    const cfg = resolveConfig({});
    expect(cfg.enabled).toBe(true);
  });

  it("preserves enabled=false when operator opts out", () => {
    const cfg = resolveConfig({ enabled: false });
    expect(cfg.enabled).toBe(false);
  });

  it("preserves enabled=true when operator opts in explicitly", () => {
    const cfg = resolveConfig({ enabled: true });
    expect(cfg.enabled).toBe(true);
  });
});

describe("prefixIds — cycle + depth defense", () => {
  it("rewrites bare sessionId fields with machineId prefix (baseline)", () => {
    const input = { sessionId: "019e2363-0710-73be-82cf-dbd38cb655cd" };
    const out = prefixIds(input, "imac") as { sessionId: string };
    expect(out.sessionId).toBe("imac:019e2363-0710-73be-82cf-dbd38cb655cd");
  });

  it("rewrites session-shaped `id` fields with machineId prefix (baseline)", () => {
    const input = { id: "019e2363-0710-73be-82cf-dbd38cb655cd", title: "Lane" };
    const out = prefixIds(input, "imac") as { id: string; title: string };
    expect(out.id).toBe("imac:019e2363-0710-73be-82cf-dbd38cb655cd");
    expect(out.title).toBe("Lane");
  });

  it("does NOT double-prefix sessionIds that already contain a colon", () => {
    const input = { sessionId: "win:019e2363-0710-73be-82cf-dbd38cb655cd" };
    const out = prefixIds(input, "imac") as { sessionId: string };
    expect(out.sessionId).toBe("win:019e2363-0710-73be-82cf-dbd38cb655cd");
  });

  it("survives a directly self-referential object without stack overflow", () => {
    // Pre-fix: this would throw `RangeError: Maximum call stack size exceeded`
    // and be swallowed by dashboard [crash-safety], corrupting in-flight state.
    type Node = { sessionId: string; self?: Node };
    const node: Node = { sessionId: "019e2363-0710-73be-82cf-dbd38cb655cd" };
    node.self = node;
    expect(() => prefixIds(node, "imac")).not.toThrow();
  });

  it("survives a cross-referencing object graph without stack overflow", () => {
    type A = { tag: "a"; ref?: B };
    type B = { tag: "b"; ref?: A };
    const a: A = { tag: "a" };
    const b: B = { tag: "b" };
    a.ref = b;
    b.ref = a;
    expect(() => prefixIds(a, "imac")).not.toThrow();
  });

  it("survives a circular array payload (typical of streaming event buffers)", () => {
    const arr: unknown[] = [];
    arr.push(arr);
    arr.push({ sessionId: "019e2363-0710-73be-82cf-dbd38cb655cd" });
    expect(() => prefixIds(arr, "imac")).not.toThrow();
  });

  it("caps recursion at PREFIX_IDS_MAX_DEPTH for non-circular but pathologically deep graphs", () => {
    // Build a linear chain `{ next: { next: { ... } } }` deeper than the
    // configured cap. Pre-fix this would overflow the stack at depths well
    // below V8's default ~10K-frame stack on hot async code paths.
    let leaf: Record<string, unknown> = { sessionId: "019e2363-0710-73be-82cf-dbd38cb655cd" };
    for (let i = 0; i < PREFIX_IDS_MAX_DEPTH + 50; i++) {
      leaf = { next: leaf };
    }
    expect(() => prefixIds(leaf, "imac")).not.toThrow();
  });

  it("still rewrites top-level ids correctly when graph contains cycles deeper down", () => {
    type Leaf = { sessionId: string; loop?: Leaf };
    const leaf: Leaf = { sessionId: "019e2363-0710-73be-82cf-dbd38cb655cd" };
    leaf.loop = leaf;
    const root = {
      sessionId: "019e7f46-1cd8-7506-8911-3d0b3a7a06a6",
      payload: leaf,
    };
    const out = prefixIds(root, "imac") as { sessionId: string; payload: { sessionId: string } };
    expect(out.sessionId).toBe("imac:019e7f46-1cd8-7506-8911-3d0b3a7a06a6");
    expect(out.payload.sessionId).toBe("imac:019e2363-0710-73be-82cf-dbd38cb655cd");
  });
});
