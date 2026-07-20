/**
 * Tier-1 read-only visibility — the client thread contracts + read-only fetchers
 * (design v0.3 Tier-1 §"What Tier-1 IS" #1 + #2; the P2 /threads UI).
 *
 * READ-ONLY. This module NEVER mutates: it defines the display view-models and
 * the fetchers that read the P1 read-model. It confers no recovery/dedup/
 * terminal authority — it only projects what the core already decided.
 *
 * `ThreadStatus*` MIRRORS the server P1 `thread-status-read.ts` contract. The
 * client cannot import the server package, so — exactly as `thread-view-api.ts`
 * mirrors the shared `ThreadDeliverySnapshot` — the status shape is re-declared
 * here structurally. It is the SAME verdict the server read produces; this file
 * only renders it. If the server contract changes, this mirror changes with it
 * (kept honest by the fixture tests + the server unit tests).
 *
 * GRACEFUL DEGRADE is the Tier-1 posture everywhere: the P1 status/list
 * endpoints are NOT wired into `server.ts` (activation-tier), so a live fetch
 * 404s today. Every fetcher degrades that to `endpointAvailable:false` +
 * `building` — a clean "not yet wired" surface, never a crash and never a
 * fabricated status.
 */
import { getApiBase } from "./api-context.js";

// ── P1 status mirror (thread-status-read.ts) ───────────────────────────────

/**
 * The Tier-1 status KIND — a MIRROR of the server P1 `ThreadStatusKind`. Coarse
 * by design: Tier-1 DISPLAYS the current barrier, it does not re-derive the
 * six-state machine. `building` = the "not yet wired" graceful-degrade.
 */
export type ThreadStatusKind =
  | "building"
  | "in_flight"
  | "delivered"
  | "failed"
  | "corrupt";

/** MIRROR of the server P1 `ThreadStatusReason` (machine-readable degrade/fail). */
export type ThreadStatusReason =
  | "substrate_absent"
  | "no_rows"
  | "unknown_state"
  | "delivered_without_executed"
  | "invalid_revision"
  | "invalid_attempt";

/**
 * The current-status projection of one thread — a MIRROR of the server P1
 * `ThreadStatus`. Read-only, no history: the verdict is read from ONE committed
 * row, never inferred from a progression.
 */
export interface ThreadStatus {
  thread_id: string;
  kind: ThreadStatusKind;
  delivery_id?: string;
  state?: string;
  revision?: number;
  reason?: ThreadStatusReason;
}

/**
 * Per-kind display metadata — theme-safe CSS-var accent tokens only (no
 * hardcoded hex), the B5 `ThreadView` discipline. `building`/`corrupt` carry a
 * per-reason caption so the "why" of a degrade is legible, never a bare label.
 */
export const STATUS_META: Record<
  ThreadStatusKind,
  { label: string; meaning: string; accent: string }
> = {
  building: {
    label: "building",
    meaning: "not yet wired — the durable outbox substrate is mid-build for this thread",
    accent: "var(--text-muted)",
  },
  in_flight: {
    label: "in flight",
    meaning: "a delivery is in motion — not yet at the durable terminal barrier",
    accent: "var(--accent-blue)",
  },
  delivered: {
    label: "delivered",
    meaning: "authoritative TerminalProof — delivered at the executed terminal (monotonic)",
    accent: "var(--accent-green)",
  },
  failed: {
    label: "failed",
    meaning: "the current row's claim is terminally failed (a correlated failure)",
    accent: "var(--accent-red)",
  },
  corrupt: {
    label: "corrupt",
    meaning: "fail-loud — the current row violates a core invariant; never coerced to a plausible status",
    accent: "var(--accent-orange)",
  },
};

/** Human caption for a degrade/fail reason (shown under a building/corrupt pill). */
export const REASON_CAPTION: Record<ThreadStatusReason, string> = {
  substrate_absent: "the outbox read is unavailable (mid-build)",
  no_rows: "the substrate exists but this thread has no rows yet",
  unknown_state: "row.state is not one of the six committed states",
  delivered_without_executed: "delivered barrier set without the executed terminal",
  invalid_revision: "revision is not a finite ≥0 integer",
  invalid_attempt: "attempt is not a finite ≥0 integer",
};

// ── thread summary + tree (list view) ──────────────────────────────────────

/**
 * One row in the /threads list. `parent_thread_id` is OPTIONAL and absent today
 * (no subthreads exist until Tier-2 creates them) → the list renders flat. When
 * Tier-2 lands and stamps a parent, the SAME data nests into a tree for free
 * (no rework). `title`/`cwd` are display hints only.
 */
export interface ThreadSummary {
  thread_id: string;
  parent_thread_id?: string | null;
  title?: string;
  cwd?: string;
  status: ThreadStatus;
}

/** A node in the rendered thread tree (children nest under a parent). */
export interface ThreadNode {
  summary: ThreadSummary;
  children: ThreadNode[];
  /**
   * Depth in the tree (0 = root). Flat today (every node depth 0). Drives the
   * indent so the tree renders correctly the instant Tier-2 stamps a parent.
   */
  depth: number;
  /**
   * Set when this node was PROMOTED to a root by the sanitize pass — its
   * declared `parent_thread_id` was dangling (points at no known thread) or
   * cycle-trapped. Carries a breadcrumb of the severed parent so the promotion
   * is honest, never silent.
   */
  promotedFrom?: string;
}

