/**
 * Config REST API helpers: read, write, redact secrets, runtime reload.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadConfig,
  validateGuestCellGrants,
  type DashboardConfig,
  type AuthConfig,
} from "@blackbelt-technology/pi-dashboard-shared/config.js";
import { refreshModelRegistry } from "./model-proxy/registry-singleton.js";

const REDACTED = "***";

/**
 * Return the current config with secrets redacted.
 */
function getConfigPaths() {
  const dir = path.join(os.homedir(), ".pi", "dashboard");
  return { dir, file: path.join(dir, "config.json") };
}

export function readConfigRedacted(): DashboardConfig {
  const config = loadConfig();
  if (config.auth) {
    config.auth = redactAuthSecrets(config.auth);
  }
  return config;
}

function redactAuthSecrets(auth: AuthConfig): AuthConfig {
  const redacted: AuthConfig = {
    ...auth,
    secret: auth.secret ? REDACTED : "",
    providers: {},
  };
  for (const [key, provider] of Object.entries(auth.providers)) {
    redacted.providers[key] = {
      ...provider,
      clientSecret: REDACTED,
    };
  }
  return redacted;
}

/**
 * Fields that require a server restart to take effect.
 */
const RESTART_FIELDS = new Set(["port", "piPort"]);

export interface WriteConfigResult {
  success: boolean;
  restartRequired: boolean;
  error?: string;
  /**
   * True when the failure is a client-side VALIDATION error (a rejected write —
   * e.g. a non-boolean `requireBrowserAuth`), distinct from a genuine
   * disk/serialize failure. FOLD-E N1: the route keys its 400-vs-500 on this
   * STRUCTURED flag, not a brittle English-substring match on `error`.
   */
  validationError?: boolean;
}

/**
 * Merge partial config into existing, preserving redacted secrets, write to disk.
 * Returns whether a restart is needed.
 */
