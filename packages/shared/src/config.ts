/**
 * Shared configuration module for PI Dashboard.
 * Used by both the server CLI and bridge extension.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const CONFIG_DIR = path.join(os.homedir(), ".pi", "dashboard");
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export type SpawnStrategy = "tmux" | "headless";

/**
 * Default cadence (ms) for the Component-A display-resurrection sweep
 * (session-resurrection design-pass §3-A, ratified 20s). `0` disables.
 * Single source of truth — consumed by server.ts + cli.ts buildConfig.
 */
export const DEFAULT_RESURRECTION_SWEEP_MS = 20000;

/**
 * Policy applied when a bridge re-registers a session after a dashboard
 * restart (i.e. the `session_register` carries `registerReason: "reattach"`).
 *
 * - `"always"` (default) — unconditionally move the session to the front
 *   of `sessionOrder` for its cwd.
 * - `"streaming-only"` — only move-to-front when the session's status is
 *   currently `"streaming"`.
 * - `"preserve"` — leave `sessionOrder` untouched (legacy behavior).
 *
 * See change: reattach-move-to-front.
 */
export type ReattachPlacement = "preserve" | "streaming-only" | "always";

const VALID_REATTACH_PLACEMENTS: ReattachPlacement[] = [
  "preserve",
  "streaming-only",
  "always",
];

export const DEFAULT_REATTACH_PLACEMENT: ReattachPlacement = "always";

/**
 * Validate a raw value against the {@link ReattachPlacement} union.
 * Anything outside the union (including `undefined`, numbers, objects)
 * falls back to {@link DEFAULT_REATTACH_PLACEMENT}.
 */
export function parseReattachPlacement(raw: unknown): ReattachPlacement {
  return typeof raw === "string" && (VALID_REATTACH_PLACEMENTS as string[]).includes(raw)
    ? (raw as ReattachPlacement)
    : DEFAULT_REATTACH_PLACEMENT;
}

export interface AuthProviderConfig {
  clientId: string;
  clientSecret: string;
  issuerUrl?: string;
  name?: string;
}

export interface AuthConfig {
  secret: string;
  providers: Record<string, AuthProviderConfig>;
  /**
   * Public base URL when the dashboard is fronted by a fixed-hostname reverse
   * proxy / tunnel (e.g. Cloudflare Tunnel → https://dash.example.com). Used as
   * the OAuth redirect_uri base so the provider callback matches the registered
   * public callback; takes precedence over the dynamic zrok tunnel URL. Unset →
   * redirect falls back to the zrok tunnel URL, else http://localhost:<port>.
   */
  publicUrl?: string;
  allowedUsers?: string[];
  bypassUrls?: string[];
  bypassHosts?: string[];
  /** Admin email override — can list/revoke every user's proxy API keys. */
  admin?: string;
  /**
   * Multi-operator principal-capture gate (Build 0). When `true`, the browser
   * `/ws` gateway REQUIRES a valid `pi_dash_token` — the pre-JWT loopback +
   * trusted-network bypass is NOT honored for the browser path, so every
   * connecting operator device (including op-1's own tailnet device) presents
   * a verified principal that binds to the connection. Default `false` →
   * single-operator behavior is byte-unchanged (the loopback/trusted-net
   * bypass stands, no principal is required).
   *
   * NOTE (reversibility, two-eyes F7 / contract Alice #6): turning this OFF in
   * config.json is NOT a clean flip — the `auth.secret` is sticky through the
   * config API and until-expiry JWT cookies persist. Reverting to fully-open
   * requires a hand-edit of config.json (remove the auth block) + restart.
   */
  requireBrowserAuth?: boolean;
  /**
   * Operator-identity source for operator-only session-write enforcement
   * (Build 1b — C-REST-CLOSURE, mandate 4c). A session-write action classified
   * `operator-only` (the session-control / lifecycle actions: shutdown,
   * retire, resurrect, spawn, resume, rename, hide/unhide, model,
   * thinking-level, flow-control, attach/detach-proposal, kill_process/
   * force_kill, and the role/preset mutations role_set/flow_management/
   * role_preset_save/delete/load) is authorized ONLY
   * when the actor is a `human` whose verified principal matches an entry here
   * (by `sub`/email or `username`, case-insensitive). A bounded co-driver
   * (op-2, authenticated but NOT listed) and a `service` actor are structurally
   * refused for operator-only actions but may still perform co-drive actions:
   * `send_prompt`, `abort` (the safety emergency-stop — the source-map
   * `SESSION_WRITE_ACTION_CLASS.abort` is CO-DRIVE, not operator-only), and
   * `request_roles` (a read).
   *
   * INERT when unset/empty OR when `requireBrowserAuth` is off: operator-only
   * enforcement no-ops, so single-operator (and flag-ON-without-an-operator)
   * behavior is byte-unchanged. The VALUES (op-1/op-2 emails) are configured at
   * Build 1 when op-2 is admitted — Build 1b ships the MECHANISM only. Because
   * enforcement is inert when this is unset, Build 1 MUST set `operatorUsers`
   * in the SAME config change that admits op-2 (dl-5761: no window for op-2 to
   * silently hold an operator-only action).
   */
  operatorUsers?: string[];
  /**
   * Optional guest → orchestration-cell allowlist. Presence activates the
   * direct dashboard cell boundary for every authenticated non-operator;
   * absence preserves the legacy dashboard-wide guest posture.
   */
  guestCellGrants?: Record<string, string[]>;
}

export type GuestCellGrants = Record<string, string[]>;

export type GuestCellGrantsValidation =
  | { ok: true; value: GuestCellGrants }
  | { ok: false; error: string };

/** Strict validation for the security-sensitive guest→cell map. */
export function validateGuestCellGrants(raw: unknown): GuestCellGrantsValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "auth.guestCellGrants must be an object map" };
  }
  const value: GuestCellGrants = {};
  for (const [rawSelector, rawCells] of Object.entries(raw as Record<string, unknown>)) {
    const selector = rawSelector.trim();
    if (!selector) {
      return { ok: false, error: "auth.guestCellGrants contains an empty guest selector" };
    }
    if (!Array.isArray(rawCells)) {
      return { ok: false, error: `auth.guestCellGrants.${rawSelector} must be an array` };
    }
    const cells: string[] = [];
    for (const rawCell of rawCells) {
      if (typeof rawCell !== "string" || !rawCell.trim()) {
        return { ok: false, error: `auth.guestCellGrants.${rawSelector} contains an invalid cell id` };
      }
      cells.push(rawCell.trim());
    }
    value[selector] = [...new Set(cells)];
  }
  return { ok: true, value };
}

