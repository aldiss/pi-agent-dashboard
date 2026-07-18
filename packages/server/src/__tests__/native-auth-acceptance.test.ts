import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerAuthPlugin, verifyState } from "../auth-plugin.js";
import { verifyToken } from "../auth.js";
import type { AuthConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";

const SECRET = "test-secret-native-auth-acceptance";

// A single github provider resolves WITHOUT network (static GITHUB_ENDPOINTS), so the app
// builds offline. Only the token-exchange + userinfo calls hit the network — we stub that
// one boundary; everything else (state signing/verify, code issue, JWT, exchange) is real.
function makeConfig(): AuthConfig {
  return {
    secret: SECRET,
    providers: { github: { clientId: "cid", clientSecret: "csec" } },
    publicUrl: "http://localhost:8000",
  } as AuthConfig;
}

async function makeApp() {
  const app = Fastify();
  await registerAuthPlugin(app, { authConfig: makeConfig(), port: 8000 });
  await app.ready();
  return app;
}

// Stub the github network boundary (token + userinfo) so the callback runs end-to-end offline.
function stubGithub() {
  return (async (url: any) => {
    const u = String(url);
    if (u.includes("login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "gh-access-tok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("api.github.com/user")) {
      return new Response(JSON.stringify({ email: "u@example.com", name: "U", login: "u" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error("unexpected fetch: " + u);
  }) as any;
}

// Issue a real single-use code via native login -> callback (github stubbed).
async function issueCode(app: Awaited<ReturnType<typeof makeApp>>): Promise<string> {
  const login = await app.inject({
    method: "GET",
    url: "/auth/login?native=1&redirect_uri=pidashboard://auth-done",
  });
  const state = new URL(login.headers.location as string).searchParams.get("state")!;
  const cb = await app.inject({
    method: "GET",
    url: `/auth/callback/github?code=ghcode&state=${encodeURIComponent(state)}`,
  });
  return new URL(cb.headers.location as string).searchParams.get("code")!;
}

describe("ACCEPTANCE — /auth/login?native=1 native round-trip (Portico dl-8987 criterion)", () => {
  it("native login auto-redirects to github with a SIGNED-NATIVE (1-dot) state", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/auth/login?native=1&redirect_uri=pidashboard://auth-done",
      });
      expect(res.statusCode).toBe(302);
      const loc = res.headers.location as string;
      expect(loc).toContain("github.com/login/oauth/authorize");
      const state = new URL(loc).searchParams.get("state")!;
      // signed-native = exactly one dot; verifyState accepts it as native with the exact redirect
      expect(state.split(".").length).toBe(2);
      const v = verifyState(state, SECRET);
      expect(v).toMatchObject({ kind: "native", redirectUri: "pidashboard://auth-done" });
    } finally {
      await app.close();
    }
  });

  it("native login with an INVALID redirect_uri is rejected before any github redirect", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/auth/login?native=1&redirect_uri=" + encodeURIComponent("pidashboard://auth-done/evil"),
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/auth/login?error=Invalid+native+redirect");
    } finally {
      await app.close();
    }
  });

  it("FULL round-trip: native login -> callback issues ?code= -> exchange returns the JWT (single-use, no-store)", async () => {
    const realFetch = global.fetch;
    global.fetch = (async (url: any) => {
      const u = String(url);
      if (u.includes("login/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "gh-access-tok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes("api.github.com/user")) {
        return new Response(JSON.stringify({ email: "u@example.com", name: "U", login: "u" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error("unexpected fetch: " + u);
    }) as any;

    try {
      const app = await makeApp();
      try {
        // 1. native login → capture the signed-native state
        const login = await app.inject({
          method: "GET",
          url: "/auth/login?native=1&redirect_uri=pidashboard://auth-done",
        });
        const state = new URL(login.headers.location as string).searchParams.get("state")!;

        // 2. callback with a provider code + our signed state → redirect to pidashboard://auth-done?code=
        const cb = await app.inject({
          method: "GET",
          url: `/auth/callback/github?code=ghcode&state=${encodeURIComponent(state)}`,
        });
        expect(cb.statusCode).toBe(302);
        const cbLoc = cb.headers.location as string;
        expect(cbLoc.startsWith("pidashboard://auth-done?code=")).toBe(true);
        // native flow must NOT set a cookie (the whole reason for the code flow)
        expect(cb.headers["set-cookie"]).toBeUndefined();
        const issuedCode = new URL(cbLoc).searchParams.get("code")!;
        expect(issuedCode.length).toBeGreaterThan(20); // 256-bit base64url

        // 3. exchange the code → JWT (in body), no-store
        const ex = await app.inject({
          method: "POST",
          url: "/api/auth/exchange",
          payload: { code: issuedCode },
        });
        expect(ex.statusCode).toBe(200);
        expect(ex.headers["cache-control"]).toBe("no-store");
        const token = ex.json().token as string;
        expect(typeof token).toBe("string");
        const payload = verifyToken(token, SECRET);
        expect(payload?.sub).toBe("u@example.com");

        // 4. single-use: the same code cannot be exchanged twice
        const ex2 = await app.inject({
          method: "POST",
          url: "/api/auth/exchange",
          payload: { code: issuedCode },
        });
        expect(ex2.statusCode).toBe(400);
      } finally {
        await app.close();
      }
    } finally {
      global.fetch = realFetch;
    }
  });

  it("a TAMPERED native state is rejected at the callback BEFORE any token/code is issued", async () => {
    const app = await makeApp();
    try {
      const login = await app.inject({
        method: "GET",
        url: "/auth/login?native=1&redirect_uri=pidashboard://auth-done",
      });
      const state = new URL(login.headers.location as string).searchParams.get("state")!;
      const [body, mac] = state.split(".");
      // Tamper the BODY (the HMAC is over the body STRING, so any body-char change reliably
      // invalidates the signature). NOTE: flipping the LAST mac char is UNRELIABLE — base64url
      // tail bits are don't-care, so a last-char flip can decode to the SAME valid HMAC bytes
      // (a re-encoding, not a real tamper). Flip body[0] for a deterministic tamper.
      const tampered = `${body[0] === "A" ? "B" : "A"}${body.slice(1)}.${mac}`;
      const cb = await app.inject({
        method: "GET",
        url: `/auth/callback/github?code=ghcode&state=${encodeURIComponent(tampered)}`,
      });
      expect(cb.statusCode).toBe(302);
      expect(cb.headers.location).toBe("/auth/login?error=Invalid+authentication+state");
      expect(cb.headers["set-cookie"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

describe("ACCEPTANCE — exchange CORS + rate-limit (Pete MAJOR-2/3 dl-9108)", () => {
  it("CORS: an evil present-Origin POST is 403'd BEFORE take — code NOT burned, still redeems from no-Origin", async () => {
    const realFetch = global.fetch;
    global.fetch = stubGithub();
    try {
      const app = await makeApp();
      try {
        const code = await issueCode(app);
        // evil cross-origin POST must be rejected BEFORE take (must not consume the single-use code)
        const evil = await app.inject({
          method: "POST",
          url: "/api/auth/exchange",
          headers: { origin: "https://evil.example" },
          payload: { code },
        });
        expect(evil.statusCode).toBe(403);
        // the SAME code still redeems from a native (no-Origin) request => it was NOT burned
        const ok = await app.inject({ method: "POST", url: "/api/auth/exchange", payload: { code } });
        expect(ok.statusCode).toBe(200);
        expect(typeof ok.json().token).toBe("string");
        expect(ok.headers["cache-control"]).toBe("no-store");
      } finally {
        await app.close();
      }
    } finally {
      global.fetch = realFetch;
    }
  });

  it("CORS: an exact-trusted-Origin POST is allowed and reflects ACAO", async () => {
    const realFetch = global.fetch;
    global.fetch = stubGithub();
    try {
      const app = await makeApp();
      try {
        const code = await issueCode(app);
        const ok = await app.inject({
          method: "POST",
          url: "/api/auth/exchange",
          headers: { origin: "http://localhost:8000" },
          payload: { code },
        });
        expect(ok.statusCode).toBe(200);
        expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:8000");
      } finally {
        await app.close();
      }
    } finally {
      global.fetch = realFetch;
    }
  });

  it("rate-limit: a same-IP exchange flood returns 429 after the window max (before burning codes)", async () => {
    const app = await makeApp();
    try {
      let got429 = false;
      for (let i = 0; i < 40; i++) {
        const r = await app.inject({ method: "POST", url: "/api/auth/exchange", payload: { code: "nonexistent" } });
        if (r.statusCode === 429) {
          got429 = true;
          break;
        }
        expect(r.statusCode).toBe(400); // bad code returns 400 until the limiter trips
      }
      expect(got429).toBe(true);
    } finally {
      await app.close();
    }
  });
});