export function writeConfigPartial(partial: Record<string, any>): WriteConfigResult {
  const { dir, file } = getConfigPaths();
  try {
    // Read raw file to preserve unknown fields
    let existing: Record<string, any> = {};
    try {
      const raw = fs.readFileSync(file, "utf-8");
      existing = JSON.parse(raw);
    } catch { /* start fresh */ }

    // Check if restart-requiring fields changed
    let restartRequired = false;
    for (const field of RESTART_FIELDS) {
      if (field in partial && partial[field] !== existing[field]) {
        restartRequired = true;
      }
    }

    // Deep merge auth section, preserving redacted secrets
    if (partial.auth) {
      const existingAuth = existing.auth || {};
      const mergedAuth: any = { ...existingAuth };

      // Preserve secret if redacted
      if (partial.auth.secret === REDACTED || !partial.auth.secret) {
        mergedAuth.secret = existingAuth.secret;
      } else {
        mergedAuth.secret = partial.auth.secret;
      }

      // Merge providers, preserving redacted clientSecrets
      if (partial.auth.providers) {
        mergedAuth.providers = { ...existingAuth.providers };
        for (const [key, provider] of Object.entries(partial.auth.providers) as [string, any][]) {
          const existingProvider = existingAuth.providers?.[key] || {};
          mergedAuth.providers[key] = { ...existingProvider, ...provider };
          if (provider.clientSecret === REDACTED) {
            mergedAuth.providers[key].clientSecret = existingProvider.clientSecret || "";
          }
        }
      }

      if (partial.auth.allowedUsers !== undefined) {
        mergedAuth.allowedUsers = partial.auth.allowedUsers;
      }

      // Build 1b PUSHBACK-1 Fix 3: persist operatorUsers through the config write
      // path. Without this branch `writeConfigPartial({auth:{operatorUsers:[…]}})`
      // returned success:true but DROPPED the value — so if Build 1 sets the
      // operator identity via the config API/UI it never persists → operator-only
      // enforcement stays INERT (op-2 silently gets operator-only actions, the
      // exact dl-5761 hazard). `!== undefined` (not truthiness) lets an empty
      // array clear all entries; omitting the key preserves the existing value
      // (carried by the `{ ...existingAuth }` seed above).
      if (partial.auth.operatorUsers !== undefined) {
        // PUSHBACK-2 FIX-P2-3 (MAJOR-1): an operatorUsers change is
        // RESTART-REQUIRED. The live gates freeze operatorUsers at startup
        // (server.ts:651 `createBrowserGateway(..., operatorUsers)`, plus the
        // REST-closure gate closures) — the SAME freeze semantics as
        // `requireBrowserAuth`. `_reloadAuth` re-threads secret/providers/
        // allowedUsers/bypass* but NEVER operatorUsers. So a runtime write that
        // returned `restartRequired:false` would tell the operator "no restart
        // needed" while the live process keeps the stale roster → op-2 retains
        // (or a revoked op-1 keeps) operator capability until a manual restart.
        // Mark it restart-required (honest, consistent with the requireBrowserAuth
        // freeze) — do NOT attempt to live-reload the frozen closures.
        const priorOperators = JSON.stringify(existingAuth.operatorUsers ?? null);
        const nextOperators = JSON.stringify(partial.auth.operatorUsers ?? null);
        if (priorOperators !== nextOperators) {
          restartRequired = true;
        }
        mergedAuth.operatorUsers = partial.auth.operatorUsers;
      }

      // Build 0 multi-operator gate. Persist requireBrowserAuth explicitly so a
      // Settings/API toggle survives reload. H-M1 (Build 1b): a security flag
      // must be a STRICT boolean — reject a non-boolean write with an error and
      // PRESERVE the prior value (never coerce a string/number toward on/off:
      // coercing a hand-typed "false"/0 could flip the gate ON = lockout, or a
      // "true" that the strict loader ignores = silent single-op-open). The
      // route surfaces this as a 400. `!== undefined` (not truthiness) still
      // lets an explicit boolean `false` clear it; omitting the key preserves
      // the existing value (carried by the `{ ...existingAuth }` seed above).
      if (partial.auth.requireBrowserAuth !== undefined) {
        if (typeof partial.auth.requireBrowserAuth !== "boolean") {
          return {
            success: false,
            restartRequired: false,
            validationError: true,
            error:
              `auth.requireBrowserAuth must be a boolean (got ` +
              `${typeof partial.auth.requireBrowserAuth}) — refusing to persist a ` +
              `malformed security flag; prior value preserved.`,
          };
        }
        const next = partial.auth.requireBrowserAuth === true;
        // Flipping the browser-auth gate is restart-required: the browser
        // gateway captures it at construction (a frozen boolean) and the `/ws`
        // upgrade gate must read the SAME frozen value, or the two gates
        // diverge (see system-routes reload path). Never apply it live.
        if (next !== (existingAuth.requireBrowserAuth === true)) {
          restartRequired = true;
        }
        mergedAuth.requireBrowserAuth = next;
      }

      // Per-cell guest boundary. Presence activates enforcement; malformed or
      // uncoupled writes are refused before disk mutation.
      if (partial.auth.guestCellGrants !== undefined) {
        const validation = validateGuestCellGrants(partial.auth.guestCellGrants);
        if (!validation.ok) {
          return {
            success: false,
            restartRequired: false,
            validationError: true,
            error: validation.error,
          };
        }
        if (
          JSON.stringify(existingAuth.guestCellGrants ?? null)
          !== JSON.stringify(validation.value)
        ) {
          restartRequired = true;
        }
        mergedAuth.guestCellGrants = validation.value;
      }

      if (mergedAuth.guestCellGrants !== undefined) {
        const validation = validateGuestCellGrants(mergedAuth.guestCellGrants);
        const usableOperator = Array.isArray(mergedAuth.operatorUsers)
          && mergedAuth.operatorUsers.some(
            (u: unknown) => typeof u === "string" && u.trim().length > 0,
          );
        if (!validation.ok || mergedAuth.requireBrowserAuth !== true || !usableOperator) {
          return {
            success: false,
            restartRequired: false,
            validationError: true,
            error: !validation.ok
              ? validation.error
              : "auth.guestCellGrants requires auth.requireBrowserAuth:true and at least one usable auth.operatorUsers identity",
          };
        }
      }

      // fix-trusted-networks-no-oauth: propagate bypassHosts / bypassUrls
      // from the incoming partial. Without these, the UI's Trusted Networks
      // save path silently dropped every entry on disk. `!== undefined`
      // (not truthiness) lets an empty array clear all entries.
      if (partial.auth.bypassHosts !== undefined) {
        mergedAuth.bypassHosts = partial.auth.bypassHosts;
      }
      if (partial.auth.bypassUrls !== undefined) {
        mergedAuth.bypassUrls = partial.auth.bypassUrls;
      }

      partial.auth = mergedAuth;
    }

    // Merge tunnel sub-object
    if (partial.tunnel) {
      partial.tunnel = { ...existing.tunnel, ...partial.tunnel };
    }

    // Merge memoryLimits sub-object
    if (partial.memoryLimits) {
      partial.memoryLimits = { ...existing.memoryLimits, ...partial.memoryLimits };
      restartRequired = true;
    }

    // Merge openspec sub-object (no restart required — live-reconfigured)
    if (partial.openspec) {
      partial.openspec = { ...existing.openspec, ...partial.openspec };
    }

    // Merge push sub-object. Defaults are runtime-safe; dispatcher shape
    // changes still require restart because transports are built at startup.
    if (partial.push) {
      const existingPush = existing.push || {};
      const incomingPush = partial.push;
      const dispatcherFieldsChanged =
        ("enabled" in incomingPush && incomingPush.enabled !== existingPush.enabled) ||
        ("coalesceWindowMs" in incomingPush && incomingPush.coalesceWindowMs !== existingPush.coalesceWindowMs) ||
        ("webPush" in incomingPush && JSON.stringify(incomingPush.webPush) !== JSON.stringify(existingPush.webPush));
      if (dispatcherFieldsChanged) restartRequired = true;
      partial.push = {
        ...existingPush,
        ...incomingPush,
        ...(incomingPush.defaults
          ? { defaults: { ...existingPush.defaults, ...incomingPush.defaults } }
          : {}),
        ...(incomingPush.webPush
          ? { webPush: { ...existingPush.webPush, ...incomingPush.webPush } }
          : {}),
      };
    }

    const merged = { ...existing, ...partial };

    // Remove computed fields that shouldn't be persisted
    delete merged.resolvedTrustedNetworks;

    // Write
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(merged, null, 2) + "\n");

    // Eager-refresh model proxy registry (config may affect proxy settings).
    refreshModelRegistry().catch(() => {});

    return { success: true, restartRequired };
  } catch (err: any) {
    return { success: false, restartRequired: false, error: err.message };
  }
}
