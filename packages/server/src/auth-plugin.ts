/**
 * Fastify plugin that registers OAuth auth routes and the onRequest hook.
 * Only registered when auth is configured.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import cookie from "@fastify/cookie";
import crypto from "node:crypto";
import type { AuthConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import {
  type ResolvedProvider,
  type TokenPayload,
  buildProviderRegistry,
  ensureAuthSecret,
  signToken,
  verifyToken,
  parseAuthCookie,
  isUserAllowed,
  buildRedirectUri,
  getPublicBaseUrl,
  setPublicUrlOverride,
  buildAuthorizeUrl,
  exchangeCode,
  fetchUserInfo,
  COOKIE_NAME,
} from "./auth.js";
import { isLoopback, isBypassedHost } from "./localhost-guard.js";

/**
 * Returns true if the request URL matches any of the configured bypass prefixes.
 * Exported for unit testing.
 */
export function isBypassed(url: string, bypassUrls: string[]): boolean {
  return bypassUrls.some((prefix) => url.startsWith(prefix));
}

/**
 * Build 1b (C-REST-CLOSURE) — capture the verified REST identity onto the
 * request for the session-write gate. Derives the actor ONLY from the verified
 * JWT cookie (`human{principal}`) or the shared-secret Bearer header
 * (`service`) — NEVER from the request body (anti-spoof). Purely additive: the
 * session-write gate only reads these when the startup-frozen multi-operator
 * flag is ON, so single-operator behavior is byte-unchanged.
 *
 * Called from BOTH the enforcing onRequest hook (providers configured) and the
 * capture-only hook (flag-ON-with-secret-but-no-provider) so the capture
 * semantics are defined once — no drift between two hand-written copies.
 */
export function captureRestIdentity(request: FastifyRequest, secret: string): void {
  const cookieToken = (request.cookies as any)?.[COOKIE_NAME];
  if (cookieToken) {
    const payload = verifyToken(cookieToken, secret);
    if (payload) {
      // A verified human principal. Cookie identity takes precedence over a
      // shared-secret header (a real user identity is strictly more specific
      // than the principal-less service secret).
      (request as any).restPrincipal = payload;
      (request as any).restActorKind = "human";
      return;
    }
  }
  const authHeader = request.headers.authorization;
  if (
    (request as any).restActorKind == null &&
    authHeader &&
    authHeader.startsWith("Bearer ") &&
    secret &&
    authHeader.slice(7) === secret
  ) {
    // Shared-secret / skill caller → a principal-less `service` actor.
    (request as any).restActorKind = "service";
  }
}



/** Escape HTML special characters to prevent XSS in server-rendered pages. */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface AuthPluginOptions {
  authConfig: AuthConfig;
  port: number;
  /** Merged trusted networks (top-level + auth.bypassHosts) */
  resolvedTrustedNetworks?: string[];
}

/**
 * State parameter encoding: encodes the return URL + CSRF nonce.
 */
function encodeState(returnUrl: string): string {
  const nonce = crypto.randomBytes(8).toString("hex");
  return Buffer.from(JSON.stringify({ returnUrl, nonce })).toString("base64url");
}

// ─── Native-flow state: versioned HMAC-signed envelope ──────────────────────
//
// The native iOS flow returns the JWT via a single-use code in the callback URL
// (`pidashboard://auth-done?code=...`) instead of a Set-Cookie, because the
// ASWebAuthenticationSession cookie does not reach the app's URLSession store on a
// real device. The native decision keys ONLY on a valid HMAC-signed `v:1` state —
// an unsigned browser state can never carry a valid signature, so the code-issuing
// branch is unreachable without a genuine signature (downgrade-resistant).
//
// SECURITY FRAMING (accurate — do NOT overclaim): the `nonce` + HMAC provide state
// INTEGRITY + tamper/downgrade-resistance. They do NOT by themselves provide full
// initiator/session CSRF binding (that would need session/PKCE binding, out of scope
// for v1). Frame honestly: this is state-signing, not full CSRF binding.

interface NativeStatePayload {
  v: 1;
  native: true;
  redirectUri: string;
  returnUrl: string;
  nonce: string;
}