export interface MemoryLimitsConfig {
  /** Max events stored per session (0 = unlimited). Default: 200 */
  maxEventsPerSession: number;
  /** Max chars before truncating string fields in events (0 = no truncation). Default: 4000 */
  maxStringFieldSize: number;
  /** Max bytes in browser WebSocket send buffer before dropping messages (0 = no limit). Default: 4194304 (4MB) */
  maxWsBufferBytes: number;
  /** Node.js --max-old-space-size in MB (0 = Node default, typically ~4 GB). Default: 0 */
  maxHeapSizeMb: number;
}

export const DEFAULT_MEMORY_LIMITS: MemoryLimitsConfig = {
  maxEventsPerSession: 5000,
  maxStringFieldSize: 4000,
  maxWsBufferBytes: 4 * 1024 * 1024,
  maxHeapSizeMb: 0,
};

export interface OpenSpecPollConfig {
  /** Poll interval in seconds. Default 30. Clamped to [5, 3600]. */
  pollIntervalSeconds: number;
  /** Max concurrent `openspec` CLI invocations across all dirs. Default 3. Clamped to [1, 16]. */
  maxConcurrentSpawns: number;
  /** `"mtime"` skips re-polling unchanged changes; `"always"` polls unconditionally. Default `"mtime"`. */
  changeDetection: "mtime" | "always";
  /** Max per-directory phase jitter in seconds. 0 disables jitter. Default 5. Clamped to [0, 60]. */
  jitterSeconds: number;
}

export const DEFAULT_OPENSPEC_POLL: OpenSpecPollConfig = {
  pollIntervalSeconds: 30,
  maxConcurrentSpawns: 3,
  changeDetection: "mtime",
  jitterSeconds: 5,
};

export interface EditorConfig {
  /** Override path to code-server binary */
  binary?: string;
  /** Minutes before idle instance is killed (default: 10) */
  idleTimeoutMinutes: number;
  /** Maximum concurrent code-server instances (default: 3) */
  maxInstances: number;
}

export const DEFAULT_EDITOR_CONFIG: EditorConfig = {
  idleTimeoutMinutes: 10,
  maxInstances: 3,
};

export interface KnownServer {
  host: string;
  port: number;
  label?: string;
  addedAt: string; // ISO timestamp
}

// ── Model Proxy ─────────────────────────────────────────────────────

export interface ProxyApiKey {
  id: string;
  label: string;
  createdBy?: string;
  scopes?: string[];
  createdAt: number;
  lastUsedAt?: number;
  expiresAt?: number;
  revokedAt?: number;
  hash: string;
}

export interface ModelProxyConfig {
  /** Master toggle. Default true. */
  enabled: boolean;
  /** Default model for requests that omit it. */
  defaultModel?: string;
  /** Optional second port for /v1/* routes (for SDKs that hardcode path-prefix-less base URLs). */
  secondPort?: number;
  /** Server-wide max concurrent streams. Default 16. Clamped [1, 256]. */
  maxConcurrentStreams: number;
  /** Per-API-key max concurrent streams. Default 4. Clamped [1, 64]. */
  perKeyConcurrentStreams: number;
  /** Per-provider concurrency caps. Keys are provider names. */
  perProviderCaps?: Record<string, number>;
  /** Enable JSONL request logging. Default false. */
  logRequests: boolean;
  /** Proxy API keys (stored hashed). */
  apiKeys: ProxyApiKey[];
}

export const DEFAULT_MODEL_PROXY: ModelProxyConfig = {
  enabled: true,
  maxConcurrentStreams: 16,
  perKeyConcurrentStreams: 4,
  logRequests: false,
  apiKeys: [],
};

/**
 * Push notification configuration.
 * See change: add-server-push-notifications.
 */
export interface PushWebPushConfig {
  /** Email address used as VAPID `mailto:` subject. Required by spec. */
  contactEmail: string;
}

export interface PushConfig {
  /** Master toggle. Default false — user must opt in. */
  enabled: boolean;
  /** Coalescing window in ms. Clamped [5_000, 300_000]. Default 30_000. */
  coalesceWindowMs: number;
  /** Web Push transport settings (VAPID). */
  webPush?: PushWebPushConfig;
  /** Global push event defaults (errors, ask_user). Completion is per-session only. */
  defaults: PushDefaults;
  /** Runtime errors surfaced in /api/health. Not persisted. */
  errors?: string[];
}

export interface PushDefaults {
  notifyErrors: boolean;
  notifyAskUser: boolean;
  /** Completion push default: off (no push), on (always push), auto (agent decides). */
  notifyCompletion: "off" | "on" | "auto";
}

export const DEFAULT_PUSH_CONFIG: PushConfig = {
  enabled: false,
  coalesceWindowMs: 30_000,
  defaults: { notifyErrors: true, notifyAskUser: true, notifyCompletion: "off" as const },
};

/**
 * Plugin-specific config namespace.
 * Lives at ~/.pi/dashboard/config.json#plugins.<id>.*
 */
export type PluginsConfig = Record<string, Record<string, unknown>>;

