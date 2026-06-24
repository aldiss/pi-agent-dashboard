/**
 * Runtime session rescan + liveness re-resolution — WI-1 acceptance proof.
 *
 * Two layers, both own-hand-verifiable:
 *  - UNIT: drive the rescanner through injected `scan` + `makeLivenessSnapshot`
 *    + a captured `sink`, asserting the guarded-merge (I5), the ended→idle
 *    liveness flip (class-2 / WI-3), the I6 stale-predecessor surface, and the
 *    §4 step-events. No fs, no registry — fully deterministic.
 *  - E2E FIXTURE (the brief's exact pre/post): a real post-boot `.jsonl` under
 *    a real sessions dir, scanned by the real `scanAllSessions`, with a real
 *    temp messenger-registry (PI_MESSENGER_REGISTRY_DIR + this process's own
 *    kill-0-alive pid). PRE-tick `/listAll` EXCLUDES it; POST-tick INCLUDES it.
 *
 * See change: handover-reliability-wi1.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemorySessionManager } from "../memory-session-manager.js";
import { createSessionRescanner, canonicalIdentity, discriminateGroup, type RescanEvent } from "../session-rescan.js";
import { createLivenessSnapshot } from "../driver-liveness.js";
import { scanAllSessions } from "../session-scanner.js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";

/** Minimal DashboardSession builder. `over` wins over every default. */
function sess(over: Partial<DashboardSession> & { id: string }): DashboardSession {
  return {
    cwd: "/tmp/x",
    source: "tui",
    status: "ended",
    startedAt: 1000,
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
    ...over,
  };
}

/** A rescanner whose scan + liveness + sink are fully injected (no fs). */
function harness(opts: {
  scanned: DashboardSession[];
  alive: Record<string, { name?: string }>; // sessionId → alive (optional clean-name)
  seed?: DashboardSession[]; // pre-existing rows in the manager
  tmuxRoleOf?: (sessionId: string) => string | null; // GUARD-1 fallback (ii)
  roleRegistrySessionId?: (roleName: string) => string | null; // discriminator corroborator
}) {
  const sm = createMemorySessionManager();
  for (const s of opts.seed ?? []) sm.restore(s);
  const events: RescanEvent[] = [];
  const added: string[] = [];
  const updated: Array<{ id: string; updates: Partial<DashboardSession> }> = [];
  const rescanner = createSessionRescanner({
    sessionManager: sm,
    broadcastSessionAdded: (s) => added.push(s.id),
    broadcastSessionUpdated: (id, u) => updated.push({ id, updates: u }),
    scan: () => opts.scanned,
    makeLivenessSnapshot: () => (id: string) =>
      id in opts.alive ? { alive: true, name: opts.alive[id].name } : { alive: false },
    ...(opts.tmuxRoleOf ? { tmuxRoleOf: opts.tmuxRoleOf } : {}),
    ...(opts.roleRegistrySessionId ? { roleRegistrySessionId: opts.roleRegistrySessionId } : {}),
    sink: (e) => events.push(e),
    now: () => 1_700_000_000_000, // fixed clock — deterministic ts
  });
  return { sm, rescanner, events, added, updated };
}

