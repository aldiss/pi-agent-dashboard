/**
 * Build-1b PUSHBACK-2 — DERIVED-coverage red-arm suite (FIX-P2-2 SHARPENED).
 *
 * The load-bearing structural fix: the WS session-write coverage DERIVES from
 * the ACTUAL reachable surface via a REAL AST TRAVERSAL (TypeScript compiler
 * API), NOT a hand-maintained list and NOT a regex splice. The PUSHBACK-1 regex
 * parser had 4 blind spots the dl-5825 re-review reproduced own-hand; this
 * rewrite closes ALL FOUR:
 *
 *   (m1) EFFECT-FREENESS, not just membership: a `WS_PASSTHROUGH_TYPES` entry
 *        that reaches `sendToSession` must NOT forward a browser-chosen dynamic
 *        `event` channel NOR an operator-only payload `type`. A passthrough
 *        forwarding a browser-chosen emit (ui_management-as-passthrough) or an
 *        operator-level write (fetch_content→role_set) → RED.
 *   (m2) the DEFAULT arm + NESTED switches: `handlePiGatewayForward`'s inner
 *        `switch (msg.type)` cases are enumerated as first-class reachable types
 *        (the exact path the original `set_model` WS-gap lived in). A new ungated
 *        `sendToSession` inside the default arm → RED.
 *   (m5) NON-`handleX` delegates + `.bind`/alias: the traversal follows the WHOLE
 *        local call graph (not just `handle*`), resolves same-file helpers
 *        (`applyAttachProposal`), and treats a `const send = …sendToSession.bind`
 *        alias as a session-write sink. An ungated write via a non-handleX helper
 *        or an alias → RED.
 *   (m4) ROBUST host-sink discriminator: host effects are a named sink set
 *        (`spawnPiSession`/`killProcess`/`removeWorktree`/`openspecArchiveCompleted`/
 *        `refreshOpenSpec`/`pollDirectoryGated`/`onDirectoryAdded` + terminal
 *        spawn/kill), followed across the call graph — NOT a hand-list one level
 *        down. `spawn_session`→spawnPiSession + `force_kill`→killProcess now
 *        SURFACE as host-effecting (they stay excluded from the derived-deferred
 *        set only because they are already GATED, not because they are invisible).
 *
 * Red-arms (plant → FAIL → restore → PASS) — see the fix2 red-arm evidence:
 *   (a) a `handleX` handler doing an ungated `sendToSession` → RED (unclassified).
 *   (b) a non-`handleX` helper / `.bind` alias doing an ungated `sendToSession`
 *       → RED (the traversal resolves it).
 *   (c) an ungated `sendToSession` INSIDE `handlePiGatewayForward`'s nested switch
 *       (default arm) → RED (the nested case is a first-class type).
 *   (d) a passthrough entry forwarding a browser-chosen `event` (re-add
 *       ui_management to WS_PASSTHROUGH_TYPES) → RED (effect-freeness).
 *   Preserved PUSHBACK-1 plants: remove a registry row (role_set) → RED; a new
 *   host-surface forward not in the mirror → derived-EQUALS-mirror RED.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  WS_GATED_TYPES,
  WS_SELF_GATED_TYPES,
  WS_ACTION_GATED_TYPES,
  WS_PASSTHROUGH_TYPES,
  WS_HOST_DEFERRED_TYPES,
  classifyWsMessage,
} from "../ws-session-write-surface.js";
import { wsMessageAction, actionClass } from "../session-authz.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..");

// The handler files whose bodies the gateway switch delegates into. The
// traversal resolves every LOCAL call across this pool (not just `handle*`).
const HANDLER_FILES = [
  "browser-gateway.ts",
  "browser-handlers/session-action-handler.ts",
  "browser-handlers/session-meta-handler.ts",
  "browser-handlers/terminal-handler.ts",
  "browser-handlers/directory-handler.ts",
  "browser-handlers/subscription-handler.ts",
];

// ── SINKS ────────────────────────────────────────────────────────────────
// A SESSION-WRITE sink is a call to `sendToSession` (or a local/param alias
// bound to it). A HOST sink is one of the named host-effecting calls, or a
// terminal spawn/kill. These are the DISCRIMINATORS; reachability is via AST
// call-graph across the WHOLE local module set (imports + re-exports resolved).
const SESSION_WRITE_LEAF = "sendToSession";
const HOST_SINK_LEAVES = new Set([
  "spawnPiSession", // host process spawn
  "killProcess", // host process kill (SIGTERM→SIGKILL)
  "removeWorktree", // git worktree removal
  "openspecArchiveCompleted", // openspec CLI subprocess
  "refreshOpenSpec", // openspec CLI re-poll (force-bypass gate)
  "pollDirectoryGated", // openspec CLI poll
  "onDirectoryAdded", // fs scan + openspec poll on pin
  // PUSHBACK-3 FIX-P3-2 (dual-review MINOR-3): the real host-KILL primitives. A
  // future passthrough-mis-parked host-killer must SURFACE as host-effecting.
  "killBySessionId", // headless-pid-registry SIGTERM by session id
  "killPidWithGroup", // platform PGID kill (SIGTERM/SIGKILL)
  "killHeadlessBySessionId", // find-by-marker + PGID kill
]);
function isTerminalHostCall(leaf: string, objText: string): boolean {
  return (leaf === "spawn" || leaf === "kill") && /terminal/i.test(objText);
}

interface FuncEntry {
  /** The function body-bearing node (declaration OR arrow/func-expr initializer). */
  node: ts.FunctionLikeDeclarationBase & { body?: ts.Node };
  /** Absolute path of the file the entry lives in (for cross-module resolution). */
  abs: string;
  /** Simple identifier parameter names, in order (for callback-param binding). */
  params: string[];
  /** True when the function body contains a `switch (msg.type)` (a dispatcher). */
  dispatcher: boolean;
}