export interface DashboardConfig {
  port: number;
  piPort: number;
  autoStart: boolean;
  autoShutdown: boolean;
  shutdownIdleSeconds: number;
  spawnStrategy: SpawnStrategy;
  tunnel: { enabled: boolean; reservedToken?: string };
  devBuildOnReload: boolean;
  auth?: AuthConfig;
  defaultModel: string;
  memoryLimits: MemoryLimitsConfig;
  editor: EditorConfig;
  /** OpenSpec background polling behavior (interval, concurrency, change detection, jitter) */
  openspec: OpenSpecPollConfig;
  /**
   * Timeout for ask_user prompts in seconds.
   * Default: 300 (5 minutes).
   * Set to -1 (or any value <= 0) for no timeout (waits indefinitely).
   * If the key is absent from config.json the default of 300 s applies.
   */
  askUserPromptTimeoutSeconds: number;
  /**
   * Cross-session operator-input surface (NOS cell cross-session-askuser-surface).
   * When enabled, pending ask_user / ctx.ui capsules are broadcast cross-session so
   * the operator sees them regardless of which session is focused. OFF by default;
   * enabling is a separate operator-named-permission gate.
   */
  crossSessionOperatorInput: { enabled: boolean };
  /** Networks trusted for full access without authentication (CIDR, wildcard, exact IP) */
  trustedNetworks: string[];
  /** Merged trustedNetworks + auth.bypassHosts (deduplicated). Computed at load time. */
  resolvedTrustedNetworks: string[];
  /** CORS allowed origins for cross-origin client hosting */
  cors: CorsConfig;
  /** Last-used server address (host:port) for reconnection */
  lastServer?: string;
  /** Whether the server was launched by the Electron app */
  electronMode: boolean;
  /**
   * Policy applied when the bridge reattaches after a dashboard restart.
   * See {@link ReattachPlacement}. Default `"always"`.
   * See change: reattach-move-to-front.
   */
  reattachPlacement: ReattachPlacement;
  /** Persisted list of known remote servers */
  knownServers: KnownServer[];
  /**
   * How long (ms) to wait for a spawned pi session to send `session_register`
   * before emitting a timeout warning. Default 30000 (30s). Clamped [5000, 120000].
   * See change: spawn-failure-diagnostics.
   */
  spawnRegisterTimeoutMs: number;
  /**
   * Per-plugin config namespaces. Reserved top-level key.
   * Each plugin's config lives at plugins.<id>.*
   * Plugin-shaped legacy top-level keys (e.g. openspec.*) stay at top-level
   * until each extract-*-as-plugin change migrates them.
   */
  plugins: PluginsConfig;
  /** Model proxy configuration (OpenAI/Anthropic-compatible /v1/* endpoints). */
  modelProxy: ModelProxyConfig;
  /**
   * Cadence (ms) for the Component-A display-resurrection sweep. Default
   * {@link DEFAULT_RESURRECTION_SWEEP_MS} (20000). `0` disables the periodic
   * sweep. See session-resurrection design-pass §3-A.
   */
  resurrectionSweepMs: number;
  /**
   * Push notification configuration.
   * Default: {enabled: false, coalesceWindowMs: 30_000}.
   * See change: add-server-push-notifications.
   */
  push: PushConfig;
}

export interface CorsConfig {
  /** Additional origins allowed for cross-origin requests */
  allowedOrigins: string[];
}

const VALID_SPAWN_STRATEGIES: SpawnStrategy[] = ["tmux", "headless"];

/** Default ask_user prompt timeout: 300 seconds (5 minutes). */
export const DEFAULT_ASK_USER_PROMPT_TIMEOUT_SECONDS = 300;

/** Default + clamp for spawnRegisterTimeoutMs. See change: spawn-failure-diagnostics. */
export const DEFAULT_SPAWN_REGISTER_TIMEOUT_MS = 30000;
export function clampSpawnRegisterTimeoutMs(v: unknown): number {
  if (typeof v !== "number" || isNaN(v)) return DEFAULT_SPAWN_REGISTER_TIMEOUT_MS;
  return Math.max(5000, Math.min(120000, v));
}

const DEFAULTS: DashboardConfig = {
  plugins: {},
  modelProxy: { ...DEFAULT_MODEL_PROXY },
  port: 8000,
  piPort: 9999,
  autoStart: true,
  autoShutdown: false,
  shutdownIdleSeconds: 300,
  spawnStrategy: "headless",
  tunnel: { enabled: true },
  devBuildOnReload: false,
  defaultModel: "",
  memoryLimits: { ...DEFAULT_MEMORY_LIMITS },
  editor: { ...DEFAULT_EDITOR_CONFIG },
  openspec: { ...DEFAULT_OPENSPEC_POLL },
  trustedNetworks: [],
  resolvedTrustedNetworks: [],
  cors: { allowedOrigins: [] },
  electronMode: false,
  knownServers: [],
  askUserPromptTimeoutSeconds: DEFAULT_ASK_USER_PROMPT_TIMEOUT_SECONDS,
  crossSessionOperatorInput: { enabled: false },
  reattachPlacement: DEFAULT_REATTACH_PLACEMENT,
  spawnRegisterTimeoutMs: 30000,
  push: { ...DEFAULT_PUSH_CONFIG },
  resurrectionSweepMs: DEFAULT_RESURRECTION_SWEEP_MS,
};

/**
 * Parse and validate the auth config section.
 *
 * Returns undefined ONLY when nothing auth-relevant is configured — that is,
 * when none of `providers`, `bypassHosts`, `bypassUrls`, or the multi-operator
 * `requireBrowserAuth` flag has any content.
 *
 * When providers is empty but bypassHosts or bypassUrls is populated, this
 * function returns a valid AuthConfig with an empty providers map. The auth
 * plugin already no-ops in that case (providerRegistry.size === 0 → skip
 * OAuth route + cookie plugin registration), so no OAuth flow activates
 * accidentally. But returning an object here lets the caller populate
 * resolvedTrustedNetworks from auth.bypassHosts — which is the entire
 * point of allowing this shape. Before this change, parseAuthConfig
 * returned undefined on empty-providers, which nuked auth.bypassHosts
 * before the resolvedTrustedNetworks merge could read it, and users
 * without OAuth lost remote network access after the UI started writing
 * to auth.bypassHosts. See openspec/changes/fix-trusted-networks-no-oauth.
 *
 * `requireBrowserAuth:true` is ALSO auth-relevant (Build 0 multi-operator
 * gate). It must keep the auth block alive even with no providers/bypass —
 * otherwise `{"auth":{"requireBrowserAuth":true}}` (or secret-only) would be
 * dropped to `undefined` here and the server would silently run single-op
 * (fail-OPEN while the operator believes multi-op is ON). This is the same
 * parser-drop trap the two-eyes teardown flagged for `auth.secret` (M1).
 */
