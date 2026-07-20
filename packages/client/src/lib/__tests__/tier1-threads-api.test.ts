/**
 * Tests for the Tier-1 pure thread-tree + status contract (`tier1-threads-api`).
 *
 * The tree builder is flat today (no parent_thread_id) but MUST already handle
 * the Tier-2 tree shape + the sanitize pass (dangling / cyclic parent → promote
 * to root with a breadcrumb; emitted-count == input-count). These lock that in
 * before any provenance data exists.
 */
import { describe, it, expect } from "vitest";
import { buildThreadTree, type ThreadSummary } from "../tier1-threads-api.js";

function summary(thread_id: string, parent_thread_id: string | null = null): ThreadSummary {
  return {
    thread_id,
    parent_thread_id,
    status: { thread_id, kind: "building", reason: "no_rows" },
  };
}

describe("buildThreadTree — flat today", () => {
  it("returns a flat list (all depth 0) when no parent_thread_id is present", () => {
    const roots = buildThreadTree([summary("a"), summary("b"), summary("c")]);
    expect(roots).toHaveLength(3);
    expect(roots.every((n) => n.depth === 0)).toBe(true);
    expect(roots.every((n) => n.children.length === 0)).toBe(true);
  });

  it("preserves input order at the root level", () => {
    const roots = buildThreadTree([summary("z"), summary("m"), summary("a")]);
    expect(roots.map((n) => n.summary.thread_id)).toEqual(["z", "m", "a"]);
  });
});

describe("buildThreadTree — Tier-2 tree shape (nests for free)", () => {
  it("nests a child under its parent and stamps depth", () => {
    const roots = buildThreadTree([summary("root"), summary("child", "root")]);
    expect(roots).toHaveLength(1);
    expect(roots[0].summary.thread_id).toBe("root");
    expect(roots[0].children).toHaveLength(1);
    expect(roots[0].children[0].summary.thread_id).toBe("child");
    expect(roots[0].children[0].depth).toBe(1);
  });

  it("handles a 3-level chain", () => {
    const roots = buildThreadTree([summary("a"), summary("b", "a"), summary("c", "b")]);
    expect(roots).toHaveLength(1);
    expect(roots[0].children[0].children[0].summary.thread_id).toBe("c");
    expect(roots[0].children[0].children[0].depth).toBe(2);
  });
});

describe("buildThreadTree — sanitize pass (safety on imported/legacy data)", () => {
  it("promotes a node with a DANGLING parent to a root with a breadcrumb", () => {
    const roots = buildThreadTree([summary("orphan", "ghost-parent")]);
    expect(roots).toHaveLength(1);
    expect(roots[0].summary.thread_id).toBe("orphan");
    expect(roots[0].promotedFrom).toBe("ghost-parent");
  });

  it("promotes a CYCLE-trapped node to a root (never infinite-loops)", () => {
    // a → b → a is a cycle; both must survive as roots, none dropped.
    const roots = buildThreadTree([summary("a", "b"), summary("b", "a")]);
    const ids = roots.map((n) => n.summary.thread_id).sort();
    expect(ids).toEqual(["a", "b"]);
    expect(roots.every((n) => n.promotedFrom !== undefined)).toBe(true);
  });

  it("asserts emitted-count == input-count (no node lost or duplicated)", () => {
    const input = [summary("a"), summary("b", "a"), summary("c"), summary("d", "ghost")];
    const roots = buildThreadTree(input);
    let emitted = 0;
    const walk = (n: { children: unknown[] }) => {
      emitted++;
      for (const c of n.children as { children: unknown[] }[]) walk(c);
    };
    for (const r of roots) walk(r);
    expect(emitted).toBe(input.length);
  });
});
