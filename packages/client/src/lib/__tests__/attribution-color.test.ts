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

const OPERATOR_AMBER_DARK = { bg: "rgba(245,158,11,0.20)", border: "rgba(245,158,11,0.40)", text: "#f5efe6" };
const GUEST_VIOLET_DARK = { bg: "rgba(139,92,246,0.20)", border: "rgba(139,92,246,0.40)", text: "#eef0f6" };
const OPERATOR_AMBER_LIGHT = { bg: "rgba(245,158,11,0.38)", border: "rgb(180,83,9)", text: "rgb(74,49,5)" };
const GUEST_VIOLET_LIGHT = { bg: "rgba(139,92,246,0.30)", border: "rgb(109,40,217)", text: "rgb(55,35,105)" };

function author(sub: string, isOperator?: boolean): MessageAuthor {
  return { sub, display: sub, ...(isOperator !== undefined ? { isOperator } : {}) };
}

describe("bubbleTintFor — role-anchored, theme-aware L3 tint", () => {
  it("DARK: isOperator:true → AMBER, isOperator:false → VIOLET (byte-unchanged)", () => {
    expect(bubbleTintFor(author("op@example.com", true), "dark")).toEqual(OPERATOR_AMBER_DARK);
    expect(bubbleTintFor(author("guest@example.com", false), "dark")).toEqual(GUEST_VIOLET_DARK);
  });

  it("LIGHT: isOperator:true → AMBER-light, isOperator:false → VIOLET-light", () => {
    expect(bubbleTintFor(author("op@example.com", true), "light")).toEqual(OPERATOR_AMBER_LIGHT);
    expect(bubbleTintFor(author("guest@example.com", false), "light")).toEqual(GUEST_VIOLET_LIGHT);
  });

  it("LIGHT tints use DARK text (readable on cream), NOT the dark theme's near-white", () => {
    const opLight = bubbleTintFor(author("op@example.com", true), "light");
    const guestLight = bubbleTintFor(author("g@example.com", false), "light");
    expect(opLight.text).not.toBe(OPERATOR_AMBER_DARK.text);
    expect(guestLight.text).not.toBe(GUEST_VIOLET_DARK.text);
    expect(opLight.text).toBe("rgb(74,49,5)");
    expect(guestLight.text).toBe("rgb(55,35,105)");
  });

  it("operator and guest tints are DISTINCT in BOTH themes (the hash collision is gone)", () => {
    for (const theme of ["light", "dark"] as const) {
      const op = bubbleTintFor(author("a@example.com", true), theme);
      const guest = bubbleTintFor(author("b@example.com", false), theme);
      expect(op).not.toEqual(guest);
      expect(op.bg).not.toBe(guest.bg);
      expect(op.border).not.toBe(guest.border);
      expect(op.text).not.toBe(guest.text);
    }
  });

  it("two OPERATORS both get the same amber (role-anchored, never a random collision)", () => {
    // Both operators → both amber. This is intentional: the role IS the anchor.
    // The 'You vs them' distinction is carried by the chip label, not the tint.
    expect(bubbleTintFor(author("op1@example.com", true), "dark"))
      .toEqual(bubbleTintFor(author("op2@example.com", true), "dark"));
    expect(bubbleTintFor(author("op1@example.com", true), "light"))
      .toEqual(bubbleTintFor(author("op2@example.com", true), "light"));
  });

  it("absent isOperator (older payload / N>2) → falls to VIOLET (guest default) in both themes", () => {
    expect(bubbleTintFor(author("legacy@example.com"), "dark")).toEqual(GUEST_VIOLET_DARK);
    expect(bubbleTintFor(author("legacy@example.com"), "light")).toEqual(GUEST_VIOLET_LIGHT);
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
