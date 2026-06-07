/**
 * Characterization + structural test for the session-list re-render storm fix.
 *
 * Ports the reconciler A/B/C harness (candidate-c/reconciler-ab.ts) into vitest.
 * It mirrors the SessionList→SessionCard parent/child structure and counts
 * child render-fn invocations across three arms:
 *
 *   A. BASELINE         — no memo, fresh `now`, fresh array, inline closures
 *   B. MEMO_ONLY        — React.memo(child) but fresh `now` + inline closures (NAIVE fix)
 *   C. MEMO_PLUS_STABLE — memo + stable `now` ref + stable callbacks + memo'd array (FULL fix)
 *
 * Reference counts (candidate-c/reconciler-ab-result.json), N=21:
 *   A: mount 21, one-item-update 21, unrelated-rerender 21
 *   B: mount 21, one-item-update 21 (DEFEATED), unrelated-rerender 21 (DEFEATED)
 *   C: mount 21, one-item-update 1,  unrelated-rerender 0
 *
 * The load-bearing point: naive React.memo(SessionCard)-only is FULLY DEFEATED
 * (21→21) because a fresh `now = Date.now()` prop and fresh inline closures
 * change identity every parent render. Only the full 4-part fix collapses the
 * storm to 1-on-change / 0-on-unrelated.
 *
 * A lightweight structural assertion then proves the SHIPPED code carries the
 * pattern: SessionCard is wrapped in React.memo, `now` is interval-state (not a
 * bare Date.now() in render scope), App memoizes the sessions array, and the
 * per-card onRename/onResume closures are gone.
 *
 * See change: fix-session-list-rerender-storm.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const N = 21; // mirrors the operator-observed mounted card surface
type Item = { id: string; v: number };

function makeItems(n: number): Map<string, Item> {
  const m = new Map<string, Item>();
  for (let i = 0; i < n; i++) m.set(`s${i}`, { id: `s${i}`, v: 0 });
  return m;
}

interface ArmResult {
  arm: "A" | "B" | "C";
  mountedChildren: number;
  onOneItemUpdate: number;
  onUnrelatedReRender: number;
}

/**
 * Runs one arm of the harness and returns render counts. Arm A = baseline,
 * B = memo-only (naive), C = memo + stable now + stable callbacks + memo'd array.
 */
function runArm(arm: "A" | "B" | "C"): ArmResult {
  let childRenders = 0;
  const Child = (props: { item: Item; now: number; onTap: (id: string) => void }) => {
    childRenders++;
    return React.createElement(
      "li",
      { onClick: () => props.onTap(props.item.id) },
      `${props.item.id}:${props.item.v}:${props.now > 0 ? "t" : ""}`,
    );
  };
  const MemoChild = React.memo(Child);
  const UseChild = arm === "A" ? Child : MemoChild;

  let setMap: React.Dispatch<React.SetStateAction<Map<string, Item>>> = () => {};
  let setBump: React.Dispatch<React.SetStateAction<number>> = () => {};

  const Parent = () => {
    const [map, _setMap] = React.useState(() => makeItems(N));
    const [, _setBump] = React.useState(0);
    setMap = _setMap;
    setBump = _setBump;

    // Part 1: stable `now`. A/B mint fresh now every render (poisons memo); C
    // holds it in a ref so identity stays put across renders.
    const nowRef = React.useRef(Date.now());
    const now = arm === "C" ? nowRef.current : Date.now();

    // Part 4: memo'd array. A/B build a fresh array each render (fresh identity);
    // C memoizes by map ref.
    const arr =
      arm === "C"
        ? // eslint-disable-next-line react-hooks/rules-of-hooks
          React.useMemo(() => Array.from(map.values()), [map])
        : Array.from(map.values());

    // Part 3: stable per-card callbacks. A/B pass a fresh inline closure to each
    // child each render (defeats memo); C passes one stable callback.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const stableTap = React.useCallback((id: string) => void id, []);

    return React.createElement(
      "ul",
      null,
      arr.map((item) =>
        // Part 2: React.memo(child) is the UseChild selection above.
        React.createElement(UseChild, {
          key: item.id,
          item,
          now,
          onTap: arm === "C" ? stableTap : (id: string) => void id,
        }),
      ),
    );
  };

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(React.createElement(Parent));
  });
  const mountedChildren = childRenders;

  // Update ONE item — simulates session_updated minting a new object ref for a
  // single session (useMessageHandler.ts:130).
  childRenders = 0;
  act(() => {
    setMap((prev) => {
      const next = new Map(prev);
      const ex = next.get("s0")!;
      next.set("s0", { ...ex, v: ex.v + 1 });
      return next;
    });
  });
  const onOneItemUpdate = childRenders;

  // Parent re-render WITHOUT touching the map — simulates openspec_update /
  // other unrelated App state changing.
  childRenders = 0;
  act(() => {
    setBump((x) => x + 1);
  });
  const onUnrelatedReRender = childRenders;

  act(() => {
    root.unmount();
  });
  container.remove();
  return { arm, mountedChildren, onOneItemUpdate, onUnrelatedReRender };
}

