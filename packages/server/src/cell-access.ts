import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { TokenPayload } from "./auth.js";
import { isUserAllowed } from "./auth.js";

export interface CellDriverEntry {
  real_name?: string;
  cell?: string | null;
  pid?: number | null;
  session_log?: string | null;
}

export interface MessengerEntry {
  name?: string;
  sessionId?: string;
  pid?: number;
}

export interface CellRegistrySnapshot {
  valid: boolean;
  drivers: Record<string, CellDriverEntry>;
  messengers: MessengerEntry[];
  cells: ReadonlySet<string>;
  fingerprint: string;
}

export interface CellAccessControllerOptions {
  authConfig?: AuthConfig;
  snapshot?: CellRegistrySnapshot;
  cellRegistryPath?: string;
  messengerRegistryDir?: string;
}

export type CellAccessRole = "operator" | "guest" | "anonymous";

export interface CellAccessController {
  readonly enabled: boolean;
  roleForPrincipal(principal: TokenPayload | null | undefined): CellAccessRole;
  cellsForPrincipal(principal: TokenPayload | null | undefined): ReadonlySet<string>;
  isPrincipalAdmitted(principal: Pick<TokenPayload, "sub" | "username"> | null | undefined): boolean;
  resolveSessionCell(session: DashboardSession): string | undefined;
  canViewSession(principal: TokenPayload | null | undefined, session: DashboardSession | undefined): boolean;
  canViewSessionId(
    principal: TokenPayload | null | undefined,
    sessionId: string,
    getSession: (id: string) => DashboardSession | undefined,
  ): boolean;
  filterSessions(principal: TokenPayload | null | undefined, sessions: DashboardSession[]): DashboardSession[];
  setSnapshot(snapshot: CellRegistrySnapshot): void;
  updateAllowedUsers(allowedUsers: string[] | undefined): void;
  refresh(): boolean;
  snapshot(): CellRegistrySnapshot;
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "invalid";
  }
}

function validCell(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function createCellRegistrySnapshot(
  rawRegistry: unknown,
  rawMessengers: unknown[],
): CellRegistrySnapshot {
  if (!rawRegistry || typeof rawRegistry !== "object" || Array.isArray(rawRegistry)) {
    return { valid: false, drivers: {}, messengers: [], cells: new Set(), fingerprint: "invalid" };
  }
  const rawDrivers = (rawRegistry as { drivers?: unknown }).drivers;
  if (!rawDrivers || typeof rawDrivers !== "object" || Array.isArray(rawDrivers)) {
    return { valid: false, drivers: {}, messengers: [], cells: new Set(), fingerprint: "invalid" };
  }

  const drivers: Record<string, CellDriverEntry> = {};
  const cells = new Set<string>();
  for (const [name, raw] of Object.entries(rawDrivers as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const entry: CellDriverEntry = {
      ...(typeof item.real_name === "string" ? { real_name: item.real_name } : {}),
      ...(validCell(item.cell) ? { cell: item.cell } : {}),
      ...(typeof item.pid === "number" && Number.isInteger(item.pid) && item.pid > 0
        ? { pid: item.pid }
        : {}),
      ...(typeof item.session_log === "string" && item.session_log.trim()
        ? { session_log: item.session_log.trim() }
        : {}),
    };
    drivers[name] = entry;
    if (entry.cell) cells.add(entry.cell);
  }

  const messengers: MessengerEntry[] = [];
  for (const raw of rawMessengers) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.sessionId !== "string" || !item.sessionId) continue;
    messengers.push({
      ...(typeof item.name === "string" && item.name ? { name: item.name } : {}),
      sessionId: item.sessionId,
      ...(typeof item.pid === "number" && Number.isInteger(item.pid) && item.pid > 0
        ? { pid: item.pid }
        : {}),
    });
  }

  const fingerprint = stableJson({ drivers, messengers });
  return { valid: true, drivers, messengers, cells, fingerprint };
}

function sessionLogMatches(session: DashboardSession, sessionLog: string): boolean {
  if (sessionLog === session.id) return true;
  if (session.sessionFile && path.resolve(sessionLog) === path.resolve(session.sessionFile)) return true;
  const base = path.basename(sessionLog);
  if (base === session.id || base === `${session.id}.jsonl`) return true;
  if (base.endsWith(`_${session.id}.jsonl`)) return true;
  return false;
}

function matchingDriverCells(
  name: string | undefined,
  pid: number | undefined,
  snapshot: CellRegistrySnapshot,
): Set<string> {
  const out = new Set<string>();
  if (!name) return out;
  for (const [key, driver] of Object.entries(snapshot.drivers)) {
    if (!driver.cell) continue;
    if (key !== name && driver.real_name !== name) continue;
    // The exact messenger sessionId is primary. A name match is corroborated ONLY
    // by a POSITIVE pid agreement present on BOTH sides — a reused driver name
    // must not inherit a granted cell on the strength of the name alone. A missing
    // pid on either side (or a disagreement) is not corroboration, so reject it.
    if (typeof pid !== "number" || typeof driver.pid !== "number" || pid !== driver.pid) continue;
    out.add(driver.cell);
  }
  return out;
}

