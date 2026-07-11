/**
 * Surface attribution — DERIVED-CARRIER-GUARD (§16.1 merge, Bert dl-6098 build-note-1).
 *
 * The ROBUST completeness proof for per-turn attribution: it iterates the
 * AUTHORITATIVE co-drive MAP — the SAME single-source-of-truth partition the
 * Build-1b WS gate + coverage test derive from (`ws-session-write-surface.ts`:
 * `WS_GATED_TYPES` + `WS_SELF_GATED_TYPES` + `WS_ACTION_GATED_TYPES` +
 * `WS_HOST_DEFERRED_TYPES` + `WS_PASSTHROUGH_TYPES`) — and classifies EVERY
 * entry into exactly one attribution disposition:
 *
 *   - `attributed` — an OPERATOR-TEXT carrier: it forwards human text that
 *     becomes a model turn, so it MUST stamp a server-derived author. Two
 *     carriers: `send_prompt` (locus-1 WS + locus-3 REST) and `prompt_response`
 *     (the browser-gateway COVER). Both stamp `deriveAuthor(...)` server-side.
 *   - `exempt` — NOT an operator model-text carrier (keep-alive, subscription,
 *     read, preference, host-surface, UI round-trip/mutation, legacy no-op).
 *     Each carries a rationale.
 *
 * ROBUST by construction (NOT a line-range, NOT a `"co-drive:"` rationale-prefix,
 * NOT a scattered-switch throwaway): the test classifies EACH carrier over the
 * WHOLE map. A NEW carrier added to any partition WITHOUT a disposition here →
 * the exhaustiveness assertion FAILS (it cannot hide). An operator-text carrier
 * mis-marked `exempt` → the attribution assertion FAILS.
 *
 * This is the FLIP of the Surface-A derived-carrier-guard deferred marker
 * (buildable now that the Build-1b co-drive map exists).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import {
  WS_GATED_TYPES,
  WS_SELF_GATED_TYPES,
  WS_ACTION_GATED_TYPES,
  WS_HOST_DEFERRED_TYPES,
  WS_PASSTHROUGH_TYPES,
} from "../ws-session-write-surface.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

/** Attribution disposition of a session-write carrier. */
type AttributionDisposition =
  | { kind: "attributed"; via: string }
  | { kind: "exempt"; rationale: string };

/**
 * The attribution classification of EVERY carrier in the co-drive map. This is
 * the per-carrier ledger the guard checks against the live map — a new carrier
 * MUST get a row here or the exhaustiveness test fails.
 */