function parseAuthConfig(raw: any): AuthConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const providers = raw.providers;
  const hasProviders =
    providers && typeof providers === "object" && Object.keys(providers).length > 0;
  const hasHosts = Array.isArray(raw.bypassHosts) && raw.bypassHosts.length > 0;
  const hasUrls = Array.isArray(raw.bypassUrls) && raw.bypassUrls.length > 0;
  // Build 0: the multi-operator gate flag is auth-relevant on its own.
  const hasBrowserAuthGate = raw.requireBrowserAuth === true;
  // Presence (including an empty map) activates the cell boundary and must keep
  // the auth block alive. Integrity/coupling is enforced before parsing.
  const hasGuestCellGrants = raw.guestCellGrants !== undefined;
  const guestCellGrantsValidation = hasGuestCellGrants
    ? validateGuestCellGrants(raw.guestCellGrants)
    : undefined;

  // H-M1 / Fix 2 (dl-5775 canon): a security flag PRESENT but NOT a strict
  // boolean (e.g. "true", 1, [], {}) is a SILENT-misconfig hazard. The LOUD
  // diagnostic + fail-CLOSED-REFUSE (at startup) is now centralized in
  // `enforceSecurityFlagIntegrity` (called from `loadConfig` before parse), so
  // it fires once with startup/runtime scope. Here we keep the strict `=== true`
  // parse (loose truthy is WORSE — it would flip a hand-typed "false"/0 toward
  // ON = lockout): a non-boolean resolves the flag UNSET (fail CLOSED to
  // single-op). No warn here (would double-log with the integrity check).

  if (!hasProviders && !hasHosts && !hasUrls && !hasBrowserAuthGate && !hasGuestCellGrants) return undefined;

  // Validate each provider has at least clientId and clientSecret.
  // validProviders may end up empty when providers is {} or all entries
  // are malformed — that's fine, the caller tolerates it as long as
  // bypassHosts or bypassUrls carries the auth-relevant content.
  const validProviders: Record<string, AuthProviderConfig> = {};
  if (hasProviders) {
    for (const [key, value] of Object.entries(providers as Record<string, unknown>)) {
      const p = value as any;
      if (p && typeof p === "object" && p.clientId && p.clientSecret) {
        validProviders[key] = {
          clientId: p.clientId,
          clientSecret: p.clientSecret,
          ...(p.issuerUrl ? { issuerUrl: p.issuerUrl } : {}),
          ...(p.name ? { name: p.name } : {}),
        };
      }
    }
  }

  // If providers was declared but all entries are malformed AND there is no
  // bypass content AND the multi-operator gate is not set, fall back to
  // undefined — same "nothing auth-relevant" rule as the top-level gate.
  if (Object.keys(validProviders).length === 0 && !hasHosts && !hasUrls && !hasBrowserAuthGate && !hasGuestCellGrants) {
    return undefined;
  }

  return {
    secret: raw.secret ?? "",
    providers: validProviders,
    ...(typeof raw.publicUrl === "string" && raw.publicUrl.trim() ? { publicUrl: raw.publicUrl.trim() } : {}),
    ...(Array.isArray(raw.allowedUsers) ? { allowedUsers: raw.allowedUsers } : Array.isArray(raw.allowedEmails) ? { allowedUsers: raw.allowedEmails } : {}),
    bypassUrls: Array.isArray(raw.bypassUrls) ? raw.bypassUrls.filter((u: unknown) => typeof u === "string") : [],
    bypassHosts: Array.isArray(raw.bypassHosts) ? raw.bypassHosts.filter((u: unknown) => typeof u === "string") : [],
    ...(typeof raw.admin === "string" && raw.admin ? { admin: raw.admin } : {}),
    // Build 0 multi-operator gate. Only honored as `true` when explicitly set.
    // Absent / non-boolean → false → single-operator behavior unchanged.
    ...(raw.requireBrowserAuth === true ? { requireBrowserAuth: true } : {}),
    // Build 1b operator-identity source. Filter to non-empty strings; omit when
    // empty so operator-only enforcement stays INERT (mandate 4c). The VALUES
    // are configured at Build 1 (op-2 admission); Build 1b ships the mechanism.
    ...(Array.isArray(raw.operatorUsers)
      ? { operatorUsers: raw.operatorUsers.filter((u: unknown) => typeof u === "string" && u.trim().length > 0) }
      : {}),
    ...(guestCellGrantsValidation?.ok
      ? { guestCellGrants: guestCellGrantsValidation.value }
      : {}),
  };
}

function parseEditorConfig(raw: any): EditorConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_EDITOR_CONFIG };
  return {
    ...(typeof raw.binary === "string" ? { binary: raw.binary } : {}),
    idleTimeoutMinutes: typeof raw.idleTimeoutMinutes === "number" ? raw.idleTimeoutMinutes : DEFAULT_EDITOR_CONFIG.idleTimeoutMinutes,
    maxInstances: typeof raw.maxInstances === "number" ? raw.maxInstances : DEFAULT_EDITOR_CONFIG.maxInstances,
  };
}

function clampNumber(raw: any, fallback: number, min: number, max: number): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function parseOpenSpecPollConfig(raw: any): OpenSpecPollConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_OPENSPEC_POLL };
  const changeDetection =
    raw.changeDetection === "always" || raw.changeDetection === "mtime"
      ? raw.changeDetection
      : DEFAULT_OPENSPEC_POLL.changeDetection;
  return {
    pollIntervalSeconds: clampNumber(raw.pollIntervalSeconds, DEFAULT_OPENSPEC_POLL.pollIntervalSeconds, 5, 3600),
    maxConcurrentSpawns: clampNumber(raw.maxConcurrentSpawns, DEFAULT_OPENSPEC_POLL.maxConcurrentSpawns, 1, 16),
    changeDetection,
    jitterSeconds: clampNumber(raw.jitterSeconds, DEFAULT_OPENSPEC_POLL.jitterSeconds, 0, 60),
  };
}

function parseMemoryLimits(raw: any): MemoryLimitsConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_MEMORY_LIMITS };
  return {
    maxEventsPerSession: typeof raw.maxEventsPerSession === "number" ? raw.maxEventsPerSession : DEFAULT_MEMORY_LIMITS.maxEventsPerSession,
    maxStringFieldSize: typeof raw.maxStringFieldSize === "number" ? raw.maxStringFieldSize : DEFAULT_MEMORY_LIMITS.maxStringFieldSize,
    maxWsBufferBytes: typeof raw.maxWsBufferBytes === "number" ? raw.maxWsBufferBytes : DEFAULT_MEMORY_LIMITS.maxWsBufferBytes,
    maxHeapSizeMb: typeof raw.maxHeapSizeMb === "number" ? raw.maxHeapSizeMb : DEFAULT_MEMORY_LIMITS.maxHeapSizeMb,
  };
}