interface Analysis {
  reachesSessionWrite: boolean;
  reachesHostSink: boolean;
  /** A `sendToSession` forwarded a dynamic (non-string-literal) `event`. */
  forwardsDynamicEvent: boolean;
  /**
   * A `sendToSession` forwarded a DYNAMIC payload `type` — an object literal with
   * a non-string-literal `type:` (`{type: msg.forwardType}`) OR a fabricated
   * non-object payload that is NOT the verbatim inbound `msg` (a browser-chosen
   * type the static registry can't see). PUSHBACK-3 FIX-P3-2 (c)/(NIT-2).
   */
  forwardsDynamicType: boolean;
  /** The `type` literals forwarded to `sendToSession` (payload `type:` props). */
  forwardedTypes: Set<string>;
}

function readAbs(abs: string): string {
  return fs.readFileSync(abs, "utf-8");
}
function read(rel: string): string {
  return readAbs(path.join(SRC, rel));
}
function parse(rel: string): ts.SourceFile {
  return ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, /*setParentNodes*/ true);
}

/**
 * Leaf callee name of a call expression:
 *   `a.b.c(`            → "c"  (property access)
 *   `f(`                → "f"  (identifier)
 *   `a["sendToSession"](` → "sendToSession"  (element access, NIT-1)
 */
function calleeLeaf(call: ts.CallExpression): string {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
    return e.argumentExpression.text;
  }
  return "";
}
/** Object text of a property/element-access callee (`ctx.terminalManager.spawn` → "ctx.terminalManager"). */
function calleeObjectText(call: ts.CallExpression, sf: ts.SourceFile): string {
  const e = call.expression;
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) return e.expression.getText(sf);
  return "";
}

