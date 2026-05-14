/**
 * Behavioral tests for predicates + JWT minting + id-prefix logic.
 *
 * Tests externally observable behavior only (per dev-orchestra CLAUDE.md
 * § Test Quality Rules). Does not read production source for expected
 * values; expected JWT shapes derived from RFC 7519 + HS256 directly.
 */
import { describe, it, expect } from "vitest";
import { isFederatedSession, machineIdOf } from "../client/predicates.js";
import { mintFederationJwt } from "../server/peer-connection.js";
import crypto from "node:crypto";

describe("isFederatedSession + machineIdOf", () => {
  it("recognizes machineId-prefixed UUID session ids", () => {
    expect(isFederatedSession({ id: "imac:019e2363-0710-73be-82cf-dbd38cb655cd" })).toBe(true);
    expect(machineIdOf({ id: "imac:019e2363-0710-73be-82cf-dbd38cb655cd" })).toBe("imac");
  });

  it("recognizes underscore + dash machineIds", () => {
    expect(isFederatedSession({ id: "macbook-pro_2:abcdef01-2345-6789-abcd-ef0123456789" })).toBe(true);
    expect(machineIdOf({ id: "win_daily-3:abcdef01-2345-6789-abcd-ef0123456789" })).toBe("win_daily-3");
  });

  it("rejects bare UUIDs (local sessions)", () => {
    expect(isFederatedSession({ id: "019e2363-0710-73be-82cf-dbd38cb655cd" })).toBe(false);
    expect(machineIdOf({ id: "019e2363-0710-73be-82cf-dbd38cb655cd" })).toBe(null);
  });

  it("rejects non-UUID-shaped ids even with prefix (avoids false-positives on misc colon-separated values)", () => {
    expect(isFederatedSession({ id: "imac:not-a-uuid" })).toBe(false);
    expect(machineIdOf({ id: "imac:not-a-uuid" })).toBe(null);
  });

  it("handles missing id safely", () => {
    expect(isFederatedSession({ id: "" })).toBe(false);
    expect(machineIdOf({ id: "" })).toBe(null);
  });
});

describe("mintFederationJwt", () => {
  const SECRET = "test-shared-secret-please-rotate-quarterly";

  it("produces three base64url segments separated by dots (RFC 7519 compact serialization)", () => {
    const jwt = mintFederationJwt(SECRET, "imac");
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    for (const p of parts) {
      // base64url chars: A-Z a-z 0-9 - _
      expect(p).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("encodes HS256 header + role=federation payload + machineId in sub", () => {
    const jwt = mintFederationJwt(SECRET, "macbook");
    const [headerB64, payloadB64] = jwt.split(".");
    const decode = (s: string): unknown =>
      JSON.parse(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"));
    const header = decode(headerB64) as { alg: string; typ: string };
    const payload = decode(payloadB64) as { sub: string; role: string; iat: number; exp: number };
    expect(header.alg).toBe("HS256");
    expect(header.typ).toBe("JWT");
    expect(payload.sub).toBe("federation:macbook");
    expect(payload.role).toBe("federation");
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it("signature verifies under HMAC-SHA256(secret, header.payload)", () => {
    const jwt = mintFederationJwt(SECRET, "imac");
    const [headerB64, payloadB64, sigB64] = jwt.split(".");
    const expected = crypto
      .createHmac("sha256", SECRET)
      .update(`${headerB64}.${payloadB64}`)
      .digest("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    expect(sigB64).toBe(expected);
  });

  it("custom ttl reflected in exp claim", () => {
    const jwt = mintFederationJwt(SECRET, "imac", 60);
    const [, payloadB64] = jwt.split(".");
    const payload = JSON.parse(
      Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"),
    ) as { iat: number; exp: number };
    expect(payload.exp - payload.iat).toBe(60);
  });
});
