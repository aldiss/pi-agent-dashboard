/**
 * driver-registry — FS wrapper over `cell-driver-registry.json`.
 *
 * Fixtures below are the real shapes measured own-hand from the live registry
 * on 2026-08-14 (Seatwright/Branchwright in a non-driver-shaped cwd; `Docket`
 * whose tmux name diverges from its key; `Docket-2` ended-in-registry but live
 * on the dashboard with a status-suffixed name).
 */
import { describe, it, expect } from "vitest";
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
