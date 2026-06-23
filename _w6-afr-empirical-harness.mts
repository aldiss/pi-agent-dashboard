/**
 * W6 empirical AFR-corpus validation harness — cell
 * dashboard-memory-pressure-fix/v1 clause-(d).
 *
 * Path B (vitest-style test harness; safest per W6 brief constraint:
 * DO NOT disrupt operator's running dashboard PID 43350 on port 8000).
 *
 * Methodology:
 *   - MODE A (post-fix): replayEntriesAsEvents (post-W4) + createMemoryEventStore
 *     (post-W3) — the current canonical-source-of-truth.
 *   - MODE B (pre-fix-sim): same replay then post-process to ADD the
 *     pre-W4 full-message `message_update` for every assistant; insert
 *     through an inline pre-W3 truncator (depth>4 short-circuit, no
 *     raw_content strip, no post-walk total-cap gate; mirrors Pete-
 *     evidence-bundle § Why current code retains too much).
 *   - MODE C (saturation, post-fix): re-load AFR corpus into 10 distinct
 *     sessionIds inside the post-fix store; observe whether heap stays
 *     bounded under multi-session pressure (simulates dashboard's
 *     `activeSessions:39` live shape).
 *
 *  Per-mode isolation: each mode runs in its own block; preceding
 *  store(s) dereferenced + `global.gc()` triggered before the next
 *  snapshot so the heap snapshot reflects that mode's footprint alone.
 *
 *  Observation window: between Mode A insert and Mode A drop, sample heap
 *  every W6_SAMPLE_MS for W6_WINDOW_MS (defaults: 10s sample × 30min).
 */

import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { replayEntriesAsEvents } from "./packages/shared/src/state-replay.ts";
import { createMemoryEventStore } from "./packages/server/src/memory-event-store.ts";
import type { DashboardEvent } from "./packages/shared/src/types.ts";
import type { EventForwardMessage } from "./packages/shared/src/protocol.ts";

const AFR_JSONL =
  "/Users/vdrobkov/.pi/agent/sessions/" +
  "--Users-vdrobkov-Misc-Documents-Copilot-pi-config-pi-.pi-cells-agency-factory-research-v1--/" +
  "2026-05-31T08-46-41-161Z_019e7d36-c209-7731-ab22-5fb2048dc257.jsonl";

const SESSION_ID = "afr-empirical-019e7d36";

const OBSERVATION_WINDOW_MS = Number(
  process.env.W6_WINDOW_MS ?? 30 * 60 * 1000,
);
const SAMPLE_INTERVAL_MS = Number(process.env.W6_SAMPLE_MS ?? 10_000);
const SATURATION_SESSIONS = Number(process.env.W6_SAT_SESSIONS ?? 10);

// ---- helpers ----------------------------------------------------------------

interface Snap {
  label: string;
  ts: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
}

function snapshot(label: string): Snap {
  if (global.gc) global.gc();
  const m = process.memoryUsage();
  return {
    label,
    ts: Date.now(),
    rss: m.rss,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    external: m.external,
    arrayBuffers: m.arrayBuffers,
  };
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function fmtSnap(s: Snap): string {
  return `[${s.label}] rss=${mb(s.rss).padStart(8)} heapUsed=${mb(s.heapUsed).padStart(8)} heapTotal=${mb(s.heapTotal).padStart(8)}`;
}

function totalStoredBytes(
  events: Array<{ seq: number; event: DashboardEvent }>,
): { count: number; bytes: number; maxBytes: number; avgBytes: number } {
  let total = 0;
  let max = 0;
  for (const e of events) {
    const s = JSON.stringify(e.event).length;
    total += s;
    if (s > max) max = s;
  }
  return {
    count: events.length,
    bytes: total,
    maxBytes: max,
    avgBytes: events.length > 0 ? Math.round(total / events.length) : 0,
  };
}

// ---- pre-fix truncator (mirrors pre-W3 buggy shape) -------------------------

function preFixTruncateStrings(obj: unknown, maxSize: number, depth = 0): unknown {
  if (depth > 4) return obj; // The bug: deep nesting short-circuits.
  if (typeof obj === "string") {
    return obj.length > maxSize ? obj.slice(0, maxSize) + "\n…[truncated]" : obj;
  }
  if (Array.isArray(obj)) {
    if (obj.length > 20) return "[array truncated]";
    return obj.map((x) => preFixTruncateStrings(x, maxSize, depth + 1));
  }
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "data" && typeof v === "string" && "mimeType" in obj) {
        result[k] = v;
        continue;
      }
      if (k === "thinking" && typeof v === "string" && v.length > maxSize) {
        result[k] = v.slice(0, 500) + "\n…[truncated]";
        continue;
      }
      result[k] = preFixTruncateStrings(v, maxSize, depth + 1);
    }
    return result;
  }
  return obj;
}