export function resolveSessionAccessCell(
  session: DashboardSession,
  snapshot: CellRegistrySnapshot,
): string | undefined {
  if (!snapshot.valid) return undefined;
  const candidates = new Set<string>();

  for (const messenger of snapshot.messengers) {
    if (messenger.sessionId !== session.id) continue;
    for (const cell of matchingDriverCells(messenger.name, messenger.pid, snapshot)) {
      candidates.add(cell);
    }
  }

  for (const driver of Object.values(snapshot.drivers)) {
    if (!driver.cell || !driver.session_log) continue;
    if (sessionLogMatches(session, driver.session_log)) candidates.add(driver.cell);
  }

  if (candidates.size > 1) return undefined;
  if (candidates.size === 1) return candidates.values().next().value;

  // Server-derived persisted metadata may preserve a historical binding, but
  // only while a valid current registry still recognizes that cell id.
  if (session.accessCellId && snapshot.cells.has(session.accessCellId)) {
    return session.accessCellId;
  }
  return undefined;
}

function identityMatches(
  principal: Pick<TokenPayload, "sub" | "username"> | null | undefined,
  selector: string,
): boolean {
  if (!principal || typeof principal.sub !== "string" || !principal.sub.trim()) return false;
  const wanted = selector.trim().toLowerCase();
  if (!wanted) return false;
  const sub = principal.sub.trim().toLowerCase();
  const username = typeof principal.username === "string" ? principal.username.trim().toLowerCase() : "";
  return wanted === sub || (!!username && wanted === username);
}

function readSnapshot(cellRegistryPath: string, messengerRegistryDir: string): CellRegistrySnapshot {
  let registry: unknown;
  try {
    registry = JSON.parse(fs.readFileSync(cellRegistryPath, "utf8"));
  } catch {
    return { valid: false, drivers: {}, messengers: [], cells: new Set(), fingerprint: "invalid" };
  }

  const messengerEntries: unknown[] = [];
  try {
    for (const file of fs.readdirSync(messengerRegistryDir).sort()) {
      if (!file.endsWith(".json")) continue;
      try {
        messengerEntries.push(JSON.parse(fs.readFileSync(path.join(messengerRegistryDir, file), "utf8")));
      } catch {
        // One partial messenger entry cannot invalidate the atomic cell registry.
      }
    }
  } catch {
    // Empty messenger set is valid: exact session_log bindings may still resolve.
  }
  return createCellRegistrySnapshot(registry, messengerEntries);
}

export function createCellAccessController(options: CellAccessControllerOptions): CellAccessController {
  const grants = options.authConfig?.guestCellGrants;
  const enabled = grants !== undefined;
  const operatorUsers = options.authConfig?.operatorUsers;
  let allowedUsers = options.authConfig?.allowedUsers;
  const cellRegistryPath = options.cellRegistryPath
    ?? process.env.PI_CELL_DRIVER_REGISTRY_FILE
    ?? path.join(os.homedir(), ".pi", "orchestration-state", "cell-driver-registry.json");
  const messengerRegistryDir = options.messengerRegistryDir
    ?? process.env.PI_MESSENGER_REGISTRY_DIR
    ?? path.join(os.homedir(), ".pi", "agent", "messenger", "registry");
  let current = options.snapshot ?? (enabled
    ? readSnapshot(cellRegistryPath, messengerRegistryDir)
    : { valid: true, drivers: {}, messengers: [], cells: new Set(), fingerprint: "disabled" });

  const controller: CellAccessController = {
    enabled,

    roleForPrincipal(principal): CellAccessRole {
      if (!principal) return "anonymous";
      if ((operatorUsers ?? []).some((selector) => identityMatches(principal, selector))) {
        return "operator";
      }
      return "guest";
    },

    cellsForPrincipal(principal): ReadonlySet<string> {
      const cells = new Set<string>();
      if (!principal || !grants) return cells;
      for (const [selector, granted] of Object.entries(grants)) {
        if (!identityMatches(principal, selector)) continue;
        for (const cell of granted) cells.add(cell);
      }
      return cells;
    },

    isPrincipalAdmitted(principal): boolean {
      if (!principal) return false;
      return isUserAllowed(principal.sub, principal.username ?? "", allowedUsers);
    },

    resolveSessionCell(session): string | undefined {
      return resolveSessionAccessCell(session, current);
    },

    canViewSession(principal, target): boolean {
      if (!enabled) return true;
      if (!principal || !controller.isPrincipalAdmitted(principal)) return false;
      if (controller.roleForPrincipal(principal) === "operator") return true;
      if (!target) return false;
      const cell = controller.resolveSessionCell(target);
      return !!cell && controller.cellsForPrincipal(principal).has(cell);
    },

    canViewSessionId(principal, sessionId, getSession): boolean {
      return controller.canViewSession(principal, getSession(sessionId));
    },

    filterSessions(principal, sessions): DashboardSession[] {
      if (!enabled) return [...sessions];
      if (!principal || !controller.isPrincipalAdmitted(principal)) return [];
      if (controller.roleForPrincipal(principal) === "operator") return [...sessions];
      return sessions.filter((item) => controller.canViewSession(principal, item));
    },

    setSnapshot(snapshot): void {
      current = snapshot;
    },

    updateAllowedUsers(next): void {
      allowedUsers = next;
    },

    refresh(): boolean {
      if (!enabled) return false;
      const next = readSnapshot(cellRegistryPath, messengerRegistryDir);
      if (next.fingerprint === current.fingerprint && next.valid === current.valid) return false;
      current = next;
      return true;
    },

    snapshot(): CellRegistrySnapshot {
      return current;
    },
  };

  return controller;
}