/** True when a function body contains a `switch (msg.type)`. */
function hasMsgTypeSwitch(node: ts.Node, sf: ts.SourceFile): boolean {
  let found = false;
  const walk = (n: ts.Node) => {
    if (found) return;
    if (ts.isSwitchStatement(n) && n.expression.getText(sf) === "msg.type") {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

/** Simple identifier parameter names of a function-like node (ignores destructuring). */
function paramNames(node: ts.FunctionLikeDeclarationBase): string[] {
  return node.parameters
    .map((p) => (ts.isIdentifier(p.name) ? p.name.text : ""))
    .filter((s) => s.length > 0);
}

/**
 * A per-file scope: local function-like declarations (index by name), plus the
 * import + re-export bindings so a call to an OUT-OF-FILE helper (imported from
 * outside HANDLER_FILES) or a CROSS-MODULE RE-EXPORTED helper resolves to its
 * real body (PUSHBACK-3 FIX-P3-2 (a)/(b)). Only RELATIVE specifiers are followed
 * (a package import is out of the local call graph — its sink leaf, if any, is
 * still matched by NAME regardless of resolution).
 */
interface FileScope {
  abs: string;
  sf: ts.SourceFile;
  locals: Map<string, FuncEntry>;
  /** localName → { absPath, importedName } for `import { a as b } from "./m"`. */
  imports: Map<string, { abs: string; name: string }>;
  /** exportedName → { absPath, importedName } for `export { a as b } from "./m"`. */
  reExports: Map<string, { abs: string; name: string }>;
}

const scopeCache = new Map<string, FileScope>();

/** Resolve a relative specifier to an absolute `.ts` path under SRC, or undefined. */
function resolveSpecifier(spec: string, fromAbs: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(fromAbs), spec.replace(/\.js$/, ""));
  for (const cand of [base + ".ts", path.join(base, "index.ts")]) {
    if (fs.existsSync(cand) && path.resolve(cand).startsWith(SRC)) return path.resolve(cand);
  }
  return undefined;
}

function buildScope(abs: string): FileScope {
  const cached = scopeCache.get(abs);
  if (cached) return cached;
  const sf = ts.createSourceFile(abs, readAbs(abs), ts.ScriptTarget.Latest, true);
  const scope: FileScope = { abs, sf, locals: new Map(), imports: new Map(), reExports: new Map() };
  scopeCache.set(abs, scope); // set early (cycle-safe)

  const addFuncLike = (name: string, node: ts.FunctionLikeDeclarationBase & { body?: ts.Node }) => {
    scope.locals.set(name, {
      node,
      abs,
      params: paramNames(node),
      dispatcher: node.body ? hasMsgTypeSwitch(node.body, sf) : false,
    });
  };

  const walk = (n: ts.Node) => {
    // function declarations
    if (ts.isFunctionDeclaration(n) && n.name && n.body) {
      addFuncLike(n.name.text, n);
    }
    // MINOR-1: arrow-const / func-expr handlers —
    // `export const handleX = (msg, ctx) => {…}` / `= function (…) {…}`.
    if (ts.isVariableStatement(n)) {
      for (const decl of n.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) &&
          decl.initializer.body
        ) {
          addFuncLike(decl.name.text, decl.initializer);
        }
      }
    }
    // imports: `import { a, b as c } from "./m"`
    if (ts.isImportDeclaration(n) && n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings)) {
      const spec = (n.moduleSpecifier as ts.StringLiteral).text;
      const targetAbs = resolveSpecifier(spec, abs);
      if (targetAbs) {
        for (const el of n.importClause.namedBindings.elements) {
          scope.imports.set(el.name.text, { abs: targetAbs, name: (el.propertyName ?? el.name).text });
        }
      }
    }
    // re-exports: `export { a, b as c } from "./m"`
    if (ts.isExportDeclaration(n) && n.moduleSpecifier && n.exportClause && ts.isNamedExports(n.exportClause)) {
      const spec = (n.moduleSpecifier as ts.StringLiteral).text;
      const targetAbs = resolveSpecifier(spec, abs);
      if (targetAbs) {
        for (const el of n.exportClause.elements) {
          scope.reExports.set(el.name.text, { abs: targetAbs, name: (el.propertyName ?? el.name).text });
        }
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return scope;
}

/**
 * Resolve a called name to its real function entry, following imports +
 * re-exports across relative modules (bounded to SRC). Cycle-guarded.
 */
function resolveFunc(name: string, fromAbs: string, seen = new Set<string>()): FuncEntry | undefined {
  const key = `${fromAbs}#${name}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  const scope = buildScope(fromAbs);
  const local = scope.locals.get(name);
  if (local) return local;
  const imp = scope.imports.get(name);
  if (imp) return resolveFunc(imp.name, imp.abs, seen);
  const re = scope.reExports.get(name);
  if (re) return resolveFunc(re.name, re.abs, seen);
  return undefined;
}

/** True when an argument expression is a `sendToSession` reference (a sink handle). */
function argIsSinkRef(arg: ts.Expression, sf: ts.SourceFile, aliases: Set<string>): boolean {
  const text = arg.getText(sf);
  if (/\.sendToSession\b/.test(text) || /\[\s*["']sendToSession["']\s*\]/.test(text)) return true;
  // an identifier already bound to the sink (a local alias passed onward)
  if (ts.isIdentifier(arg) && aliases.has(arg.text)) return true;
  return false;
}

/** Unwrap `as`/parenthesized expressions to the underlying node. */
function unwrap(e: ts.Expression): ts.Expression {
  let cur: ts.Expression = e;
  while (ts.isAsExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur)) {
    cur = cur.expression;
  }
  return cur;
}

/** Inspect a `sendToSession` (or alias) call's 2nd arg for `type`/`event` shape. */
function inspectForwardArg(call: ts.CallExpression, sf: ts.SourceFile, out: Analysis): void {
  const payload = call.arguments[1];
  if (!payload) return;
  if (!ts.isObjectLiteralExpression(payload)) {
    // NIT-2: a NON-object-literal forward escapes the effect-freeness check. The
    // verbatim inbound `msg` (optionally `as any`) is SAFE — it preserves the
    // case discriminant (the type can't be browser-re-chosen). Anything else
    // fabricated (a local var, a call result) is an opaque dynamic payload.
    const inner = unwrap(payload);
    const isVerbatimMsg = ts.isIdentifier(inner) && inner.text === "msg";
    if (!isVerbatimMsg) out.forwardsDynamicType = true;
    return;
  }
  for (const prop of payload.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = prop.name.getText(sf);
    if (key === "type") {
      if (ts.isStringLiteral(prop.initializer)) {
        out.forwardedTypes.add(prop.initializer.text);
      } else {
        // (c) DYNAMIC payload type (`{type: msg.forwardType}`): a non-string-
        // literal `type` is a browser-chosen channel — treat as dangerous.
        out.forwardsDynamicType = true;
      }
    }
    if (key === "event" && !ts.isStringLiteral(prop.initializer)) {
      // A non-string-literal `event:` value = a browser-chosen dynamic channel
      // (e.g. `event: msg.event`), the ui_management side-effect shape.
      out.forwardsDynamicEvent = true;
    }
  }
}

/**
 * Analyze the code reachable from `seeds` for the discriminators. Follows every
 * LOCAL call across the resolver (imports + re-exports; dispatchers opaque —
 * their nested cases are enumerated as separate types), treats a local alias of
 * `sendToSession` as a session-write sink, AND models CALLBACK-PARAMETER aliases:
 * when a callee is invoked with a `.sendToSession` reference as an argument, the
 * corresponding PARAMETER is bound as a session-write sink inside the callee body
 * (PUSHBACK-3 FIX-P3-2 — the dual-review's callback-parameter plant).
 */
function analyze(seeds: ts.Node[], seedAbs: string): Analysis {
  const out: Analysis = {
    reachesSessionWrite: false,
    reachesHostSink: false,
    forwardsDynamicEvent: false,
    forwardsDynamicType: false,
    forwardedTypes: new Set(),
  };
  const visited = new Set<string>();

  const walk = (n: ts.Node, sf: ts.SourceFile, fileAbs: string, aliases: Set<string>) => {
    // Alias capture: `const send = ctx.piGateway.sendToSession.bind(...)`, a
    // property-access `= ctx.piGateway.sendToSession`, or an element-access
    // `= ctx.piGateway["sendToSession"]` (NIT-1).
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) {
      const initText = n.initializer.getText(sf);
      if (/\.sendToSession\b/.test(initText) || /\[\s*["']sendToSession["']\s*\]/.test(initText)) {
        aliases.add(n.name.text);
      }
    }
    if (ts.isCallExpression(n)) {
      const leaf = calleeLeaf(n);
      const objText = calleeObjectText(n, sf);
      // Session-write sink (direct, element-access, or via local/param alias).
      if (leaf === SESSION_WRITE_LEAF || aliases.has(leaf)) {
        out.reachesSessionWrite = true;
        inspectForwardArg(n, sf, out);
      }
      // Host sink (named or terminal spawn/kill).
      if (HOST_SINK_LEAVES.has(leaf) || isTerminalHostCall(leaf, objText)) {
        out.reachesHostSink = true;
      }
      // Resolve a local/imported/re-exported call across the graph (dispatchers
      // opaque). Bind callback params: a param that receives a sink reference at
      // THIS call site is a session-write sink inside the callee body.
      const target = resolveFunc(leaf, fileAbs);
      if (target && !target.dispatcher) {
        const boundParams: string[] = [];
        n.arguments.forEach((arg, i) => {
          if (argIsSinkRef(arg, sf, aliases) && target.params[i]) boundParams.push(target.params[i]);
        });
        const key = `${target.abs}#${leaf}#${[...boundParams].sort().join(",")}`;
        if (!visited.has(key) && target.node.body) {
          visited.add(key);
          walk(target.node.body, target.node.getSourceFile() ?? sf, target.abs, new Set(boundParams));
        }
      }
    }
    ts.forEachChild(n, (c) => walk(c, sf, fileAbs, aliases));
  };

  const seedScope = buildScope(seedAbs);
  for (const seed of seeds) walk(seed, seedScope.sf, seedAbs, new Set());
  return out;
}