/** Result of classifying + verifying a callback `state` (envelope grammar). */
export type VerifiedState =
  | { kind: "native"; redirectUri: string; returnUrl: string; nonce: string }
  | { kind: "browser"; returnUrl: string; nonce: string }
  | { kind: "reject" };

/** True for a NON-EMPTY base64url token (alphabet [A-Za-z0-9_-], no dots/padding). */
export function isBase64Url(s: unknown): boolean {
  return typeof s === "string" && s.length > 0 && /^[A-Za-z0-9_-]+$/.test(s);
}

/**
 * Sign a native-flow state: `base64url(JSON(payload)) + "." + base64url(HMAC-SHA256(body))`.
 * Versioned (`v:1`). base64url has no `.`, so the single dot is an unambiguous envelope
 * discriminator (1 dot = signed-native, 0 dots = unsigned-browser).
 */
export function signState(payload: NativeStatePayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

/**
 * Classify + verify a callback `state` per the envelope grammar (Alice dl-8969/8976),
 * BEFORE any provider exchange or side-effect. Reject-not-downgrade throughout:
 *   (a) exactly ONE dot  → signed-native v:1 → constant-time HMAC verify + STRICT schema, else reject
 *   (b) NO dot           → unsigned-browser {returnUrl, nonce}; `native`/`redirectUri` FORBIDDEN
 *   (c) any other shape  → reject (>=2 dots / non-base64url / malformed)
 */
export function verifyState(state: unknown, secret: string): VerifiedState {
  if (typeof state !== "string" || state.length === 0) return { kind: "reject" };
  const dotCount = (state.match(/\./g) || []).length;

  // (a) SIGNED-NATIVE — exactly one dot, two non-empty base64url segments
  if (dotCount === 1) {
    const parts = state.split(".");
    const body = parts[0];
    const mac = parts[1];
    if (!isBase64Url(body) || !isBase64Url(mac)) return { kind: "reject" };
    // constant-time HMAC verify — length-check FIRST (timingSafeEqual throws on length mismatch)
    const expected = crypto.createHmac("sha256", secret).update(body).digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(mac, "base64url");
    } catch {
      return { kind: "reject" };
    }
    if (provided.length !== expected.length) return { kind: "reject" };
    if (!crypto.timingSafeEqual(provided, expected)) return { kind: "reject" };
    // STRICT field schema (Alice dl-8976): v===1, native===true (not truthy), strict string types
    let parsed: any;
    try {
      parsed = JSON.parse(Buffer.from(body, "base64url").toString());
    } catch {
      return { kind: "reject" };
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.v !== 1 ||
      parsed.native !== true ||
      typeof parsed.redirectUri !== "string" ||
      parsed.redirectUri.length === 0 ||
      typeof parsed.returnUrl !== "string" ||
      typeof parsed.nonce !== "string" ||
      parsed.nonce.length === 0
    ) {
      return { kind: "reject" };
    }
    return {
      kind: "native",
      redirectUri: parsed.redirectUri,
      returnUrl: parsed.returnUrl,
      nonce: parsed.nonce,
    };
  }

  // (b) UNSIGNED-BROWSER — no dot; native/redirectUri are FORBIDDEN (cannot smuggle native)
  if (dotCount === 0) {
    if (!isBase64Url(state)) return { kind: "reject" };
    let parsed: any;
    try {
      parsed = JSON.parse(Buffer.from(state, "base64url").toString());
    } catch {
      return { kind: "reject" };
    }
    if (!parsed || typeof parsed !== "object") return { kind: "reject" };
    if ("native" in parsed || "redirectUri" in parsed) return { kind: "reject" };
    const returnUrl = typeof parsed.returnUrl === "string" ? parsed.returnUrl : "/";
    const nonce = typeof parsed.nonce === "string" ? parsed.nonce : "";
    return { kind: "browser", returnUrl, nonce };
  }

  // (c) any other shape → reject
  return { kind: "reject" };
}

/**
 * EXACT native-redirect validation (Alice A6): accept ONLY the exact canonical
 * `pidashboard://auth-done`. Rejects any path (incl a trailing slash), query, fragment,
 * userinfo, port, or scheme/host variant. Returns the canonical URI (we append `?code=`
 * ourselves); throws on any deviation.
 */
