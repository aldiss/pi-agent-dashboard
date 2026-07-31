import { describe, it, expect } from "vitest";
import { makeCollisionSafeOptions } from "../option-collision.js";

describe("makeCollisionSafeOptions", () => {
  describe("no collision (99% case) — zero behavior change", () => {
    it("leaves distinct labels byte-identical and reports no collision", () => {
      const safe = makeCollisionSafeOptions(["Ship it", "Hold", "Cancel"]);
      expect(safe.displayOptions).toEqual(["Ship it", "Hold", "Cancel"]);
      expect(safe.hadCollision).toBe(false);
    });

    it("resolve is an index-preserving passthrough for distinct labels", () => {
      const safe = makeCollisionSafeOptions(["Ship it", "Hold", "Cancel"]);
      expect(safe.resolve("Ship it")).toEqual({ index: 0, value: "Ship it" });
      expect(safe.resolve("Hold")).toEqual({ index: 1, value: "Hold" });
      expect(safe.resolve("Cancel")).toEqual({ index: 2, value: "Cancel" });
    });

    it("resolve returns undefined for a label that is not an option", () => {
      const safe = makeCollisionSafeOptions(["A", "B"]);
      expect(safe.resolve("Z")).toBeUndefined();
    });
  });

  describe("duplicate-label bijection (A4 core)", () => {
    it("disambiguates identical labels and maps each display back to its EXACT original index", () => {
      // Two options share the label "Deploy" but are the 1st and 2nd distinct
      // intended actions. A click must resolve to the exact one shown.
      const safe = makeCollisionSafeOptions(["Deploy", "Deploy", "Rollback"]);
      expect(safe.hadCollision).toBe(true);
      expect(safe.displayOptions).toEqual(["Deploy", "Deploy (2)", "Rollback"]);

      // Bijection: each display label round-trips to the precise original slot.
      expect(safe.resolve("Deploy")).toEqual({ index: 0, value: "Deploy" });
      expect(safe.resolve("Deploy (2)")).toEqual({ index: 1, value: "Deploy" });
      expect(safe.resolve("Rollback")).toEqual({ index: 2, value: "Rollback" });

      // The clicked hidden option is NOT confusable: index 0 ≠ index 1 even
      // though both original labels read "Deploy".
      expect(safe.resolve("Deploy")!.index).not.toBe(safe.resolve("Deploy (2)")!.index);
    });

    it("treats labels identical only after trimming as a collision", () => {
      const safe = makeCollisionSafeOptions(["Yes", "Yes "]);
      expect(safe.hadCollision).toBe(true);
      // First occurrence keeps its bytes; the trimmed-duplicate is suffixed.
      expect(safe.displayOptions[0]).toBe("Yes");
      expect(safe.displayOptions[1]).not.toBe(safe.displayOptions[0].trim());
      expect(safe.resolve(safe.displayOptions[0])).toEqual({ index: 0, value: "Yes" });
      expect(safe.resolve(safe.displayOptions[1])).toEqual({ index: 1, value: "Yes " });
    });

    it("handles triple duplicates with ascending unique suffixes", () => {
      const safe = makeCollisionSafeOptions(["Opt", "Opt", "Opt"]);
      expect(safe.displayOptions).toEqual(["Opt", "Opt (2)", "Opt (3)"]);
      expect(safe.resolve("Opt (3)")).toEqual({ index: 2, value: "Opt" });
      // All three display labels are unique.
      expect(new Set(safe.displayOptions).size).toBe(3);
    });

    it("skips a suffix that would itself collide with a literal option", () => {
      // "X (2)" already exists literally, so the 2nd "X" must not reuse it.
      const safe = makeCollisionSafeOptions(["X", "X (2)", "X"]);
      expect(new Set(safe.displayOptions).size).toBe(3);
      // The disambiguated third element must round-trip to index 2.
      const third = safe.displayOptions[2];
      expect(safe.resolve(third)).toEqual({ index: 2, value: "X" });
      // And the literal "X (2)" still maps to its own index 1.
      expect(safe.resolve("X (2)")).toEqual({ index: 1, value: "X (2)" });
    });
  });
});