/**
 * Parse and validate the push notification config block.
 *
 * Normalizes: no block → `{enabled: false}`. When `enabled: true`
 * and `webPush.contactEmail` is missing, populates `errors` array.
 * Coalesce window clamped [5_000, 300_000], default 30_000.
 *
 * See change: add-server-push-notifications.
 */
export function parsePushConfig(raw: any): PushConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PUSH_CONFIG };
  const enabled = raw.enabled === true;
  const coalesceWindowMs = clampNumber(raw.coalesceWindowMs, DEFAULT_PUSH_CONFIG.coalesceWindowMs, 5_000, 300_000);

  const defaultsRaw = raw.defaults;
  const defaults: PushDefaults = {
    notifyErrors: defaultsRaw && typeof defaultsRaw.notifyErrors === "boolean" ? defaultsRaw.notifyErrors : true,
    notifyAskUser: defaultsRaw && typeof defaultsRaw.notifyAskUser === "boolean" ? defaultsRaw.notifyAskUser : true,
    notifyCompletion: defaultsRaw && ["off", "on", "auto"].includes(defaultsRaw.notifyCompletion) ? defaultsRaw.notifyCompletion : "off",
  };

  const webPushRaw = raw.webPush;
  const webPush: PushWebPushConfig | undefined =
    webPushRaw && typeof webPushRaw === "object" && typeof webPushRaw.contactEmail === "string"
      ? { contactEmail: webPushRaw.contactEmail }
      : undefined;

  const result: PushConfig = { enabled, coalesceWindowMs, defaults };
  if (webPush) result.webPush = webPush;

  // When enabled but no contactEmail, surface error
  if (enabled && !webPush) {
    result.errors = ["missing contactEmail"];
  }

  return result;
}

function parsePluginsConfig(raw: unknown): PluginsConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: PluginsConfig = {};
  for (const [id, val] of Object.entries(raw as Record<string, unknown>)) {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      result[id] = val as Record<string, unknown>;
    }
  }
  return result;
}

/**
 * Get the plugins config block from a loaded DashboardConfig.
 * Provides typed access to plugins.<id>.* namespaces.
 */
export function getPluginsConfig(config: DashboardConfig): PluginsConfig {
  return config.plugins ?? {};
}

/**
 * Get a single plugin's config from a loaded DashboardConfig.
 * Returns {} if the plugin has no stored config.
 */
/**
 * Build Node.js --max-old-space-size args from config, or empty if disabled (0).
 * Returns an array suitable for `nodeArgs` in `spawnNodeScript`.
 */
export function buildMaxHeapArgs(limits: MemoryLimitsConfig): string[] {
  if (limits.maxHeapSizeMb > 0) {
    return [`--max-old-space-size=${limits.maxHeapSizeMb}`];
  }
  return [];
}

export function getPluginConfig(
  config: DashboardConfig,
  pluginId: string,
): Record<string, unknown> {
  return config.plugins?.[pluginId] ?? {};
}

export function parseModelProxyConfig(raw: any): ModelProxyConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_MODEL_PROXY };

  const apiKeys: ProxyApiKey[] = [];
  if (Array.isArray(raw.apiKeys)) {
    for (const entry of raw.apiKeys) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof entry.id === "string" &&
        typeof entry.label === "string" &&
        typeof entry.hash === "string" &&
        typeof entry.createdAt === "number"
      ) {
        apiKeys.push({
          id: entry.id,
          label: entry.label,
          hash: entry.hash,
          createdAt: entry.createdAt,
          ...(typeof entry.createdBy === "string" ? { createdBy: entry.createdBy } : {}),
          ...(Array.isArray(entry.scopes) ? { scopes: entry.scopes.filter((s: unknown) => typeof s === "string") } : {}),
          ...(typeof entry.lastUsedAt === "number" ? { lastUsedAt: entry.lastUsedAt } : {}),
          ...(typeof entry.expiresAt === "number" ? { expiresAt: entry.expiresAt } : {}),
          ...(typeof entry.revokedAt === "number" ? { revokedAt: entry.revokedAt } : {}),
        });
      }
    }
  }

  let perProviderCaps: Record<string, number> | undefined;
  if (raw.perProviderCaps && typeof raw.perProviderCaps === "object" && !Array.isArray(raw.perProviderCaps)) {
    perProviderCaps = {};
    for (const [key, val] of Object.entries(raw.perProviderCaps)) {
      if (typeof val === "number" && Number.isFinite(val) && val >= 1) {
        perProviderCaps[key] = Math.min(val, 256);
      }
    }
  }

  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_MODEL_PROXY.enabled,
    ...(typeof raw.defaultModel === "string" ? { defaultModel: raw.defaultModel } : {}),
    ...(typeof raw.secondPort === "number" && raw.secondPort >= 1024 && raw.secondPort <= 65535
      ? { secondPort: raw.secondPort }
      : {}),
    maxConcurrentStreams: clampNumber(
      raw.maxConcurrentStreams,
      DEFAULT_MODEL_PROXY.maxConcurrentStreams,
      1,
      256,
    ),
    perKeyConcurrentStreams: clampNumber(
      raw.perKeyConcurrentStreams,
      DEFAULT_MODEL_PROXY.perKeyConcurrentStreams,
      1,
      64,
    ),
    ...(perProviderCaps ? { perProviderCaps } : {}),
    logRequests:
      typeof raw.logRequests === "boolean" ? raw.logRequests : DEFAULT_MODEL_PROXY.logRequests,
    apiKeys,
  };
}

function parseKnownServers(raw: any): KnownServer[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry: any) => entry && typeof entry === "object" && typeof entry.host === "string" && typeof entry.port === "number")
    .map((entry: any) => ({
      host: entry.host,
      port: entry.port,
      ...(typeof entry.label === "string" ? { label: entry.label } : {}),
      addedAt: typeof entry.addedAt === "string" ? entry.addedAt : new Date().toISOString(),
    }));
}

function parseTrustedNetworks(raw: any): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry: unknown) => typeof entry === "string" && entry.length > 0);
}

