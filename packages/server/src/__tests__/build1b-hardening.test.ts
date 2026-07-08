/**
 * Build 1b §7 hardening — H-M1 (fail-closed-LOUD on malformed/unparseable
 * security-flag config) + NIT-3 negative-shape config tests + H-M3
 * (flag-flip must not drop the verifier secret).
 *
 * Every case is RED-ARM (plant instructions in each block header).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import { writeConfigPartial } from "../config-api.js";
import { WebSocket } from "ws";
import { signToken, COOKIE_NAME } from "../auth.js";
import { createTestServer, type TestServerHandle } from "../test-support/test-server.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
function tryOpen(ws: WebSocket, ms = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
    if (ws.readyState === WebSocket.OPEN) return done(true);
    ws.on("open", () => done(true));
    ws.on("error", () => done(false));
    ws.on("unexpected-response", () => done(false));
    setTimeout(() => done(ws.readyState === WebSocket.OPEN), ms);
  });
}

describe("Build 1b §7 H-M1 + NIT-3 — malformed/unparseable security-flag config", () => {
  let testDir: string;
  let configFile: string;
  let origHome: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "b1b-hm1-"));
    fs.mkdirSync(path.join(testDir, ".pi", "dashboard"), { recursive: true });
    configFile = path.join(testDir, ".pi", "dashboard", "config.json");
    origHome = process.env.HOME!;
    process.env.HOME = testDir;
  });
  afterEach(() => {
    process.env.HOME = origHome;
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  // ── Fix 2 + FOLD-C(i): a present-but-malformed requireBrowserAuth ─────────
  // PUSHBACK-1 UPDATED the prior "ignore" semantics → fail-CLOSED-REFUSE at
  // STARTUP (the operator clearly intended the gate; silently running it OFF-
  // and-open is the dl-5775 canon). At RUNTIME the same config warns + degrades
  // to single-op (N3: no availability regression for background callers).
  // Red-arm: revert the startup throw in enforceSecurityFlagIntegrity → the
  // startup-throw expectation fails (green-open on a malformed security flag).
  it.each([
    ['string "true"', "true"],
    ["number 1", 1],
    ["empty array", []],
    ["empty object", {}],
  ])("STARTUP throws fail-closed-REFUSE on a non-boolean requireBrowserAuth (%s)", (_label, value) => {
    fs.writeFileSync(configFile, JSON.stringify({ auth: { secret: "s", requireBrowserAuth: value } }));
    expect(() => loadConfig({ startup: true })).toThrow(/SECURITY CONFIG MALFORMED/);
  });

  it.each([
    ['string "true"', "true"],
    ["number 1", 1],
  ])("RUNTIME degrades (no throw) on a non-boolean requireBrowserAuth (%s) — flag resolves unset", (_label, value) => {
    fs.writeFileSync(configFile, JSON.stringify({ auth: { secret: "s", requireBrowserAuth: value } }));
    // Runtime (default) must NOT throw (background caller availability, N3).
    expect(() => loadConfig()).not.toThrow();
    const config = loadConfig();
    // The malformed flag is NOT honored (strict === true): degrade to single-op.
    expect(config.auth?.requireBrowserAuth).not.toBe(true);
  });

  // ── Fix 2: requireBrowserAuth misplaced at the top level ─────────────────
  // The loader only reads auth.requireBrowserAuth → a top-level placement was
  // SILENTLY ignored (fail-OPEN while the operator intended the gate ON).
  // PUSHBACK-1: STARTUP throws fail-closed-REFUSE (MISPLACED); RUNTIME warns +
  // degrades (auth stays undefined — the misplaced flag is still not honored).
  // Red-arm: remove the misplaced-top-level branch → the startup throw is gone.
  it("STARTUP throws fail-closed-REFUSE on a top-level requireBrowserAuth (misplaced)", () => {
    fs.writeFileSync(configFile, JSON.stringify({ requireBrowserAuth: true, port: 8000 }));
    expect(() => loadConfig({ startup: true })).toThrow(/SECURITY CONFIG MISPLACED/);
  });

  it("RUNTIME does not throw on a top-level requireBrowserAuth, and it is still not honored", () => {
    fs.writeFileSync(configFile, JSON.stringify({ requireBrowserAuth: true, port: 8000 }));
    expect(() => loadConfig()).not.toThrow();
    // Still not honored at the top level (auth block never built from it).
    expect(loadConfig().auth).toBeUndefined();
  });

  it("still honors a STRICT boolean true (control — not over-tightened)", () => {
    fs.writeFileSync(configFile, JSON.stringify({ auth: { requireBrowserAuth: true } }));
    const config = loadConfig({ startup: true });
    expect(config.auth?.requireBrowserAuth).toBe(true);
  });

  // ── PUSHBACK-2 FIX-P2-6 (m7): narrow the top-level-misplaced refusal ──────
  // A top-level `requireBrowserAuth:false` is ZERO-security-delta (Build-0
  // booted single-op-open with the flag absent = the same posture). Refusing it
  // is a pure AVAILABILITY regression. A top-level TRUTHY flag is still a
  // misconfigured security directive (intended ON, ignored) → still refused.
  it("STARTUP BOOTS on a top-level requireBrowserAuth:false (zero-security-delta, not a silent-open)", () => {
    // Red-arm: revert the `!== false` narrowing (refuse any top-level presence)
    // → this boot throws → RED (the availability regression returns).
    fs.writeFileSync(configFile, JSON.stringify({ requireBrowserAuth: false, port: 8000 }));
    expect(() => loadConfig({ startup: true })).not.toThrow();
    expect(loadConfig({ startup: true }).port).toBe(8000);
  });

  it("STARTUP still REFUSES a top-level truthy requireBrowserAuth (silent-open prevention intact)", () => {
    fs.writeFileSync(configFile, JSON.stringify({ requireBrowserAuth: true, port: 8000 }));
    expect(() => loadConfig({ startup: true })).toThrow(/SECURITY CONFIG MISPLACED/);
    // A truthy non-boolean top-level placement is also still refused.
    fs.writeFileSync(configFile, JSON.stringify({ requireBrowserAuth: "true", port: 8000 }));
    expect(() => loadConfig({ startup: true })).toThrow(/SECURITY CONFIG MISPLACED/);
  });

  // ── PUSHBACK-2 FIX-P2-6 (n2): unparseable-escalation keys on the KEY shape ─
  // The escalation used `/requireBrowserAuth/.test(rawText)` — matched the token
  // ANYWHERE (an email, a comment, a string value) → a false boot-refusal on a
  // config where the flag is genuinely unset.
  it("STARTUP BOOTS on an unparseable config whose requireBrowserAuth text is only an INCIDENTAL substring", () => {
    // Malformed JSON (so the catch runs) whose ONLY `requireBrowserAuth`
    // occurrence is inside an email value / comment — NOT a JSON key.
    // Red-arm: revert to `/requireBrowserAuth/.test(rawText)` → this throws on
    // the incidental substring → RED.
    fs.writeFileSync(
      configFile,
      '{ "auth": { "allowedUsers": ["x@requireBrowserAuth.example"] } oops-not-json',
    );
    expect(() => loadConfig({ startup: true })).not.toThrow();
  });

  it("STARTUP still REFUSES an unparseable config carrying the requireBrowserAuth KEY (silent-open prevention intact)", () => {
    // The flag present as a real JSON key (`"requireBrowserAuth":`) → still a
    // fail-closed refuse (the operator was configuring the gate here).
    fs.writeFileSync(configFile, '{ "auth": { "requireBrowserAuth": true } oops-not-json');
    expect(() => loadConfig({ startup: true })).toThrow(/SECURITY CONFIG UNPARSEABLE/);
  });

  // ── PUSHBACK-3 FIX-P3-5 (dual-review MINOR-2): unquoted/single-quoted key ──────
  // An operator who hand-edits config.json intending multi-op ON but drops or
  // single-quotes the key quotes (a JS habit) makes JSON.parse throw. The OLD
  // `/"requireBrowserAuth"\s*:/` demanded a DOUBLE-quoted key → MISSED it → the
  // catch returned open single-op defaults SILENTLY (not even the loud warn) on a
  // config the operator intended ON. The quote-agnostic key match refuses it.
  it("STARTUP REFUSES an unparseable config with an UNQUOTED requireBrowserAuth key (JS-habit hand-edit)", () => {
    // Red-arm: revert to `/"requireBrowserAuth"\s*:/` (double-quote-only) → the
    // unquoted key is missed → this no longer throws → RED (silent single-op-open).
    fs.writeFileSync(configFile, "{ auth: { requireBrowserAuth: true } }");
    expect(() => loadConfig({ startup: true })).toThrow(/SECURITY CONFIG UNPARSEABLE/);
  });

  it("STARTUP REFUSES an unparseable config with a SINGLE-quoted requireBrowserAuth key", () => {
    fs.writeFileSync(configFile, "{ 'auth': { 'requireBrowserAuth': true } }");
    expect(() => loadConfig({ startup: true })).toThrow(/SECURITY CONFIG UNPARSEABLE/);
  });

  it("STARTUP REFUSES an unparseable config with a MIXED-CASE requireBrowserAuth key (case-insensitive)", () => {
    fs.writeFileSync(configFile, "{ auth: { requirebrowserauth: true } }");
    expect(() => loadConfig({ startup: true })).toThrow(/SECURITY CONFIG UNPARSEABLE/);
  });

  // ── FOLD-C(ii) coupling-guard: operatorUsers set + flag absent → LOUD warn ─
  // Product-safe (single-op baseline) so it WARNS, never throws — even at
  // startup. Red-arm: remove the coupling-guard branch → no diagnostic on the
  // silent-drop of the auth block.
  it("does NOT throw at startup on operatorUsers-set-but-flag-absent (coupling-guard warns, not refuses)", () => {
    fs.writeFileSync(configFile, JSON.stringify({ auth: { secret: "s", operatorUsers: ["op1@example.com"] } }));
    expect(() => loadConfig({ startup: true })).not.toThrow();
  });

  // ── PUSHBACK-4 m-1: malformed operatorUsers with the gate ON → LOUD/refuse ─
  // operatorUsers PRESENT but yielding ZERO usable operators while
  // requireBrowserAuth is ON → operatorConfigured silently false → operator-only
  // enforcement INERT while the operator believes the gate is up → op-2 reaches
  // the whole operator-only surface (the dl-5761 window). Was silent; now
  // symmetric to the requireBrowserAuth guards: STARTUP throws, RUNTIME warns.
  // Red-arm: remove the malformed-operator-users branch in
  // enforceSecurityFlagIntegrity → these startup-throw expectations fail.
  it("STARTUP throws fail-closed-REFUSE on a SCALAR operatorUsers with the gate ON (m-1 fail-open closed)", () => {
    fs.writeFileSync(configFile, JSON.stringify({ auth: { secret: "s", requireBrowserAuth: true, operatorUsers: "op1@example.com" } }));
    expect(() => loadConfig({ startup: true })).toThrow(/SECURITY CONFIG MALFORMED/);
  });

  it("STARTUP throws on an all-WHITESPACE operatorUsers with the gate ON (zero usable identities)", () => {
    fs.writeFileSync(configFile, JSON.stringify({ auth: { secret: "s", requireBrowserAuth: true, operatorUsers: ["   ", ""] } }));
    expect(() => loadConfig({ startup: true })).toThrow(/SECURITY CONFIG MALFORMED/);
  });

  it("STARTUP throws on a NON-STRING operatorUsers element with the gate ON", () => {
    fs.writeFileSync(configFile, JSON.stringify({ auth: { secret: "s", requireBrowserAuth: true, operatorUsers: [123] } }));
    expect(() => loadConfig({ startup: true })).toThrow(/SECURITY CONFIG MALFORMED/);
  });

  it("RUNTIME degrades (no throw) on the same malformed operatorUsers + gate-ON (N3 availability)", () => {
    fs.writeFileSync(configFile, JSON.stringify({ auth: { secret: "s", requireBrowserAuth: true, operatorUsers: "op1@example.com" } }));
    expect(() => loadConfig()).not.toThrow();
  });

  it("does NOT throw on a VALID operatorUsers with the gate ON (control — not over-tightened)", () => {
    fs.writeFileSync(configFile, JSON.stringify({ auth: { secret: "s", requireBrowserAuth: true, operatorUsers: ["op1@example.com"] } }));
    expect(() => loadConfig({ startup: true })).not.toThrow();
    expect(loadConfig({ startup: true }).auth?.operatorUsers).toEqual(["op1@example.com"]);
  });

  it("does NOT throw on an EMPTY operatorUsers with the gate ON (intentional inert; op-1 retains control)", () => {
    fs.writeFileSync(configFile, JSON.stringify({ auth: { secret: "s", requireBrowserAuth: true, operatorUsers: [] } }));
    expect(() => loadConfig({ startup: true })).not.toThrow();
  });

  // ── FOLD-C(iii) lenient-on-typo: unrelated malformed JSON never trips it ──
  // ── H-M1: STARTUP throws on an UNPARSEABLE config carrying the flag TEXT ──
  // Red-arm: revert loadConfig's catch to `return defaults` unconditionally →
  // this throw-expectation fails (silent single-op-open on a mid-edit malformed
  // auth gate).
  it("STARTUP throws on an unparseable config that textually carries requireBrowserAuth (no silent single-op)", () => {
    // Malformed JSON (trailing junk) that still contains the security flag.
    fs.writeFileSync(configFile, '{ "auth": { "requireBrowserAuth": true } oops-not-json');
    expect(() => loadConfig({ startup: true })).toThrow(/SECURITY CONFIG UNPARSEABLE/);
  });

  it("RUNTIME does NOT throw on the same unparseable-with-flag config (N3 availability — degrades)", () => {
    fs.writeFileSync(configFile, '{ "auth": { "requireBrowserAuth": true } oops-not-json');
    // Background callers must not throw on a mid-edit hand-edit (N3).
    expect(() => loadConfig()).not.toThrow();
  });

  it("does NOT throw on unrelated malformed JSON (no security flag → lenient default preserved), even at startup", () => {
    fs.writeFileSync(configFile, "not valid json {{{");
    expect(() => loadConfig({ startup: true })).not.toThrow();
    expect(loadConfig().port).toBe(8000);
  });

  // ── H-M1 config-API write: reject a non-boolean, preserve prior value ─────
  // Red-arm: drop the typeof-boolean guard in writeConfigPartial → a non-boolean
  // write coerces + persists (result.success true) → these assertions fail.
  it("writeConfigPartial REJECTS a non-boolean requireBrowserAuth (preserves prior)", () => {
    fs.writeFileSync(configFile, JSON.stringify({ auth: { secret: "s", requireBrowserAuth: true } }));
    const result = writeConfigPartial({ auth: { requireBrowserAuth: "true" as any } });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/must be a boolean/);
    // Prior value preserved on disk (not coerced/overwritten).
    const onDisk = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    expect(onDisk.auth.requireBrowserAuth).toBe(true);
  });

  it("writeConfigPartial ACCEPTS a strict boolean requireBrowserAuth (control)", () => {
    fs.writeFileSync(configFile, JSON.stringify({ auth: { secret: "s", requireBrowserAuth: true } }));
    const result = writeConfigPartial({ auth: { requireBrowserAuth: false } });
    expect(result.success).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    expect(onDisk.auth.requireBrowserAuth).toBe(false);
  });

  // ── Fix 3 (MAJOR-1): operatorUsers round-trips through writeConfigPartial ──
  // The auth deep-merge had branches for secret/providers/allowedUsers/
  // requireBrowserAuth/bypass* but NONE for operatorUsers → a write returned
  // success:true and DROPPED the value → operator-only enforcement stayed inert
  // (op-2 gets operator-only actions). Red-arm: drop the operatorUsers persist
  // branch in config-api.ts → the round-trip assertion fails (value not on disk
  // / not read back).
  it("writeConfigPartial persists operatorUsers → on disk → read back through loadConfig (round-trip) + restartRequired", () => {
    fs.writeFileSync(configFile, JSON.stringify({ auth: { secret: "s", requireBrowserAuth: true } }));
    const result = writeConfigPartial({ auth: { operatorUsers: ["op1@example.com", "op1b@example.com"] } });
    expect(result.success).toBe(true);
    // PUSHBACK-2 FIX-P2-3 addendum (m6): the live gates FREEZE operatorUsers at
    // startup (server.ts createBrowserGateway + REST closures) and `_reloadAuth`
    // NEVER re-threads it → the change is restart-required. A disk+loadConfig
    // round-trip alone is a restart SIMULATION that greens over the live
    // fail-open; assert the API tells the operator to restart.
    // Red-arm: drop the operatorUsers `restartRequired=true` branch in
    // config-api.ts → the live gate keeps the stale roster while the API says
    // "no restart needed" → this assertion fails.
    expect(result.restartRequired).toBe(true);
    // Persisted on disk.
    const onDisk = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    expect(onDisk.auth.operatorUsers).toEqual(["op1@example.com", "op1b@example.com"]);
    // Read back through loadConfig (the value the gate actually reads).
    const reloaded = loadConfig();
    expect(reloaded.auth?.operatorUsers).toEqual(["op1@example.com", "op1b@example.com"]);
  });

  it("writeConfigPartial flags restartRequired when operatorUsers changes; NOT when re-set to the same value", () => {
    fs.writeFileSync(configFile, JSON.stringify({ auth: { secret: "s", requireBrowserAuth: true, operatorUsers: ["op1@example.com"] } }));
    // A REVOKE (remove op1) is restart-required — the live gate keeps the stale
    // roster otherwise (a dual-review own-hand finding: a revoke returned
    // restartRequired:false yet the live gate kept the stale operator).
    const revoke = writeConfigPartial({ auth: { operatorUsers: [] } });
    expect(revoke.restartRequired).toBe(true);
    // Re-set to the SAME value → no change → no restart.
    fs.writeFileSync(configFile, JSON.stringify({ auth: { secret: "s", requireBrowserAuth: true, operatorUsers: ["op1@example.com"] } }));
    const same = writeConfigPartial({ auth: { operatorUsers: ["op1@example.com"] } });
    expect(same.restartRequired).toBe(false);
  });

  it("writeConfigPartial preserves an existing operatorUsers when the key is omitted", () => {
    fs.writeFileSync(configFile, JSON.stringify({ auth: { secret: "s", requireBrowserAuth: true, operatorUsers: ["op1@example.com"] } }));
    // A write that touches only allowedUsers must NOT drop operatorUsers.
    const result = writeConfigPartial({ auth: { allowedUsers: ["op1@example.com", "op2@example.com"] } });
    expect(result.success).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    expect(onDisk.auth.operatorUsers).toEqual(["op1@example.com"]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// H-M3 — flag-flip must NOT drop the verifier secret + lock out valid cookies
// ───────────────────────────────────────────────────────────────────────────
describe("Build 1b §7 H-M3 — flip OFF preserves the verifier secret (frozen-ON gate keeps verifying cookies)", () => {
  let testDir: string;
  let configFile: string;
  let origHome: string;
  let handle: TestServerHandle | undefined;
  const SECRET = "hm3-flip-preserve-secret";

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "b1b-hm3-"));
    fs.mkdirSync(path.join(testDir, ".pi", "dashboard"), { recursive: true });
    configFile = path.join(testDir, ".pi", "dashboard", "config.json");
    origHome = process.env.HOME!;
    process.env.HOME = testDir;
  });
  afterEach(async () => {
    if (handle) { await handle.stop(); handle = undefined; }
    process.env.HOME = origHome;
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  // Red-arm: remove the H-M3 secret-preserve block in system-routes' reload
  // path → after the flip the frozen-ON /ws gate has no secret → a VALID cookie
  // is 401'd → the "still connects" assertion fails.
  it("a valid-cookie /ws STILL connects under a frozen-ON gate after a runtime flip OFF (flag-only-no-provider)", async () => {
    // flag-only-no-provider mode: {secret, requireBrowserAuth:true}, no providers.
    fs.writeFileSync(configFile, JSON.stringify({ auth: { secret: SECRET, requireBrowserAuth: true } }));
    const loaded = loadConfig();
    expect(loaded.auth?.requireBrowserAuth).toBe(true);
    handle = await createTestServer({
      authConfig: loaded.auth,
      resolvedTrustedNetworks: loaded.resolvedTrustedNetworks,
    });
    const { httpPort } = handle;

    // Baseline: a valid cookie connects (gate ON, secret present).
    const token = signToken({ sub: "op1@example.com", name: "Op", username: "op1", provider: "github" }, SECRET);
    const before = new WebSocket(`ws://localhost:${httpPort}/ws`, { headers: { Cookie: `${COOKIE_NAME}=${token}` } });
    expect(await tryOpen(before)).toBe(true);
    try { before.close(); } catch { /* noop */ }

    // Flip the flag OFF via the real reload path → loadConfig() would collapse
    // the secret-only block to undefined; H-M3 preserves the prior secret so the
    // frozen-ON gate keeps verifying.
    const res = await fetch(`http://localhost:${httpPort}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auth: { requireBrowserAuth: false } }),
    });
    expect((await res.json()).success).toBe(true);
    await delay(120);

    // THE H-M3 ASSERTION: the same valid cookie STILL connects (secret survived
    // the reload; the frozen-ON gate did not lock out valid cookies).
    const after = new WebSocket(`ws://localhost:${httpPort}/ws`, { headers: { Cookie: `${COOKIE_NAME}=${token}` } });
    const openedAfter = await tryOpen(after);
    try { after.close(); } catch { /* noop */ }
    expect(openedAfter).toBe(true);

    // And a NO-cookie /ws is still refused (frozen-ON gate intact).
    const noCookie = new WebSocket(`ws://localhost:${httpPort}/ws`);
    const openedNoCookie = await tryOpen(noCookie);
    try { noCookie.close(); } catch { /* noop */ }
    expect(openedNoCookie).toBe(false);
  }, 20000);

  // ── FOLD-E N1: route-level status assertion (400 validation vs 500 disk) ──
  // The 400-vs-500 split was a brittle English-substring match; now keyed on the
  // structured `validationError` flag. Assert the ROUTE returns the right status.
  // Red-arm: change the split back to always-500 (or drop validationError) → the
  // 400 assertion fails.
  it("PUT /api/config with a non-boolean requireBrowserAuth → 400 (validation), a valid write → 200", async () => {
    fs.writeFileSync(configFile, JSON.stringify({ auth: { secret: SECRET, requireBrowserAuth: true } }));
    const loaded = loadConfig();
    handle = await createTestServer({
      authConfig: loaded.auth,
      resolvedTrustedNetworks: loaded.resolvedTrustedNetworks,
    });
    const { httpPort } = handle;

    // Malformed security-flag write → 400 (client validation error), NOT 500.
    const bad = await fetch(`http://localhost:${httpPort}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auth: { requireBrowserAuth: "true" } }),
    });
    expect(bad.status).toBe(400);
    const badBody = await bad.json();
    expect(badBody.success).toBe(false);
    expect(badBody.error).toMatch(/must be a boolean/);

    // A valid (strict-boolean) write → 200.
    const ok = await fetch(`http://localhost:${httpPort}/api/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auth: { requireBrowserAuth: false } }),
    });
    expect(ok.status).toBe(200);
  }, 20000);
});
