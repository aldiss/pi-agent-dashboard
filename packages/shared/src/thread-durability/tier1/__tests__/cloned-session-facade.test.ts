/**
 * Cloned-DTO facade tests — the correctness point of the seam: a returned DTO
 * is a deep clone (mutating it never reaches the source), is deep-frozen, and
 * the facade never exposes the live manager object.
 */
import { describe, it, expect } from "vitest";

import {
  createClonedSessionFacade,
  type ReadonlySessionManagerLike,
  type SessionEntryDto,
  type SessionTreeNodeDto,
} from "../cloned-session-facade.js";

/**
 * A fake manager that ALIASES its live internals exactly like the real pi
 * `SessionManager` (`getEntry`/`getLeafEntry` return the SAME object stored in
 * `byId`; `getEntries` returns a fresh array of the SAME refs — a shallow
 * copy). This is the hazard the facade defends against; the tests assert the
 * facade severs it.
 */
class AliasingFakeManager implements ReadonlySessionManagerLike {
  // The "live internals" — the facade must never let a caller mutate these.
  readonly byId = new Map<string, SessionEntryDto>();
  header: { type: "session"; id: string; cwd: string; timestamp: string; extra: { n: number } };
  leafId: string | null;

  constructor() {
    const e1: SessionEntryDto = {
      type: "message",
      id: "e1",
      parentId: null,
      timestamp: "t0",
      message: { role: "user", nested: { deep: "orig" } },
    };
    const e2: SessionEntryDto = {
      type: "message",
      id: "e2",
      parentId: "e1",
      timestamp: "t1",
      message: { role: "assistant", nested: { deep: "orig2" } },
    };
    this.byId.set("e1", e1);
    this.byId.set("e2", e2);
    this.leafId = "e2";
    this.header = { type: "session", id: "sess", cwd: "/w", timestamp: "t0", extra: { n: 1 } };
  }

  getCwd() {
    return "/w";
  }
  getSessionId() {
    return "sess";
  }
  getSessionDir() {
    return "/w/.pi";
  }
  getSessionFile() {
    return "/w/.pi/sess.jsonl";
  }
  getSessionName() {
    return "my-session";
  }
  getLeafId() {
    return this.leafId;
  }
  // ALIAS: hands back the live object (like this.byId.get(this.leafId)).
  getLeafEntry() {
    return this.leafId ? this.byId.get(this.leafId) : undefined;
  }
  // ALIAS: hands back the live object (like this.byId.get(id)).
  getEntry(id: string) {
    return this.byId.get(id);
  }
  // ALIAS: fresh array, SAME refs (shallow — like getBranch walking byId).
  getBranch(_fromId?: string) {
    return [...this.byId.values()];
  }
  // ALIAS: fresh array, SAME refs (shallow copy — matches getEntries()).
  getEntries() {
    return [...this.byId.values()];
  }
  // ALIAS: tree wrapping the SAME live entry refs.
  getTree(): SessionTreeNodeDto[] {
    const e1 = this.byId.get("e1")!;
    const e2 = this.byId.get("e2")!;
    return [{ entry: e1, children: [{ entry: e2, children: [] }] }];
  }
  getHeader() {
    return this.header;
  }
  getLabel(_id: string) {
    return undefined;
  }
}