/**
 * A present-but-malformed / misplaced browser-auth security flag (Build-1b
 * PUSHBACK-1 Fix 2 + FOLD-C). The operator clearly INTENDED to configure the
 * multi-operator gate (`requireBrowserAuth` is textually present) but wrote it
 * in a shape the loader will not honor — so honoring the flag OFF-and-open would
 * be a SILENT-misconfig (operator believes the gate is ON; the server runs it
 * OFF, anonymous access open). This is the dl-5775 canon.
 *
 * `code` discriminates the two shapes:
 *   - `malformed`  — `auth.requireBrowserAuth` present but NOT a strict boolean
 *     (e.g. `"true"`, `1`, `[]`, `{}`). FOLD-C(i).
 *   - `misplaced`  — `requireBrowserAuth` set at the TOP LEVEL (not under
 *     `auth`), where the loader never reads it (`config.ts` parses `parsed.auth`
 *     only). Fix 2 (the silently-ignored top-level placement).
 */
export class SecurityFlagConfigError extends Error {
  readonly code:
    | "malformed"
    | "misplaced"
    | "malformed-operator-users"
    | "malformed-cell-grants"
    | "cell-grants-coupling";
  constructor(
    code:
      | "malformed"
      | "misplaced"
      | "malformed-operator-users"
      | "malformed-cell-grants"
      | "cell-grants-coupling",
    message: string,
  ) {
    super(message);
    this.name = "SecurityFlagConfigError";
    this.code = code;
  }
}

/** Options for {@link loadConfig}. */
export interface LoadConfigOptions {
  /**
   * STARTUP scope (N3): when true, a present-malformed / misplaced browser-auth
   * security flag → THROW (fail-CLOSED, refuse startup) rather than warn. Set
   * ONLY by the server-boot caller (`buildConfig` in cli.ts) so a runtime
   * hand-edit read by a background caller does NOT throw (avoids the
   * availability regression FOLD-C(iv) names). Default false → warn LOUD and
   * degrade to the single-op baseline (product-safe: no NEW anonymous-op-2
   * window — the residual is the single-op posture).
   */
  startup?: boolean;
}

/**
 * Enforce browser-auth security-flag integrity on the RAW parsed config
 * (Build-1b PUSHBACK-1 Fix 2 + FOLD-C). Keyed on security-flag-INTENT-present
 * (the `requireBrowserAuth` text present AND in a shape the loader won't honor),
 * NOT on any-malformed-config — so an unrelated typo never trips it (FOLD-C(iii)
 * lenient-on-typo). At STARTUP a violation THROWS (fail-CLOSED-REFUSE); at
 * runtime it warns LOUD and returns (degrade to single-op baseline).
 *
 * Also emits the FOLD-C(ii) coupling-guard: `operatorUsers` present but
 * `requireBrowserAuth` absent — a LOUD warn (operator wired operator identities
 * but no gate to enforce them), never a throw (product-safe).
 */
/**
 * True when `auth.operatorUsers` is PRESENT but yields ZERO usable operator
 * identities (a scalar, a non-string element, or an all-whitespace string).
 * ABSENT (`undefined`) and EMPTY (`[]`) return false — both are INTENTIONAL
 * (flag-ON-without-operator = op-1 retains full control), so only the fail-open-
 * shaped malformed case is flagged. PUSHBACK-4 m-1 (the dl-5761 window).
 */
function operatorUsersPresentButUnusable(raw: unknown): boolean {
  if (raw === undefined) return false; // absent → intentional (no operator admitted)
  if (Array.isArray(raw) && raw.length === 0) return false; // empty [] → intentional inert
  const usable = Array.isArray(raw)
    ? raw.filter((u) => typeof u === "string" && u.trim().length > 0).length
    : 0; // scalar / object → zero usable identities
  return usable === 0;
}