/**
 * Enumerate every reachable browser message-type and the code that runs for it:
 *   - each `case "<t>":` of the OUTER `switch (msg.type)` in browser-gateway;
 *   - each `case "<t>":` of any NESTED `switch (msg.type)` inside a dispatcher
 *     the default arm delegates to (handlePiGatewayForward) — first-class types.
 * Returns type → its Analysis.
 */
function analyzeReachableTypes(): Map<string, Analysis> {
  const gwAbs = path.join(SRC, HANDLER_FILES[0]!);
  // Warm the scope cache for every declared handler file (so a call into any of
  // them resolves even before the traversal reaches it via imports).
  for (const rel of HANDLER_FILES) buildScope(path.join(SRC, rel));
  const gwScope = buildScope(gwAbs);
  const gwSf = gwScope.sf;

  // Find the OUTER switch (msg.type) in browser-gateway.
  let outerSwitch: ts.SwitchStatement | undefined;
  const findSwitch = (n: ts.Node) => {
    if (outerSwitch) return;
    if (ts.isSwitchStatement(n) && n.expression.getText(gwSf) === "msg.type") {
      outerSwitch = n;
      return;
    }
    ts.forEachChild(n, findSwitch);
  };
  findSwitch(gwSf);
  expect(outerSwitch, "browser-gateway switch(msg.type) must exist").toBeDefined();

  const seedsByType = new Map<string, { seeds: ts.Node[]; abs: string }>();

  for (const clause of outerSwitch!.caseBlock.clauses) {
    if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)) {
      seedsByType.set(clause.expression.text, { seeds: [...clause.statements], abs: gwAbs });
    } else if (ts.isDefaultClause(clause)) {
      // The default arm delegates to a dispatcher (handlePiGatewayForward). Pull
      // its NESTED switch cases in as first-class reachable types (m2).
      const dispatcherLeaves: string[] = [];
      const collectCalls = (n: ts.Node) => {
        if (ts.isCallExpression(n)) {
          const leaf = calleeLeaf(n);
          const entry = resolveFunc(leaf, gwAbs);
          if (entry?.dispatcher) dispatcherLeaves.push(leaf);
        }
        ts.forEachChild(n, collectCalls);
      };
      for (const st of clause.statements) collectCalls(st);

      for (const dleaf of dispatcherLeaves) {
        const entry = resolveFunc(dleaf, gwAbs)!;
        const entrySf = entry.node.getSourceFile();
        const nestedWalk = (n: ts.Node) => {
          if (ts.isSwitchStatement(n) && n.expression.getText(entrySf) === "msg.type") {
            for (const c of n.caseBlock.clauses) {
              if (ts.isCaseClause(c) && ts.isStringLiteral(c.expression)) {
                seedsByType.set(c.expression.text, { seeds: [...c.statements], abs: entry.abs });
              }
            }
          }
          ts.forEachChild(n, nestedWalk);
        };
        if (entry.node.body) nestedWalk(entry.node.body);
      }
    }
  }

  const result = new Map<string, Analysis>();
  for (const [type, { seeds, abs }] of seedsByType) {
    result.set(type, analyze(seeds, abs));
  }
  return result;
}

