import { describe, it, expect } from "vitest";
import { assertDistinctOptions, DuplicateOptionError } from "../option-collision.js";

// A4 (Pete dl-13350 + Lane): the display-rename disambiguation approach
// (makeCollisionSafeOptions) is SUPERSEDED by fail-closed rejection. Duplicate
// labels (after trimming) are rejected BEFORE render so a click can never
// resolve to a different hidden option than the one shown.

describe("assertDistinctOptions (A4 fail-closed)", () => {
  describe("distinct labels — pass through unchanged (99% case)", () => {
    it("returns the options unchanged when all labels are distinct", () => {
      const opts = ["Ship it", "Hold", "Cancel"];
      expect(assertDistinctOptions(opts)).toBe(opts);
    });

    it("does not throw for a two-option distinct list", () => {
      expect(() => assertDistinctOptions(["Yes", "No"])).not.toThrow();
    });

    it("leading/trailing whitespace that stays distinct after trim is allowed", () => {
      // "Yes" vs "No " → trimmed "Yes"/"No" are distinct.
      expect(() => assertDistinctOptions(["Yes", "No "])).not.toThrow();
    });
  });

  describe("duplicate labels — REJECT before render", () => {
    it("throws DuplicateOptionError on an exact duplicate label", () => {
      expect(() => assertDistinctOptions(["Deploy", "Deploy", "Rollback"])).toThrow(DuplicateOptionError);
    });

    it("rejects labels identical only AFTER trimming (the trimmed-duplicate case)", () => {
      // "Deploy" and "Deploy " collide after trim — must reject.
      let err: unknown;
      try { assertDistinctOptions(["Deploy", "Deploy ", "Rollback"]); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(DuplicateOptionError);
      expect((err as DuplicateOptionError).label).toBe("Deploy");
      expect((err as DuplicateOptionError).indices).toEqual([0, 1]);
    });

    it("error names the colliding label + indices, and reads clearly", () => {
      let err: DuplicateOptionError | undefined;
      try { assertDistinctOptions(["A", "B", "A"]); } catch (e) { err = e as DuplicateOptionError; }
      expect(err).toBeInstanceOf(DuplicateOptionError);
      expect(err!.label).toBe("A");
      expect(err!.indices).toEqual([0, 2]);
      expect(err!.message).toMatch(/distinct/i);
      expect(err!.message).toMatch(/"A"/);
    });

    it("prefixes the error with a context (batch sub-question / multiselect locator)", () => {
      let err: DuplicateOptionError | undefined;
      try { assertDistinctOptions(["X", "X"], 'ask_user batch sub-question "Pick"'); } catch (e) { err = e as DuplicateOptionError; }
      expect(err!.message).toMatch(/^ask_user batch sub-question "Pick":/);
    });

    it("rejects triple duplicates (all colliding indices reported)", () => {
      let err: DuplicateOptionError | undefined;
      try { assertDistinctOptions(["Opt", "Opt", "Opt"]); } catch (e) { err = e as DuplicateOptionError; }
      expect(err!.indices).toEqual([0, 1, 2]);
    });
  });
});
