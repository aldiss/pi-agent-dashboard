/**
 * Surface A #6 — BA-3 hunk-scope: the author-stamp is CONFINED to the
 * else-branch send payload and NEVER bleeds into the authorization gate.
 *
 * Attribution ⊥ authorization (Contract-3): the Build-0 gate
 * (`authorizeSessionAction(...)` + the refuse branch) must stay byte-identical
 * to Build-0 — the A-slice only ADDS an `author` field downstream of it. This
 * source-scanning lint asserts the gate region contains NONE of the A-slice
 * tokens (`deriveAuthor`, `author`, `<speaker>`). If it fails, an author change
 * leaked into the gate block — revert it out.
 *
 * See brief §5 red-arm 6 (BA-3 hunk-scope).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const HANDLER = path.resolve(__dirname, "../browser-handlers/session-action-handler.ts");

function readHandler(): string {
  return fs.readFileSync(HANDLER, "utf8");
}

/**
 * Extract the authorization gate region: from the `authorizeSessionAction({`
 * call through the end of its `if (!decision.allowed) { … }` refuse branch.
 * This is the block the A-slice must NOT touch (Build-0 :234-250).
 */
function extractGateRegion(src: string): string {
  const start = src.indexOf("const decision = authorizeSessionAction({");
  expect(start).toBeGreaterThan(-1);
  // The refuse branch ends at the first `return;` after the decision check.
  const afterDecision = src.indexOf("if (!decision.allowed)", start);
  expect(afterDecision).toBeGreaterThan(-1);
  const refuseEnd = src.indexOf("return;", afterDecision);
  expect(refuseEnd).toBeGreaterThan(-1);
  return src.slice(start, refuseEnd + "return;".length);
}

describe("Surface A #6 — BA-3 hunk-scope: author-stamp stays out of the gate", () => {
  it("the authorization gate region contains no A-slice author tokens", () => {
    const gate = extractGateRegion(readHandler());
    // The gate must be byte-clean of every attribution token.
    expect(gate).not.toMatch(/deriveAuthor/);
    expect(gate).not.toMatch(/\bauthor\b/);
    expect(gate).not.toMatch(/speaker/i);
  });

  it("the author-stamp IS present, but only in the else-branch send (downstream of the gate)", () => {
    const src = readHandler();
    const gateStart = src.indexOf("const decision = authorizeSessionAction({");
    const authorStamp = src.indexOf("const author = deriveAuthor(ctx.principal);");
    // The stamp exists…
    expect(authorStamp).toBeGreaterThan(-1);
    // …and strictly AFTER the gate (downstream), never inside/above it.
    expect(authorStamp).toBeGreaterThan(gateStart);
  });

  it("the forwarded send is field-by-field (no `...msg` spread) — anti-spoof invariant", () => {
    const src = readHandler();
    // The else-branch send must never wholesale-spread the client message.
    // (A `...msg`/`...(msg as any)` spread is the BA-2 hole.)
    expect(src).not.toMatch(/sendToSession\([^)]*\.\.\.\s*\(?\s*msg/s);
  });
});