describe("createClonedSessionFacade — mutation isolation (the alias is severed)", () => {
  it("mutating a returned getEntry DTO does NOT affect the source", () => {
    const mgr = new AliasingFakeManager();
    const facade = createClonedSessionFacade(mgr);

    const dto = facade.getEntry("e1")!;
    // The clone must not be the same reference as the live internal object.
    expect(dto).not.toBe(mgr.byId.get("e1"));
    // Deep-clone: nested objects are distinct refs too.
    expect(dto.message).not.toBe((mgr.byId.get("e1") as SessionEntryDto).message);

    // Attempt to mutate the returned DTO through a non-frozen alias path.
    const mutable = structuredClone(dto) as SessionEntryDto;
    (mutable.message as { nested: { deep: string } }).nested.deep = "HACKED";
    // The source is untouched regardless.
    expect(
      ((mgr.byId.get("e1") as SessionEntryDto).message as { nested: { deep: string } }).nested.deep,
    ).toBe("orig");
  });

  it("the returned DTO is deep-frozen (runtime read-only)", () => {
    const mgr = new AliasingFakeManager();
    const facade = createClonedSessionFacade(mgr);
    const dto = facade.getEntry("e1")!;

    expect(Object.isFrozen(dto)).toBe(true);
    // Nested objects are frozen too (deep freeze).
    expect(Object.isFrozen(dto.message)).toBe(true);
    expect(Object.isFrozen((dto.message as { nested: unknown }).nested)).toBe(true);

    // A direct mutation throws in strict mode (ESM modules are strict).
    expect(() => {
      (dto as { type: string }).type = "changed";
    }).toThrow(TypeError);
    // And the source stayed intact.
    expect(mgr.byId.get("e1")!.type).toBe("message");
  });

  it("getEntries returns cloned+frozen entries, source array refs untouched", () => {
    const mgr = new AliasingFakeManager();
    const facade = createClonedSessionFacade(mgr);

    const entries = facade.getEntries();
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(Object.isFrozen(e)).toBe(true);
      // Each cloned entry is a distinct ref from the live internal.
      expect(e).not.toBe(mgr.byId.get(e.id));
    }
    // The returned array itself is frozen too.
    expect(Object.isFrozen(entries)).toBe(true);
  });

  it("getTree deep-clones + freezes nested nodes and their entries", () => {
    const mgr = new AliasingFakeManager();
    const facade = createClonedSessionFacade(mgr);

    const tree = facade.getTree();
    expect(tree).toHaveLength(1);
    const root = tree[0]!;
    expect(Object.isFrozen(root)).toBe(true);
    expect(Object.isFrozen(root.entry)).toBe(true);
    expect(root.entry).not.toBe(mgr.byId.get("e1"));
    // Nested child + its entry are cloned + frozen.
    const child = root.children[0]!;
    expect(Object.isFrozen(child)).toBe(true);
    expect(child.entry).not.toBe(mgr.byId.get("e2"));
    expect(child.entry.id).toBe("e2");
  });

  it("getHeader returns a cloned+frozen header, not the live one", () => {
    const mgr = new AliasingFakeManager();
    const facade = createClonedSessionFacade(mgr);

    const h = facade.getHeader()!;
    expect(h).not.toBe(mgr.header);
    expect(Object.isFrozen(h)).toBe(true);
    expect(Object.isFrozen((h as unknown as { extra: unknown }).extra)).toBe(true);
    expect(h.cwd).toBe("/w");
  });

  it("getLeafEntry clones the live leaf (never the aliased ref)", () => {
    const mgr = new AliasingFakeManager();
    const facade = createClonedSessionFacade(mgr);

    const leaf = facade.getLeafEntry()!;
    expect(leaf.id).toBe("e2");
    expect(leaf).not.toBe(mgr.byId.get("e2"));
    expect(Object.isFrozen(leaf)).toBe(true);
  });
});

describe("createClonedSessionFacade — never exposes the live manager", () => {
  it("the facade object is not the manager and carries no manager-returning getter", () => {
    const mgr = new AliasingFakeManager();
    const facade = createClonedSessionFacade(mgr);

    expect(facade).not.toBe(mgr);
    // No enumerable facade value is the live manager or its live internals.
    for (const value of Object.values(facade as unknown as Record<string, unknown>)) {
      expect(value).not.toBe(mgr);
      expect(value).not.toBe(mgr.byId);
    }
    // No mutation surface leaked onto the facade.
    expect((facade as unknown as Record<string, unknown>).appendMessage).toBeUndefined();
    expect((facade as unknown as Record<string, unknown>).branch).toBeUndefined();
    expect((facade as unknown as Record<string, unknown>).setSessionFile).toBeUndefined();
  });

  it("scalar getters pass through by value", () => {
    const mgr = new AliasingFakeManager();
    const facade = createClonedSessionFacade(mgr);

    expect(facade.getCwd()).toBe("/w");
    expect(facade.getSessionId()).toBe("sess");
    expect(facade.getSessionDir()).toBe("/w/.pi");
    expect(facade.getSessionFile()).toBe("/w/.pi/sess.jsonl");
    expect(facade.getSessionName()).toBe("my-session");
    expect(facade.getLeafId()).toBe("e2");
  });

  it("undefined/absent getters degrade cleanly (getSessionName optional)", () => {
    // A manager without getSessionName still yields a facade that returns
    // undefined (the optional chain), never throws.
    const mgr = new AliasingFakeManager();
    (mgr as { getSessionName?: () => string | undefined }).getSessionName = undefined;
    const facade = createClonedSessionFacade(mgr);
    expect(facade.getSessionName()).toBeUndefined();
  });
});