describe("session-rescan — WI-1", () => {
  describe("class-1 VISIBILITY: guarded-merge of absent rows (I4/I5)", () => {
    it("merges an ABSENT scanned row into the manager (pre: absent → post: present)", () => {
      const h = harness({ scanned: [sess({ id: "new-1" })], alive: {} });
      expect(h.sm.get("new-1")).toBeUndefined(); // PRE
      const summary = h.rescanner.tick("test");
      expect(h.sm.get("new-1")).toBeDefined(); // POST
      expect(summary.merged).toBe(1);
      expect(h.added).toEqual(["new-1"]);
      // §4 step-events present.
      expect(h.events.find((e) => e.type === "rescan_started")).toBeTruthy();
      const merged = h.events.find((e) => e.type === "row_merged");
      expect(merged).toMatchObject({ type: "row_merged", id: "new-1", reason: "absent" });
    });

    it("an absent-but-ALIVE pi/tmux row merges in idle+visible (boot-equivalent Fix-L at merge)", () => {
      const h = harness({
        scanned: [sess({ id: "drv-1", status: "ended", hidden: true })],
        alive: { "drv-1": { name: "Don" } },
      });
      h.rescanner.tick("test");
      const row = h.sm.get("drv-1");
      expect(row?.status).toBe("idle");
      expect(row?.hidden).toBe(false);
      expect(row?.name).toBe("Don"); // registry clean-name applied
    });

    it("a CC session is merged but NEVER resurrected (stays ended, read-only)", () => {
      const h = harness({
        scanned: [sess({ id: "cc-1", source: "claude-code", status: "ended", hidden: true })],
        alive: { "cc-1": { name: "ShouldNotApply" } }, // even if a registry entry exists
      });
      h.rescanner.tick("test");
      const row = h.sm.get("cc-1");
      expect(row?.status).toBe("ended");
      expect(row?.source).toBe("claude-code");
    });
  });

  describe("I5 guard: never clobber a live/active row", () => {
    it("a scanned row whose id is already LIVE is skipped (no overwrite)", () => {
      const live = sess({ id: "live-1", status: "active", name: "LiveName", tokensIn: 999 });
      const stale = sess({ id: "live-1", status: "ended", name: "StaleName", tokensIn: 0 });
      const h = harness({ scanned: [stale], alive: {}, seed: [live] });
      const summary = h.rescanner.tick("test");
      const row = h.sm.get("live-1");
      expect(row?.status).toBe("active"); // unchanged
      expect(row?.name).toBe("LiveName"); // unchanged
      expect(row?.tokensIn).toBe(999); // unchanged
      expect(summary.skipped).toBe(1);
      expect(summary.merged).toBe(0);
      expect(h.events.find((e) => e.type === "row_skipped")).toMatchObject({
        type: "row_skipped",
        id: "live-1",
        reason: "live-active-guard",
      });
    });

    it("restore() itself refuses to overwrite a live row (unit, the I5 fix-site)", () => {
      const sm = createMemorySessionManager();
      sm.restore(sess({ id: "a", status: "active", name: "Keep" }));
      const result = sm.restore(sess({ id: "a", status: "ended", name: "Clobber" }));
      expect(result).toEqual({ applied: false, reason: "live-active-guard" });
      expect(sm.get("a")?.name).toBe("Keep");
      expect(sm.get("a")?.status).toBe("active");
    });

    it("restore() DOES replace an ended row, and reports reason existing-ended", () => {
      const sm = createMemorySessionManager();
      sm.restore(sess({ id: "b", status: "ended", name: "Old" }));
      const result = sm.restore(sess({ id: "b", status: "idle", name: "New" }));
      expect(result).toEqual({ applied: true, reason: "existing-ended" });
      expect(sm.get("b")?.name).toBe("New");
    });
  });

  describe("class-2 LIVENESS-TRUTH: ended→idle re-resolution on tick (WI-3 fold-in)", () => {
    it("an EXISTING ended-but-kill0-alive pi/tmux row flips to idle (no restart)", () => {
      const h = harness({
        scanned: [], // not in the scan — purely an in-manager re-resolution
        alive: { "ghost-alive": { name: "Lane" } },
        seed: [sess({ id: "ghost-alive", status: "ended", hidden: true, name: "stale" })],
      });
      const summary = h.rescanner.tick("test");
      const row = h.sm.get("ghost-alive");
      expect(row?.status).toBe("idle"); // flipped
      expect(row?.hidden).toBe(false);
      expect(row?.name).toBe("Lane"); // registry clean-name
      expect(summary.flipped).toBe(1);
      expect(h.updated).toContainEqual({ id: "ghost-alive", updates: { status: "idle", hidden: false, name: "Lane" } });
      expect(h.events.find((e) => e.type === "liveness_reresolved")).toMatchObject({
        type: "liveness_reresolved",
        id: "ghost-alive",
        kill0: "alive",
        flippedTo: "idle",
      });
    });

    it("a genuinely DEAD ended row stays ended (no flip, no event noise)", () => {
      const h = harness({
        scanned: [],
        alive: {}, // dead
        seed: [sess({ id: "really-dead", status: "ended" })],
      });
      const summary = h.rescanner.tick("test");
      expect(h.sm.get("really-dead")?.status).toBe("ended");
      expect(summary.flipped).toBe(0);
      expect(h.events.find((e) => e.type === "liveness_reresolved")).toBeUndefined();
    });

    it("a CC ended row is never flipped even if a registry entry claims alive", () => {
      const h = harness({
        scanned: [],
        alive: { "cc-ended": { name: "X" } },
        seed: [sess({ id: "cc-ended", source: "claude-code", status: "ended" })],
      });
      h.rescanner.tick("test");
      expect(h.sm.get("cc-ended")?.status).toBe("ended");
    });
  });

  describe("I6 cross-guard: alive predecessor + same-name successor → surface, don't duplicate", () => {
    it("does NOT create a 2nd live 'Lane' card; surfaces the predecessor for reap", () => {
      // Successor Lane-9 is live and holds the name 'Lane'. Predecessor Lane-8 is
      // ended but its pid is kill-0 alive (Lane-8 case, pid 58184). Flipping it
      // would make two live 'Lane' cards — I6 forbids that.
      const h = harness({
        scanned: [],
        alive: { "lane-8": { name: "Lane" } },
        seed: [
          sess({ id: "lane-9", status: "active", name: "Lane" }), // live successor
          sess({ id: "lane-8", status: "ended", name: "Lane" }), // alive predecessor
        ],
      });
      const summary = h.rescanner.tick("test");
      // Predecessor NOT flipped — stays ended (no duplicate live card).
      expect(h.sm.get("lane-8")?.status).toBe("ended");
      // Successor untouched.
      expect(h.sm.get("lane-9")?.status).toBe("active");
      // Exactly one live 'Lane'.
      expect(h.sm.listAll().filter((s) => s.name === "Lane" && s.status !== "ended")).toHaveLength(1);
      expect(summary.surfaced).toBe(1);
      expect(summary.flipped).toBe(0);
      const surfaced = h.events.find((e) => e.type === "stale_predecessor_surfaced");
      expect(surfaced).toMatchObject({
        type: "stale_predecessor_surfaced",
        id: "lane-8",
        name: "Lane",
        successorId: "lane-9",
      });
    });

    it("two ended-alive rows with the SAME name: first flips, second surfaces (no dup)", () => {
      const h = harness({
        scanned: [],
        alive: { "twin-a": { name: "Twin" }, "twin-b": { name: "Twin" } },
        seed: [
          sess({ id: "twin-a", status: "ended", name: "Twin" }),
          sess({ id: "twin-b", status: "ended", name: "Twin" }),
        ],
      });
      const summary = h.rescanner.tick("test");
      const live = h.sm.listAll().filter((s) => s.name === "Twin" && s.status !== "ended");
      expect(live).toHaveLength(1); // exactly one, never two
      expect(summary.flipped).toBe(1);
      expect(summary.surfaced).toBe(1);
    });
  });

  describe("rescan_complete summary event", () => {
    it("emits a final rescan_complete carrying the per-tick counts", () => {
      const h = harness({
        scanned: [sess({ id: "m1" })],
        alive: { "f1": { name: "F" } },
        seed: [sess({ id: "f1", status: "ended" })],
      });
      h.rescanner.tick("periodic");
      const complete = h.events.find((e) => e.type === "rescan_complete");
      expect(complete).toMatchObject({ type: "rescan_complete", merged: 1, flipped: 1, incoherent: 0 });
    });
  });
});