export function validateNativeRedirect(uri: unknown): string {
  // WIRE-EXACT primary gate: the ONLY accepted value is the byte-exact canonical string.
  // URL-component checks ALONE are parsing-variance-vulnerable — Node accepts empty-but-
  // present aliases (pidashboard://auth-done with a trailing ? / # / : / @) whose NORMALIZED
  // components look exact. So accept only the raw exact string; the component checks below
  // now ONLY ever throw (specific reject-reasons) — they never accept. (Pete MAJOR-1 dl-9108.)
  if (uri === "pidashboard://auth-done") return "pidashboard://auth-done";
  if (typeof uri !== "string" || uri.length === 0) throw new Error("invalid_native_redirect");
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    throw new Error("invalid_native_redirect");
  }
  if (u.protocol !== "pidashboard:") throw new Error("invalid_native_redirect");
  if (u.hostname !== "auth-done") throw new Error("invalid_native_redirect");
  if (u.username || u.password) throw new Error("invalid_native_redirect");
  if (u.port) throw new Error("invalid_native_redirect");
  if (u.pathname !== "") throw new Error("invalid_native_redirect");
  if (u.search) throw new Error("invalid_native_redirect");
  if (u.hash) throw new Error("invalid_native_redirect");
  // Passed every component check but is NOT the byte-exact canonical (an empty-alias
  // wire-variant like a trailing ? / # / : / @) → reject.
  throw new Error("invalid_native_redirect");
}

/**
 * Parser-canonical open-redirect guard (Alice A12), fail-closed. Resolve `returnUrl`
 * against a TRUSTED configured base (deployment identity, never a request header).
 * Same-origin → canonical relative (`pathname+search+hash`); anything else (cross-origin,
 * `//evil`, `/\evil`, external-absolute, `javascript:`/`data:`, embedded credentials,
 * malformed/non-string) → `/`.
 */
export function validateReturnUrl(returnUrl: unknown, trustedBase: string): string {
  if (typeof returnUrl !== "string") return "/";
  let base: URL;
  let u: URL;
  try {
    base = new URL(trustedBase);
    u = new URL(returnUrl, base);
  } catch {
    return "/";
  }
  if (u.origin !== base.origin) return "/";
  if (u.username || u.password) return "/";
  return u.pathname + u.search + u.hash;
}

/** The exact origin of a base URL, or null if unparseable (for exact-origin CORS). */
export function safeOrigin(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

/**
 * In-memory single-use code store for the native code-exchange flow. `put` stamps a TTL;
 * `take` is a SYNC get-and-delete with expiry-checked-AT-take (single-use — a code is never
 * returned twice, and an expired code is never returned). 256-bit codes + a 60s TTL make
 * brute-force/replay infeasible.
 */
export function createAuthCodeStore(opts?: { maxEntries?: number }): {
  put: (code: string, token: string, o: { ttlMs: number }) => void;
  take: (code: unknown) => string | null;
  sweepExpired: () => number;
  size: () => number;
} {
  const store = new Map<string, { token: string; expiresAt: number }>();
  const MAX = opts?.maxEntries ?? 10_000;
  function sweepExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [c, e] of store) {
      if (now > e.expiresAt) {
        store.delete(c);
        removed++;
      }
    }
    return removed;
  }
  return {
    put(code, token, o) {
      // Bound memory (Pete MAJOR-3 dl-9108): sweep expired when at the cap, then hard-cap by
      // evicting the oldest insertion, so unredeemed codes can never grow without bound.
      if (store.size >= MAX) sweepExpired();
      while (store.size >= MAX) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        store.delete(oldest);
      }
      store.set(code, { token, expiresAt: Date.now() + o.ttlMs });
    },
    take(code) {
      if (typeof code !== "string" || code.length === 0) return null;
      const entry = store.get(code);
      if (!entry) return null;
      store.delete(code); // single-use: delete on take, regardless of expiry
      if (Date.now() > entry.expiresAt) return null; // expiry-at-take
      return entry.token;
    },
    sweepExpired,
    size: () => store.size,
  };
}