function enforceSecurityFlagIntegrity(parsed: any, startup: boolean): void {
  const fail = (err: SecurityFlagConfigError) => {
    if (startup) throw err;
    console.error(
      `[dashboard] ${err.message} Running SINGLE-OPERATOR (multi-operator gate ` +
        `OFF) — fix the config and restart to enable the gate.`,
    );
  };

  // ── misplaced: top-level requireBrowserAuth (Fix 2) ──────────────────────
  // The loader reads `parsed.auth.requireBrowserAuth` only; a top-level
  // `{"requireBrowserAuth":true,...}` is silently ignored. Refuse it loud (the
  // operator plainly intended the gate). PUSHBACK-2 FIX-P2-6 (m7): narrow the
  // refusal to a NON-FALSE presence. A top-level `false` is zero-security-delta
  // (Build-0 booted single-op-open with the flag absent = the same posture), so
  // refusing it is a pure AVAILABILITY regression, not a silent-open guard. A
  // top-level truthy `true`/`"true"`/`1` IS a misconfigured security directive
  // (the operator intended the gate ON but it is ignored) → still refused.
  if (
    parsed &&
    typeof parsed === "object" &&
    parsed.requireBrowserAuth !== undefined &&
    parsed.requireBrowserAuth !== false
  ) {
    fail(
      new SecurityFlagConfigError(
        "misplaced",
        `SECURITY CONFIG MISPLACED: requireBrowserAuth is set at the TOP LEVEL ` +
          `(${JSON.stringify(parsed.requireBrowserAuth)}) but the loader only reads ` +
          `auth.requireBrowserAuth — the flag is IGNORED there. Move it under "auth".`,
      ),
    );
  }

  // ── malformed: non-boolean auth.requireBrowserAuth (FOLD-C(i)) ───────────
  const auth = parsed?.auth;
  if (
    auth &&
    typeof auth === "object" &&
    auth.requireBrowserAuth !== undefined &&
    auth.requireBrowserAuth !== true &&
    auth.requireBrowserAuth !== false
  ) {
    fail(
      new SecurityFlagConfigError(
        "malformed",
        `SECURITY CONFIG MALFORMED: auth.requireBrowserAuth must be a boolean, got ` +
          `${JSON.stringify(auth.requireBrowserAuth)} (${typeof auth.requireBrowserAuth}).`,
      ),
    );
  }

  // ── FOLD-C(ii) coupling-guard: operatorUsers set, flag absent (LOUD warn) ─
  // operator identities configured but no gate to enforce them → the
  // operator-only enforcement is inert. Product-safe (single-op baseline), so a
  // warn, never a throw — but LOUD, esp. with more than one allowed user.
  if (
    auth &&
    typeof auth === "object" &&
    Array.isArray(auth.operatorUsers) &&
    auth.operatorUsers.some((u: unknown) => typeof u === "string" && u.trim().length > 0) &&
    auth.requireBrowserAuth !== true
  ) {
    const multi = Array.isArray(auth.allowedUsers) && auth.allowedUsers.length > 1;
    console.error(
      `[dashboard] SECURITY CONFIG COUPLING: auth.operatorUsers is set but ` +
        `auth.requireBrowserAuth is not true — operator-only enforcement is INERT ` +
        `(the gate is OFF, so no session-write is operator-restricted)` +
        (multi ? ` while allowedUsers lists more than one user` : ``) +
        `. Set auth.requireBrowserAuth:true to enforce operator-only actions.`,
    );
  }

  // ── malformed operatorUsers with the gate ON (PUSHBACK-4 m-1) ─────────────
  // operatorUsers PRESENT but yielding ZERO usable operators (a scalar, a non-
  // string element, or an all-whitespace string) WHILE requireBrowserAuth is ON
  // → `operatorConfigured` silently collapses to false → operator-only
  // enforcement goes INERT while the operator believes the gate is up → an
  // admitted op-2 reaches the ENTIRE operator-only surface (shutdown / kill /
  // spawn / resume / model / prompt-command host-shell) — the dl-5761 window,
  // previously with NO throw and NO warn. ASYMMETRIC to the loud
  // requireBrowserAuth guards above; close it symmetrically. An ABSENT or
  // EMPTY-`[]` operatorUsers stays INTENTIONAL (op-1 retains full control) → no
  // diagnostic (see operatorUsersPresentButUnusable). At STARTUP a violation
  // THROWS (fail-CLOSED-REFUSE); at runtime it warns LOUD and degrades.
  if (
    auth &&
    typeof auth === "object" &&
    auth.requireBrowserAuth === true &&
    operatorUsersPresentButUnusable(auth.operatorUsers)
  ) {
    fail(
      new SecurityFlagConfigError(
        "malformed-operator-users",
        `SECURITY CONFIG MALFORMED: auth.operatorUsers is set ` +
          `(${JSON.stringify(auth.operatorUsers)}) but yields ZERO usable operator ` +
          `identities while auth.requireBrowserAuth is ON — operator-only ` +
          `enforcement would be INERT (every session-write open to any admitted ` +
          `user). Provide a non-empty array of non-empty strings, or remove ` +
          `operatorUsers to intentionally run flag-ON-without-operator (op-1 ` +
          `retains full control).`,
      ),
    );
  }

  // Cell-boundary activation is security-sensitive. Presence (even `{}`) must
  // never silently degrade to phase-1 dashboard-wide access.
  if (auth && typeof auth === "object" && auth.guestCellGrants !== undefined) {
    const grants = validateGuestCellGrants(auth.guestCellGrants);
    if (!grants.ok) {
      fail(new SecurityFlagConfigError("malformed-cell-grants", grants.error));
    }
    const usableOperator = Array.isArray(auth.operatorUsers)
      && auth.operatorUsers.some((u: unknown) => typeof u === "string" && u.trim().length > 0);
    if (auth.requireBrowserAuth !== true || !usableOperator) {
      fail(
        new SecurityFlagConfigError(
          "cell-grants-coupling",
          `SECURITY CONFIG COUPLING: auth.guestCellGrants requires ` +
            `auth.requireBrowserAuth:true and at least one usable auth.operatorUsers identity.`,
        ),
      );
    }
  }
}

/**
 * Load configuration from ~/.pi/dashboard/config.json.
 * Returns defaults for missing fields, malformed JSON, or missing file.
 *
 * Security-flag integrity (Build-1b PUSHBACK-1 Fix 2 + FOLD-C): at STARTUP
 * (`opts.startup`) a present-malformed / misplaced / unparseable-with-flag
 * browser-auth config THROWS (fail-CLOSED-REFUSE); at runtime it warns LOUD and
 * degrades to the single-op baseline (no availability regression, N3).
 */
