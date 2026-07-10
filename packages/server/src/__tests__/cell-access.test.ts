import { describe, expect, it } from "vitest";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { AuthConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import type { TokenPayload } from "../auth.js";
import {
  createCellAccessController,
  createCellRegistrySnapshot,
  resolveSessionAccessCell,
} from "../cell-access.js";

const OP = {
  sub: "owner@example.com",
  name: "Owner",
  username: "owner",
  provider: "github",
  exp: 0,
} as TokenPayload;
const GUEST = {
  sub: "friend@example.com",
  name: "Friend",
  username: "cherchenie",
  provider: "github",
  exp: 0,
} as TokenPayload;
const OTHER = {
  sub: "other@example.com",
  name: "Other",
  username: "other",
  provider: "github",
  exp: 0,
} as TokenPayload;

function session(id: string, name: string, cwd: string, extra: Partial<DashboardSession> = {}): DashboardSession {
  return {
    id,
    name,
    cwd,
    source: "tmux",
    status: "active",
    startedAt: 1,
    ...extra,
  };
}

function auth(grants?: Record<string, string[]>): AuthConfig {
  return {
    secret: "test-only",
    providers: {},
    requireBrowserAuth: true,
    allowedUsers: ["owner", "cherchenie", "other"],
    operatorUsers: ["owner"],
    ...(grants === undefined ? {} : { guestCellGrants: grants }),
  };
}

describe("cell access registry binding", () => {
  const rawRegistry = {
    drivers: {
      Alpha: { real_name: "Alpha", cell: "cell-a", pid: 101, session_log: "" },
      Beta: { real_name: "Beta", cell: "cell-b", pid: 202, session_log: "" },
      Gamma: { real_name: "Gamma", cell: "cell-a", pid: 303, session_log: "" },
      HistoricalCc: {
        real_name: "HistoricalCc",
        cell: "cell-c",
        pid: 404,
        session_log: "/tmp/sessions/2026-01-01_uuid-cc.jsonl",
      },
      StalePid: { real_name: "StalePid", cell: "cell-secret", pid: 999, session_log: "" },
    },
  };
  const messengers = [
    { name: "Alpha", sessionId: "sid-a", pid: 101 },
    { name: "Beta", sessionId: "sid-b", pid: 202 },
    { name: "Gamma", sessionId: "sid-g", pid: 303 },
  ];

  it("maps same-CWD sessions to distinct registry cells and one cell across distinct CWDs", () => {
    const snapshot = createCellRegistrySnapshot(rawRegistry, messengers);
    expect(resolveSessionAccessCell(session("sid-a", "Alpha", "/same"), snapshot)).toBe("cell-a");
    expect(resolveSessionAccessCell(session("sid-b", "Beta", "/same"), snapshot)).toBe("cell-b");
    expect(resolveSessionAccessCell(session("sid-g", "Gamma", "/other"), snapshot)).toBe("cell-a");
  });

  it("binds a non-mesh session only by exact session_log UUID/path, never PID alone", () => {
    const snapshot = createCellRegistrySnapshot(rawRegistry, messengers);
    expect(resolveSessionAccessCell(session("uuid-cc", "renamed", "/tmp", {
      sessionFile: "/tmp/sessions/2026-01-01_uuid-cc.jsonl",
      pid: 123,
    }), snapshot)).toBe("cell-c");

    // RED arm: a stale registry pid reused by an unrelated process is not authority.
    expect(resolveSessionAccessCell(session("unrelated", "Unrelated", "/other", { pid: 999 }), snapshot)).toBeUndefined();
  });

  it("rejects client/name/CWD claims and conflicting exact bindings", () => {
    const snapshot = createCellRegistrySnapshot(rawRegistry, messengers);
    expect(resolveSessionAccessCell(session("unknown", "Alpha", "/same", {
      accessCellId: "cell-secret",
    }), { ...snapshot, valid: false })).toBeUndefined();

    const conflicting = createCellRegistrySnapshot(
      {
        drivers: {
          Alpha: { real_name: "Alpha", cell: "cell-a", pid: 101, session_log: "sid-a" },
          Other: { real_name: "Other", cell: "cell-b", session_log: "sid-a" },
        },
      },
      [{ name: "Alpha", sessionId: "sid-a", pid: 101 }],
    );
    expect(resolveSessionAccessCell(session("sid-a", "Alpha", "/same"), conflicting)).toBeUndefined();
  });

  it("uses persisted server metadata only with a valid current registry snapshot", () => {
    const snapshot = createCellRegistrySnapshot(rawRegistry, messengers);
    const historical = session("old", "Old", "/old", { accessCellId: "cell-a" });
    expect(resolveSessionAccessCell(historical, snapshot)).toBe("cell-a");
    expect(resolveSessionAccessCell(historical, { ...snapshot, valid: false })).toBeUndefined();
  });
});

describe("guest cell grants", () => {
  const registry = createCellRegistrySnapshot(
    { drivers: { Alpha: { real_name: "Alpha", cell: "cell-a", pid: 101 } } },
    [{ name: "Alpha", sessionId: "sid-a", pid: 101 }],
  );
  const visible = session("sid-a", "Alpha", "/repo");
  const unclassified = session("sid-x", "Unknown", "/repo");

  it("preserves phase-1 behavior when guestCellGrants is absent", () => {
    const controller = createCellAccessController({ authConfig: auth(), snapshot: registry });
    expect(controller.enabled).toBe(false);
    expect(controller.canViewSession(GUEST, visible)).toBe(true);
    expect(controller.canViewSession(GUEST, unclassified)).toBe(true);
  });

  it("operators see all; matching guest sees granted cell only; unmatched guest sees none", () => {
    const controller = createCellAccessController({
      authConfig: auth({ cherchenie: ["cell-a"] }),
      snapshot: registry,
    });
    expect(controller.enabled).toBe(true);
    expect(controller.canViewSession(OP, visible)).toBe(true);
    expect(controller.canViewSession(OP, unclassified)).toBe(true);
    expect(controller.canViewSession(GUEST, visible)).toBe(true);
    expect(controller.canViewSession(GUEST, unclassified)).toBe(false);
    expect(controller.canViewSession(OTHER, visible)).toBe(false);
  });

  it("matches exact email or username case-insensitively and unions matching selectors", () => {
    const controller = createCellAccessController({
      authConfig: auth({ CHERCHENIE: ["cell-a"], "friend@example.com": ["cell-b"] }),
      snapshot: registry,
    });
    expect([...controller.cellsForPrincipal(GUEST)].sort()).toEqual(["cell-a", "cell-b"]);
  });

  it("a present empty map activates fail-closed guest visibility", () => {
    const controller = createCellAccessController({ authConfig: auth({}), snapshot: registry });
    expect(controller.enabled).toBe(true);
    expect(controller.canViewSession(GUEST, visible)).toBe(false);
    expect(controller.filterSessions(GUEST, [visible, unclassified])).toEqual([]);
  });

  it("live allowedUsers revocation immediately removes existing-cookie visibility", () => {
    const controller = createCellAccessController({
      authConfig: auth({ cherchenie: ["cell-a"] }),
      snapshot: registry,
    });
    expect(controller.canViewSession(GUEST, visible)).toBe(true);
    controller.updateAllowedUsers(["owner"]);
    expect(controller.isPrincipalAdmitted(GUEST)).toBe(false);
    expect(controller.canViewSession(GUEST, visible)).toBe(false);
    expect(controller.filterSessions(GUEST, [visible])).toEqual([]);
  });
});