/**
 * Fixed-window per-key rate limiter (Pete MAJOR-3 dl-9108 / design lines 54,73). `check(key)`
 * returns false when the key exceeds `max` hits in the current `windowMs` window (in-memory,
 * self-pruning on window roll). Keyed by caller IP for the exchange endpoint so a single
 * caller cannot brute-force/replay codes unbounded.
 */
export function createRateLimiter(opts: { max: number; windowMs: number }): {
  check: (key: string) => boolean;
  reset: () => void;
} {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return {
    check(key) {
      const now = Date.now();
      const e = hits.get(key);
      if (!e || now >= e.resetAt) {
        hits.set(key, { count: 1, resetAt: now + opts.windowMs });
        return true;
      }
      if (e.count >= opts.max) return false;
      e.count++;
      return true;
    },
    reset() {
      hits.clear();
    },
  };
}

/**
 * Simple login page HTML with provider links.
 */
function renderLoginPage(providers: ResolvedProvider[], error?: string): string {
  const providerLinks = providers
    .map((p) => `<a href="/auth/start/${p.key}" style="display:block;margin:10px 0;padding:12px 24px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;text-align:center;font-size:16px;">Sign in with ${p.name}</a>`)
    .join("\n");

  const errorHtml = error
    ? `<div style="color:#ef4444;margin-bottom:16px;">${error}</div>`
    : "";

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PI Dashboard — Sign In</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0;}
.card{background:#1e293b;padding:40px;border-radius:12px;max-width:400px;width:100%;text-align:center;}
h1{margin:0 0 24px;font-size:24px;}</style>
</head><body><div class="card"><h1>🔐 PI Dashboard</h1>${errorHtml}${providerLinks}</div></body></html>`;
}

/**
 * Access denied page HTML.
 */
function renderDeniedPage(email: string): string {
  const safeEmail = escapeHtml(email);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PI Dashboard — Access Denied</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0;}
.card{background:#1e293b;padding:40px;border-radius:12px;max-width:400px;width:100%;text-align:center;}
h1{margin:0 0 16px;font-size:24px;color:#ef4444;}</style>
</head><body><div class="card"><h1>Access Denied</h1><p>The email <strong>${safeEmail}</strong> is not authorized to access this dashboard.</p>
<a href="/auth/login" style="color:#60a5fa;">Try a different account</a></div></body></html>`;
}

