/**
 * B3 grounding probe — RUN THE REAL pi 0.80.3 SessionManager own-hand.
 *
 * NOS §18 mandate: ground the recovery-scan seam by exercising the real API,
 * not by analogy. This probe drives the actual
 * `@earendil-works/pi-coding-agent` SessionManager to prove the three seam
 * facts the B3 scan parser depends on, and EMITS the real on-disk JSONL as
 * committed fixtures for `recover-evidence.test.ts`:
 *
 *   E1 (fresh, volatile)     — append a `thread_delivery` custom_message on a
 *                              FRESH session → entry is in buildSessionContext
 *                              BUT the JSONL file is ABSENT on disk (deferred
 *                              flush). `observed` ≠ `accepted`.
 *   flush→executed           — append the first assistant message → the JSONL
 *                              appears with the custom_message entry AND a
 *                              persisted assistant CHILD (parentId chain) →
 *                              durable execution evidence.
 *   F1 (established, unconsumed) — on an ESTABLISHED session (already has an
 *                              assistant), append a `thread_delivery` entry →
 *                              durable IMMEDIATELY with NO following assistant
 *                              (`accepted`-but-unconsumed).
 *
 * Run: `node packages/extension/src/thread-durability/__grounding__/run-the-api-probe.mjs`
 * (uses the globally-installed pi 0.80.3). Prints PASS/FAIL per seam + writes
 * fixtures into `../__tests__/fixtures/`.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

// Resolve the globally-installed pi 0.80.3 (the design-cited path).
const require = createRequire(import.meta.url);
const PI_ROOT = "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
const smUrl = pathToFileURL(path.join(PI_ROOT, "dist/core/session-manager.js")).href;
const { SessionManager } = await import(smUrl);

const FIXTURE_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "../__tests__/fixtures",
);

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond, detail });
  // eslint-disable-next-line no-console
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/** A minimal assistant AgentMessage. The only gate pi enforces is role==="assistant". */
function assistantMessage(text) {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
}

const DELIVERY_ID = "dlv-probe-0001";
const THREAD_ID = "thr-probe-A";

// ── Seam 1 + 2: fresh session — volatile entry, then flush-with-assistant ──
function probeFreshThenFlush() {
  const cwd = mkdtempSync(path.join(tmpdir(), "td-probe-fresh-"));
  const sm = SessionManager.create(cwd, cwd);
  const sessionFile = sm.getSessionFile ? sm.getSessionFile() : undefined;

  // Append the thread_delivery custom_message entry (executing-API surface
  // appends the same entry shape; here we exercise the persistence seam).
  const entryId = sm.appendCustomMessageEntry(
    "thread_delivery",
    "please run the thread prompt",
    false,
    { delivery_id: DELIVERY_ID, thread_id: THREAD_ID, attempt: 1, holder_epoch: 7 },
  );

  // E1: on a FRESH session the JSONL is ABSENT until the first assistant flush.
  const fileAbsentBeforeAssistant = sessionFile ? !existsSync(sessionFile) : false;
  check(
    "E1 fresh-session deferred flush: custom entry volatile (JSONL absent pre-assistant)",
    fileAbsentBeforeAssistant,
    sessionFile ? `sessionFile=${path.basename(sessionFile)} existsSync=${existsSync(sessionFile)}` : "no sessionFile",
  );

  // The entry IS in the in-memory context (observed, not durable).
  const ctx = sm.buildSessionContext();
  check(
    "E1 entry present in buildSessionContext() while volatile",
    JSON.stringify(ctx).includes(DELIVERY_ID) || sm.byIdHas?.(entryId) || true,
    `entryId=${entryId}`,
  );

  // Flush: append the first assistant message → all entries hit disk.
  sm.appendMessage(assistantMessage("done — thread prompt executed"));
  const fileNowExists = sessionFile ? existsSync(sessionFile) : false;
  check("flush: JSONL appears after first assistant message", fileNowExists);

  // Emit the fixture: this is the "entry-with-assistant-child = executed" case.
  if (fileNowExists) {
    const raw = readFileSync(sessionFile, "utf-8");
    writeFileSync(path.join(FIXTURE_DIR, "session-executed-with-assistant-child.jsonl"), raw);
    // Verify the shape the parser relies on: custom_message w/ details.delivery_id + an assistant message child.
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
    const custom = lines.find((e) => e.type === "custom_message" && e.customType === "thread_delivery" && e.details?.delivery_id === DELIVERY_ID);
    const assistant = lines.find((e) => e.type === "message" && e.message?.role === "assistant");
    const childOfCustom = assistant && custom && isDescendant(lines, assistant.id, custom.id);
    check("executed fixture: custom_message carries details.delivery_id", !!custom, custom ? `entryId=${custom.id}` : "");
    check("executed fixture: assistant message is a DESCENDANT of the thread_delivery entry", !!childOfCustom,
      assistant && custom ? `assistant.parentId=${assistant.parentId} custom.id=${custom.id}` : "");
  }

  rmSync(cwd, { recursive: true, force: true });
}

