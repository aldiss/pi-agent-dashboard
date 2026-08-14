import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchExternalSessions,
  fetchExternalSessionsSnapshot,
} from "../external-sessions-api.js";

const originalFetch = globalThis.fetch;

function mockFetch(
  handler: (url: string, init?: RequestInit) => { status?: number; body: unknown },
): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const result = handler(url, init);
    const status = result.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => result.body,
    } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const session = {
  id: "codex:cx-gap2",
  runtime: "codex" as const,
  tmuxSession: "cx-gap2",
  tmuxSocket: "pi",
  title: "cx-gap2",
  cwd: "/tmp/gap2",
  runtimePid: 4242,
  state: "live" as const,
  model: "gpt-5.6-sol",
  effort: "ultra",
  firstSeenAt: 1_000,
  lastLiveAt: 2_000,
  endedAt: null,
  output: "working",
  outputAt: 2_000,
  outputChangedAt: 1_900,
  lineCount: 1,
};

describe("fetchExternalSessionsSnapshot", () => {
  it("returns sessions, owners, and drivers unchanged", async () => {
    const owners = {
      "cx-gap2": { owner: "Gap2", cell: "cell-a" },
    };
    const drivers = [
      { realName: "Gap2", cell: "cell-a", tmux: "gap2-driver" },
    ];
    mockFetch(() => ({ body: { sessions: [session], owners, drivers } }));

    await expect(fetchExternalSessionsSnapshot()).resolves.toEqual({
      sessions: [session],
      owners,
      drivers,
    });
  });

  it("defaults missing owners and drivers without dropping legacy sessions", async () => {
    mockFetch(() => ({ body: { sessions: [session] } }));

    await expect(fetchExternalSessionsSnapshot()).resolves.toEqual({
      sessions: [session],
      owners: {},
      drivers: [],
    });
  });

  it("rejects non-OK responses", async () => {
    mockFetch(() => ({ status: 503, body: { error: "unavailable" } }));

    await expect(fetchExternalSessionsSnapshot()).rejects.toThrow(/external-sessions 503/);
  });
});

describe("fetchExternalSessions compatibility", () => {
  it("returns only the sessions array from an enriched snapshot", async () => {
    mockFetch(() => ({
      body: {
        sessions: [session],
        owners: { "cx-gap2": { owner: "Gap2", cell: "cell-a" } },
        drivers: [{ realName: "Gap2", cell: "cell-a", tmux: "gap2-driver" }],
      },
    }));

    await expect(fetchExternalSessions()).resolves.toEqual([session]);
  });
});