function preFixCreateTruncator(maxStringSize: number) {
  if (maxStringSize <= 0) return (e: DashboardEvent) => e;
  return (event: DashboardEvent): DashboardEvent => {
    if (!event.data || typeof event.data !== "object") return event;
    const truncated = preFixTruncateStrings(event.data, maxStringSize);
    return truncated !== event.data
      ? ({ ...event, data: truncated } as DashboardEvent)
      : event;
  };
}

function makePreFixStore(maxStringSize = 4_000) {
  const truncate = preFixCreateTruncator(maxStringSize);
  const buf: Array<{ seq: number; event: DashboardEvent }> = [];
  let nextSeq = 1;
  return {
    insertEvent(_sid: string, event: DashboardEvent): number {
      const seq = nextSeq++;
      buf.push({ seq, event: truncate(event) });
      return seq;
    },
    getEvents(_sid: string, _minSeq: number) {
      return buf.slice();
    },
  };
}

/**
 * Inject the pre-W4 full-message `message_update` immediately before every
 * assistant `message_end` event (the line 96 emission deleted by W4).
 * Keeps every other emission identical to canonical replay so the only
 * delta between Mode A and Mode B input is the W3+W4 mutation pair.
 */
function injectPreW4Duplication(
  events: EventForwardMessage[],
): EventForwardMessage[] {
  const out: EventForwardMessage[] = [];
  for (const m of events) {
    if (m.event.eventType === "message_end") {
      const msg = (m.event.data as Record<string, unknown>).message;
      if (msg) {
        out.push({
          ...m,
          event: {
            eventType: "message_update",
            timestamp: m.event.timestamp,
            data: { message: msg },
          } as DashboardEvent,
        });
      }
    }
    out.push(m);
  }
  return out;
}

// ---- corpus load -----------------------------------------------------------

function loadCorpusEntries(): { entries: any[]; rawBytes: number } {
  const raw = readFileSync(AFR_JSONL, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const entries: any[] = [];
  let parseErrors = 0;
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      parseErrors++;
    }
  }
  console.log(
    `[corpus] loaded ${entries.length} entries from AFR JSONL ` +
      `(${mb(raw.length)}; parse-errors=${parseErrors})`,
  );
  return { entries, rawBytes: raw.length };
}