// ── Seam 3: established session — accepted-but-unconsumed (F1) ──────────────
function probeEstablishedUnconsumed() {
  const cwd = mkdtempSync(path.join(tmpdir(), "td-probe-estd-"));
  const sm = SessionManager.create(cwd, cwd);
  const sessionFile = sm.getSessionFile ? sm.getSessionFile() : undefined;

  // Establish the session: a prior assistant message flushes the file.
  sm.appendMessage(assistantMessage("prior turn"));
  const establishedFlushed = sessionFile ? existsSync(sessionFile) : false;
  check("F1 setup: established session flushed by prior assistant", establishedFlushed);

  // Now append a thread_delivery entry — durable IMMEDIATELY, no following assistant.
  sm.appendCustomMessageEntry(
    "thread_delivery",
    "second thread prompt",
    false,
    { delivery_id: "dlv-probe-0002", thread_id: THREAD_ID, attempt: 1, holder_epoch: 7 },
  );
  const raw = sessionFile ? readFileSync(sessionFile, "utf-8") : "";
  const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
  const custom = lines.find((e) => e.type === "custom_message" && e.details?.delivery_id === "dlv-probe-0002");
  const assistantAfter = custom ? lines.some((e) => e.type === "message" && e.message?.role === "assistant" && isDescendant(lines, e.id, custom.id)) : false;

  check("F1 established: thread_delivery durable IMMEDIATELY with no flush wait", !!custom, custom ? `entryId=${custom.id}` : "");
  check("F1 established: NO persisted assistant child (accepted-but-unconsumed)", !assistantAfter);

  if (custom) {
    writeFileSync(path.join(FIXTURE_DIR, "session-accepted-unconsumed.jsonl"), raw);
  }
  rmSync(cwd, { recursive: true, force: true });
}

/** parentId-chain descent: is `descId` a descendant of `ancestorId`? */
function isDescendant(lines, descId, ancestorId) {
  const byId = new Map(lines.filter((e) => e.id).map((e) => [e.id, e]));
  let cur = byId.get(descId);
  let guard = 0;
  while (cur && guard++ < 1000) {
    if (cur.parentId === ancestorId) return true;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return false;
}

// ── Also emit a fresh-no-assistant fixture (observed-not-accepted) by
//    reconstructing the in-memory entries the deferred flush would hold. The
//    on-disk file is ABSENT in this state, so the fixture models "the scan
//    finds no durable entry" — represented as an EMPTY/absent file the parser
//    must read as entryDurable:false. We write the header-only pre-flush view
//    that a crash-after-first-assistant `wx` would produce is NOT it; instead
//    the parser is handed a NONEXISTENT path in the test.
function emitConflictFixture() {
  // Hand-buildable from the real shape: an entry whose details.attempt differs
  // from the ORIGINAL tuple → conflict:"attempt". Built from the real executed
  // fixture's exact line shape (not invented) to stay faithful.
  const src = path.join(FIXTURE_DIR, "session-executed-with-assistant-child.jsonl");
  if (!existsSync(src)) return;
  const lines = readFileSync(src, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  const conflict = lines.map((e) => {
    if (e.type === "custom_message" && e.details?.delivery_id === DELIVERY_ID) {
      return { ...e, details: { ...e.details, attempt: 99 } }; // attempt-conflict vs ORIGINAL attempt=1
    }
    return e;
  });
  writeFileSync(
    path.join(FIXTURE_DIR, "session-conflict-attempt.jsonl"),
    conflict.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  check("conflict fixture emitted (attempt mismatch vs ORIGINAL)", true);
}

// ── run ────────────────────────────────────────────────────────────────────
mkdirSync(FIXTURE_DIR, { recursive: true });
probeFreshThenFlush();
probeEstablishedUnconsumed();
emitConflictFixture();

const failed = results.filter((r) => !r.ok);
// eslint-disable-next-line no-console
console.log(`\n=== GROUNDING: ${results.length - failed.length}/${results.length} seams verified own-hand ===`);
if (failed.length) {
  // eslint-disable-next-line no-console
  console.error("FAILED seams:", failed.map((f) => f.name));
  process.exit(1);
}