const ATTRIBUTION_LEDGER: Record<string, AttributionDisposition> = {
  // ── OPERATOR-TEXT carriers: MUST be attributed (server-stamped author) ──────
  send_prompt: { kind: "attributed", via: "locus-1 (session-action-handler else-branch) + locus-3 (REST /prompt)" },
  prompt_response: { kind: "attributed", via: "browser-gateway prompt_response COVER (buildPromptResponseForward)" },

  // ── EXEMPT: not an operator model-text carrier ──────────────────────────────
  // gated operator-only / co-drive session-writes that are NOT human model-text
  abort: { kind: "exempt", rationale: "control: stops a turn; no human text" },
  resume_session: { kind: "exempt", rationale: "lifecycle: resume/fork; no model-text turn" },
  spawn_session: { kind: "exempt", rationale: "lifecycle: spawn; no model-text turn" },
  shutdown: { kind: "exempt", rationale: "lifecycle: shutdown; no human text" },
  force_kill: { kind: "exempt", rationale: "lifecycle: kill; no human text" },
  kill_process: { kind: "exempt", rationale: "lifecycle: kill child; no human text" },
  flow_control: { kind: "exempt", rationale: "control: flow abort/toggle; no human text" },
  flow_management: { kind: "exempt", rationale: "flow CRUD; no model-text turn" },
  set_model: { kind: "exempt", rationale: "config: model switch; no human text" },
  set_thinking_level: { kind: "exempt", rationale: "config: thinking level; no human text" },
  rename_session: { kind: "exempt", rationale: "metadata: session name; no model-text turn" },
  hide_session: { kind: "exempt", rationale: "metadata: hide; local; no model-text" },
  unhide_session: { kind: "exempt", rationale: "metadata: unhide; local; no model-text" },
  attach_proposal: { kind: "exempt", rationale: "metadata: attach openspec; no model-text" },
  detach_proposal: { kind: "exempt", rationale: "metadata: detach openspec; no model-text" },
  role_set: { kind: "exempt", rationale: "config: role; no model-text turn" },
  role_preset_save: { kind: "exempt", rationale: "config: role preset; no model-text" },
  role_preset_delete: { kind: "exempt", rationale: "config: role preset; no model-text" },
  role_preset_load: { kind: "exempt", rationale: "config: role preset; no model-text" },
  // action-gated
  ui_management: { kind: "exempt", rationale: "extension-UI read/mutation (action-gated); not a model-text turn" },
  // host-deferred (host surface, not per-session model-text)
  create_terminal: { kind: "exempt", rationale: "host PTY spawn; not a model-text turn" },
  kill_terminal: { kind: "exempt", rationale: "host PTY kill; not a model-text turn" },
  openspec_bulk_archive: { kind: "exempt", rationale: "worktree/archive op; not a model-text turn" },
  openspec_refresh: { kind: "exempt", rationale: "openspec CLI refresh; not a model-text turn" },
  pin_directory: { kind: "exempt", rationale: "directory pin + fs scan; not a model-text turn" },
  // passthrough: keep-alive / subscription / local prefs / reads / interactive round-trips
  ping: { kind: "exempt", rationale: "keep-alive; no forward" },
  subscribe: { kind: "exempt", rationale: "subscription bookkeeping; no human text" },
  unsubscribe: { kind: "exempt", rationale: "subscription bookkeeping; local" },
  session_view: { kind: "exempt", rationale: "viewed-state; local" },
  session_unview: { kind: "exempt", rationale: "viewed-state; local" },
  set_push_prefs: { kind: "exempt", rationale: "push prefs; local map" },
  reorder_sessions: { kind: "exempt", rationale: "order preference; local" },
  unpin_directory: { kind: "exempt", rationale: "directory pin preference; local" },
  reorder_pinned_dirs: { kind: "exempt", rationale: "directory order preference; local" },
  rename_terminal: { kind: "exempt", rationale: "terminal title; no session forward" },
  fetch_content: { kind: "exempt", rationale: "READ: session content" },
  list_sessions: { kind: "exempt", rationale: "READ: sessions for a cwd" },
  request_commands: { kind: "exempt", rationale: "READ: slash-commands" },
  request_models: { kind: "exempt", rationale: "READ: models" },
  request_providers: { kind: "exempt", rationale: "READ: providers" },
  request_roles: { kind: "exempt", rationale: "READ: roles list; no model-text turn" },
  list_files: { kind: "exempt", rationale: "READ: files for autocomplete" },
  request_installed_packages: { kind: "exempt", rationale: "READ: installed packages" },
  extension_ui_response: { kind: "exempt", rationale: "co-drive: answers an extension-UI request; NOT a model-text turn (structured UI reply, no <speaker>)" },
  architect_prompt_response: { kind: "exempt", rationale: "legacy no-op (superseded by prompt_response)" },
};

/** Every carrier that appears anywhere in the authoritative co-drive map. */
function allMappedCarriers(): Set<string> {
  const all = new Set<string>();
  for (const t of WS_GATED_TYPES) all.add(t);
  for (const t of WS_SELF_GATED_TYPES) all.add(t);
  for (const t of WS_ACTION_GATED_TYPES) all.add(t);
  for (const t of WS_HOST_DEFERRED_TYPES) all.add(t);
  for (const t of WS_PASSTHROUGH_TYPES.keys()) all.add(t);
  return all;
}