describe("session-list re-render storm — reconciler A/B/C characterization", () => {
  it("A. BASELINE storms every child on a single update AND on unrelated re-render", () => {
    const a = runArm("A");
    expect(a.mountedChildren).toBe(N);
    expect(a.onOneItemUpdate).toBe(N); // 21 — the storm
    expect(a.onUnrelatedReRender).toBe(N); // 21 — unrelated frame storms too
  });

  it("B. MEMO_ONLY is DEFEATED — fresh now + inline closures keep it at 21→21", () => {
    const b = runArm("B");
    expect(b.mountedChildren).toBe(N);
    // The load-bearing trap: naive React.memo alone does NOT help.
    expect(b.onOneItemUpdate).toBe(N); // still 21
    expect(b.onUnrelatedReRender).toBe(N); // still 21
  });

  it("C. FULL 4-part fix collapses to 1-on-change and 0-on-unrelated", () => {
    const c = runArm("C");
    expect(c.mountedChildren).toBe(N);
    // Correctness bar: the ONE changed card still re-renders (live updates kept).
    expect(c.onOneItemUpdate).toBe(1);
    // Unrelated re-render no longer touches any card.
    expect(c.onUnrelatedReRender).toBe(0);
  });

  it("the three arms differ exactly as the diagnostic recorded (A=B≠C)", () => {
    const [a, b, c] = (["A", "B", "C"] as const).map(runArm);
    // A and B are indistinguishable on the hot paths — memo-only buys nothing.
    expect(b.onOneItemUpdate).toBe(a.onOneItemUpdate);
    expect(b.onUnrelatedReRender).toBe(a.onUnrelatedReRender);
    // C is the only arm that breaks the storm.
    expect(c.onOneItemUpdate).toBeLessThan(b.onOneItemUpdate);
    expect(c.onUnrelatedReRender).toBeLessThan(b.onUnrelatedReRender);
  });
});

describe("session-list re-render storm — shipped-code structural assertions", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sessionCardSrc = readFileSync(path.join(here, "../SessionCard.tsx"), "utf8");
  const sessionListSrc = readFileSync(path.join(here, "../SessionList.tsx"), "utf8");
  const appSrc = readFileSync(path.join(here, "../../App.tsx"), "utf8");

  it("Part 2: SessionCard is wrapped in React.memo (named export preserved)", () => {
    expect(sessionCardSrc).toMatch(/export const SessionCard = React\.memo\(function SessionCard\(/);
  });

  it("Part 1: SessionList does not compute `now` as a bare Date.now() in render scope", () => {
    expect(sessionListSrc).not.toMatch(/^\s*const now = Date\.now\(\);/m);
    // It must instead be interval-updated state.
    expect(sessionListSrc).toMatch(/const \[now, setNow\] = useState\(\(\) => Date\.now\(\)\)/);
    expect(sessionListSrc).toMatch(/setInterval\(\s*\(\)\s*=>\s*setNow\(Date\.now\(\)\)/);
  });

  it("Part 3: per-card onRename/onResume inline closures are gone from SessionList", () => {
    expect(sessionListSrc).not.toMatch(/onRename=\{onRename \? \(name\) =>/);
    expect(sessionListSrc).not.toMatch(/onResume=\{onResume \? \(mode\) =>/);
    // Stable App handlers are forwarded directly.
    expect(sessionListSrc).toMatch(/onRename=\{onRename\}/);
    expect(sessionListSrc).toMatch(/onResume=\{onResume\}/);
  });

  it("Part 3: SessionCard onResume/onRename are id-based so callers forward stable refs", () => {
    expect(sessionCardSrc).toMatch(/onRename\?: \(id: string, name: string\) => void/);
    expect(sessionCardSrc).toMatch(/onResume\?: \(id: string, mode: "continue" \| "fork"\) => void/);
    expect(sessionCardSrc).toMatch(/onResume\(session\.id, "continue"\)/);
    expect(sessionCardSrc).toMatch(/onResume\(session\.id, "fork"\)/);
  });

  it("Part 4: App memoizes the sessions/terminals arrays handed to SessionList", () => {
    expect(appSrc).toMatch(/const sessionsArr = useMemo\(\(\) => Array\.from\(sessions\.values\(\)\), \[sessions\]\)/);
    expect(appSrc).toMatch(/const terminalsArr = useMemo\(\(\) => Array\.from\(terminals\.values\(\)\), \[terminals\]\)/);
    expect(appSrc).toMatch(/sessions=\{sessionsArr\}/);
    expect(appSrc).not.toMatch(/sessions=\{Array\.from\(sessions\.values\(\)\)\}/);
  });
});
