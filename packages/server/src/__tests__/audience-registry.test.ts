/**
 * door-3 audience derivation + registry-CHANGE re-derive (build-items 1 + 2).
 *
 * Exercises the dashboard-server's thin FS wrapper (`audience-registry.ts`) over
 * the vendored pure core: the same audience the client buffers on, plus the
 * ratified registry-refresh fold (a session established under an unreadable/partial
 * registry self-corrects `unknown → operator` going FORWARD once the registry
 * completes). Injected reader + clock — no real FS, deterministic. The exact
 * value table is separately drift-guarded by the vendored golden-corpus test.
 * See change: operator-voice-buffer-hold.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { createAudienceRegistry } from "../audience-registry.js";
import { sessionFromMeta } from "../session-scanner.js";
import type { SessionMeta } from "@blackbelt-technology/pi-dashboard-shared/session-meta.js";

const NOW = Date.parse("2026-07-19T15:00:00Z");
const FRESH = "2026-07-19T14:55:00Z"; // 5 min old — inside the 30-min window
// Joan = standing incumbent; Commwright-2 = live non-standing member.
const REGISTRY = JSON.stringify({
  schema_version: "1.0",
  updated_at: FRESH,
  roles: {
    joan: { themed_name: "Joan", tier: "L0.5b" },
    commwright: { tmux_session: "Commwright-2" },
  },
});

function reg(readFile: () => string) {
  return createAudienceRegistry({ readFile, now: () => NOW });
}

describe("deriveSessionAudience — sessionFromMeta stamps the right audience", () => {
  it("standing crew → operator (named path ignores hasUI/source)", () => {
    expect(reg(() => REGISTRY).deriveSessionAudience("Joan", "tmux")).toBe("operator");
  });

  it("registered non-standing + complete registry → agent", () => {
    expect(reg(() => REGISTRY).deriveSessionAudience("Commwright-2", "tmux")).toBe("agent");
  });

  it("named-miss → unknown (no positive membership)", () => {
    expect(reg(() => REGISTRY).deriveSessionAudience("subagent-worker-3f4a", "tmux")).toBe("unknown");
  });

  it("unset name + interactive source → operator; unset + headless → unknown", () => {
    const r = reg(() => REGISTRY);
    expect(r.deriveSessionAudience(undefined, "tui")).toBe("operator");
    expect(r.deriveSessionAudience(undefined, "terminal")).toBe("operator");
    expect(r.deriveSessionAudience(undefined, "zed")).toBe("operator");
    expect(r.deriveSessionAudience(undefined, "tmux")).toBe("unknown");
    expect(r.deriveSessionAudience(undefined, undefined)).toBe("unknown");
  });

  it("unreadable registry → even a standing member is unknown (fail-open, then HOLDS)", () => {
    const r = reg(() => { throw new Error("ENOENT"); });
    expect(r.deriveSessionAudience("Joan", "tmux")).toBe("unknown");
  });
});

describe("registry-CHANGE re-derive (Bert's ratified fold) — forward-only", () => {
  it("flips unknown → operator once the registry completes (via cache invalidate)", () => {
    let content: string | null = null; // start: registry missing/unreadable
    const r = createAudienceRegistry({
      now: () => NOW,
      readFile: () => {
        if (content === null) throw new Error("ENOENT");
        return content;
      },
    });

    // A standing member established under an unreadable registry fails open to
    // unknown (shown+exempt → the client HOLDS on operator... but it's unknown here,
    // so renders live; the point is it is NOT yet provably-operator).
    expect(r.deriveSessionAudience("Joan", "tmux")).toBe("unknown");

    // The registry completes; the coarse watch fires → cache invalidated.
    content = REGISTRY;
    r.invalidate();

    // Going FORWARD, the same standing session self-corrects to operator.
    expect(r.deriveSessionAudience("Joan", "tmux")).toBe("operator");
  });

  it("startWatch / stopWatch on a missing registry file do not throw (coarse, best-effort)", () => {
    const r = createAudienceRegistry({
      registryPath: "/nonexistent/door3/role-registry.json",
      readFile: () => { throw new Error("ENOENT"); },
      now: () => NOW,
    });
    expect(() => {
      r.startWatch(() => {});
      r.stopWatch();
    }).not.toThrow();
  });
});

/**
 * Watch durability over ATOMIC REPLACEMENT.
 *
 * `role-registry.json` is rewritten temp-file + rename, which unlinks the inode.
 * A file-bound watch fires once and then goes deaf, so audience derivation
 * silently freezes on the first write. Real temp dir + real renames (an in-place
 * `writeFileSync` keeps the inode and would pass against the broken code), frozen
 * clock + long TTL so the observed audience can only move via the watch.
 */
