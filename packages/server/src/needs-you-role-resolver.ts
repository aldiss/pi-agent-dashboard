/**
 * Themed-name → operator-language ROLE resolver for the watcher (§3 decision-3
 * enhancement). The pure core takes an injected `resolveRole`; this backs it
 * with the role-registry + cell-driver-registry so labels stay current vs a
 * hardcoded seed. The `THEMED_NAMES` predicate (browser-safe) remains the
 * backstop — this resolver is the PRIMARY themed→role resolution.
 *
 * DEFENSIVE by design: the registries carry no clean "role phrase" field (the
 * `status` field embeds role hints WITH jargon — tenure-N, tier codes). So the
 * resolver extracts a de-jargoned hint where cleanly possible, else falls back
 * to a safe generic ("the <cell> driver" / "the driver") — NEVER emits a raw
 * themed-name or a jargon-laden status (the predicate would reject it downstream).
 */

import os from "node:os";
import path from "node:path";
import { readJsonFile } from "./json-store.js";
import { ORCHESTRATION_STATE_DIR_SEGMENTS } from "@blackbelt-technology/pi-dashboard-shared/needs-you-band.js";

interface RoleRegistry {
  roles?: Record<string, { themed_name?: string; status?: string; tier?: string }>;
}

/** Strip jargon tokens (tenure-N, tier codes, §-cites, dl-ids) from a hint. */
export function dejargonRoleHint(status: string): string | null {
  // The `status` shape is e.g. "L0.5 Peggy — operator inbox manager · tenure-67".
  // Take the segment AFTER the em/en-dash (the human role phrase). Split ONLY on
  // em/en-dash — NEVER the hyphen (that would break "tenure-152" /
  // "system-evolution"). No em-dash ⇒ use the whole string.
  const parts = status.split(/[—–]/);
  const afterDash = (parts.length > 1 ? parts.slice(1).join(" ") : status).trim();
  const hint = afterDash
    .replace(/·.*$/, "") // drop "· tenure-67 ..."
    .replace(/\btenure-\d+\b/gi, "")
    .replace(/\bL\d+(\.\d+)?[a-z]?\b/g, "") // tier codes L0.5a
    .replace(/§\s*\d+(\.\d+)*/g, "")
    .replace(/\bdl-\d+\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  // A role phrase should be short + wordy. Reject empty / too-long / no-letters.
  if (hint.length === 0 || hint.length > 60 || !/[a-z]/i.test(hint)) return null;
  return hint;
}

/** Clean a cell id into a role-language phrase: "grocery-meal-planner" → "the grocery-meal-planner driver". */
export function cellToRole(cell: string): string {
  const clean = cell.replace(/^[a-z]+\+/i, "").replace(/\/v\d+$/i, "").trim();
  return clean.length > 0 ? `the ${clean} driver` : "the driver";
}

/**
 * Build a `resolveRole(key)` from the role-registry. `key` is a cell id or a
 * themed-name. Cells resolve to "the <cell> driver"; themed-names resolve to a
 * de-jargoned role hint when cleanly extractable, else to a safe generic.
 * Registry injectable for tests.
 */
export function createRoleResolver(registry?: RoleRegistry): (key: string) => string {
  const reg = registry ?? readJsonFile<RoleRegistry>(rolePath(), {});
  const roles = reg.roles ?? {};
  // Reverse index: themed_name (lowercased) → status hint.
  const byThemed = new Map<string, string>();
  for (const entry of Object.values(roles)) {
    const themed = entry.themed_name?.toLowerCase();
    if (themed && entry.status) byThemed.set(themed, entry.status);
  }

  return (key: string): string => {
    if (!key) return "the driver";
    // A cell id (contains "+", "/", or "-" cell-shape) → "the <cell> driver".
    if (/[+/]/.test(key) || key.includes("-")) {
      // But a themed-name may also contain "-"; prefer a themed match first.
      const themedHit = byThemed.get(key.toLowerCase());
      if (themedHit) {
        const hint = dejargonRoleHint(themedHit);
        if (hint) return startsLower(hint) ? hint : `the ${lowerFirst(hint)}`;
      }
      return cellToRole(key);
    }
    // A bare themed-name.
    const status = byThemed.get(key.toLowerCase());
    if (status) {
      const hint = dejargonRoleHint(status);
      if (hint) return startsLower(hint) ? hint : `the ${lowerFirst(hint)}`;
    }
    return "the driver";
  };
}

function rolePath(): string {
  return path.join(os.homedir(), ...ORCHESTRATION_STATE_DIR_SEGMENTS, "role-registry.json");
}
function startsLower(s: string): boolean {
  return /^(the|a|an)\b/i.test(s);
}
function lowerFirst(s: string): string {
  return s.length ? s[0]!.toLowerCase() + s.slice(1) : s;
}