/** True when a forwarded payload `type` maps to an OPERATOR-ONLY session action. */
function isOperatorOnlyForward(type: string): boolean {
  const action = wsMessageAction(type);
  return action !== undefined && actionClass(action) === "operator-only";
}

describe("Build 1b PUSHBACK-2 — WS session-write coverage DERIVES via AST traversal", () => {
  const analyzed = analyzeReachableTypes();

  it("the traversal found the reachable switch cases incl. nested-dispatcher types (sanity)", () => {
    // A representative spread across gated / passthrough / host / nested-forwarded.
    for (const t of [
      "shutdown", "role_set", "request_roles", "create_terminal", "ping",
      "subscribe", "set_model", "set_thinking_level", // set_model/level are NESTED (default arm)
    ]) {
      expect(analyzed.has(t), `case "${t}" must be enumerated`).toBe(true);
    }
    expect(analyzed.size).toBeGreaterThanOrEqual(30);
  });

  // ── (P4-1 completeness) EVERY reachable case lands in a KNOWN disposition ──
  // The P3-2 gap `evil_arrow` exposed: an outer case whose handler is
  // UNRESOLVABLE (`handleEvilArrow` undefined) → `analyze()` walks no body →
  // reachesSessionWrite=false → the session-write assertion below `continue`-
  // skips it → it smuggled past GREEN (while tsc separately reds the undefined
  // handler). Close the completeness half HERE: every enumerated reachable
  // message-type (outer + nested-dispatcher cases) MUST classify into exactly
  // one of the five dispositions. An UNMAPPED case (in none of the partitions)
  // → classifyWsMessage undefined → RED — regardless of whether analyze() found a
  // sink. Catches BOTH the unresolvable-handler case AND a real-typed case left
  // unclassified (which tsc alone would NOT flag).
  it("every reachable switch case classifies into exactly one disposition (P4-1: no unmapped/unresolved case)", () => {
    // Red-arm: re-plant `case "evil_arrow": handleEvilArrow(msg as any, ctx);` in
    // the gateway switch → "evil_arrow" is in no partition → unmapped → RED
    // (npm-run-lint ALSO reds it: TS2304 undefined handler + TS2678 not-in-union).
    const unmapped: string[] = [];
    for (const type of analyzed.keys()) {
      if (classifyWsMessage(type) === undefined) unmapped.push(type);
    }
    expect(
      unmapped,
      `reachable case(s) with NO disposition (an unresolvable handler OR a real ` +
        `type never classified; either can hide an ungated effect): ` +
        `${unmapped.join(", ")}. Gate it (WS_SESSION_WRITE_MESSAGE_ACTION), classify ` +
        `it (WS_PASSTHROUGH_TYPES / WS_ACTION_GATED_TYPES / WS_HOST_DEFERRED_TYPES), ` +
        `or remove the dead case.`,
    ).toEqual([]);
  });

  // ── (m1 + m5 + m2) every reachable session-write is gated AND effect-safe ──
  it("every reachable session-write forward is classified, and no passthrough smuggles an operator-level effect", () => {
    const unclassified: string[] = [];
    const smugglers: string[] = [];
    for (const [type, a] of analyzed) {
      if (!a.reachesSessionWrite) continue;
      const disp = classifyWsMessage(type);
      // (a)/(b)/(c): a reachable session-write must be classified as
      // gated / self-gated / action-gated / passthrough (NOT undefined, NOT
      // host-deferred-only). An ungated new handler / helper / nested case → here.
      const classified =
        disp === "gated" || disp === "self-gated" || disp === "action-gated" || disp === "passthrough";
      if (!classified) {
        unclassified.push(`${type}(${disp ?? "unmapped"})`);
        continue;
      }
      // (m1) EFFECT-FREENESS: a PASSTHROUGH (co-drive-safe) type reaching a
      // session-write must NOT forward a browser-chosen dynamic `event` channel,
      // a DYNAMIC/opaque payload `type` (a fabricated `{type: msg.x}` or a
      // non-`msg` non-object forward — PUSHBACK-3 (c)/(NIT-2)), NOR an
      // operator-only payload `type`. (action-gated ui_management is EXEMPT — the
      // runtime gate classifies each message read/mutation/forged.)
      if (disp === "passthrough") {
        if (a.forwardsDynamicEvent) {
          smugglers.push(`${type}(browser-chosen event channel)`);
        }
        if (a.forwardsDynamicType) {
          smugglers.push(`${type}(browser-chosen/opaque payload type)`);
        }
        const opOnly = [...a.forwardedTypes].filter(isOperatorOnlyForward);
        if (opOnly.length > 0) {
          smugglers.push(`${type}(forwards operator-only: ${opOnly.join("/")})`);
        }
      }
    }
    // Red-arm (a)/(b)/(c): plant an ungated sendToSession via a handleX handler,
    // a non-handleX helper/.bind alias, or inside handlePiGatewayForward's nested
    // switch → the offending type shows up in `unclassified` → RED.
    expect(
      unclassified,
      `reachable session-write forwards with NO classification (ungated op-2 ` +
        `bypass): ${unclassified.join(", ")}. Gate it (WS_SESSION_WRITE_MESSAGE_ACTION) ` +
        `or classify it (WS_PASSTHROUGH_TYPES read/co-drive) or action-gate it.`,
    ).toEqual([]);
    // Red-arm (d): re-add ui_management to WS_PASSTHROUGH_TYPES (browser-gateway
    // still forwards `event: msg.event`) → passthrough + dynamic event → RED.
    // Or plant fetch_content→role_set (passthrough forwards operator-only) → RED.
    expect(
      smugglers,
      `passthrough types smuggling an operator-level effect (must be gated / ` +
        `action-gated, not blanket passthrough): ${smugglers.join(", ")}.`,
    ).toEqual([]);
  });

  it("every gated WS message-type is actually reachable in the gateway switch (no dead registry rows)", () => {
    for (const type of WS_GATED_TYPES) {
      // set_thinking_level/set_model are reached via the default→nested switch;
      // they are enumerated as nested types now. All others are explicit cases.
      const reachable = analyzed.has(type);
      expect(reachable, `gated type ${type} must be reachable`).toBe(true);
    }
  });

  // ── (m4) DERIVED host-surface set EQUALS the runtime mirror ────────────────
  it("the DERIVED host-surface forward set EQUALS the runtime mirror WS_HOST_DEFERRED_TYPES", () => {
    // Derive: a reachable type reaching a HOST sink that is NOT already gated /
    // self-gated (a gated host-effecter — spawn_session, force_kill — is
    // operator-controlled, so it is honestly excluded from the DEFERRED set even
    // though the robust discriminator now SEES its host reach).
    const derivedHost = new Set<string>();
    for (const [type, a] of analyzed) {
      if (!a.reachesHostSink) continue;
      if (WS_GATED_TYPES.has(type) || WS_SELF_GATED_TYPES.has(type)) continue;
      derivedHost.add(type);
    }
    // Red-arm: add a NEW host-surface forward (a case reaching a host sink) not
    // in the mirror → derived grows → RED until added to WS_HOST_DEFERRED_TYPES.
    // Also proves FIX-P2-5: openspec_refresh + pin_directory AUTO-surface here.
    expect(
      [...derivedHost].sort(),
      `host-surface forwards derived from the route table must match the runtime ` +
        `mirror. A mismatch means a host-surface forward is silently absent — add ` +
        `it to WS_HOST_DEFERRED_TYPES (surfaces as known-ungated-deferred-to-Build-1c).`,
    ).toEqual([...WS_HOST_DEFERRED_TYPES].sort());
  });

  it("openspec_refresh + pin_directory are host-deferred (FIX-P2-5: auto-surfaced, not passthrough)", () => {
    // The two host-surface forwards mis-parked as passthrough. They must be
    // host-deferred (reach a host sink, not gated) — and NOT in passthrough.
    for (const t of ["openspec_refresh", "pin_directory"]) {
      expect(classifyWsMessage(t), `${t} must be host-deferred`).toBe("host-deferred");
      expect(WS_PASSTHROUGH_TYPES.has(t), `${t} must NOT be passthrough`).toBe(false);
      expect(analyzed.get(t)?.reachesHostSink, `${t} must reach a host sink`).toBe(true);
    }
  });

  it("host-deferred types are NOT gated (scope-honest: deferred, not closed in Build-1b)", () => {
    for (const type of WS_HOST_DEFERRED_TYPES) {
      expect(WS_GATED_TYPES.has(type), `${type} must be deferred, not gated in Build-1b`).toBe(false);
    }
  });

  // ── the partitions are disjoint (a type has exactly one disposition) ───────
  it("gated / self-gated / action-gated / passthrough / host-deferred partitions are pairwise disjoint", () => {
    const buckets: Array<[string, Iterable<string>]> = [
      ["gated", WS_GATED_TYPES],
      ["self-gated", WS_SELF_GATED_TYPES],
      ["action-gated", WS_ACTION_GATED_TYPES],
      ["passthrough", WS_PASSTHROUGH_TYPES.keys()],
      ["host-deferred", WS_HOST_DEFERRED_TYPES],
    ];
    const seen = new Map<string, string>();
    for (const [name, set] of buckets) {
      for (const t of set) {
        expect(seen.has(t), `${t} is in both ${seen.get(t)} and ${name}`).toBe(false);
        seen.set(t, name);
      }
    }
  });

  // ── ui_management is action-gated (FIX-P2-1): not passthrough, reaches write ─
  it("ui_management is ACTION-GATED and reaches a session-write (the arbitrary-emit channel)", () => {
    expect(classifyWsMessage("ui_management")).toBe("action-gated");
    expect(WS_PASSTHROUGH_TYPES.has("ui_management")).toBe(false);
    const a = analyzed.get("ui_management");
    expect(a?.reachesSessionWrite, "ui_management forwards to the session").toBe(true);
    // It forwards a browser-chosen dynamic `event` — the exact reason it can NOT
    // be a blanket passthrough (the runtime gate classifies read/mutation/forged).
    expect(a?.forwardsDynamicEvent, "ui_management forwards a browser-chosen event").toBe(true);
  });
});
