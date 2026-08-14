/**
 * classifyTier — driver-registry signal.
 *
 * Live drivers are spawned into arbitrary working directories, so the cwd
 * heuristic (`nos-cells/` or a `-driver` path segment) misses them and they
 * land in `other`. The authoritative signal is the driver registry
 * (`~/.pi/orchestration-state/cell-driver-registry.json`), which `spawn-driver`
 * writes at spawn; the server stamps membership onto the session record as
 * `isRegisteredDriver` and this classifier consults it BEFORE the heuristics.
 *
 * Shapes below are measured own-hand from the running dashboard + registry
 * on 2026-08-14, not invented.
 */
import { describe, it, expect } from "vitest";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { classifyTier } from "../session-grouping.js";

function s(overrides: Partial<DashboardSession>): DashboardSession {
  return {
    id: "x",
    cwd: "/x",
    source: "tui",
    status: "active",
    startedAt: 0,
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
    ...overrides,
  } as DashboardSession;
}

describe("classifyTier — registered drivers", () => {
  it("classifies a registered driver in a non-driver-shaped cwd as drivers", () => {
    // Seatwright: cwd is the orchestration-state root — no `nos-cells/`, no
    // `-driver` segment. Registry is the only signal that it is a driver.
    expect(
      classifyTier(
        s({
          name: "Seatwright",
          source: "tmux",
          cwd: "/Users/vdrobkov/.pi/orchestration-state",
          isRegisteredDriver: true,
        }),
      ),
    ).toBe("drivers");

    // Branchwright: cwd is an ordinary product repo checkout.
    expect(
      classifyTier(
        s({
          name: "Branchwright",
          source: "tmux",
          cwd: "/Users/vdrobkov/Misc/Documents/Copilot/pi-agent-dashboard",
          isRegisteredDriver: true,
        }),
      ),
    ).toBe("drivers");

    // Trunkwright + Paneview share Branchwright's cwd — same shape, same result.
    for (const name of ["Trunkwright", "Paneview"]) {
      expect(
        classifyTier(
          s({
            name,
            source: "tmux",
            cwd: "/Users/vdrobkov/Misc/Documents/Copilot/pi-agent-dashboard",
            isRegisteredDriver: true,
          }),
        ),
      ).toBe("drivers");
    }
  });

  it("does NOT promote an unregistered tmux session (the guard)", () => {
    // The discriminator: registry membership moves a session, absence does not.
    // A change that moves this row too has replaced one bad heuristic with another.
    expect(
      classifyTier(
        s({
          name: "some-random-pane",
          source: "tmux",
          cwd: "/Users/vdrobkov/Misc/Documents/Copilot/pi-agent-dashboard",
          isRegisteredDriver: false,
        }),
      ),
    ).toBe("other");

    // Absent flag (registry unreadable / older server) behaves the same.
    expect(
      classifyTier(
        s({
          name: "some-random-pane",
          source: "tmux",
          cwd: "/Users/vdrobkov/Misc/Documents/Copilot/pi-agent-dashboard",
        }),
      ),
    ).toBe("other");
  });

  it("keeps standing-crew out of drivers even when registered (order-safe)", () => {
    // Every one of the nine canonical names ALSO has a row in the driver
    // registry, so this ordering is load-bearing, not theoretical: `Harry` is
    // `state=alive` in the registry right now.
    for (const name of ["Joan", "Bert", "Peggy", "Lane", "Pete", "Faye", "Don", "Alice", "Harry"]) {
      expect(
        classifyTier(s({ name, source: "tmux", cwd: "/anywhere", isRegisteredDriver: true })),
      ).toBe("standing-crew");
    }
    // Including the live status-suffix name shape.
    expect(
      classifyTier(
        s({
          name: "Joan — L0.5b Joan tenure-109 — system-evolution",
          source: "tmux",
          cwd: "/anywhere",
          isRegisteredDriver: true,
        }),
      ),
    ).toBe("standing-crew");
  });

  it("resolves Dawn as standing-crew and never lets the registry check reach her", () => {
    // Dawn is the 10th standing seat (L0.5f, ratified 2026-07-30). Her live
    // shape — source=tmux, cwd=~/.pi/orchestration-state, single-capital name —
    // matches NEITHER the cwd heuristic NOR THEMED_NAME_RE, so before she was
    // added to STANDING_CREW_NAME_RE she fell through to `other`.
    expect(
      classifyTier(
        s({ name: "Dawn", source: "tmux", cwd: "/Users/vdrobkov/.pi/orchestration-state" }),
      ),
    ).toBe("standing-crew");

    // The ordering proof, stated non-vacuously: Dawn is NOT in the driver
    // registry today, so asserting on her real (absent) flag would prove
    // nothing. Force the flag TRUE — the standing-crew test must still win, so
    // the registry check is unreachable for her by construction, not by luck.
    expect(
      classifyTier(
        s({
          name: "Dawn",
          source: "tmux",
          cwd: "/Users/vdrobkov/.pi/orchestration-state",
          isRegisteredDriver: true,
        }),
      ),
    ).toBe("standing-crew");

    // Same for the cwd fallback that would otherwise claim her.
    expect(
      classifyTier(
        s({
          name: "Dawn",
          source: "tmux",
          cwd: "/Users/x/.pi/orchestration-state/nos-cells/some-driver",
          isRegisteredDriver: true,
        }),
      ),
    ).toBe("standing-crew");

    // Live status-suffix shape + case-insensitivity, matching the other nine.
    expect(
      classifyTier(s({ name: "Dawn — recorder channel", source: "tmux", cwd: "/anywhere" })),
    ).toBe("standing-crew");
    expect(classifyTier(s({ name: "dawn-tenure-3", source: "tmux", cwd: "/anywhere" }))).toBe(
      "standing-crew",
    );

    // Boundary still holds: a longer word merely starting with "Dawn" is not her,
    // and "Don" must not swallow "Dawn" (nor the reverse).
    expect(classifyTier(s({ name: "Dawning", source: "tmux", cwd: "/anywhere" }))).toBe("other");
  });

  it("keeps a cell-internal worker out of drivers even when registered", () => {
    // Worker checks run before the driver check.
    expect(
      classifyTier(
        s({
          name: "subagent-worker-3f4a9b",
          source: "tmux",
          cwd: "/anywhere",
          isRegisteredDriver: true,
        }),
      ),
    ).toBe("worker");
    expect(
      classifyTier(
        s({
          name: "Vault",
          source: "tmux",
          cwd: "/anywhere",
          sessionFile: "/home/user/.pi/cells/foo/run-3/session.jsonl",
          isRegisteredDriver: true,
        }),
      ),
    ).toBe("worker");
  });

  it("retains the cwd heuristics as fallbacks when the flag is absent", () => {
    // Registry unreadable → flag absent → today's behaviour still applies.
    expect(
      classifyTier(
        s({
          name: "Vault",
          source: "tmux",
          cwd: "/Users/x/.pi/orchestration-state/nos-cells/cell-git-repo-binding",
        }),
      ),
    ).toBe("drivers");
    expect(
      classifyTier(s({ name: "Solo", source: "tmux", cwd: "/Users/x/work/my-thing-driver" })),
    ).toBe("drivers");
    // And the /.pi/cells/ guard on that fallback still holds.
    expect(
      classifyTier(
        s({ name: "OakHawk", source: "tmux", cwd: "/Users/x/.pi/cells/some-driver-cell/v1" }),
      ),
    ).toBe("cell-executor");
  });

  it("does not promote a registered name on a non-tmux source", () => {
    // The operator's own TUI pane keeps its tier; every registered driver
    // measured on the live dashboard is source=tmux.
    expect(
      classifyTier(s({ name: "Seatwright", source: "tui", cwd: "/x", isRegisteredDriver: true })),
    ).toBe("operator-chat-pane");
  });
});
