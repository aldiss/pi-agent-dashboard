import { describe, expect, it } from "vitest";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { AuthConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import type { TokenPayload } from "../auth.js";
import { createCellAccessController, createCellRegistrySnapshot } from "../cell-access.js";
import {
  authorizeGuestBrowserMessage,
  filterServerMessageForPrincipal,
} from "../cell-access-ws.js";

const OP = { sub: "op@example.com", username: "op", name: "Op", provider: "github", exp: 0 } as TokenPayload;
const GUEST = { sub: "guest@example.com", username: "guest", name: "Guest", provider: "github", exp: 0 } as TokenPayload;
const config: AuthConfig = {
  secret: "test",
  providers: {},
  requireBrowserAuth: true,
  allowedUsers: ["op", "guest"],
  operatorUsers: ["op"],
  guestCellGrants: { guest: ["cell-a"] },
};
const snapshot = createCellRegistrySnapshot(
  { drivers: {
    A: { real_name: "A", cell: "cell-a", pid: 1 },
    B: { real_name: "B", cell: "cell-b", pid: 2 },
  } },
  [
    { name: "A", sessionId: "a", pid: 1 },
    { name: "B", sessionId: "b", pid: 2 },
  ],
);
const access = createCellAccessController({ authConfig: config, snapshot });
const A: DashboardSession = { id: "a", name: "A", cwd: "/shared", source: "tmux", status: "active", startedAt: 1 };
const B: DashboardSession = { id: "b", name: "B", cwd: "/shared", source: "tmux", status: "active", startedAt: 1 };
const sessions = new Map([[A.id, A], [B.id, B]]);
const getSession = (id: string) => sessions.get(id);

describe("guest browser inbound classification", () => {
  it("allows session co-drive/read carriers only for visible session", () => {
    expect(authorizeGuestBrowserMessage({ type: "send_prompt", sessionId: "a", text: "hi" } as any, GUEST, access, getSession)).toEqual({ allowed: true });
    expect(authorizeGuestBrowserMessage({ type: "fetch_content", sessionId: "a", seq: 1 } as any, GUEST, access, getSession)).toEqual({ allowed: true });
    expect(authorizeGuestBrowserMessage({ type: "abort", sessionId: "b" } as any, GUEST, access, getSession)).toEqual({ allowed: false, reason: "session-unavailable" });
    expect(authorizeGuestBrowserMessage({ type: "abort", sessionId: "missing" } as any, GUEST, access, getSession)).toEqual({ allowed: false, reason: "session-unavailable" });
  });

  it("refuses CWD/global/preference carriers even when they mention an inside session", () => {
    for (const msg of [
      { type: "list_files", sessionId: "a", cwd: "/shared" },
      { type: "list_sessions", cwd: "/shared" },
      { type: "set_push_prefs", sessionId: "a", prefs: { notifyCompletion: "on" } },
      { type: "reorder_sessions", cwd: "/shared", sessionIds: ["a"] },
      { type: "create_terminal", cwd: "/shared" },
      { type: "unknown_future", sessionId: "a" },
    ]) {
      expect(authorizeGuestBrowserMessage(msg as any, GUEST, access, getSession)).toEqual({ allowed: false, reason: "operator-only" });
    }
    expect(authorizeGuestBrowserMessage({ type: "ping" } as any, GUEST, access, getSession)).toEqual({ allowed: true });
  });

  it("operator is not filtered", () => {
    expect(authorizeGuestBrowserMessage({ type: "unknown_future" } as any, OP, access, getSession)).toEqual({ allowed: true });
  });
});

describe("server→browser final egress filter", () => {
  it("filters snapshot sessions and orders atomically", () => {
    const visible = new Set<string>();
    const filtered = filterServerMessageForPrincipal(
      { type: "sessions_snapshot", sessions: [{ ...A, leaked: B }, B], orders: { "/shared": ["a", "b"], "/hidden": ["b"], "/outside": ["a"] } } as any,
      GUEST,
      access,
      getSession,
      visible,
    ) as any;
    expect(filtered.sessions.map((s: DashboardSession) => s.id)).toEqual(["a"]);
    expect(filtered.sessions[0]).toBe(A);
    expect(filtered.orders).toEqual({ "/shared": ["a"] });
    expect([...visible]).toEqual(["a"]);
  });

  it("delivers allowed session carriers, hides outside carriers, and preserves removal for a previously visible id", () => {
    const visible = new Set<string>(["a"]);
    expect(filterServerMessageForPrincipal({ type: "event", sessionId: "a", seq: 1, event: {} } as any, GUEST, access, getSession, visible)).not.toBeNull();
    expect(filterServerMessageForPrincipal({ type: "event", sessionId: "b", seq: 1, event: {} } as any, GUEST, access, getSession, visible)).toBeNull();

    sessions.delete("a");
    expect(filterServerMessageForPrincipal({ type: "session_removed", sessionId: "a" } as any, GUEST, access, getSession, visible)).toEqual({ type: "session_removed", sessionId: "a" });
    expect([...visible]).toEqual([]);
    sessions.set("a", A);
  });

  it("default-denies unknown/unscoped core and plugin carriers for guest but not operator", () => {
    const guestVisible = new Set<string>();
    const unknown = { type: "planted_unknown", secretCwd: "/outside" } as any;
    const unknownWithAllowedId = { type: "planted_unknown", sessionId: "a", outside: B } as any;
    const plugin = { type: "plugin_payload", sessions: [B] } as any;
    expect(filterServerMessageForPrincipal(unknown, GUEST, access, getSession, guestVisible)).toBeNull();
    expect(filterServerMessageForPrincipal(unknownWithAllowedId, GUEST, access, getSession, guestVisible)).toBeNull();
    expect(filterServerMessageForPrincipal(plugin, GUEST, access, getSession, guestVisible)).toBeNull();
    const spoofedCore = { type: "event", sessionId: "a", seq: 1, event: { outside: B } } as any;
    expect(filterServerMessageForPrincipal(spoofedCore, GUEST, access, getSession, guestVisible, "plugin")).toBeNull();
    expect(filterServerMessageForPrincipal(spoofedCore, OP, access, getSession, new Set(), "plugin")).toBe(spoofedCore);
    expect(filterServerMessageForPrincipal(unknown, OP, access, getSession, new Set())).toBe(unknown);
    expect(filterServerMessageForPrincipal(plugin, OP, access, getSession, new Set())).toBe(plugin);
  });

  it("sanitizes safe-global pong instead of forwarding plugin-added fields", () => {
    expect(filterServerMessageForPrincipal({ type: "pong", leaked: B } as any, GUEST, access, getSession, new Set())).toEqual({ type: "pong" });
  });
});
