import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  signState,
  verifyState,
  validateNativeRedirect,
  validateReturnUrl,
  isBase64Url,
  safeOrigin,
  createAuthCodeStore,
} from "../auth-plugin.js";

const SECRET = "test-secret-native-auth-v4";

// Build a validly-HMAC-signed state from an ARBITRARY payload (to exercise the strict
// schema independently of the HMAC — an attacker without the secret cannot do this, but
// the strict schema is defense-in-depth against a mis-signed state).
function signRaw(payload: unknown, secret = SECRET): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}
// The legacy unsigned browser state (0-dot), as encodeState produces it.
function unsigned(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

describe("isBase64Url", () => {
  it("accepts non-empty base64url, rejects dots/spaces/empty/non-string", () => {
    expect(isBase64Url("abcABC-_09")).toBe(true);
    expect(isBase64Url("a.b")).toBe(false); // dot is the envelope separator, not base64url
    expect(isBase64Url("a b")).toBe(false);
    expect(isBase64Url("a=b")).toBe(false); // no padding
    expect(isBase64Url("")).toBe(false);
    expect(isBase64Url(null)).toBe(false);
    expect(isBase64Url(123)).toBe(false);
  });
});

describe("signState / verifyState round-trip (signed-native)", () => {
  it("A: a signed v:1 native state verifies back to kind=native with fields intact", () => {
    const state = signState(
      { v: 1, native: true, redirectUri: "pidashboard://auth-done", returnUrl: "/x", nonce: "n1" },
      SECRET,
    );
    expect(state.split(".").length).toBe(2); // exactly one dot
    const v = verifyState(state, SECRET);
    expect(v).toEqual({ kind: "native", redirectUri: "pidashboard://auth-done", returnUrl: "/x", nonce: "n1" });
  });
});

describe("verifyState — A14 HMAC integrity / reject-not-downgrade", () => {
  const good = signState(
    { v: 1, native: true, redirectUri: "pidashboard://auth-done", returnUrl: "/", nonce: "n" },
    SECRET,
  );

  it("rejects a tampered body (HMAC no longer matches)", () => {
    const [body, mac] = good.split(".");
    const tampered = `${body.slice(0, -1)}${body.slice(-1) === "A" ? "B" : "A"}.${mac}`;
    expect(verifyState(tampered, SECRET).kind).toBe("reject");
  });
  it("rejects a tampered mac", () => {
    const [body, mac] = good.split(".");
    const tampered = `${body}.${mac.slice(0, -1)}${mac.slice(-1) === "A" ? "B" : "A"}`;
    expect(verifyState(tampered, SECRET).kind).toBe("reject");
  });
  it("rejects a state signed with a different secret (no downgrade to native)", () => {
    const other = signState(
      { v: 1, native: true, redirectUri: "pidashboard://auth-done", returnUrl: "/", nonce: "n" },
      "attacker-secret",
    );
    expect(verifyState(other, SECRET).kind).toBe("reject");
  });
  it("rejects empty / non-string / wrong-length mac segments", () => {
    expect(verifyState("", SECRET).kind).toBe("reject");
    expect(verifyState(undefined as any, SECRET).kind).toBe("reject");
    const [body] = good.split(".");
    expect(verifyState(`${body}.`, SECRET).kind).toBe("reject"); // empty mac
    expect(verifyState(`.${body}`, SECRET).kind).toBe("reject"); // empty body
    expect(verifyState(`${body}.zzzz`, SECRET).kind).toBe("reject"); // short mac (length mismatch)
  });
});

describe("verifyState — Alice dl-8976 STRICT schema (native===true / v===1 / string types)", () => {
  it("rejects native !== true even with a valid HMAC (not truthy: number 1, string 'true')", () => {
    expect(verifyState(signRaw({ v: 1, native: 1, redirectUri: "pidashboard://auth-done", returnUrl: "/", nonce: "n" }), SECRET).kind).toBe("reject");
    expect(verifyState(signRaw({ v: 1, native: "true", redirectUri: "pidashboard://auth-done", returnUrl: "/", nonce: "n" }), SECRET).kind).toBe("reject");
    expect(verifyState(signRaw({ v: 1, native: false, redirectUri: "pidashboard://auth-done", returnUrl: "/", nonce: "n" }), SECRET).kind).toBe("reject");
  });
  it("rejects v !== 1", () => {
    expect(verifyState(signRaw({ v: 2, native: true, redirectUri: "pidashboard://auth-done", returnUrl: "/", nonce: "n" }), SECRET).kind).toBe("reject");
    expect(verifyState(signRaw({ v: "1", native: true, redirectUri: "pidashboard://auth-done", returnUrl: "/", nonce: "n" }), SECRET).kind).toBe("reject");
  });
  it("rejects empty redirectUri / empty nonce / non-string fields", () => {
    expect(verifyState(signRaw({ v: 1, native: true, redirectUri: "", returnUrl: "/", nonce: "n" }), SECRET).kind).toBe("reject");
    expect(verifyState(signRaw({ v: 1, native: true, redirectUri: "pidashboard://auth-done", returnUrl: "/", nonce: "" }), SECRET).kind).toBe("reject");
    expect(verifyState(signRaw({ v: 1, native: true, redirectUri: 5, returnUrl: "/", nonce: "n" }), SECRET).kind).toBe("reject");
    expect(verifyState(signRaw({ v: 1, native: true, redirectUri: "pidashboard://auth-done", returnUrl: 5, nonce: "n" }), SECRET).kind).toBe("reject");
  });
});

describe("verifyState — A2b unsigned-browser (0-dot) + native-smuggle forbidden", () => {
  it("classifies a legacy no-dot {returnUrl,nonce} state as browser", () => {
    const v = verifyState(unsigned({ returnUrl: "/dash", nonce: "n" }), SECRET);
    expect(v).toEqual({ kind: "browser", returnUrl: "/dash", nonce: "n" });
  });
  it("REJECTS an unsigned state that carries native / redirectUri (cannot smuggle native)", () => {
    expect(verifyState(unsigned({ returnUrl: "/", nonce: "n", native: true }), SECRET).kind).toBe("reject");
    expect(verifyState(unsigned({ returnUrl: "/", nonce: "n", redirectUri: "pidashboard://auth-done" }), SECRET).kind).toBe("reject");
    expect(verifyState(unsigned({ returnUrl: "/", nonce: "n", native: false }), SECRET).kind).toBe("reject");
  });
  it("rejects a non-base64url or non-JSON 0-dot state", () => {
    expect(verifyState("!!!not-base64url!!!", SECRET).kind).toBe("reject");
    expect(verifyState(unsigned("a plain string not an object"), SECRET).kind).toBe("reject");
  });
});

describe("verifyState — A14b envelope grammar (dot-count discriminator)", () => {
  it("rejects >=2 dots and other malformed shapes", () => {
    expect(verifyState("a.b.c", SECRET).kind).toBe("reject");
    expect(verifyState("a.b.c.d", SECRET).kind).toBe("reject");
    expect(verifyState(".", SECRET).kind).toBe("reject");
  });
});

describe("validateNativeRedirect — A6 EXACT (only pidashboard://auth-done)", () => {
  it("accepts ONLY the exact canonical uri, returning the canonical form", () => {
    expect(validateNativeRedirect("pidashboard://auth-done")).toBe("pidashboard://auth-done");
  });
  it("rejects trailing slash, path, query, fragment, port, userinfo, case + host/scheme variants", () => {
    const bad = [
      "pidashboard://auth-done/", // trailing slash (Alice dl-8969)
      "pidashboard://auth-done//",
      "pidashboard://auth-done/extra",
      "pidashboard://auth-done?attacker=1",
      "pidashboard://auth-done#frag",
      "pidashboard://auth-done:8080",
      "pidashboard://auth-done@evil.example",
      "pidashboard://user:pass@auth-done",
      "pidashboard://AUTH-DONE", // non-special scheme host NOT lowercased -> != auth-done
      "pidashboard://auth-done.evil.example",
      "pidashboard://evil.example",
      "https://auth-done",
      "pidashboard:auth-done", // no authority
      "not a url",
      "",
    ];
    for (const uri of bad) {
      expect(() => validateNativeRedirect(uri), `should reject: ${uri}`).toThrow();
    }
    expect(() => validateNativeRedirect(null)).toThrow();
    expect(() => validateNativeRedirect(123)).toThrow();
  });
});

describe("validateReturnUrl — A12 parser-canonical, fail-closed", () => {
  const base = "http://localhost:8000";
  it("returns canonical same-origin relative for normal + same-origin-absolute inputs", () => {
    expect(validateReturnUrl("/dashboard", base)).toBe("/dashboard");
    expect(validateReturnUrl("/p?x=1#h", base)).toBe("/p?x=1#h");
    expect(validateReturnUrl("http://localhost:8000/dash?a=1", base)).toBe("/dash?a=1");
  });
  it("returns '/' for open-redirect vectors (//evil, /\\evil, external, js:, data:, credentials, non-string)", () => {
    expect(validateReturnUrl("//evil.example", base)).toBe("/");
    expect(validateReturnUrl("/\\evil.example", base)).toBe("/"); // backslash network-path (WHATWG special-scheme)
    expect(validateReturnUrl("/\\/evil.example", base)).toBe("/");
    expect(validateReturnUrl("https://evil.example/x", base)).toBe("/");
    expect(validateReturnUrl("javascript:alert(1)", base)).toBe("/");
    expect(validateReturnUrl("data:text/html,x", base)).toBe("/");
    expect(validateReturnUrl("http://user:pass@localhost:8000/x", base)).toBe("/"); // embedded credentials
    expect(validateReturnUrl(123 as any, base)).toBe("/");
    expect(validateReturnUrl(null as any, base)).toBe("/");
    expect(validateReturnUrl("http://localhost:9999/x", base)).toBe("/"); // different port = cross-origin
  });
});

describe("createAuthCodeStore — A3/A4/A5 single-use + expiry-at-take", () => {
  it("A3: take returns the token once", () => {
    const s = createAuthCodeStore();
    s.put("c1", "jwt-1", { ttlMs: 60_000 });
    expect(s.take("c1")).toBe("jwt-1");
  });
  it("A5: a code is single-use (second take is null)", () => {
    const s = createAuthCodeStore();
    s.put("c2", "jwt-2", { ttlMs: 60_000 });
    expect(s.take("c2")).toBe("jwt-2");
    expect(s.take("c2")).toBeNull();
  });
  it("A4: an expired code returns null (expiry-at-take) and is consumed", () => {
    const s = createAuthCodeStore();
    s.put("c3", "jwt-3", { ttlMs: -1000 }); // already expired
    expect(s.take("c3")).toBeNull();
    expect(s.take("c3")).toBeNull();
  });
  it("returns null for unknown / empty / non-string codes; size tracks live entries", () => {
    const s = createAuthCodeStore();
    expect(s.take("nope")).toBeNull();
    expect(s.take("")).toBeNull();
    expect(s.take(undefined)).toBeNull();
    s.put("c4", "jwt-4", { ttlMs: 60_000 });
    expect(s.size()).toBe(1);
    s.take("c4");
    expect(s.size()).toBe(0);
  });
});

describe("safeOrigin", () => {
  it("returns the exact origin or null", () => {
    expect(safeOrigin("http://localhost:8000/auth/callback/github")).toBe("http://localhost:8000");
    expect(safeOrigin("https://dash.example.com")).toBe("https://dash.example.com");
    expect(safeOrigin("not a url")).toBeNull();
  });
});
