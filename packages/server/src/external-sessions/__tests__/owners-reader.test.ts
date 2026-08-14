import { describe, expect, it, vi } from "vitest";
import {
  createExternalSessionOwnersReader,
  parseExternalSessionOwners,
} from "../owners-reader.js";

function ownerRegistry(sessions: Record<string, unknown>): unknown {
  return {
    schema_version: 1,
    updated_at: "2026-08-14T12:00:00.000Z",
    sessions,
  };
}

describe("parseExternalSessionOwners", () => {
  it("returns valid cell and null-cell records from the sessions map", () => {
    expect(
      parseExternalSessionOwners(
        ownerRegistry({
          "cx-gap2": {
            owner: "Seatwright",
            cell: "cell-alpha",
            runtime: "codex",
            cwd: "/private/tmp/gap2-wt",
            spawned_at: "2026-08-14T10:00:00.000Z",
          },
          "claude-review": {
            owner: "Docket",
            cell: null,
            runtime: "claude-code",
            cwd: "/private/tmp/review-wt",
            spawned_at: "2026-08-14T11:00:00.000Z",
          },
        }),
      ),
    ).toEqual({
      "cx-gap2": { owner: "Seatwright", cell: "cell-alpha" },
      "claude-review": { owner: "Docket", cell: null },
    });
  });

  it("ignores invalid session rows", () => {
    expect(
      parseExternalSessionOwners(
        ownerRegistry({
          valid: {
            owner: "Seatwright",
            cell: "cell-alpha",
            runtime: "codex",
            cwd: "/private/tmp/gap2-wt",
            spawned_at: "2026-08-14T10:00:00.000Z",
          },
          nullRow: null,
          missingOwner: { cell: "cell-beta" },
          invalidOwner: { owner: 42, cell: "cell-beta" },
          missingCell: { owner: "Branchwright" },
          invalidCell: { owner: "Branchwright", cell: 42 },
        }),
      ),
    ).toEqual({
      valid: { owner: "Seatwright", cell: "cell-alpha" },
    });
  });

  it("preserves special tmux names as own JSON properties", () => {
    const parsed = JSON.parse(
      '{"schema_version":1,"sessions":{"__proto__":{"owner":"Paneview","cell":null}}}',
    );
    const owners = parseExternalSessionOwners(parsed);

    expect(Object.hasOwn(owners, "__proto__")).toBe(true);
    expect(owners.__proto__).toEqual({ owner: "Paneview", cell: null });
    expect(JSON.parse(JSON.stringify(owners))).toEqual(
      JSON.parse('{"__proto__":{"owner":"Paneview","cell":null}}'),
    );
  });
});

describe("createExternalSessionOwnersReader", () => {
  it.each([
    ["a missing file", () => { throw new Error("ENOENT"); }],
    ["malformed JSON", () => "{ not json"],
  ])("returns an empty map for %s", (_label, readFile) => {
    const reader = createExternalSessionOwnersReader({ readFile });

    expect(reader.getOwners()).toEqual({});
  });

  it("caches within the TTL and re-reads when the TTL lapses", () => {
    let now = 1_000;
    let payload = JSON.stringify(
      ownerRegistry({
        "cx-alpha": { owner: "Alpha", cell: "cell-alpha" },
      }),
    );
    const readFile = vi.fn(() => payload);
    const reader = createExternalSessionOwnersReader({
      ttlMs: 5_000,
      now: () => now,
      readFile,
    });

    expect(reader.getOwners()).toEqual({
      "cx-alpha": { owner: "Alpha", cell: "cell-alpha" },
    });

    payload = JSON.stringify(
      ownerRegistry({
        "cx-beta": { owner: "Beta", cell: null },
      }),
    );
    now = 5_999;
    expect(reader.getOwners()).toEqual({
      "cx-alpha": { owner: "Alpha", cell: "cell-alpha" },
    });
    expect(readFile).toHaveBeenCalledTimes(1);

    now = 6_000;
    expect(reader.getOwners()).toEqual({
      "cx-beta": { owner: "Beta", cell: null },
    });
    expect(readFile).toHaveBeenCalledTimes(2);
  });
});
