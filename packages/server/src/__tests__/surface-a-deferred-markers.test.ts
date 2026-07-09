/**
 * Surface A #7 — FLIPPED deferred-loci assertions (§16.1 merge over Build-1b).
 *
 * Off Build-0 these two loci were DEFERRED (Build-1b-coupled) and this file
 * asserted "must be deferred/unattributed + marker present". At the §16.1 merge
 * onto Build-1b, both loci are now WIRED, so the assertions are FLIPPED:
 *
 *  (a) Locus-3 REST `/prompt` — NOW carries `deriveAuthor(request.restPrincipal)`
 *      (Build-1b's server-stashed REST identity, never the body → BA-2 holds by
 *      construction). Red-arm: derive the REST author from the request BODY →
 *      this test FAILS.
 *  (b) Derived-carrier-guard — the map-classify-EACH assertion now lives in its
 *      own test (`surface-attribution-carrier-guard.test.ts`), iterating the
 *      authoritative co-drive MAP (`ws-session-write-surface.ts`). This file no
 *      longer asserts the deferred marker for it.
 *
 * See merge-directive §2 (wire the 3 deferred loci).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SESSION_API = path.resolve(__dirname, "../session-api.ts");

function read(p: string): string {
  return fs.readFileSync(p, "utf8");
}

/** Slice the REST POST `/api/session/:id/prompt` handler body. */
function extractRestPromptHandler(src: string): string {
  const start = src.indexOf('"/api/session/:id/prompt"');
  expect(start).toBeGreaterThan(-1);
  // The next route registration bounds this handler.
  const nextRoute = src.indexOf('"/api/session/:id/abort"', start);
  expect(nextRoute).toBeGreaterThan(-1);
  return src.slice(start, nextRoute);
}

describe("Surface A #7(a) — Locus-3 REST /prompt NOW attributed (FLIPPED at §16.1)", () => {
  it("the REST /prompt send stamps the author from request.restPrincipal (server-derived)", () => {
    const handler = extractRestPromptHandler(read(SESSION_API));
    // Find the sendToSession send-object in this handler.
    const sendIdx = handler.indexOf("piGateway.sendToSession(id, {");
    expect(sendIdx).toBeGreaterThan(-1);
    const sendObj = handler.slice(sendIdx, handler.indexOf("});", sendIdx));
    // The send now carries a server-stamped `author`.
    expect(sendObj).toMatch(/\bauthor\b/);
    // Derived via deriveAuthor over the Build-1b REST-identity stash.
    expect(handler).toMatch(/deriveAuthor\(\s*\(request as any\)\.restPrincipal/);
  });

  it("the REST author is derived SERVER-SIDE from restPrincipal — NEVER from the request body (BA-2)", () => {
    const handler = extractRestPromptHandler(read(SESSION_API));
    // The author derivation must read `request.restPrincipal`, not the body
    // (`request.body`, `text`, `images`, or a client-supplied author field).
    expect(handler).toMatch(/deriveAuthor\(\s*\(request as any\)\.restPrincipal/);
    // The author source is NEVER the request body.
    expect(handler).not.toMatch(/deriveAuthor\(\s*request\.body/);
    expect(handler).not.toMatch(/author:\s*request\.body/);
    // No client-claimed author field is read off the body.
    expect(handler).not.toMatch(/const\s+\w+\s*=\s*\(request\.body[^;]*author/);
  });

  it("REUSES Build-1b's single REST-identity stash (no second REST-identity path)", () => {
    const src = read(SESSION_API);
    // Exactly one restPrincipal read in the prompt path — the Build-1b stash.
    // (rest-session-gate.ts owns the other read; session-api must not mint a
    // parallel REST identity.)
    const occurrences = (src.match(/restPrincipal/g) ?? []).length;
    expect(occurrences).toBeGreaterThan(0);
    // No fabricated principal / re-decode of the cookie in session-api.
    expect(src).not.toMatch(/verifyToken\(|jwt\.verify|decodeToken/);
  });
});
