/**
 * Tier-1 read-only visibility — SEED fixtures + injectable fetchers for the
 * /threads UI (design v0.3 Tier-1; the P2 demo layer). Sister-shape to
 * `thread-view-seed.ts` (the B5 seed): the durable outbox + the P1 endpoints are
 * EMPTY/unregistered until activation, so the UI is demonstrated with fixtures.
 *
 * Three demo postures the /threads UI must show (per the brief):
 *   1. SEED     — a thread WITH a status + a populated message lane + empty
 *                 status/hand-off lanes (honest labels + gap badges).
 *   2. EMPTY    — the clean "no durable threads yet" empty-state.
 *   3. BUILDING — the graceful-degrade: endpoints unregistered → every thread
 *                 reads `building` ("not yet wired"), lanes empty.
 *
 * The message-lane seed is read THROUGH the P1 cloned-DTO facade: the fixture
 * `ReadonlySessionManagerLike` below is wrapped by `createClonedSessionFacade`
 * in `buildMessageLaneStateFromManager`, exactly as a live server would wrap the
 * real `ReadonlySessionManager`. That proves the seam in the demo, not just in
 * a unit test.
 */
import type {
  ReadonlySessionManagerLike,
  SessionEntryDto,
  SessionHeaderDto,
  SessionTreeNodeDto,
} from "@blackbelt-technology/pi-dashboard-shared/thread-durability/tier1/cloned-session-facade.js";
import type {
  ThreadSummary,
  ThreadsListResult,
  ThreadStatusResult,
  ThreadStatus,
} from "./tier1-threads-api.js";
import type { HandoffLaneResult } from "./thread-handoff-lane-api.js";

// ── seed thread ids ────────────────────────────────────────────────────────

export const SEED_THREAD_DELIVERED = "thread-onboarding-flow";
export const SEED_THREAD_INFLIGHT = "thread-nightly-report";
export const SEED_THREAD_BUILDING = "thread-fresh-spawn";

// ── the message-lane seed entries (durable session JSONL shape) ─────────────

/**
 * A faithful slice of a durable session's on-disk entries for the DELIVERED
 * seed thread: ordinary user/assistant content INTERLEAVED with a
 * `thread_delivery` custom_message provenance row, plus a run of 3 identical
 * consecutive tool calls. The tool run is deliberate: on the live chat those 3
 * collapse into a ×N pill (grouping ON); on THIS lane, M11 keeps them as 3
 * distinct native rows (grouping OFF) — the seed lets that difference be seen.
 *
 * Shapes match pi 0.80.3 (grounded own-hand): a `message` entry wraps
 * `{role, content}`; a tool call is an assistant `content[]` `toolCall` block;
 * a tool result is a `message` with `role:"toolResult"`.
 */
const SEED_ENTRIES_DELIVERED: SessionEntryDto[] = [
  {
    type: "message",
    id: "e-001",
    parentId: null,
    timestamp: "2026-07-20T09:00:00.000Z",
    message: { role: "user", content: "Kick off the onboarding flow for the new workspace." },
  } as SessionEntryDto,
  {
    type: "message",
    id: "e-002",
    parentId: "e-001",
    timestamp: "2026-07-20T09:00:02.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "On it — I'll provision the workspace, then verify it's reachable." },
        { type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "curl -s localhost:8000/health" } },
      ],
    },
  } as unknown as SessionEntryDto,
  {
    type: "message",
    id: "e-003",
    parentId: "e-002",
    timestamp: "2026-07-20T09:00:03.000Z",
    message: {
      role: "toolResult",
      toolCallId: "tc-1",
      toolName: "bash",
      content: [{ type: "text", text: "curl: (7) connection refused" }],
      isError: true,
    },
  } as unknown as SessionEntryDto,
  {
    type: "message",
    id: "e-004",
    parentId: "e-003",
    timestamp: "2026-07-20T09:00:05.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Not up yet — polling until it answers." },
        { type: "toolCall", id: "tc-2", name: "bash", arguments: { command: "curl -s localhost:8000/health" } },
      ],
    },
  } as unknown as SessionEntryDto,
  {
    type: "message",
    id: "e-005",
    parentId: "e-004",
    timestamp: "2026-07-20T09:00:06.000Z",
    message: {
      role: "toolResult",
      toolCallId: "tc-2",
      toolName: "bash",
      content: [{ type: "text", text: "curl: (7) connection refused" }],
      isError: true,
    },
  } as unknown as SessionEntryDto,
  {
    type: "message",
    id: "e-006",
    parentId: "e-005",
    timestamp: "2026-07-20T09:00:08.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tc-3", name: "bash", arguments: { command: "curl -s localhost:8000/health" } },
      ],
    },
  } as unknown as SessionEntryDto,
  {
    type: "message",
    id: "e-007",
    parentId: "e-006",
    timestamp: "2026-07-20T09:00:09.000Z",
    message: {
      role: "toolResult",
      toolCallId: "tc-3",
      toolName: "bash",
      content: [{ type: "text", text: '{"status":"ok"}' }],
      isError: false,
    },
  } as unknown as SessionEntryDto,
  // The durable thread_delivery provenance row (custom_message). This is the
  // entry the message lane must surface (native, un-grouped) — NOT ordinary chat.
  {
    type: "custom_message",
    customType: "thread_delivery",
    id: "e-008",
    parentId: "e-007",
    timestamp: "2026-07-20T09:00:10.000Z",
    content: "Onboarding workspace reachable — handing the delivery to the durable outbox.",
    display: "Onboarding workspace reachable — handing the delivery to the durable outbox.",
    details: { delivery_id: "dlv-onb-0001", thread_id: SEED_THREAD_DELIVERED, attempt: 1, holder_epoch: 4 },
  } as unknown as SessionEntryDto,
  {
    type: "message",
    id: "e-009",
    parentId: "e-008",
    timestamp: "2026-07-20T09:00:12.000Z",
    message: { role: "assistant", content: "Workspace is live and the onboarding delivery is durable. Done." },
  } as SessionEntryDto,
];

