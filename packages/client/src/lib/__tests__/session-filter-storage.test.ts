import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  getActiveOnly,
  setActiveOnly,
  getCollapsedGroups,
  setCollapsedGroups,
  pruneStaleCollapsedGroups,
  removeLegacyHiddenSessions,
  getStaleHoursThreshold,
  setStaleHoursThreshold,
  getHideStale,
  setHideStale,
  getGroupByFolder,
  setGroupByFolder,
  getGroupByCell,
  setGroupByCell,
} from "../session-filter-storage.js";

// Node 25's built-in localStorage overrides jsdom's and lacks standard methods.
// Mock window.localStorage with a simple Map-based implementation.
const store = new Map<string, string>();
const mockStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => store.set(key, value),
  removeItem: (key: string) => store.delete(key),
  clear: () => store.clear(),
} as unknown as Storage;

Object.defineProperty(window, "localStorage", { value: mockStorage, writable: true });

describe("session-filter-storage", () => {
  beforeEach(() => {
    store.clear();
  });

  describe("removeLegacyHiddenSessions", () => {
    it("should remove legacy hiddenSessions key", () => {
      store.set("dashboard:hiddenSessions", '["a","b"]');
      removeLegacyHiddenSessions();
      expect(store.has("dashboard:hiddenSessions")).toBe(false);
    });

    it("should not throw when key does not exist", () => {
      expect(() => removeLegacyHiddenSessions()).not.toThrow();
    });
  });

  describe("getActiveOnly / setActiveOnly", () => {
    it("should return true when nothing stored (default ON)", () => {
      expect(getActiveOnly()).toBe(true);
    });

    it("should round-trip true", () => {
      setActiveOnly(true);
      expect(getActiveOnly()).toBe(true);
    });

    it("should round-trip false", () => {
      setActiveOnly(false);
      expect(getActiveOnly()).toBe(false);
    });
  });

  describe("getCollapsedGroups / setCollapsedGroups", () => {
    it("should return empty set when nothing stored", () => {
      expect(getCollapsedGroups()).toEqual(new Set());
    });

    it("should round-trip a set of cwds", () => {
      const cwds = new Set(["/home/user/a", "/home/user/b"]);
      setCollapsedGroups(cwds);
      expect(getCollapsedGroups()).toEqual(cwds);
    });

    it("should return empty set for invalid JSON", () => {
      store.set("dashboard:collapsedGroups", "not-json");
      expect(getCollapsedGroups()).toEqual(new Set());
    });

    it("should filter out non-string values", () => {
      store.set("dashboard:collapsedGroups", '["/a", 123, null, "/b"]');
      expect(getCollapsedGroups()).toEqual(new Set(["/a", "/b"]));
    });
  });

  describe("pruneStaleCollapsedGroups", () => {
    it("should remove cwds not in known set", () => {
      setCollapsedGroups(new Set(["/a", "/b", "/c"]));
      const result = pruneStaleCollapsedGroups(new Set(["/a", "/c", "/d"]));
      expect(result).toEqual(new Set(["/a", "/c"]));
      expect(getCollapsedGroups()).toEqual(new Set(["/a", "/c"]));
    });

    it("should return empty set when no overlap", () => {
      setCollapsedGroups(new Set(["/x", "/y"]));
      const result = pruneStaleCollapsedGroups(new Set(["/a"]));
      expect(result).toEqual(new Set());
    });

    it("should handle empty collapsed set", () => {
      const result = pruneStaleCollapsedGroups(new Set(["/a"]));
      expect(result).toEqual(new Set());
    });

    // ── dashboard-session-naming-clarity-fix Bug A ──
    // Tier-toggle keys (`tier:*`) share the same collapsed-groups Set as
    // cwd-keys per SessionList `handleToggleTierCollapse` design but have
    // no cwd-shaped lifetime; the prune pass MUST preserve them unconditionally.
    // Sister to mobile-ux-audit/v1 W6-OperatorEmpirical-F1.

    it("preserves tier:* keys even when knownCwds is empty", () => {
      setCollapsedGroups(new Set(["tier:worker", "tier:standing-crew", "tier:cell-executor"]));
      const result = pruneStaleCollapsedGroups(new Set());
      expect(result).toEqual(new Set(["tier:worker", "tier:standing-crew", "tier:cell-executor"]));
      expect(getCollapsedGroups()).toEqual(new Set(["tier:worker", "tier:standing-crew", "tier:cell-executor"]));
    });

    it("preserves __cell__:* keys even when knownCwds is empty", () => {
      setCollapsedGroups(new Set(["__cell__:Paneview", "__cell__:__ungrouped__"]));
      const result = pruneStaleCollapsedGroups(new Set());

      expect(result).toEqual(new Set(["__cell__:Paneview", "__cell__:__ungrouped__"]));
      expect(getCollapsedGroups()).toEqual(result);
    });

    it("preserves cwd-keys present in knownCwds and tier:* keys together", () => {
      setCollapsedGroups(new Set(["/a", "/b", "tier:worker"]));
      const result = pruneStaleCollapsedGroups(new Set(["/a", "/b"]));
      expect(result).toEqual(new Set(["/a", "/b", "tier:worker"]));
    });

    it("drops cwd-keys NOT in knownCwds while preserving tier:* keys", () => {
      setCollapsedGroups(new Set(["/a", "/stale", "tier:worker", "tier:standing-crew"]));
      const result = pruneStaleCollapsedGroups(new Set(["/a"]));
      expect(result).toEqual(new Set(["/a", "tier:worker", "tier:standing-crew"]));
      expect(result.has("/stale")).toBe(false);
    });

    it("preserves mixed (tier:* + cwd) Set across multiple prune passes", () => {
      setCollapsedGroups(new Set(["/a", "tier:worker"]));
      // First prune: /a still known.
      pruneStaleCollapsedGroups(new Set(["/a"]));
      expect(getCollapsedGroups()).toEqual(new Set(["/a", "tier:worker"]));
      // Second prune: /a no longer known; tier:* must still survive.
      pruneStaleCollapsedGroups(new Set(["/b"]));
      expect(getCollapsedGroups()).toEqual(new Set(["tier:worker"]));
      // Third prune: nothing known; tier:* still survives.
      pruneStaleCollapsedGroups(new Set());
      expect(getCollapsedGroups()).toEqual(new Set(["tier:worker"]));
    });
  });

  describe("getStaleHoursThreshold / setStaleHoursThreshold", () => {
    it("defaults to 24 when nothing stored", () => {
      expect(getStaleHoursThreshold()).toBe(24);
    });

    it("round-trips a positive number", () => {
      setStaleHoursThreshold(48);
      expect(getStaleHoursThreshold()).toBe(48);
    });

    it("round-trips 0 (filter disabled)", () => {
      setStaleHoursThreshold(0);
      expect(getStaleHoursThreshold()).toBe(0);
    });

    it("falls back to default on malformed storage", () => {
      store.set("dashboard:staleHours", "not-a-number");
      expect(getStaleHoursThreshold()).toBe(24);
    });

    it("falls back to default on negative stored value", () => {
      store.set("dashboard:staleHours", "-5");
      expect(getStaleHoursThreshold()).toBe(24);
    });
  });

  describe("getHideStale / setHideStale", () => {
    it("defaults to true when nothing stored", () => {
      expect(getHideStale()).toBe(true);
    });

    it("round-trips true", () => {
      setHideStale(true);
      expect(getHideStale()).toBe(true);
    });

    it("round-trips false", () => {
      setHideStale(false);
      expect(getHideStale()).toBe(false);
    });
  });

  describe("getGroupByFolder / setGroupByFolder", () => {
    it("defaults to true when nothing stored", () => {
      expect(getGroupByFolder()).toBe(true);
    });

    it("round-trips true", () => {
      setGroupByFolder(true);
      expect(getGroupByFolder()).toBe(true);
    });

    it("round-trips false", () => {
      setGroupByFolder(false);
      expect(getGroupByFolder()).toBe(false);
    });
  });

  describe("getGroupByCell / setGroupByCell", () => {
    it("defaults to false when dashboard:groupByCell is absent", () => {
      expect(getGroupByCell()).toBe(false);
    });

    it("persists true under dashboard:groupByCell", () => {
      setGroupByCell(true);
      expect(store.get("dashboard:groupByCell")).toBe("true");
      expect(getGroupByCell()).toBe(true);
    });

    it("round-trips false under dashboard:groupByCell", () => {
      setGroupByCell(true);
      setGroupByCell(false);
      expect(store.get("dashboard:groupByCell")).toBe("false");
      expect(getGroupByCell()).toBe(false);
    });
  });
});