/**
 * Build the thread tree (pure): group by `parent_thread_id` if present, else a
 * flat list. Runs a SANITIZE pass over the COMPLETE input (design v0.3 Tier-1
 * §"Tree sanitize"): any node whose parent is dangling (unknown id) or
 * cycle-trapped is PROMOTED to a root with a `promotedFrom` breadcrumb — never
 * dropped, never allowed to form an infinite render. Asserts
 * emitted-count == input-count (a lost/duplicated node is a bug, surfaced loud).
 *
 * Flat today: with no `parent_thread_id` anywhere, every node is a depth-0 root
 * and this reduces to a stable flat list (input order preserved).
 */
export function buildThreadTree(summaries: readonly ThreadSummary[]): ThreadNode[] {
  const byId = new Map<string, ThreadSummary>();
  for (const s of summaries) byId.set(s.thread_id, s);

  // Resolve each node's EFFECTIVE root-or-parent: walk the parent chain; if it
  // dangles (unknown id) or loops (revisit), the node is promoted to a root and
  // we record the severed parent id as the breadcrumb.
  const promotedFrom = new Map<string, string | undefined>();
  function effectiveParent(s: ThreadSummary): string | null {
    const declared = s.parent_thread_id ?? null;
    if (declared === null) return null; // a genuine root
    if (!byId.has(declared)) {
      promotedFrom.set(s.thread_id, declared); // dangling → promote, breadcrumb
      return null;
    }
    // Cycle guard: walk up; if we revisit ourselves, the edge is cyclic.
    const seen = new Set<string>([s.thread_id]);
    let cursor: string | null = declared;
    while (cursor !== null) {
      if (seen.has(cursor)) {
        promotedFrom.set(s.thread_id, declared); // cycle-trapped → promote
        return null;
      }
      seen.add(cursor);
      const parent = byId.get(cursor);
      cursor = parent?.parent_thread_id ?? null;
      if (cursor !== null && !byId.has(cursor)) cursor = null;
    }
    return declared;
  }

  const nodes = new Map<string, ThreadNode>();
  for (const s of summaries) {
    nodes.set(s.thread_id, { summary: s, children: [], depth: 0, promotedFrom: promotedFrom.get(s.thread_id) });
  }

  const roots: ThreadNode[] = [];
  for (const s of summaries) {
    const node = nodes.get(s.thread_id)!;
    const parentId = effectiveParent(s);
    node.promotedFrom = promotedFrom.get(s.thread_id);
    if (parentId === null) {
      roots.push(node);
    } else {
      nodes.get(parentId)!.children.push(node);
    }
  }

  // Stamp depth by walking from each root (input order preserved at each level).
  function stampDepth(node: ThreadNode, depth: number) {
    node.depth = depth;
    for (const child of node.children) stampDepth(child, depth + 1);
  }
  for (const root of roots) stampDepth(root, 0);

  // Sanitize assertion: every input node appears exactly once in the forest.
  let emitted = 0;
  function count(node: ThreadNode) {
    emitted++;
    for (const child of node.children) count(child);
  }
  for (const root of roots) count(root);
  if (emitted !== summaries.length) {
    // A lost/duplicated node is a real bug — surface it loud, never silently.
    throw new Error(
      `buildThreadTree: emitted ${emitted} nodes but received ${summaries.length} — tree sanitize invariant violated`,
    );
  }

  return roots;
}

// ── fetch results + fetchers (graceful degrade) ────────────────────────────

/** Result of the /threads list fetch — distinguishes "unregistered" from data. */
export interface ThreadsListResult {
  threads: ThreadSummary[];
  /** False when the endpoint is unregistered/404 (held-activation) → held empty-state. */
  endpointAvailable: boolean;
}

/**
 * Fetch the durable delivery-threads list (read-only). Degrades GRACEFULLY: an
 * unregistered route (the held-until-activation state — `server.ts` not wired)
 * 404s → `endpointAvailable:false` + no threads (a clean "not yet wired"
 * empty-state), never a crash. A malformed body degrades the same way.
 */
export async function fetchThreadsList(): Promise<ThreadsListResult> {
  const res = await fetch(`${getApiBase()}/api/threads`);
  if (res.status === 404) return { threads: [], endpointAvailable: false };
  if (!res.ok) throw new Error(`threads-list request failed (${res.status})`);
  const body = await res.json();
  if (!body?.success) return { threads: [], endpointAvailable: false };
  const threads: ThreadSummary[] = body.data?.threads ?? [];
  return { threads, endpointAvailable: true };
}

/** Result of a per-thread status fetch. */
export interface ThreadStatusResult {
  status: ThreadStatus;
  endpointAvailable: boolean;
}

/**
 * Fetch one thread's authoritative current status (read-only). Degrades to a
 * `building` verdict (`substrate_absent`) + `endpointAvailable:false` when the
 * endpoint is unregistered — the SAME graceful-degrade the server P1 read
 * applies when the outbox substrate is absent, so the UI is consistent whether
 * the substrate or the route is the thing that is mid-build.
 */
export async function fetchThreadStatus(threadId: string): Promise<ThreadStatusResult> {
  const building: ThreadStatus = { thread_id: threadId, kind: "building", reason: "substrate_absent" };
  const res = await fetch(`${getApiBase()}/api/threads/${encodeURIComponent(threadId)}/status`);
  if (res.status === 404) return { status: building, endpointAvailable: false };
  if (!res.ok) throw new Error(`thread-status request failed (${res.status})`);
  const body = await res.json();
  if (!body?.success || !body.data?.status) return { status: building, endpointAvailable: false };
  return { status: body.data.status as ThreadStatus, endpointAvailable: true };
}