describe("session-rescan — WI-1 seam-finalization (trigger-b + discriminator + GUARD-1/2)", () => {
  describe("dedup trigger (b): same-name multi-live, NO flip involved", () => {
    it("two already-IDLE same-name rows → OLDER surfaced (trigger b), NEWER kept", () => {
      // Lane-8 + Lane-9 both already idle (no liveness flip). startedAt is the
      // discriminator: lane-9 newer → successor; lane-8 older → surfaced.
      const h = harness({
        scanned: [],
        alive: {}, // no flip path exercised — both already non-ended
        seed: [
          sess({ id: "lane-8", status: "idle", name: "Lane", startedAt: 1000 }),
          sess({ id: "lane-9", status: "idle", name: "Lane", startedAt: 2000 }),
        ],
      });
      const summary = h.rescanner.tick("test");
      expect(summary.surfaced).toBe(1);
      expect(summary.flipped).toBe(0); // nothing flipped — pure trigger-b
      expect(summary.incoherent).toBe(0);
      const surfaced = h.events.find((e) => e.type === "stale_predecessor_surfaced");
      expect(surfaced).toMatchObject({
        type: "stale_predecessor_surfaced",
        id: "lane-8", // the OLDER one
        successorId: "lane-9", // the NEWER one
        trigger: "same-name-multi-live",
      });
    });

    it("newest-by-startedAt is the successor regardless of row order", () => {
      const h = harness({
        scanned: [],
        alive: {},
        seed: [
          sess({ id: "c", status: "idle", name: "Role", startedAt: 3000 }), // newest
          sess({ id: "a", status: "idle", name: "Role", startedAt: 1000 }),
          sess({ id: "b", status: "idle", name: "Role", startedAt: 2000 }),
        ],
      });
      const summary = h.rescanner.tick("test");
      expect(summary.surfaced).toBe(2); // a + b
      const surfaced = h.events.filter((e) => e.type === "stale_predecessor_surfaced");
      expect(surfaced.every((e) => e.type === "stale_predecessor_surfaced" && e.successorId === "c")).toBe(true);
      expect(surfaced.map((e) => (e.type === "stale_predecessor_surfaced" ? e.id : "")).sort()).toEqual(["a", "b"]);
    });

    it("a single live row of a name is NOT a group → no surface, no incoherent", () => {
      const h = harness({
        scanned: [],
        alive: {},
        seed: [sess({ id: "solo", status: "idle", name: "Solo", startedAt: 1000 })],
      });
      const summary = h.rescanner.tick("test");
      expect(summary.surfaced).toBe(0);
      expect(summary.incoherent).toBe(0);
    });
  });

  describe("GUARD-1: grouping-key for null/empty-name rows", () => {
    it("a name:null row is grouped with a same-role row via the injected tmux fallback", () => {
      // Mid-respawn successor has name:null; tmux maps its sessionId → "Lane".
      // It then groups with the explicit-name "Lane" predecessor and dedups.
      const h = harness({
        scanned: [],
        alive: {},
        seed: [
          sess({ id: "lane-old", status: "idle", name: "Lane", startedAt: 1000 }),
          sess({ id: "lane-new", status: "idle", name: undefined, startedAt: 2000 }),
        ],
        tmuxRoleOf: (id) => (id === "lane-new" ? "Lane" : null),
      });
      const summary = h.rescanner.tick("test");
      // Grouped → lane-new (newer) successor, lane-old surfaced.
      expect(summary.surfaced).toBe(1);
      expect(summary.incoherent).toBe(0);
      const surfaced = h.events.find((e) => e.type === "stale_predecessor_surfaced");
      expect(surfaced).toMatchObject({ id: "lane-old", successorId: "lane-new" });
    });

    it("a name:null row that NO source resolves is NOT grouped (left alone, no event)", () => {
      const h = harness({
        scanned: [],
        alive: {}, // registry can't resolve it
        seed: [
          sess({ id: "named", status: "idle", name: "Alpha", startedAt: 1000 }),
          sess({ id: "orphan", status: "idle", name: undefined, startedAt: 2000, cwd: "/unique/cwd", sessionDir: "/unique/sd" }),
        ],
        tmuxRoleOf: () => null, // no tmux map either
      });
      const summary = h.rescanner.tick("test");
      // 'orphan' shares no name, no registry, no tmux, no cwd-cluster peer → ungrouped.
      expect(summary.surfaced).toBe(0);
      expect(summary.incoherent).toBe(0);
      // 'named' is a lone group of 1 → no action. Both rows untouched.
      expect(h.sm.get("orphan")?.status).toBe("idle");
      expect(h.sm.get("named")?.status).toBe("idle");
    });
  });

  describe("GUARD-2: identity_incoherent escape-hatch — surface, never guess", () => {
    it("equal startedAt (no unique newest) → identity_incoherent, NOT a stale_predecessor guess", () => {
      const h = harness({
        scanned: [],
        alive: {},
        seed: [
          sess({ id: "tie-1", status: "idle", name: "Twin", startedAt: 5000 }),
          sess({ id: "tie-2", status: "idle", name: "Twin", startedAt: 5000 }), // exact tie
        ],
      });
      const summary = h.rescanner.tick("test");
      expect(summary.incoherent).toBe(1);
      expect(summary.surfaced).toBe(0); // NO guess
      const incoherent = h.events.find((e) => e.type === "identity_incoherent");
      expect(incoherent).toMatchObject({ type: "identity_incoherent", roleOrCluster: "Twin" });
      expect(incoherent && incoherent.type === "identity_incoherent" && incoherent.candidateIds.sort()).toEqual(["tie-1", "tie-2"]);
      expect(h.events.find((e) => e.type === "stale_predecessor_surfaced")).toBeUndefined();
    });

    it("role-registry session_id DISAGREES with the startedAt winner → identity_incoherent", () => {
      // startedAt says reg-new (2000) is the successor, but the role-registry
      // names reg-old as canonical. Registries actively disagree → surface.
      const h = harness({
        scanned: [],
        alive: {},
        seed: [
          sess({ id: "reg-old", status: "idle", name: "Don", startedAt: 1000 }),
          sess({ id: "reg-new", status: "idle", name: "Don", startedAt: 2000 }),
        ],
        roleRegistrySessionId: (role) => (role === "Don" ? "reg-old" : null),
      });
      const summary = h.rescanner.tick("test");
      expect(summary.incoherent).toBe(1);
      expect(summary.surfaced).toBe(0);
      const incoherent = h.events.find((e) => e.type === "identity_incoherent");
      expect(incoherent).toMatchObject({ type: "identity_incoherent", roleOrCluster: "Don" });
      expect(incoherent && incoherent.type === "identity_incoherent" && /disagree/i.test(incoherent.reason)).toBe(true);
    });

    it("role-registry session_id AGREES with the startedAt winner → clean dedup (no incoherent)", () => {
      // Corroborator names reg-new — same as the startedAt winner → still clean.
      const h = harness({
        scanned: [],
        alive: {},
        seed: [
          sess({ id: "reg-old", status: "idle", name: "Don", startedAt: 1000 }),
          sess({ id: "reg-new", status: "idle", name: "Don", startedAt: 2000 }),
        ],
        roleRegistrySessionId: (role) => (role === "Don" ? "reg-new" : null),
      });
      const summary = h.rescanner.tick("test");
      expect(summary.incoherent).toBe(0);
      expect(summary.surfaced).toBe(1);
      expect(h.events.find((e) => e.type === "stale_predecessor_surfaced")).toMatchObject({ id: "reg-old", successorId: "reg-new" });
    });

    it("cwd-cluster fallback basis is ALWAYS incoherent (≥2 name-null rows in one cwd)", () => {
      // Two mid-respawn rows, both name:null, no registry, no tmux — they share a
      // cwd. The low-confidence cwd-cluster forms a group but GUARD-2 refuses to
      // pick a successor from cwd alone → identity_incoherent.
      const h = harness({
        scanned: [],
        alive: {},
        seed: [
          sess({ id: "blob-1", status: "idle", name: undefined, startedAt: 1000, cwd: "/proj", sessionDir: "/proj/.sd" }),
          sess({ id: "blob-2", status: "idle", name: undefined, startedAt: 2000, cwd: "/proj", sessionDir: "/proj/.sd" }),
        ],
        tmuxRoleOf: () => null,
      });
      const summary = h.rescanner.tick("test");
      expect(summary.incoherent).toBe(1);
      expect(summary.surfaced).toBe(0); // never a cwd-only guess
      const incoherent = h.events.find((e) => e.type === "identity_incoherent");
      expect(incoherent?.type === "identity_incoherent" && incoherent.candidateIds.sort()).toEqual(["blob-1", "blob-2"]);
      expect(incoherent?.type === "identity_incoherent" && /cwd-cluster/i.test(incoherent.reason)).toBe(true);
    });
  });

  describe("pure helpers (direct unit — discriminator + canonical identity)", () => {
    const noReg = { roleRegistrySessionId: () => null };
    const dead = (_id: string) => ({ alive: false as const });
    const noTmux = (_id: string) => null;

    it("canonicalIdentity prefers registry name, then explicit name, then tmux, else null", () => {
      // registry alive+name wins even over a different explicit name.
      expect(
        canonicalIdentity({ id: "x", name: "ExplicitName" }, () => ({ alive: true, name: "RegName" }), noTmux),
      ).toEqual({ key: "role:RegName", display: "RegName", basis: "registry" });
      // no registry → explicit name.
      expect(canonicalIdentity({ id: "x", name: "Plain" }, dead, noTmux)).toEqual({
        key: "role:Plain",
        display: "Plain",
        basis: "name",
      });
      // no registry, no name → tmux.
      expect(canonicalIdentity({ id: "x", name: undefined }, dead, () => "TmuxRole")).toEqual({
        key: "role:TmuxRole",
        display: "TmuxRole",
        basis: "tmux",
      });
      // nothing resolves → null (ungrouped).
      expect(canonicalIdentity({ id: "x", name: undefined }, dead, noTmux)).toBeNull();
    });

    it("discriminateGroup decides the clean newest-startedAt case", () => {
      const rows = [sess({ id: "old", startedAt: 1 }), sess({ id: "new", startedAt: 9 })];
      const v = discriminateGroup(rows, "name", "Role", noReg);
      expect(v.kind).toBe("decided");
      if (v.kind === "decided") {
        expect(v.successor.id).toBe("new");
        expect(v.predecessors.map((r) => r.id)).toEqual(["old"]);
      }
    });

    it("discriminateGroup → incoherent on startedAt tie", () => {
      const rows = [sess({ id: "a", startedAt: 5 }), sess({ id: "b", startedAt: 5 })];
      expect(discriminateGroup(rows, "name", "Role", noReg).kind).toBe("incoherent");
    });

    it("discriminateGroup → incoherent on missing startedAt at the top", () => {
      const rows = [sess({ id: "a", startedAt: undefined }), sess({ id: "b", startedAt: undefined })];
      expect(discriminateGroup(rows, "name", "Role", noReg).kind).toBe("incoherent");
    });

    it("discriminateGroup → always incoherent for cwd-cluster basis even with clean startedAt", () => {
      const rows = [sess({ id: "a", startedAt: 1 }), sess({ id: "b", startedAt: 9 })];
      expect(discriminateGroup(rows, "cwd-cluster", "cwd:/proj", noReg).kind).toBe("incoherent");
    });
  });
});