describe("audience registry — watch survives atomic replacement", () => {
  const tmpDirs: string[] = [];
  const registries: Array<{ stopWatch: () => void }> = [];

  afterEach(() => {
    for (const r of registries.splice(0)) r.stopWatch();
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function tmpDir(): string {
    const dir = mkdtempSync(join(os.tmpdir(), "audience-registry-watch-"));
    tmpDirs.push(dir);
    return dir;
  }

  /** Real atomic replace: write a sibling temp file, then rename over the target. */
  function atomicWrite(path: string, contents: string): void {
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, contents);
    renameSync(tmp, path);
  }

  // Three distinct registries. Joan is standing crew (→ operator when present);
  // Commwright-2 is a live non-standing member (→ agent when present).
  const ONLY_COMMWRIGHT = JSON.stringify({
    schema_version: "1.0",
    updated_at: FRESH,
    roles: { commwright: { tmux_session: "Commwright-2" } },
  });
  const ONLY_JOAN = JSON.stringify({
    schema_version: "1.0",
    updated_at: FRESH,
    roles: { joan: { themed_name: "Joan", tier: "L0.5b" } },
  });
  const BOTH = REGISTRY;

  /** Frozen clock + 10-minute TTL: the cache never lapses inside a test. */
  function mkWatched(registryPath: string) {
    const r = createAudienceRegistry({ registryPath, ttlMs: 600_000, now: () => NOW });
    registries.push(r);
    return r;
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
    const path = join(dir, "role-registry.json");
    atomicWrite(path, ONLY_JOAN);

    const r = mkWatched(path);
    let changes = 0;
    r.startWatch(() => {
      changes++;
    });
    await drainLookback(() => {
      changes = 0;
    });

    expect(r.deriveSessionAudience("Joan", "tmux")).toBe("operator");

    // First replacement — Joan drops out of the registry.
    atomicWrite(path, ONLY_COMMWRIGHT);
    await waitFor(() => r.deriveSessionAudience("Joan", "tmux") === "unknown");
    expect(r.deriveSessionAudience("Commwright-2", "tmux")).toBe("agent");

    // Second replacement — the whole point. The inode the first watch was bound
    // to is already gone; only a directory watch still sees this.
    atomicWrite(path, BOTH);
    await waitFor(() => r.deriveSessionAudience("Joan", "tmux") === "operator");
    expect(r.deriveSessionAudience("Commwright-2", "tmux")).toBe("agent");
    expect(changes).toBeGreaterThanOrEqual(2);
  });

  it("keeps firing across many replacements (fifth write still lands)", async () => {
    const dir = tmpDir();
    const path = join(dir, "role-registry.json");
    atomicWrite(path, ONLY_JOAN);

    const r = mkWatched(path);
    r.startWatch(() => {});

    // Explicit step table — each step flips Joan's audience, so every waitFor
    // observes a real transition rather than a value that was already true.
    const steps: Array<[string, string]> = [
      [ONLY_COMMWRIGHT, "unknown"],
      [BOTH, "operator"],
      [ONLY_COMMWRIGHT, "unknown"],
      [ONLY_JOAN, "operator"],
      [ONLY_COMMWRIGHT, "unknown"],
      [BOTH, "operator"],
    ];
    for (const [content, expected] of steps) {
      atomicWrite(path, content);
      await waitFor(() => r.deriveSessionAudience("Joan", "tmux") === expected);
    }
    expect(r.deriveSessionAudience("Joan", "tmux")).toBe("operator");
    expect(r.deriveSessionAudience("Commwright-2", "tmux")).toBe("agent");
  });

  it("coalesces one replacement into a single onChange", async () => {
    const dir = tmpDir();
    const path = join(dir, "role-registry.json");
    atomicWrite(path, ONLY_JOAN);

    const r = mkWatched(path);
    let changes = 0;
    r.startWatch(() => {
      changes++;
    });
    await drainLookback(() => {
      changes = 0;
    });

    atomicWrite(path, ONLY_COMMWRIGHT);
    await waitFor(() => r.deriveSessionAudience("Joan", "tmux") === "unknown");
    await settle(); // let any trailing rename/change event arrive
    expect(changes).toBe(1);
  });

  it("ignores unrelated files in the same directory", async () => {
    const dir = tmpDir();
    const path = join(dir, "role-registry.json");
    atomicWrite(path, ONLY_JOAN);

    const r = mkWatched(path);
    let changes = 0;
    r.startWatch(() => {
      changes++;
    });
    await drainLookback(() => {
      changes = 0;
    });

    // The sister registry, an atomic writer's temp file, and an editor swap file.
    atomicWrite(join(dir, "cell-driver-registry.json"), "{}");
    writeFileSync(join(dir, `role-registry.json.tmp.${process.pid + 1}`), "scratch");
    writeFileSync(join(dir, ".role-registry.json.swp"), "scratch");
    await settle(400);

    expect(changes).toBe(0);
    expect(r.deriveSessionAudience("Joan", "tmux")).toBe("operator");
  });

  it("does not leak watchers across repeated start/stop cycles", async () => {
    const dir = tmpDir();
    const path = join(dir, "role-registry.json");
    atomicWrite(path, ONLY_JOAN);

    const r = mkWatched(path);
    let changes = 0;
    const onChange = () => {
      changes++;
    };

    // startWatch is idempotent: three calls must not install three watchers.
    r.startWatch(onChange);
    r.startWatch(onChange);
    r.startWatch(onChange);
    await drainLookback(() => {
      changes = 0;
    });

    atomicWrite(path, ONLY_COMMWRIGHT);
    await waitFor(() => changes > 0);
    await settle();
    expect(changes).toBe(1);

    // stopWatch clears the single watcher it owns. Had the extra startWatch calls
    // leaked watchers, they would still be live here and keep firing.
    r.stopWatch();
    changes = 0;
    atomicWrite(path, BOTH);
    await settle(400);
    expect(changes).toBe(0);

    // Repeated cycles leave nothing behind either.
    for (let i = 0; i < 3; i++) {
      r.startWatch(onChange);
      r.stopWatch();
    }
    changes = 0;
    atomicWrite(path, ONLY_JOAN);
    await settle(400);
    expect(changes).toBe(0);
  });

  it("watches a registry created after startWatch (directory exists, file does not)", async () => {
    const dir = tmpDir();
    const path = join(dir, "role-registry.json");

    const r = mkWatched(path);
    r.startWatch(() => {});
    expect(r.deriveSessionAudience("Joan", "tmux")).toBe("unknown");

    atomicWrite(path, ONLY_JOAN);
    await waitFor(() => r.deriveSessionAudience("Joan", "tmux") === "operator");
  });

  it("startWatch on a missing DIRECTORY degrades without throwing", () => {
    const dir = tmpDir();
    const r = mkWatched(join(dir, "nope", "role-registry.json"));
    expect(() => r.startWatch(() => {})).not.toThrow();
    expect(() => r.stopWatch()).not.toThrow();
    // And a later create is simply missed — the TTL re-read still covers it.
    mkdirSync(join(dir, "nope"));
    expect(r.deriveSessionAudience("Joan", "tmux")).toBe("unknown");
  });
});

describe("sessionFromMeta — writes the audience field (Item 1 plumbing)", () => {
  it("stamps the derived audience onto the DashboardSession", () => {
    const meta = { name: "Joan", source: "tui", cwd: "/x" } as unknown as SessionMeta;
    const s = sessionFromMeta("id1", "/nope.jsonl", "/dir", meta, 0, () => "operator");
    expect(s.audience).toBe("operator");
    expect(s.source).toBe("tui");
  });

  it("defaults a missing source to 'tui' and derives on that SAME resolved source", () => {
    let seenSource: string | undefined;
    const meta = { name: undefined, cwd: "/x" } as unknown as SessionMeta;
    const s = sessionFromMeta("id2", "/nope.jsonl", "/dir", meta, 0, (_name, src) => {
      seenSource = src;
      return "unknown";
    });
    expect(seenSource).toBe("tui"); // missing source → "tui" (consistent with display)
    expect(s.audience).toBe("unknown");
  });
});