// ---- main ------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`[w6] node ${process.version}`);
  console.log(`[w6] AFR JSONL: ${AFR_JSONL}`);
  console.log(`[w6] observation window: ${OBSERVATION_WINDOW_MS / 1000}s sample=${SAMPLE_INTERVAL_MS / 1000}s`);
  console.log(`[w6] gc exposed: ${typeof global.gc === "function"}`);
  console.log("");

  // ---- baseline ------------------------------------------------------------
  const baseline = snapshot("baseline");
  console.log(fmtSnap(baseline));

  const { entries, rawBytes } = loadCorpusEntries();
  const afterParse = snapshot("afterParse");
  console.log(fmtSnap(afterParse));
  console.log("");

  // ---- MODE A: POST-FIX ----------------------------------------------------
  console.log("=== MODE A: POST-FIX (W3 sanitizer + W4 dup-deletion canonical) ===");
  const tA0 = performance.now();
  let synthesisedA: EventForwardMessage[] | null = replayEntriesAsEvents(SESSION_ID, entries);
  const tA1 = performance.now();
  console.log(`[A] replayEntriesAsEvents → ${synthesisedA.length} events in ${(tA1 - tA0).toFixed(1)}ms`);

  // Per-session cap=0 ⇒ unlimited (mirrors live dashboard's pinned-session shape).
  let storeA: ReturnType<typeof createMemoryEventStore> | null = createMemoryEventStore(
    () => false,
    100,
    0,
    4_000,
  );
  const tA2 = performance.now();
  for (const m of synthesisedA) storeA.insertEvent(SESSION_ID, m.event);
  const tA3 = performance.now();
  console.log(`[A] inserted ${synthesisedA.length} events in ${(tA3 - tA2).toFixed(1)}ms`);

  // Drop the input event array; sanitised copies are inside storeA.
  synthesisedA = null;

  const afterAInsert = snapshot("afterA_insert");
  console.log(fmtSnap(afterAInsert));
  const eventsA = storeA.getEvents(SESSION_ID, 1);
  const sizeA = totalStoredBytes(eventsA);
  console.log(
    `[A] stored bytes: ${mb(sizeA.bytes)} (count=${sizeA.count}; max=${mb(sizeA.maxBytes)}; avg=${(sizeA.avgBytes / 1024).toFixed(2)} KB)`,
  );

  // sample distribution: number of events that hit the summarize fallback.
  let summaryEventCount = 0;
  for (const e of eventsA) {
    const d = e.event.data as Record<string, unknown> | undefined;
    if (d && typeof d === "object" && "__summary" in d) summaryEventCount++;
  }
  console.log(`[A] summarize-fallback fired on ${summaryEventCount}/${sizeA.count} events`);
  console.log("");

  // ---- OBSERVATION WINDOW (Mode A alive) -----------------------------------
  console.log(
    `=== OBSERVATION WINDOW: ${OBSERVATION_WINDOW_MS / 1000}s, sample every ${SAMPLE_INTERVAL_MS / 1000}s ===`,
  );
  console.log("[note] holds Mode A store in scope; verifies steady-state heap stability + GC under post-fix shape.");
  const samples: Snap[] = [];
  const start = Date.now();
  while (Date.now() - start < OBSERVATION_WINDOW_MS) {
    await new Promise((r) => setTimeout(r, SAMPLE_INTERVAL_MS));
    const s = snapshot(`t=${Math.round((Date.now() - start) / 1000)}s`);
    samples.push(s);
    console.log(fmtSnap(s));
  }
  console.log(`[ref] storeA sessionCount=${storeA.sessionCount()}; eventCount=${eventsA.length}`);
  console.log("");

  // ---- MODE C: SATURATION (post-fix; N distinct sessions) ------------------
  console.log(`=== MODE C: SATURATION (${SATURATION_SESSIONS} distinct sessions; post-fix store) ===`);
  // Re-use the same store (post-fix) so we test multi-session retention.
  const beforeSat = snapshot("beforeSat");
  console.log(fmtSnap(beforeSat));
  const replayForSat = replayEntriesAsEvents("template", entries);
  const satSnaps: Snap[] = [];
  for (let i = 0; i < SATURATION_SESSIONS; i++) {
    const sid = `afr-sat-${i.toString().padStart(2, "0")}`;
    for (const m of replayForSat) {
      // clone event to avoid sharing references across "sessions"
      storeA.insertEvent(sid, { ...m.event, data: m.event.data });
    }
    const s = snapshot(`sat-after-${i + 1}-sess`);
    satSnaps.push(s);
    console.log(fmtSnap(s) + ` (storeA.sessionCount=${storeA.sessionCount()})`);
  }
  console.log("");

  // ---- MODE B: PRE-FIX SIMULATION -----------------------------------------
  console.log("=== MODE B: PRE-FIX SIMULATION (no W3 sanitizer + pre-W4 dup) ===");
  // Free Mode A first to isolate Mode B heap footprint.
  storeA = null;
  (eventsA as unknown[]).length = 0;
  const afterDropA = snapshot("afterDropA");
  console.log(fmtSnap(afterDropA));

  const tB0 = performance.now();
  let synthesisedB: EventForwardMessage[] | null = injectPreW4Duplication(
    replayEntriesAsEvents(SESSION_ID, entries),
  );
  const tB1 = performance.now();
  console.log(`[B] pre-W4 inject → ${synthesisedB.length} events in ${(tB1 - tB0).toFixed(1)}ms`);

  let storeB: ReturnType<typeof makePreFixStore> | null = makePreFixStore(4_000);
  const tB2 = performance.now();
  for (const m of synthesisedB) storeB.insertEvent(SESSION_ID, m.event);
  const tB3 = performance.now();
  console.log(`[B] inserted ${synthesisedB.length} events in ${(tB3 - tB2).toFixed(1)}ms`);
  synthesisedB = null;

  const afterBInsert = snapshot("afterB_insert");
  console.log(fmtSnap(afterBInsert));
  const eventsB = storeB.getEvents(SESSION_ID, 1);
  const sizeB = totalStoredBytes(eventsB);
  console.log(
    `[B] stored bytes: ${mb(sizeB.bytes)} (count=${sizeB.count}; max=${mb(sizeB.maxBytes)}; avg=${(sizeB.avgBytes / 1024).toFixed(2)} KB)`,
  );
  console.log("");

  // ---- DELTA ---------------------------------------------------------------
  const eventCountDelta = sizeB.count - sizeA.count;
  const storedBytesDelta = sizeB.bytes - sizeA.bytes;
  const storedBytesPct = sizeB.bytes > 0 ? (storedBytesDelta / sizeB.bytes) * 100 : 0;
  // Per-mode heap delta: insert-snapshot vs pre-insert baseline (afterParse for A, afterDropA for B).
  const heapADelta = afterAInsert.heapUsed - afterParse.heapUsed;
  const heapBDelta = afterBInsert.heapUsed - afterDropA.heapUsed;
  console.log("=== DELTA (post-fix vs pre-fix-sim) ===");
  console.log(
    `events: pre-fix=${sizeB.count} post-fix=${sizeA.count} Δ=${eventCountDelta} (${((eventCountDelta / sizeB.count) * 100).toFixed(1)}%)`,
  );
  console.log(
    `stored: pre-fix=${mb(sizeB.bytes)} post-fix=${mb(sizeA.bytes)} Δ=−${mb(storedBytesDelta)} (${storedBytesPct.toFixed(1)}% reduction)`,
  );
  console.log(
    `max event: pre-fix=${mb(sizeB.maxBytes)} post-fix=${mb(sizeA.maxBytes)} cap=30 KB`,
  );
  console.log(
    `heap delta: A insert=+${mb(heapADelta)} | B insert=+${mb(heapBDelta)}`,
  );
  console.log("");

  // ---- machine-readable JSON ----------------------------------------------
  const result = {
    nodeVersion: process.version,
    afrJsonl: AFR_JSONL,
    afrJsonlBytes: rawBytes,
    corpusEntries: entries.length,
    baseline,
    afterParse,
    modeA: {
      synthesisedEvents: sizeA.count,
      synthMs: tA1 - tA0,
      insertMs: tA3 - tA2,
      afterInsert: afterAInsert,
      heapDelta: heapADelta,
      storedBytes: sizeA,
      summaryEventCount,
    },
    saturation: {
      sessions: SATURATION_SESSIONS,
      snapshots: satSnaps,
    },
    modeB: {
      synthesisedEvents: sizeB.count,
      synthMs: tB1 - tB0,
      insertMs: tB3 - tB2,
      afterDropA,
      afterInsert: afterBInsert,
      heapDelta: heapBDelta,
      storedBytes: sizeB,
    },
    delta: {
      eventCountDelta,
      storedBytesDelta,
      storedBytesReductionPct: storedBytesPct,
    },
    observationWindowMs: OBSERVATION_WINDOW_MS,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    samples,
  };

  console.log("=== RESULT_JSON_BEGIN ===");
  console.log(JSON.stringify(result, null, 2));
  console.log("=== RESULT_JSON_END ===");

  // keep storeB referenced so we cannot dead-code-eliminate
  console.log(`[ref] storeB events=${storeB.getEvents(SESSION_ID, 1).length}`);
}

main().catch((e) => {
  console.error("[w6] FATAL:", e);
  process.exit(1);
});
