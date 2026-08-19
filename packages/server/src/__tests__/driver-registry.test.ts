/**
 * driver-registry — FS wrapper over `cell-driver-registry.json`.
 *
 * Fixtures below are the real shapes measured own-hand from the live registry
 * on 2026-08-14 (Seatwright/Branchwright in a non-driver-shaped cwd; `Docket`
 * whose tmux name diverges from its key; `Docket-2` ended-in-registry but live
 * on the dashboard with a status-suffixed name).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import {
  createDriverRegistry,
  driverLookupKeys,
  indexDriverNames,
} from "../driver-registry.js";

const REGISTRY_FIXTURE = JSON.stringify({
  schema_version: 1,
  drivers: {
    Seatwright: {
      real_name: "Seatwright",
      state: "alive",
      tmux: "Seatwright",
      cell: "cell-seat",
    },
    Branchwright: {
      real_name: "Branchwright",
      state: "alive",
      tmux: "Branchwright",
      cell: "cell-branch",
    },
    Docket: { real_name: "Docket", state: "alive", tmux: "Docket-5", cell: "cell-docket" },
    "Docket-2": { real_name: "Docket-2", state: "ended", tmux: null, cell: null },
    Harry: { real_name: "Harry", state: "alive", tmux: "harry-live-20", cell: "cell-harry" },
    "sess-019f13fd": { real_name: "sess-019f13fd", state: "alive", tmux: null, cell: null },
  },
});

function mk(json: string) {
  return createDriverRegistry({ registryPath: "/fake", readFile: () => json });
}

describe("driverLookupKeys", () => {
  it("returns the trimmed, lowercased name", () => {
    expect(driverLookupKeys("  Seatwright ")).toEqual(["seatwright"]);
  });

  it("also returns the leading segment before a ' — ' status suffix", () => {
    // Live shape: `Docket-2 — HOLD-WARM (Joan-directed, do-not-reap)…`
    expect(driverLookupKeys("Docket-2 — HOLD-WARM (Joan-directed)")).toEqual([
      "docket-2 — hold-warm (joan-directed)",
      "docket-2",
    ]);
    // Two separators: identity is the FIRST segment.
    expect(driverLookupKeys("GateDriver — L2 GateDriver — pi-landing-gate")).toContain("gatedriver");
  });

  it("returns no keys for an absent or blank name", () => {
    expect(driverLookupKeys(undefined)).toEqual([]);
    expect(driverLookupKeys("   ")).toEqual([]);
  });
});

describe("indexDriverNames", () => {
  it("indexes the row key, real_name and tmux name, lowercased", () => {
    const names = indexDriverNames(JSON.parse(REGISTRY_FIXTURE));
    expect(names.has("seatwright")).toBe(true);
    expect(names.has("docket")).toBe(true);
    // tmux name diverges from the key on a handful of live rows.
    expect(names.has("docket-5")).toBe(true);
    expect(names.has("harry-live-20")).toBe(true);
  });

  it("indexes ended rows too (a driver that ended is still a driver)", () => {
    expect(indexDriverNames(JSON.parse(REGISTRY_FIXTURE)).has("docket-2")).toBe(true);
  });

  it("returns an empty set for malformed input rather than throwing", () => {
    expect(indexDriverNames(null).size).toBe(0);
    expect(indexDriverNames({}).size).toBe(0);
    expect(indexDriverNames({ drivers: "nope" }).size).toBe(0);
    expect(indexDriverNames({ drivers: { A: null, B: 42 } }).has("a")).toBe(true);
  });
});

describe("createDriverRegistry", () => {
  it("returns canonical driver records with tmux aliases and null cells", () => {
    const drivers = mk(REGISTRY_FIXTURE).getCellDrivers();

    expect(drivers).toHaveLength(6);
    expect(drivers).toEqual(expect.arrayContaining([
      { realName: "Seatwright", tmux: "Seatwright", cell: "cell-seat" },
      { realName: "Docket", tmux: "Docket-5", cell: "cell-docket" },
      { realName: "Docket-2", tmux: null, cell: null },
    ]));
  });

  it("recognises a registered driver by exact name", () => {
    const reg = mk(REGISTRY_FIXTURE);
    expect(reg.isRegisteredDriver("Seatwright")).toBe(true);
    expect(reg.isRegisteredDriver("branchwright")).toBe(true);
  });

  it("recognises a registered driver whose name carries a status suffix", () => {
    expect(mk(REGISTRY_FIXTURE).isRegisteredDriver("Docket-2 — HOLD-WARM (do-not-reap)")).toBe(true);
  });

  it("rejects an unregistered name (the guard)", () => {
    const reg = mk(REGISTRY_FIXTURE);
    expect(reg.isRegisteredDriver("some-random-pane")).toBe(false);
    expect(reg.isRegisteredDriver(undefined)).toBe(false);
    expect(reg.isRegisteredDriver("")).toBe(false);
    // Not a prefix/substring match: a longer name is not the driver.
    expect(reg.isRegisteredDriver("SeatwrightExtra")).toBe(false);
  });

  it("degrades to false when the registry is missing or unparseable", () => {
    const missing = createDriverRegistry({
      registryPath: "/fake",
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    expect(missing.isRegisteredDriver("Seatwright")).toBe(false);
    expect(missing.getDriverNames().size).toBe(0);
    expect(missing.getCellDrivers()).toEqual([]);

    const garbage = mk("{ not json");
    expect(garbage.isRegisteredDriver("Seatwright")).toBe(false);
    expect(garbage.getCellDrivers()).toEqual([]);
  });

  it("caches within the TTL and re-reads after it lapses", () => {
    let reads = 0;
    let payload = JSON.stringify({
      drivers: { Alpha: { real_name: "Alpha", tmux: null, cell: null } },
    });
    let now = 1000;
    const reg = createDriverRegistry({
      registryPath: "/fake",
      ttlMs: 5000,
      now: () => now,
      readFile: () => {
        reads++;
        return payload;
      },
    });

    expect(reg.isRegisteredDriver("Alpha")).toBe(true);
    expect(reg.getCellDrivers()).toEqual([
      { realName: "Alpha", tmux: null, cell: null },
    ]);
    expect(reg.isRegisteredDriver("Alpha")).toBe(true);
    expect(reads).toBe(1);

    payload = JSON.stringify({
      drivers: { Beta: { real_name: "Beta", tmux: "beta-live", cell: "cell-beta" } },
    });
    now += 1000;
    expect(reg.getCellDrivers()).toEqual([
      { realName: "Alpha", tmux: null, cell: null },
    ]); // still cached
    now += 5000;
    expect(reg.getCellDrivers()).toEqual([
      { realName: "Beta", tmux: "beta-live", cell: "cell-beta" },
    ]); // TTL lapsed → re-read
    expect(reg.isRegisteredDriver("Beta")).toBe(true);
    expect(reads).toBe(2);
  });

  it("invalidate() forces a re-read before the TTL lapses", () => {
    let payload = JSON.stringify({ drivers: { Alpha: { real_name: "Alpha" } } });
    const reg = createDriverRegistry({
      registryPath: "/fake",
      ttlMs: 60_000,
      now: () => 1000,
      readFile: () => payload,
    });
    expect(reg.isRegisteredDriver("Beta")).toBe(false);
    payload = JSON.stringify({ drivers: { Beta: { real_name: "Beta" } } });
    reg.invalidate();
    expect(reg.isRegisteredDriver("Beta")).toBe(true);
  });

  it("startWatch on a missing registry does not throw", () => {
    const reg = createDriverRegistry({ registryPath: "/no/such/path/registry.json" });
    expect(() => reg.startWatch(() => {})).not.toThrow();
    expect(() => reg.stopWatch()).not.toThrow();
  });
});

/**
 * Watch durability over ATOMIC REPLACEMENT.
 *
 * Every writer of this registry replaces it temp-file + rename, which unlinks the
 * inode. A file-bound watch therefore fires exactly once and goes deaf — the
 * defect these tests pin. They use a real temp dir and real renames (an in-place
 * `writeFileSync` keeps the inode and would pass against the broken code), and
 * they FREEZE the clock with a long TTL so the only thing that can move the
 * observed state is the watch itself, never a TTL re-read.
 */