const SEED_HEADER_DELIVERED: SessionHeaderDto = {
  type: "session",
  id: SEED_THREAD_DELIVERED,
  cwd: "/Users/dev/workspaces/onboarding",
  timestamp: "2026-07-20T09:00:00.000Z",
};

/**
 * A minimal in-memory `ReadonlySessionManagerLike` over a fixed entry list —
 * the fixture the message lane reads THROUGH the P1 facade. Getters return the
 * raw fixture objects; the facade clones + freezes them (so this fixture need
 * not itself freeze). Mirrors the real manager's getter surface only as far as
 * the message lane consumes it.
 */
export function createFixtureManager(
  entries: SessionEntryDto[],
  header: SessionHeaderDto,
): ReadonlySessionManagerLike {
  const byId = new Map(entries.map((e) => [e.id, e]));
  return {
    getCwd: () => header.cwd,
    getSessionId: () => header.id,
    getSessionDir: () => `/fixture/${header.id}`,
    getSessionFile: () => `/fixture/${header.id}/session.jsonl`,
    getSessionName: () => header.id,
    getLeafId: () => entries[entries.length - 1]?.id ?? null,
    getLeafEntry: () => entries[entries.length - 1],
    getEntry: (id: string) => byId.get(id),
    getBranch: () => entries.slice(),
    getEntries: () => entries.slice(),
    getTree: (): SessionTreeNodeDto[] => entries.map((entry) => ({ entry, children: [] })),
    getHeader: () => header,
    getLabel: () => undefined,
  };
}

/** The delivered seed thread's fixture manager (read through the P1 facade). */
export function seedDeliveredManager(): ReadonlySessionManagerLike {
  return createFixtureManager(SEED_ENTRIES_DELIVERED, SEED_HEADER_DELIVERED);
}

// ── seed statuses + summaries ──────────────────────────────────────────────

const STATUS_DELIVERED: ThreadStatus = {
  thread_id: SEED_THREAD_DELIVERED,
  kind: "delivered",
  delivery_id: "dlv-onb-0001",
  state: "executed",
  revision: 5,
};
const STATUS_INFLIGHT: ThreadStatus = {
  thread_id: SEED_THREAD_INFLIGHT,
  kind: "in_flight",
  delivery_id: "dlv-rpt-0002",
  state: "accepted",
  revision: 2,
};
const STATUS_BUILDING: ThreadStatus = {
  thread_id: SEED_THREAD_BUILDING,
  kind: "building",
  reason: "no_rows",
};

export const SEED_SUMMARIES: ThreadSummary[] = [
  { thread_id: SEED_THREAD_DELIVERED, parent_thread_id: null, title: "Onboarding flow", cwd: "/Users/dev/workspaces/onboarding", status: STATUS_DELIVERED },
  { thread_id: SEED_THREAD_INFLIGHT, parent_thread_id: null, title: "Nightly report", cwd: "/Users/dev/workspaces/reports", status: STATUS_INFLIGHT },
  { thread_id: SEED_THREAD_BUILDING, parent_thread_id: null, title: "Fresh spawn", cwd: "/Users/dev/workspaces/scratch", status: STATUS_BUILDING },
];

/** Map a seed thread id → its seed status (for the per-thread status fetcher). */
const SEED_STATUS_BY_ID = new Map<string, ThreadStatus>(
  SEED_SUMMARIES.map((s) => [s.thread_id, s.status]),
);

// ── injectable fetchers (seed / empty / building) ──────────────────────────

/** SEED: the full three-thread list (delivered + in-flight + building). */
export const seedThreadsListFetcher = async (): Promise<ThreadsListResult> => ({
  threads: SEED_SUMMARIES,
  endpointAvailable: true,
});

/** EMPTY: a registered-but-empty durable store (clean empty-state). */
export const emptyThreadsListFetcher = async (): Promise<ThreadsListResult> => ({
  threads: [],
  endpointAvailable: true,
});

/** BUILDING: the endpoint is unregistered (held activation) — degrade. */
export const buildingThreadsListFetcher = async (): Promise<ThreadsListResult> => ({
  threads: [],
  endpointAvailable: false,
});

/** SEED: resolve a thread's seed status; unknown ids degrade to building. */
export const seedThreadStatusFetcher = async (threadId: string): Promise<ThreadStatusResult> => {
  const status = SEED_STATUS_BY_ID.get(threadId);
  if (!status) return { status: { thread_id: threadId, kind: "building", reason: "no_rows" }, endpointAvailable: true };
  return { status, endpointAvailable: true };
};

/** BUILDING: status endpoint unregistered → building/substrate_absent. */
export const buildingThreadStatusFetcher = async (threadId: string): Promise<ThreadStatusResult> => ({
  status: { thread_id: threadId, kind: "building", reason: "substrate_absent" },
  endpointAvailable: false,
});

/**
 * Hand-off lane fetcher — EMPTY for every seed thread (the A4
 * `thread-holder-change` verb has not landed, so there are genuinely no
 * hand-off events yet). `endpointAvailable:true` so the lane renders its honest
 * "empty until A4" label rather than the unregistered degrade.
 */
export const seedHandoffLaneFetcher = async (): Promise<HandoffLaneResult> => ({
  events: [],
  endpointAvailable: true,
});

/** BUILDING: hand-off endpoint unregistered → empty + degrade. */
export const buildingHandoffLaneFetcher = async (): Promise<HandoffLaneResult> => ({
  events: [],
  endpointAvailable: false,
});
