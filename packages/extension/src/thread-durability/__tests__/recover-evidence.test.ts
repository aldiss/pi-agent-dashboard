/**
 * B3 recover-evidence — tests (design v3.6 §C3.2, the F1 gate).
 *
 * The scan is unit-tested against REAL fixture session-JSONL emitted by the
 * run-the-API grounding probe (`__grounding__/run-the-api-probe.mjs`) driving
 * the actual pi 0.80.3 SessionManager — NOT hand-invented shapes. The four
 * §C3.4-case fixtures:
 *   - executed-with-assistant-child  → durable execution (do-not-redeliver)
 *   - accepted-unconsumed            → durable entry, NO assistant child (F1)
 *   - absent file                    → volatile / observed (redeliver)
 *   - conflict-attempt               → attempt mismatch vs ORIGINAL (fail-loud)
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  scanDurableEvidence,
  resolveHolderLiveness,
  createRecoverEvidenceResolver,
  parseSessionEntries,
  type LivenessProbe,
  type OutboxEntryView,
} from "../recover-evidence.js";
import type { HolderIdentity } from "@blackbelt-technology/pi-dashboard-shared/thread-durability/index.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const readFix = (name: string) => fs.readFileSync(path.join(FIX, name), "utf-8");

const EXECUTED = "session-executed-with-assistant-child.jsonl";
const UNCONSUMED = "session-accepted-unconsumed.jsonl";
const CONFLICT = "session-conflict-attempt.jsonl";

// ── the fixtures exist (grounding evidence committed) ──────────────────────

describe("grounding fixtures present (emitted by the run-the-API probe)", () => {
  it("all three real-pi fixtures are on disk", () => {
    expect(fs.existsSync(path.join(FIX, EXECUTED))).toBe(true);
    expect(fs.existsSync(path.join(FIX, UNCONSUMED))).toBe(true);
    expect(fs.existsSync(path.join(FIX, CONFLICT))).toBe(true);
  });

  it("fixtures have the real pi JSONL shape: header line + custom_message with details.delivery_id", () => {
    const entries = parseSessionEntries(readFix(EXECUTED));
    expect(entries[0].type).toBe("session"); // SessionHeader first
    const custom = entries.find((e) => e.type === "custom_message");
    expect(custom?.customType).toBe("thread_delivery");
    expect(custom?.details?.delivery_id).toBe("dlv-probe-0001");
  });
});

// ── scanDurableEvidence against REAL fixtures (the F1 correctness core) ─────

describe("scanDurableEvidence — executed (assistant child persisted)", () => {
  it("entry durable + persisted assistant DESCENDANT → executed evidence", () => {
    const ev = scanDurableEvidence(readFix(EXECUTED), { delivery_id: "dlv-probe-0001", attempt: 1 });
    expect(ev.entryDurable).toBe(true);
    expect(ev.hasPersistedAssistantChild).toBe(true);
    expect(ev.executedClaimCorroborated).toBe(true);
    expect(ev.conflict).toBeNull();
  });
});

describe("scanDurableEvidence — accepted-but-unconsumed (F1)", () => {
  it("entry durable but assistant is an ANCESTOR, not a child → NO execution evidence", () => {
    const ev = scanDurableEvidence(readFix(UNCONSUMED), { delivery_id: "dlv-probe-0002", attempt: 1 });
    expect(ev.entryDurable).toBe(true);
    expect(ev.hasPersistedAssistantChild).toBe(false); // the F1 gate — never false-prove execution
    expect(ev.executedClaimCorroborated).toBe(false);
    expect(ev.conflict).toBeNull();
  });
});

describe("scanDurableEvidence — volatile / observed (delivery absent from the file)", () => {
  it("a delivery_id not present in the session → entryDurable false (redeliver, never drop)", () => {
    const ev = scanDurableEvidence(readFix(EXECUTED), { delivery_id: "dlv-NOT-IN-FILE", attempt: 1 });
    expect(ev.entryDurable).toBe(false);
    expect(ev.hasPersistedAssistantChild).toBe(false);
    expect(ev.conflict).toBeNull();
  });

  it("empty text (fresh-session unflushed JSONL) → entryDurable false", () => {
    const ev = scanDurableEvidence("", { delivery_id: "dlv-probe-0001", attempt: 1 });
    expect(ev.entryDurable).toBe(false);
  });
});

describe("scanDurableEvidence — conflict (attempt mismatch vs ORIGINAL)", () => {
  it("durable entry whose details.attempt != expected → conflict:'attempt' (fail-loud upstream)", () => {
    // The conflict fixture has attempt=99 baked into the real entry shape.
    const ev = scanDurableEvidence(readFix(CONFLICT), { delivery_id: "dlv-probe-0001", attempt: 1 });
    expect(ev.entryDurable).toBe(true);
    expect(ev.conflict).toBe("attempt");
  });

  it("entry_id mismatch vs a previously-observed entry_id → conflict:'entry'", () => {
    const ev = scanDurableEvidence(readFix(EXECUTED), { delivery_id: "dlv-probe-0001", attempt: 1, entry_id: "WRONG-ENTRY-ID" });
    expect(ev.conflict).toBe("entry");
  });
});

describe("scanDurableEvidence — bind by delivery_id, never by text/position (§C3.4 case 5)", () => {
  it("a second delivery with the same content but a different delivery_id is NOT matched", () => {
    // EXECUTED holds dlv-probe-0001; asking for a different id yields no durable entry.
    const ev = scanDurableEvidence(readFix(EXECUTED), { delivery_id: "dlv-probe-XXXX", attempt: 1 });
    expect(ev.entryDurable).toBe(false);
  });
});

// ── exact-identity liveness (never a bare PID — Alice E3) ───────────────────

const CLAIM: HolderIdentity = { pid: 4242, session_id: "sess-A", start_epoch: 1000 };

function probe(over: Partial<LivenessProbe> & { alive?: boolean; startEpoch?: number | null; sessionId?: string | null } = {}): LivenessProbe {
  return {
    isAlive: () => over.alive ?? true,
    startEpochOf: () => (over.startEpoch === undefined ? 1000 : over.startEpoch),
    sessionIdOf: over.sessionId !== undefined ? () => over.sessionId! : undefined,
  };
}

describe("resolveHolderLiveness — exact-identity, reuse-safe", () => {
  it("exact tuple match (pid+session+epoch) → live", () => {
    expect(resolveHolderLiveness(CLAIM, probe({ alive: true, startEpoch: 1000, sessionId: "sess-A" }))).toBe("live");
  });

  it("process dead → exact_death", () => {
    expect(resolveHolderLiveness(CLAIM, probe({ alive: false }))).toBe("exact_death");
  });

  it("REUSED pid: alive but different start_epoch → exact_death (never false-prove liveness)", () => {
    expect(resolveHolderLiveness(CLAIM, probe({ alive: true, startEpoch: 9999, sessionId: "sess-A" }))).toBe("exact_death");
  });

  it("REUSED pid: alive, same epoch by luck but different session_id → exact_death", () => {
    expect(resolveHolderLiveness(CLAIM, probe({ alive: true, startEpoch: 1000, sessionId: "sess-OTHER" }))).toBe("exact_death");
  });

  it("alive but start_epoch unknowable → conservative exact_death (never hold-forever on a maybe-reused pid)", () => {
    expect(resolveHolderLiveness(CLAIM, probe({ alive: true, startEpoch: null }))).toBe("exact_death");
  });
});

// ── the composed resolver (I/O layer) ───────────────────────────────────────

function entryView(over: Partial<OutboxEntryView> = {}): OutboxEntryView {
  return {
    delivery_id: "dlv-probe-0001",
    attempt: 1,
    holder_session_id: "sess-A",
    holder_identity: { ...CLAIM },
    payload_hash: "hash-1",
    ...over,
  };
}

describe("createRecoverEvidenceResolver — composed scan + liveness", () => {
  it("scanEvidence reads the holder's real session file by session_id", () => {
    const resolver = createRecoverEvidenceResolver({
      sessionFilePath: (sid) => (sid === "sess-A" ? path.join(FIX, EXECUTED) : null),
      liveness: probe({ alive: false }),
    });
    const ev = resolver.scanEvidence(entryView());
    expect(ev.entryDurable).toBe(true);
    expect(ev.hasPersistedAssistantChild).toBe(true);
  });

  it("absent session file (fresh/unflushed) → volatile evidence (E1)", () => {
    const resolver = createRecoverEvidenceResolver({
      sessionFilePath: () => "/nonexistent/path/xyz.jsonl",
      liveness: probe({ alive: false }),
    });
    expect(resolver.scanEvidence(entryView()).entryDurable).toBe(false);
  });

  it("null session-file path → volatile evidence", () => {
    const resolver = createRecoverEvidenceResolver({
      sessionFilePath: () => null,
      liveness: probe({ alive: false }),
    });
    expect(resolver.scanEvidence(entryView()).entryDurable).toBe(false);
  });

  it("resolveLiveness delegates to the exact-identity probe", () => {
    const resolver = createRecoverEvidenceResolver({
      sessionFilePath: () => null,
      liveness: probe({ alive: true, startEpoch: 1000, sessionId: "sess-A" }),
    });
    expect(resolver.resolveLiveness(entryView())).toBe("live");
  });

  it("leaseElapsed is forwarded when provided", () => {
    const resolver = createRecoverEvidenceResolver({
      sessionFilePath: () => null,
      liveness: probe({ alive: true }),
      leaseElapsed: () => true,
    });
    expect(resolver.leaseElapsed?.(entryView())).toBe(true);
  });
});