export async function registerAuthPlugin(
  fastify: FastifyInstance,
  options: AuthPluginOptions,
): Promise<void> {
  const { authConfig, port, resolvedTrustedNetworks } = options;

  // Public-URL override for OAuth redirect_uri (fixed-hostname tunnel front).
  setPublicUrlOverride(authConfig.publicUrl);

  // Mutable auth state — can be rebuilt at runtime via reloadAuth()
  const authState = {
    secret: ensureAuthSecret(authConfig),
    providerRegistry: await buildProviderRegistry(authConfig.providers),
    allowedUsers: authConfig.allowedUsers,
    bypassUrls: authConfig.bypassUrls ?? [],
    bypassHosts: resolvedTrustedNetworks ?? authConfig.bypassHosts ?? [],
  };

  // Single-use code store + per-IP rate limiter for the native code-exchange flow (per-plugin
  // instances). A periodic unref'd sweep bounds expired-code retention (Pete MAJOR-3 dl-9108).
  const authCodeStore = createAuthCodeStore({ maxEntries: 10_000 });
  const exchangeRateLimiter = createRateLimiter({ max: 30, windowMs: 60_000 });
  const authCodeSweep = setInterval(() => authCodeStore.sweepExpired(), 60_000);
  if (typeof (authCodeSweep as any).unref === "function") (authCodeSweep as any).unref();

  // Tag requests with authentication status (read by createNetworkGuard) and
  // the Build 1b REST-captured identity. Registered here — BEFORE the
  // no-providers early-return — so the session-write REST gate always has the
  // fields even in flag-ON-with-secret-but-no-provider mode.
  fastify.decorateRequest("isAuthenticated", false);
  // Build 1b (C-REST-CLOSURE): stash the REST-captured principal + actor kind on
  // the request so the session-write REST gate can construct the SAME
  // `SessionActor` the WS seam does — `human{principal}` for a verified JWT
  // cookie, `service` for the shared-secret / Bearer path. Additive: nothing
  // reads these when the multi-operator gate is OFF (byte-unchanged).
  fastify.decorateRequest("restPrincipal", null);
  fastify.decorateRequest("restActorKind", null);

  // Register the cookie parser now (needed by BOTH the capture hook below and
  // the full OAuth onRequest hook). Idempotent-safe: registered once here.
  await fastify.register(cookie);

  if (authState.providerRegistry.size === 0) {
    // No OAuth providers → the login/callback flow can't run, so we do NOT
    // register the enforcing onRequest hook (that would 401 every request with
    // no way to log in). BUT the multi-operator gate still needs REST
    // principal-capture: register a CAPTURE-ONLY hook (no enforcement, no
    // redirect) so a valid `pi_dash_token` cookie / shared-secret Bearer still
    // binds its identity for the session-write gate. Build 1b F4-closure +
    // operator-only enforcement then work in flag-ON-with-secret mode even
    // before an OAuth provider is configured. See change: fix build1b no-provider capture.
    console.warn("Auth configured but no providers resolved — OAuth login disabled (REST principal-capture still active)");
    fastify.addHook("onRequest", async (request: FastifyRequest) => {
      captureRestIdentity(request, authState.secret);
    });
    return;
  }

  // Expose reload function on the fastify instance for runtime config updates
  (fastify as any)._reloadAuth = async (newConfig: AuthConfig) => {
    setPublicUrlOverride(newConfig.publicUrl);
    authState.secret = ensureAuthSecret(newConfig);
    authState.providerRegistry = await buildProviderRegistry(newConfig.providers);
    authState.allowedUsers = newConfig.allowedUsers;
    authState.bypassUrls = newConfig.bypassUrls ?? [];
    authState.bypassHosts = newConfig.bypassHosts ?? [];
    const names = Array.from(authState.providerRegistry.values()).map((p) => p.name);
    console.log(`🔐 Auth reloaded with providers: ${names.join(", ")}`);
  };

  // (decorators + cookie plugin already registered above, before the
  // no-providers early-return, so REST principal-capture works in every mode.)

  // ─── Auth Routes ────────────────────────────────────────────────────────

  // GET /auth/login — provider picker or auto-redirect
  fastify.get("/auth/login", async (request, reply) => {
    const providers = Array.from(authState.providerRegistry.values());
    const error = (request.query as any)?.error;

    if (providers.length === 1 && !error) {
      // Auto-redirect to single provider
      const p = providers[0];
      const redirectUri = buildRedirectUri(p.key, port);
      const q = request.query as any;
      const returnUrl = typeof q?.return === "string" ? q.return : "/";
      // Native-app flow: /auth/login?native=1&redirect_uri=pidashboard://auth-done
      // → validate the native redirect FIRST, then sign a versioned (v:1) native state.
      // The HMAC signature is the ONLY thing that unlocks the callback's code-issuing
      // branch (downgrade-resistant). A browser (no native=1) gets the unsigned state.
      const isNative = q?.native === "1" || q?.native === "true";
      let state: string;
      if (isNative) {
        let nativeRedirect: string;
        try {
          nativeRedirect = validateNativeRedirect(q?.redirect_uri);
        } catch {
          return reply.redirect("/auth/login?error=Invalid+native+redirect");
        }
        state = signState(
          {
            v: 1,
            native: true,
            redirectUri: nativeRedirect,
            returnUrl,
            nonce: crypto.randomBytes(8).toString("hex"),
          },
          authState.secret,
        );
      } else {
        state = encodeState(returnUrl);
      }
      const url = buildAuthorizeUrl(p, redirectUri, state);
      return reply.redirect(url);
    }

    return reply.type("text/html").send(renderLoginPage(providers, error));
  });

  // GET /auth/start/:provider — redirect to provider's authorize URL
  fastify.get("/auth/start/:provider", async (request, reply) => {
    const providerKey = (request.params as any).provider;
    const provider = authState.providerRegistry.get(providerKey);
    if (!provider) {
      return reply.code(404).send({ error: "Unknown provider" });
    }
    const redirectUri = buildRedirectUri(providerKey, port);
    const returnUrl = (request.query as any)?.return || "/";
    const state = encodeState(returnUrl);
    const url = buildAuthorizeUrl(provider, redirectUri, state);
    return reply.redirect(url);
  });

  // GET /auth/callback/:provider — OAuth callback
  fastify.get("/auth/callback/:provider", async (request, reply) => {
    const providerKey = (request.params as any).provider;
    const provider = authState.providerRegistry.get(providerKey);
    if (!provider) {
      return reply.code(404).send({ error: "Unknown provider" });
    }

    const query = request.query as any;
    const code = query.code;
    const stateParam = query.state || "";

    if (!code) {
      return reply.redirect("/auth/login?error=Missing+authorization+code");
    }

    // Verify state BEFORE any side-effect (no provider exchange / token / code / cookie
    // until the state is classified + a native state's HMAC verified). A signed-looking
    // state that fails verification is REJECTED, never downgraded to native/browser.
    const verified = verifyState(stateParam, authState.secret);
    if (verified.kind === "reject") {
      return reply.redirect("/auth/login?error=Invalid+authentication+state");
    }
    if (verified.kind === "native") {
      // Re-validate the native redirect target BEFORE the provider exchange.
      try {
        validateNativeRedirect(verified.redirectUri);
      } catch {
        return reply.redirect("/auth/login?error=Invalid+native+redirect");
      }
    }

    const redirectUri = buildRedirectUri(providerKey, port);
    const accessToken = await exchangeCode(provider, code, redirectUri);
    if (!accessToken) {
      return reply.redirect("/auth/login?error=Token+exchange+failed");
    }

    const userInfo = await fetchUserInfo(provider, accessToken);
    if (!userInfo) {
      return reply.redirect("/auth/login?error=Failed+to+fetch+user+info");
    }

    if (!isUserAllowed(userInfo.email, userInfo.username, authState.allowedUsers)) {
      return reply.code(403).type("text/html").send(renderDeniedPage(userInfo.email));
    }

    const token = signToken(
      { sub: userInfo.email, name: userInfo.name, username: userInfo.username, provider: providerKey },
      authState.secret,
    );

    // Native flow: issue a single-use code (the JWT is fetched via POST /api/auth/exchange,
    // NOT set as a cookie — the ASWebAuthenticationSession cookie does not reach the app on
    // device). Validate the redirect target AGAIN before storing the code (validate-before-put).
    if (verified.kind === "native") {
      let target: string;
      try {
        target = validateNativeRedirect(verified.redirectUri);
      } catch {
        return reply.redirect("/auth/login?error=Invalid+native+redirect");
      }
      const authCode = crypto.randomBytes(32).toString("base64url"); // 256-bit, single-use
      authCodeStore.put(authCode, token, { ttlMs: 60_000 }); // 60s TTL, AFTER target validated
      return reply.redirect(`${target}?code=${encodeURIComponent(authCode)}`);
    }

    // Browser flow: set the cookie, redirect to the parser-canonical same-origin returnUrl
    // (open-redirect closed — validated against the trusted deployment base, never a header).
    reply.setCookie(COOKIE_NAME, token, {
      path: "/",
      httpOnly: true,
      secure: request.protocol === "https",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60, // 7 days in seconds
    });

    return reply.redirect(validateReturnUrl(verified.returnUrl, getPublicBaseUrl(port)));
  });

  // POST /auth/logout
  fastify.post("/auth/logout", async (_request, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: "/" });
    return reply.redirect("/auth/login");
  });

  // ─── Native code exchange ───────────────────────────────────────────────
  // The native app cannot read the Set-Cookie from ASWebAuthenticationSession, so the
  // callback issues a single-use `code` and the app exchanges it here for the JWT (in the
  // body). The code IS the credential (256-bit, single-use, 60s TTL) → unauthenticated by
  // design (op-2 exempt-set in the onRequest hook), CORS-locked to the exact deployment
  // origin, JWT never cached (no-store). Build-notes dl-8927 #1/#2/#3.
  const applyExchangeCors = (request: FastifyRequest, reply: FastifyReply): void => {
    const trustedOrigin = safeOrigin(getPublicBaseUrl(port));
    const origin = request.headers.origin;
    // EXACT origin match only (never substring/prefix). Native URLSession sends no Origin
    // → no CORS header needed (CORS is browser-enforced); a browser gets it only on exact match.
    if (typeof origin === "string" && trustedOrigin !== null && origin === trustedOrigin) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
    }
  };

  fastify.options("/api/auth/exchange", async (request, reply) => {
    const trustedOrigin = safeOrigin(getPublicBaseUrl(port));
    const origin = request.headers.origin;
    // Reject a present non-exact Origin (consistent with the POST); native/no-Origin + exact pass.
    if (typeof origin === "string" && origin.length > 0 && origin !== trustedOrigin) {
      return reply.code(403).send();
    }
    applyExchangeCors(request, reply);
    if (typeof origin === "string" && origin === trustedOrigin) {
      reply.header("Access-Control-Allow-Methods", "POST, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "content-type");
    }
    return reply.code(204).send();
  });

  fastify.post("/api/auth/exchange", async (request, reply) => {
    // The JWT must never be cached by any intermediary (build-note dl-8927 #1).
    reply.header("Cache-Control", "no-store");
    reply.header("Pragma", "no-cache");
    // Reject a PRESENT non-exact Origin BEFORE consuming the code (Pete MAJOR-2 dl-9108): a
    // cross-origin browser must not be able to BURN a single-use code (CORS only blocks the
    // response read, not the server-side execution). Native URLSession sends no Origin → allowed.
    const trustedOrigin = safeOrigin(getPublicBaseUrl(port));
    const origin = request.headers.origin;
    if (typeof origin === "string" && origin.length > 0 && origin !== trustedOrigin) {
      return reply.code(403).send({ error: "forbidden_origin" });
    }
    // Per-IP rate bound BEFORE take (Pete MAJOR-3): a rate-limited caller must not burn codes.
    if (!exchangeRateLimiter.check(request.ip)) {
      return reply.code(429).send({ error: "rate_limited" });
    }
    applyExchangeCors(request, reply); // reflect ACAO only on the exact-origin match
    const token = authCodeStore.take((request.body as any)?.code);
    if (!token) {
      // NEVER log the code or the JWT (build-note dl-8927 #3).
      return reply.code(400).send({ error: "invalid_or_expired_code" });
    }
    return reply.send({ token });
  });

  // GET /auth/status — no auth required
  fastify.get("/auth/status", async (request, reply) => {
    const cookieToken = (request.cookies as any)?.[COOKIE_NAME];
    if (cookieToken) {
      const payload = verifyToken(cookieToken, authState.secret);
      if (payload) {
        return { authenticated: true, user: { name: payload.name, email: payload.sub, provider: payload.provider } };
      }
    }
    return { authenticated: false };
  });

  // ─── onRequest Hook ─────────────────────────────────────────────────────

  fastify.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    // ── Build 1b REST principal-capture (mandate 3) ─────────────────────────
    // Capture the verified principal / service-kind FIRST — before ANY bypass
    // early-return — so a valid-cookie request that would otherwise short-
    // circuit on the loopback / trusted-net / bypass path (op-1's own device,
    // the integration tests) still binds its identity for the session-write
    // gate. This is the REST mirror of the WS `wsPrincipal` capture. Purely
    // additive: the session-write gate only reads it when the startup-frozen
    // multi-operator flag is ON, so single-op behavior is byte-unchanged. The
    // actor derives ONLY from the verified cookie / shared-secret — NEVER from
    // the request body (anti-spoof).
    captureRestIdentity(request, authState.secret);

    // Localhost bypass
    if (isLoopback(request.ip)) return;

    // Skip auth routes
    if (request.url.startsWith("/auth/")) return;

    // Skip health endpoint
    if (request.url === "/api/health") return;

    // Skip the native code-exchange endpoint — the single-use code IS the credential
    // (unauthenticated by design; CORS-locked + no-store in the handler). op-2 exempt-set.
    if (request.url.split("?")[0] === "/api/auth/exchange") return;

    // Skip /v1/* — proxy auth gate handles those
    if (request.url.startsWith("/v1/")) return;

    // Skip configured bypass URL prefixes
    if (isBypassed(request.url, authState.bypassUrls)) return;

    // Skip configured bypass hosts (trusted source IPs)
    if (isBypassedHost(request.ip, authState.bypassHosts)) return;

    // Validate Authorization: Bearer token (for agent/skill auth).
    // Check this BEFORE cookie/JWT validation so skills can call push APIs
    // regardless of browser cookie state.
    // See change: add-server-push-notifications.
    const authHeader = request.headers.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const bearerToken = authHeader.slice(7);
      if (authState.secret && bearerToken === authState.secret) {
        (request as any).isAuthenticated = true;
        return;
      }
    }

    // Validate JWT cookie
    const cookieToken = (request.cookies as any)?.[COOKIE_NAME];
    if (cookieToken) {
      const payload = verifyToken(cookieToken, authState.secret);
      if (payload) {
        (request as any).isAuthenticated = true;
        return;
      }
      // Invalid/expired — clear cookie
      reply.clearCookie(COOKIE_NAME, { path: "/" });
    }

    // Not authenticated — redirect or 401
    const accept = request.headers.accept || "";
    if (accept.includes("text/html")) {
      const returnUrl = encodeURIComponent(request.url);
      return reply.redirect(`/auth/login?return=${returnUrl}`);
    }
    return reply.code(401).send({ error: "Authentication required" });
  });

  const providerNames = Array.from(authState.providerRegistry.values()).map((p) => p.name);
  console.log(`🔐 Auth enabled with providers: ${providerNames.join(", ")}`);
}

