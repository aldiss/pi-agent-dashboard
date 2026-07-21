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
import { describe, it, expect } from "vitest";
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