describe("createDriverRegistry — watch survives atomic replacement", () => {
  const tmpDirs: string[] = [];
  const registries: Array<{ stopWatch: () => void }> = [];

  afterEach(() => {
    for (const r of registries.splice(0)) r.stopWatch();
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function tmpDir(): string {
    const dir = mkdtempSync(join(os.tmpdir(), "driver-registry-watch-"));
    tmpDirs.push(dir);
    return dir;
  }

  /** Real atomic replace: write a sibling temp file, then rename over the target. */
  function atomicWrite(path: string, contents: string): void {
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, contents);
    renameSync(tmp, path);
  }

  function payload(...names: string[]): string {
    const drivers: Record<string, unknown> = {};
    for (const n of names) drivers[n] = { real_name: n, state: "alive", tmux: null, cell: null };
    return JSON.stringify({ schema_version: 1, drivers });
  }

  /** Frozen clock + 10-minute TTL: the cache never lapses inside a test. */
  function mkWatched(registryPath: string) {
    const reg = createDriverRegistry({ registryPath, ttlMs: 600_000, now: () => 1_000_000 });
    registries.push(reg);
    return reg;
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`waitFor timed out after ${timeoutMs}ms`);
  }

  const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

  /**
   * Drain the platform's watch lookback before counting callbacks.
   *
   * macOS FSEvents redelivers events from just BEFORE a watch was installed
   * (measured own-hand: a watch created after the setup write still receives that
   * write's `rename`). That is a platform artifact of test setup, not a filter
   * miss — the unrelated-file writes below carry their own basenames and are
   * correctly rejected. Settle, then zero, so a count measures only what the test
   * does after this point.
   */
  const drainLookback = (reset: () => void) => settle(250).then(reset);

  it("reflects the SECOND atomic replacement, not just the first", async () => {
    const dir = tmpDir();
    const path = join(dir, "cell-driver-registry.json");
    atomicWrite(path, payload("Alpha"));

    const reg = mkWatched(path);
    let changes = 0;
    reg.startWatch(() => {
      changes++;
    });
    await drainLookback(() => {
      changes = 0;
    });

    expect(reg.isRegisteredDriver("Alpha")).toBe(true);

    // First replacement — passes even against the broken file-watch.
    atomicWrite(path, payload("Beta"));
    await waitFor(() => reg.isRegisteredDriver("Beta"));
    expect(reg.isRegisteredDriver("Alpha")).toBe(false);

    // Second replacement — the whole point. The inode the first watch was bound
    // to is already gone; only a directory watch still sees this.
    atomicWrite(path, payload("Gamma"));
    await waitFor(() => reg.isRegisteredDriver("Gamma"));
    expect(reg.isRegisteredDriver("Beta")).toBe(false);
    expect(changes).toBeGreaterThanOrEqual(2);
  });

  it("keeps firing across many replacements (fifth write still lands)", async () => {
    const dir = tmpDir();
    const path = join(dir, "cell-driver-registry.json");
    atomicWrite(path, payload("Seed"));

    const reg = mkWatched(path);
    reg.startWatch(() => {});

    for (const name of ["One", "Two", "Three", "Four", "Five"]) {
      atomicWrite(path, payload(name));
      await waitFor(() => reg.isRegisteredDriver(name));
    }
    expect(reg.isRegisteredDriver("Five")).toBe(true);
    expect(reg.isRegisteredDriver("Seed")).toBe(false);
  });

  it("coalesces one replacement into a single onChange", async () => {
    const dir = tmpDir();
    const path = join(dir, "cell-driver-registry.json");
    atomicWrite(path, payload("Alpha"));

    const reg = mkWatched(path);
    let changes = 0;
    reg.startWatch(() => {
      changes++;
    });
    await drainLookback(() => {
      changes = 0;
    });

    atomicWrite(path, payload("Beta"));
    await waitFor(() => reg.isRegisteredDriver("Beta"));
    await settle(); // let any trailing rename/change event arrive
    expect(changes).toBe(1);
  });

  it("ignores unrelated files in the same directory", async () => {
    const dir = tmpDir();
    const path = join(dir, "cell-driver-registry.json");
    atomicWrite(path, payload("Alpha"));

    const reg = mkWatched(path);
    let changes = 0;
    reg.startWatch(() => {
      changes++;
    });
    await drainLookback(() => {
      changes = 0;
    });

    // A sibling registry, an atomic writer's temp file, and an editor swap file.
    atomicWrite(join(dir, "role-registry.json"), payload("Other"));
    writeFileSync(join(dir, `cell-driver-registry.json.tmp.${process.pid + 1}`), "scratch");
    writeFileSync(join(dir, ".cell-driver-registry.json.swp"), "scratch");
    await settle(400);

    expect(changes).toBe(0);
    expect(reg.isRegisteredDriver("Alpha")).toBe(true);
  });

  it("does not leak watchers across repeated start/stop cycles", async () => {
    const dir = tmpDir();
    const path = join(dir, "cell-driver-registry.json");
    atomicWrite(path, payload("Alpha"));

    const reg = mkWatched(path);
    let changes = 0;
    const onChange = () => {
      changes++;
    };

    // startWatch is idempotent: three calls must not install three watchers.
    reg.startWatch(onChange);
    reg.startWatch(onChange);
    reg.startWatch(onChange);
    await drainLookback(() => {
      changes = 0;
    });

    atomicWrite(path, payload("Beta"));
    await waitFor(() => changes > 0);
    await settle();
    expect(changes).toBe(1);

    // stopWatch clears the single watcher it owns. Had the extra startWatch calls
    // leaked watchers, they would still be live here and keep firing.
    reg.stopWatch();
    changes = 0;
    atomicWrite(path, payload("Gamma"));
    await settle(400);
    expect(changes).toBe(0);

    // Repeated cycles leave nothing behind either.
    for (let i = 0; i < 3; i++) {
      reg.startWatch(onChange);
      reg.stopWatch();
    }
    changes = 0;
    atomicWrite(path, payload("Delta"));
    await settle(400);
    expect(changes).toBe(0);
  });

  it("watches a registry created after startWatch (directory exists, file does not)", async () => {
    const dir = tmpDir();
    const path = join(dir, "cell-driver-registry.json");

    const reg = mkWatched(path);
    reg.startWatch(() => {});
    expect(reg.isRegisteredDriver("Alpha")).toBe(false);

    atomicWrite(path, payload("Alpha"));
    await waitFor(() => reg.isRegisteredDriver("Alpha"));
  });

  it("startWatch on a missing DIRECTORY degrades without throwing", () => {
    const dir = tmpDir();
    const reg = mkWatched(join(dir, "nope", "cell-driver-registry.json"));
    expect(() => reg.startWatch(() => {})).not.toThrow();
    expect(() => reg.stopWatch()).not.toThrow();
    // And a later create is simply missed — the TTL re-read still covers it.
    mkdirSync(join(dir, "nope"));
    expect(reg.isRegisteredDriver("Alpha")).toBe(false);
  });
});