describe("session-rescan — E2E fixture through real scanAllSessions + registry (the brief's pre/post)", () => {
  let sessionsDir: string;
  let regDir: string;
  const ALIVE_PID = process.pid; // unquestionably kill-0 alive

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "rescan-sessions-"));
    regDir = mkdtempSync(join(tmpdir(), "rescan-reg-"));
    process.env.PI_MESSENGER_REGISTRY_DIR = regDir;
  });
  afterEach(() => {
    delete process.env.PI_MESSENGER_REGISTRY_DIR;
    rmSync(sessionsDir, { recursive: true, force: true });
    rmSync(regDir, { recursive: true, force: true });
  });

  /** Write a real post-boot session .jsonl under an existing cwd dir. */
  function dropSessionJsonl(cwdEnc: string, tsName: string, id: string, cwd: string): void {
    const dir = join(sessionsDir, cwdEnc);
    mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "session", id, cwd, timestamp: "2026-06-24T07:00:00.000Z" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "post-boot turn" } }),
    ];
    writeFileSync(join(dir, `${tsName}_${id}.jsonl`), lines.join("\n") + "\n");
  }

  it("post-boot no-bridge JSONL: PRE-tick listAll EXCLUDES, POST-tick INCLUDES (pid=null), WITHOUT restart", () => {
    const sm = createMemorySessionManager();
    // Boot already happened with an EMPTY sessions dir → manager has nothing.
    expect(sm.listAll()).toHaveLength(0);

    // A new session lands AFTER boot (no bridge registration, no restart).
    dropSessionJsonl("--proj--", "2026-06-24T07-01-00-000Z", "postboot-uuid", "/proj");

    const rescanner = createSessionRescanner({
      sessionManager: sm,
      broadcastSessionAdded: () => {},
      broadcastSessionUpdated: () => {},
      // REAL scan of the temp sessions dir + REAL registry snapshot.
      scan: () => scanAllSessions(sessionsDir).sessions,
      makeLivenessSnapshot: () => createLivenessSnapshot(),
      sink: () => {},
    });

    // PRE: excluded (this is the class-1 bug — invisible until restart).
    expect(sm.get("postboot-uuid")).toBeUndefined();

    // One tick — no restart.
    rescanner.tick("test");

    // POST: included. No registry entry binds it → stays ended, pid undefined.
    const row = sm.get("postboot-uuid");
    expect(row).toBeDefined();
    expect(row?.cwd).toBe("/proj");
    expect(row?.status).toBe("ended"); // never registered, no live pid → correctly ended
    expect(row?.pid).toBeUndefined();
  });

  it("post-boot JSONL whose pid IS kill-0 alive: POST-tick merges it idle+visible (Fix-L composition)", () => {
    const sm = createMemorySessionManager();
    dropSessionJsonl("--proj--", "2026-06-24T07-02-00-000Z", "alive-uuid", "/proj");
    // A messenger-registry entry binds sessionId === id with THIS process's pid.
    writeFileSync(join(regDir, "Don.json"), JSON.stringify({ name: "Don", pid: ALIVE_PID, sessionId: "alive-uuid" }));

    const rescanner = createSessionRescanner({
      sessionManager: sm,
      broadcastSessionAdded: () => {},
      broadcastSessionUpdated: () => {},
      scan: () => scanAllSessions(sessionsDir).sessions,
      makeLivenessSnapshot: () => createLivenessSnapshot(),
      sink: () => {},
    });

    expect(sm.get("alive-uuid")).toBeUndefined(); // PRE
    rescanner.tick("test");
    const row = sm.get("alive-uuid"); // POST
    expect(row).toBeDefined();
    expect(row?.status).toBe("idle"); // alive → not false-ended
    expect(row?.hidden).toBe(false);
    expect(row?.name).toBe("Don"); // registry clean-name
  });

  it("an EXISTING ended row whose pid is kill-0 alive flips to idle on the tick (no restart)", () => {
    const sm = createMemorySessionManager();
    // Seed an ended row (as boot would, having false-ended a live driver).
    sm.restore({
      id: "flip-uuid",
      cwd: "/proj",
      source: "tui",
      status: "ended",
      hidden: true,
      startedAt: 1000,
      tokensIn: 0,
      tokensOut: 0,
      cost: 0,
    });
    writeFileSync(join(regDir, "Lane.json"), JSON.stringify({ name: "Lane", pid: ALIVE_PID, sessionId: "flip-uuid" }));

    const rescanner = createSessionRescanner({
      sessionManager: sm,
      broadcastSessionAdded: () => {},
      broadcastSessionUpdated: () => {},
      scan: () => [], // not in scan — pure in-manager re-resolution
      makeLivenessSnapshot: () => createLivenessSnapshot(),
      sink: () => {},
    });

    expect(sm.get("flip-uuid")?.status).toBe("ended"); // PRE
    rescanner.tick("test");
    expect(sm.get("flip-uuid")?.status).toBe("idle"); // POST — flipped, no restart
    expect(sm.get("flip-uuid")?.name).toBe("Lane");
  });
});