export function loadConfig(opts?: LoadConfigOptions): DashboardConfig {
  const startup = opts?.startup === true;
  const configDir = path.join(os.homedir(), ".pi", "dashboard");
  const configFile = path.join(configDir, "config.json");
  const defaults: DashboardConfig = { ...DEFAULTS };

  // Hoisted so the catch can inspect the raw text: H-M1 (Build 1b) fail
  // CLOSED + LOUD when a config carrying an auth security flag is UNPARSEABLE.
  // The legacy catch silently returned open single-op defaults — but if the
  // operator was mid-edit on the auth gate and left the JSON malformed, that
  // silent degrade is a SILENT-misconfig (operator believes multi-op ON, runs
  // single-op-open). Only escalate when the auth security flag is textually
  // present (a bare typo in an unrelated config keeps the lenient default).
  let rawText: string | undefined;
  try {
    if (!fs.existsSync(configFile)) return defaults;
    rawText = fs.readFileSync(configFile, "utf-8");
    if (!rawText.trim()) return defaults;
    const parsed = JSON.parse(rawText);

    // Fix 2 + FOLD-C: enforce security-flag integrity on the raw parsed config
    // BEFORE we build the result. At startup a present-malformed / misplaced
    // flag throws (fail-CLOSED-REFUSE); at runtime it warns + degrades.
    enforceSecurityFlagIntegrity(parsed, startup);

    const rawStrategy = parsed.spawnStrategy;
    const spawnStrategy: SpawnStrategy =
      VALID_SPAWN_STRATEGIES.includes(rawStrategy) ? rawStrategy : defaults.spawnStrategy;

    const result: DashboardConfig = {
      port: parsed.port ?? defaults.port,
      piPort: parsed.piPort ?? defaults.piPort,
      autoStart: parsed.autoStart ?? defaults.autoStart,
      autoShutdown: parsed.autoShutdown ?? defaults.autoShutdown,
      shutdownIdleSeconds: parsed.shutdownIdleSeconds ?? defaults.shutdownIdleSeconds,
      spawnStrategy,
      tunnel: {
        enabled: parsed.tunnel?.enabled ?? defaults.tunnel.enabled,
        ...(parsed.tunnel?.reservedToken ? { reservedToken: parsed.tunnel.reservedToken } : {}),
      },
      devBuildOnReload: parsed.devBuildOnReload ?? defaults.devBuildOnReload,
      defaultModel: typeof parsed.defaultModel === "string" ? parsed.defaultModel : defaults.defaultModel,
      auth: parseAuthConfig(parsed.auth),
      memoryLimits: parseMemoryLimits(parsed.memoryLimits),
      editor: parseEditorConfig(parsed.editor),
      openspec: parseOpenSpecPollConfig(parsed.openspec),
      trustedNetworks: parseTrustedNetworks(parsed.trustedNetworks),
      resolvedTrustedNetworks: [],
      cors: {
        allowedOrigins: Array.isArray(parsed.cors?.allowedOrigins)
          ? parsed.cors.allowedOrigins.filter((o: unknown) => typeof o === "string")
          : defaults.cors.allowedOrigins,
      },
      ...(typeof parsed.lastServer === "string" ? { lastServer: parsed.lastServer } : {}),
      electronMode: parsed.electronMode === true,
      knownServers: parseKnownServers(parsed.knownServers),
      reattachPlacement: parseReattachPlacement(parsed.reattachPlacement),
      plugins: parsePluginsConfig(parsed.plugins),
      askUserPromptTimeoutSeconds: typeof parsed.askUserPromptTimeoutSeconds === "number"
        ? parsed.askUserPromptTimeoutSeconds
        : defaults.askUserPromptTimeoutSeconds,
      crossSessionOperatorInput: {
        enabled: (parsed.crossSessionOperatorInput as { enabled?: unknown } | undefined)?.enabled === true,
      },
      spawnRegisterTimeoutMs: clampSpawnRegisterTimeoutMs(parsed.spawnRegisterTimeoutMs),
      modelProxy: parseModelProxyConfig(parsed.modelProxy),
      push: parsePushConfig(parsed.push),
      // `0` disables the sweep; any other non-negative number is honored; a
      // missing / malformed value falls back to the 20s default.
      resurrectionSweepMs:
        typeof parsed.resurrectionSweepMs === "number" && Number.isFinite(parsed.resurrectionSweepMs) && parsed.resurrectionSweepMs >= 0
          ? parsed.resurrectionSweepMs
          : DEFAULT_RESURRECTION_SWEEP_MS,
    };

    // Compute resolvedTrustedNetworks: merge trustedNetworks + auth.bypassHosts
    const merged = new Set(result.trustedNetworks);
    if (result.auth?.bypassHosts) {
      for (const h of result.auth.bypassHosts) merged.add(h);
    }
    result.resolvedTrustedNetworks = Array.from(merged);
    return result;
  } catch (err) {
    // A present-malformed / misplaced security flag threw from
    // enforceSecurityFlagIntegrity (startup scope) — re-throw it UNCHANGED so it
    // is not re-wrapped as UNPARSEABLE (the JSON parsed fine; the flag shape is
    // the problem). Fix 2 + FOLD-C.
    if (err instanceof SecurityFlagConfigError) throw err;

    // H-M1 fail CLOSED + LOUD: an UNPARSEABLE config that textually carries the
    // browser-auth security flag is refused — never silently degraded to open
    // single-op defaults. A mid-edit malformed auth gate must not boot the
    // operator into single-op-open while they believe multi-op is ON.
    //
    // N3 (FOLD-C(iv)): SCOPE the throw to STARTUP. A runtime hand-edit read by a
    // background caller (the ~25 runtime loadConfig callers) must NOT throw — an
    // availability regression. At runtime we warn LOUD + degrade to defaults.
    // A malformed config with NO auth security flag keeps the lenient default
    // (return defaults) so unrelated typos don't brick an already-open server
    // (FOLD-C(iii) lenient-on-typo — keyed on the flag being present as a JSON
    // KEY). PUSHBACK-2 FIX-P2-6 (n2): match the `requireBrowserAuth` KEY shape
    // (the name followed by `:`), NOT a bare substring anywhere — a bare
    // `/requireBrowserAuth/.test(rawText)` false-matches an incidental occurrence
    // (an `allowedUsers` email `x@requireBrowserAuth.example`, a string value, a
    // `//` comment) and bricks boot on a config where the flag is genuinely unset.
    //
    // PUSHBACK-3 FIX-P3-5 (dual-review MINOR-2): match the key REGARDLESS OF QUOTING,
    // case-insensitively. An operator hand-editing `config.json` who drops or
    // single-quotes the key quotes (`{auth:{requireBrowserAuth:true}}` — a JS
    // habit) makes JSON.parse throw; the OLD `/"requireBrowserAuth"\s*:/` demanded
    // a DOUBLE-quoted key, so the regex MISSED it → the catch returned open
    // single-op defaults with NOT EVEN the loud warn (a SILENT single-op-open on a
    // config the operator INTENDED multi-op ON). `["']?` around the name accepts
    // double / single / unquoted; `\s*:` pins it to a key-with-colon (still not an
    // email — `…requireBrowserAuth.example` has no colon after the token). The
    // `["']?` AFTER the name also handles the double-quoted `"requireBrowserAuth":`
    // form (the closing quote sits between the name and the colon).
    const securityKey = rawText?.match(/["']?(requireBrowserAuth|guestCellGrants)["']?\s*:/i)?.[1];
    if (rawText !== undefined && securityKey) {
      const msg =
        `[dashboard] SECURITY CONFIG UNPARSEABLE: ${configFile} carries auth.${securityKey} ` +
        `but is not valid JSON (${err instanceof Error ? err.message : String(err)}). ` +
        `Refusing to start with silent single-operator defaults — fix the JSON and restart.`;
      if (startup) throw new Error(msg);
      console.error(msg + ` (runtime read — degrading to single-op defaults; a restart would refuse.)`);
    }
    return defaults;
  }
}

/**
 * Create ~/.pi/dashboard/config.json with defaults if it doesn't exist.
 * Creates the directory recursively if needed.
 */
export function ensureConfig(): void {
  const configDir = path.join(os.homedir(), ".pi", "dashboard");
  const configFile = path.join(configDir, "config.json");

  if (fs.existsSync(configFile)) return;

  fs.mkdirSync(configDir, { recursive: true });

  const defaults = {
    port: DEFAULTS.port,
    piPort: DEFAULTS.piPort,
    autoStart: DEFAULTS.autoStart,
    autoShutdown: DEFAULTS.autoShutdown,
    shutdownIdleSeconds: DEFAULTS.shutdownIdleSeconds,
    spawnStrategy: DEFAULTS.spawnStrategy,
    tunnel: DEFAULTS.tunnel,
    devBuildOnReload: DEFAULTS.devBuildOnReload,
  };

  fs.writeFileSync(configFile, JSON.stringify(defaults, null, 2) + "\n");
}
