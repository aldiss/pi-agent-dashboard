/**
 * Role-anchored attribution tint tests (multi-operator, Surface A — Option B).
 *
 * PROVES the collision-avoidance property that motivated Option B: the OLD
 * hash-based `attributionColorFor` CAN map two distinct subs to the same palette
 * slot (a real collision exists), whereas the NEW role-anchored `bubbleTintFor`
 * is DISTINCT by construction — operator → amber, guest → violet — so two
 * co-driving operators can never share a bubble tint.
 */
import { describe, it, expect } from "vitest";
import type { MessageAuthor } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { bubbleTintFor, attributionColorFor } from "../attribution-color.js";

const OPERATOR_AMBER = { bg: "rgba(245,158,11,0.20)", border: "rgba(245,158,11,0.40)", text: "#f5efe6" };
const GUEST_VIOLET = { bg: "rgba(139,92,246,0.20)", border: "rgba(139,92,246,0.40)", text: "#eef0f6" };

function author(sub: string, isOperator?: boolean): MessageAuthor {
  return { sub, display: sub, ...(isOperator !== undefined ? { isOperator } : {}) };
}

describe("bubbleTintFor — role-anchored L3 tint", () => {
  it("isOperator:true → AMBER tint", () => {
    expect(bubbleTintFor(author("op@example.com", true))).toEqual(OPERATOR_AMBER);
  });

  it("isOperator:false → VIOLET tint", () => {
    expect(bubbleTintFor(author("guest@example.com", false))).toEqual(GUEST_VIOLET);
  });

  it("operator and guest tints are DISTINCT (the hash collision is gone)", () => {
    const op = bubbleTintFor(author("a@example.com", true));
    const guest = bubbleTintFor(author("b@example.com", false));
    expect(op).not.toEqual(guest);
    expect(op.bg).not.toBe(guest.bg);
    expect(op.border).not.toBe(guest.border);
    expect(op.text).not.toBe(guest.text);
  });

  it("two OPERATORS both get the same amber (role-anchored, never a random collision)", () => {
    // Both operators → both amber. This is intentional: the role IS the anchor.
    // The 'You vs them' distinction is carried by the chip label, not the tint.
    expect(bubbleTintFor(author("op1@example.com", true)))
      .toEqual(bubbleTintFor(author("op2@example.com", true)));
  });

  it("absent isOperator (older payload / N>2) → falls to VIOLET (guest default)", () => {
    expect(bubbleTintFor(author("legacy@example.com"))).toEqual(GUEST_VIOLET);
  });
});

describe("attributionColorFor — retained hash fallback (N>2)", () => {
  it("is deterministic (same sub → same accent across calls)", () => {
    expect(attributionColorFor("op1@example.com")).toEqual(attributionColorFor("op1@example.com"));
  });

  it("a hash COLLISION is demonstrably possible (why Option B replaced it for N=2)", () => {
    // Brute-force two distinct subs that hash to the same palette slot. Finding
    // ANY such pair proves the old scheme could collide two operators' colors —
    // the exact defect the role-anchored tint removes.
    let collision: [string, string] | null = null;
    outer: for (let i = 0; i < 500; i++) {
      for (let j = i + 1; j < 500; j++) {
        const a = `user${i}@example.com`;
        const b = `user${j}@example.com`;
        if (JSON.stringify(attributionColorFor(a)) === JSON.stringify(attributionColorFor(b))) {
          collision = [a, b];
          break outer;
        }
      }
    }
    expect(collision).not.toBeNull();
  });
});