/**
 * Decision returned by {@link validateWsUpgrade}. Carries both the allow/deny
 * verdict AND the verified principal bound to the connection (Build 0 —
 * principal-capture). `validateWsUpgrade` used to return a bare boolean, which
 * discarded the decoded `TokenPayload`; the multi-operator work needs that
 * identity to reach the send path, so the gate now returns it.
 */
export interface WsUpgradeDecision {
  /** Whether the WebSocket upgrade is permitted. */
  allowed: boolean;
  /**
   * The verified principal (decoded JWT) bound to this connection, or null.
   * Non-null only when a valid `pi_dash_token` cookie was presented. In
   * single-operator mode (`requireBrowserAuth=false`) a loopback/trusted-net
   * peer is allowed with a null principal (no cookie required) — exactly
   * today's behavior. In multi-operator mode (`requireBrowserAuth=true`) a
   * non-null principal is a precondition of `allowed:true`.
   */
  principal: TokenPayload | null;
}

/**
 * Validate auth for a WebSocket upgrade request AND capture the verified
 * principal. Returns a {@link WsUpgradeDecision} — `allowed` is the verdict,
 * `principal` is the decoded token (null when no/invalid cookie).
 *
 * @param requireBrowserAuth  Build 0 multi-operator gate. When `true`, the
 *   loopback + trusted-network bypass is NOT honored: the upgrade is allowed
 *   ONLY with a valid cookie, so every browser connection binds a verified
 *   principal. Default `false` → single-operator decision is byte-identical to
 *   the legacy boolean gate (loopback/trusted-net bypass the token check).
 */