describe("Derived-carrier-guard — classify EACH carrier over the authoritative co-drive map", () => {
  it("EXHAUSTIVE: every carrier in the map has an attribution disposition (a new one can't hide)", () => {
    const unclassified: string[] = [];
    for (const carrier of allMappedCarriers()) {
      if (!(carrier in ATTRIBUTION_LEDGER)) unclassified.push(carrier);
    }
    // A NEW carrier added to ws-session-write-surface.ts without a row here →
    // this fails, forcing an explicit attributed/exempt decision.
    expect(unclassified).toEqual([]);
  });

  it("no STALE ledger rows: every ledgered carrier still exists in the map", () => {
    const mapped = allMappedCarriers();
    const stale = Object.keys(ATTRIBUTION_LEDGER).filter((c) => !mapped.has(c));
    expect(stale).toEqual([]);
  });

  it("every OPERATOR-TEXT carrier is ATTRIBUTED (server-stamped author)", () => {
    // The operator-text carriers are the ones whose disposition is `attributed`.
    const attributed = Object.entries(ATTRIBUTION_LEDGER)
      .filter(([, d]) => d.kind === "attributed")
      .map(([c]) => c)
      .sort();
    // The full operator-text carrier set (completeness): send_prompt +
    // prompt_response. If a future carrier forwards human model-text, it MUST
    // join this set (and be wired) — the exhaustiveness test above forces the
    // decision; this pins the CURRENT complete set.
    expect(attributed).toEqual(["prompt_response", "send_prompt"]);
  });

  it("each attributed carrier actually stamps deriveAuthor at its send site (server-derived)", () => {
    const handler = fs.readFileSync(
      path.resolve(__dirname, "../browser-handlers/session-action-handler.ts"), "utf8");
    const sessionApi = fs.readFileSync(path.resolve(__dirname, "../session-api.ts"), "utf8");
    const gateway = fs.readFileSync(path.resolve(__dirname, "../browser-gateway.ts"), "utf8");
    const forward = fs.readFileSync(path.resolve(__dirname, "../prompt-response-forward.ts"), "utf8");

    // send_prompt — WS locus-1 (else-branch) + REST locus-3 both derive server-side.
    // The author's FIRST arg is the server-bound principal (anti-spoof: never the
    // client body). The SECOND arg is the startup-frozen `operatorUsers` (also
    // server-side) that sources the DISPLAY-ONLY `isOperator` bit — it feeds UI
    // color anchoring, never any enforcement path. See change: multi-op-color-distinction.
    expect(handler).toMatch(/const author = deriveAuthor\(ctx\.principal, ctx\.operatorUsers\)/);
    expect(sessionApi).toMatch(/deriveAuthor\(\s*\(request as any\)\.restPrincipal/);
    // prompt_response — the COVER routes through the field-by-field helper that
    // stamps deriveAuthor(principal, operatorUsers) server-side.
    expect(gateway).toMatch(/buildPromptResponseForward\(pr, principals\.get\(ws\) \?\? null, operatorUsers\)/);
    expect(forward).toMatch(/deriveAuthor\(principal, operatorUsers\)/);
  });

  it("no attributed carrier derives its author from the client message BODY (BA-2)", () => {
    // Strip line comments so a comment mentioning `...msg` (e.g. "NOT a `...msg`
    // spread") is not a false positive — we only flag EXECUTABLE spreads.
    const stripComments = (s: string) => s.replace(/\/\/[^\n]*/g, "");
    const forward = stripComments(fs.readFileSync(path.resolve(__dirname, "../prompt-response-forward.ts"), "utf8"));
    const handler = stripComments(fs.readFileSync(
      path.resolve(__dirname, "../browser-handlers/session-action-handler.ts"), "utf8"));
    // The forwarded object is reconstructed field-by-field — never a WHOLESALE
    // `...msg` / `...(msg as any)` spread that would let a forged author ride.
    // The negative lookahead `(?!\s*\.)` allows safe FIELD spreads
    // (`...(msg.answer ? {answer: msg.answer} : {})`, `...(msg.queueNonce ...)`)
    // while forbidding the wholesale spread (`...msg`, `...(msg as any)`).
    const WHOLESALE_MSG_SPREAD = /\.\.\.\s*\(?\s*msg\b(?!\s*\.)/;
    expect(forward).not.toMatch(WHOLESALE_MSG_SPREAD);
    expect(handler).not.toMatch(WHOLESALE_MSG_SPREAD);
  });
});