export function validateWsUpgrade(
  cookieHeader: string | undefined,
  remoteAddress: string,
  secret: string,
  trustedNetworks: string[] = [],
  requireBrowserAuth = false,
): WsUpgradeDecision {
  // Resolve the verified principal once (null when no/invalid cookie).
  const token = parseAuthCookie(cookieHeader);
  const principal = token ? verifyToken(token, secret) : null;

  // Multi-operator mode: identity is REQUIRED for the browser path. No
  // loopback / trusted-network bypass — op-1's own tailnet device must present
  // a verified principal so every turn has an author to bind. This tightening
  // (in code, gated by the flag) IS the trustedNetworks-close for the browser
  // gateway (two-eyes F1/F2).
  if (requireBrowserAuth) {
    return principal ? { allowed: true, principal } : { allowed: false, principal: null };
  }

  // Single-operator mode (default): allow/deny is byte-unchanged from the
  // legacy boolean gate — loopback and trusted networks bypass the token
  // check. The principal is captured opportunistically (additive) but nothing
  // in the single-operator send path reads it.
  if (isLoopback(remoteAddress)) return { allowed: true, principal };
  if (trustedNetworks.length > 0 && isBypassedHost(remoteAddress, trustedNetworks)) {
    return { allowed: true, principal };
  }
  return principal ? { allowed: true, principal } : { allowed: false, principal: null };
}
