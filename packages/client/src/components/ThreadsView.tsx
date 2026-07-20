/**
 * ThreadsView — the read-only `/threads` visibility surface (design v0.3 Tier-1,
 * P2). The durable delivery-threads the core already tracks, as:
 *
 *   • a TREE by `parent_thread_id` if present, else a FLAT list (flat today — no
 *     subthreads exist until Tier-2 — but the SAME data nests for free the
 *     instant Tier-2 stamps a parent: no rework);
 *   • per-thread CURRENT-STATUS from the P1 `thread-status-read` verdict
 *     (`ThreadStatusBadge`), including the "building / not yet wired"
 *     graceful-degrade;
 *   • on select, the THREE source-separated, read-only history lanes
 *     (`ThreadHistoryLanes`) — message (through the P1 facade, M11 off) / status
 *     (empty until Tier-3) / hand-off (empty until the A4 verb).
 *
 * READ-ONLY, additive: this view creates no thread, drives no routing, writes
 * nothing, confers no authority. It DISPLAYS the P1 read-model. Everything
 * degrades gracefully when the P1 endpoints are unregistered (held activation) —
 * demonstrated with seed / empty / building fixtures (the outbox is empty until
 * the held drain loop activates, like B5).
 *
 * Client-cost honesty: the list + the embedded message lane render the existing
 * PLAIN lists — virtualization is DEFERRED (a subsystem rewrite). Long lists
 * render every row; this view does not claim O(page).
 *
 * Theme-safe: CSS-var tokens only (the B5 discipline) — every theme renders.
 */
import React, { useMemo, useState } from "react";
import { Icon } from "@mdi/react";
import { mdiSourceBranch, mdiChevronRight, mdiTrayFull, mdiFolderNetworkOutline } from "@mdi/js";
import { ThreadStatusBadge } from "./ThreadStatusBadge.js";
import { ThreadHistoryLanes } from "./ThreadHistoryLanes.js";
import { useThreadsList, type ThreadsListFetcher } from "../hooks/useThreadsList.js";
import { buildThreadTree, type ThreadNode, type ThreadSummary } from "../lib/tier1-threads-api.js";
import { buildMessageLaneStateFromManager } from "../lib/thread-message-lane.js";
import type { ReadonlySessionManagerLike } from "@blackbelt-technology/pi-dashboard-shared/thread-durability/tier1/cloned-session-facade.js";
import type { HandoffLaneResult } from "../lib/thread-handoff-lane-api.js";
import { fetchHandoffLane } from "../lib/thread-handoff-lane-api.js";

/**
 * A message-lane provider: threadId → a `ReadonlySessionManagerLike` (or null
 * when the thread has no durable session yet). The live client resolves this to
 * the real session manager (server-cloned via the P1 facade over REST); the
 * demo/tests resolve it to a fixture manager. Read THROUGH the P1 facade inside
 * `buildMessageLaneStateFromManager` — never the raw manager.
 */
export type MessageLaneManagerProvider = (threadId: string) => ReadonlySessionManagerLike | null;

interface Props {
  /** Injectable list fetcher (default = live REST; demo/tests feed fixtures). */
  fetcher?: ThreadsListFetcher;
  /** Injectable message-lane manager provider (default = none → empty lane). */
  messageLaneProvider?: MessageLaneManagerProvider;
  /** Injectable hand-off lane fetcher (default = live REST). */
  handoffFetcher?: (threadId: string) => Promise<HandoffLaneResult>;
}

/** One selectable row in the thread list (indented by tree depth). */
function ThreadRow({
  node,
  selected,
  onSelect,
}: {
  node: ThreadNode;
  selected: boolean;
  onSelect: (threadId: string) => void;
}) {
  const s = node.summary;
  return (
    <button
      type="button"
      onClick={() => onSelect(s.thread_id)}
      data-testid="thread-row"
      data-thread-id={s.thread_id}
      aria-pressed={selected}
      className="w-full text-left rounded-md border px-3 py-2 transition-colors hover:brightness-110"
      style={{
        marginLeft: node.depth * 16,
        borderColor: selected ? "var(--accent-primary)" : "var(--border-secondary)",
        background: selected ? "color-mix(in srgb, var(--accent-primary) 10%, var(--bg-surface))" : "var(--bg-surface)",
      }}
    >
      <div className="flex items-center gap-2">
        <Icon path={mdiChevronRight} size={0.6} style={{ color: "var(--text-muted)" }} />
        <span className="text-xs font-semibold truncate" style={{ color: "var(--text-primary)" }}>
          {s.title ?? s.thread_id}
        </span>
        <span className="flex-1" />
        <ThreadStatusBadge status={s.status} variant="compact" />
      </div>
      <div className="mt-1 flex items-center gap-2">
        <span className="text-[10px] truncate" style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          {s.thread_id}
        </span>
        {node.promotedFrom && (
          <span
            className="text-[9px] px-1 py-0.5 rounded"
            style={{ color: "var(--accent-orange)", backgroundColor: "color-mix(in srgb, var(--accent-orange) 14%, transparent)" }}
            title={`Declared parent ${node.promotedFrom} was dangling or cyclic — promoted to a root`}
            data-testid="thread-row-promoted"
          >
            promoted · parent {node.promotedFrom}
          </span>
        )}
      </div>
    </button>
  );
}

/** Flatten the tree to a render list (pre-order) so indentation reads top-down. */
function flattenTree(nodes: ThreadNode[]): ThreadNode[] {
  const out: ThreadNode[] = [];
  function walk(node: ThreadNode) {
    out.push(node);
    for (const child of node.children) walk(child);
  }
  for (const n of nodes) walk(n);
  return out;
}

/** The detail panel for a selected thread: full status + the three lanes. */
function ThreadDetail({
  summary,
  messageLaneProvider,
  handoffFetcher,
}: {
  summary: ThreadSummary;
  messageLaneProvider?: MessageLaneManagerProvider;
  handoffFetcher: (threadId: string) => Promise<HandoffLaneResult>;
}) {
  // Build the message-lane state THROUGH the P1 facade (the provider yields a
  // ReadonlySessionManagerLike; the builder wraps it in createClonedSessionFacade).
  const messageLaneState = useMemo(() => {
    const mgr = messageLaneProvider?.(summary.thread_id) ?? null;
    if (!mgr) return null;
    return buildMessageLaneStateFromManager(mgr, summary.thread_id);
  }, [messageLaneProvider, summary.thread_id]);

  // Hand-off lane — empty until the A4 verb; endpointAvailable distinguishes
  // "held/unregistered" from "genuinely empty".
  const [handoff, setHandoff] = useState<HandoffLaneResult>({ events: [], endpointAvailable: true });
  React.useEffect(() => {
    let cancelled = false;
    handoffFetcher(summary.thread_id)
      .then((r) => { if (!cancelled) setHandoff(r); })
      .catch(() => { if (!cancelled) setHandoff({ events: [], endpointAvailable: false }); });
    return () => { cancelled = true; };
  }, [handoffFetcher, summary.thread_id]);

  return (
    <div className="flex flex-col gap-3 min-h-0" data-testid="thread-detail" data-thread-id={summary.thread_id}>
      <div
        className="rounded-lg border px-3 py-2.5 flex flex-col gap-2"
        style={{ borderColor: "var(--border-secondary)", background: "var(--bg-surface)" }}
      >
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold truncate" style={{ color: "var(--text-primary)" }}>
            {summary.title ?? summary.thread_id}
          </h3>
          <span className="flex-1" />
          <span className="text-[10px] truncate" style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            {summary.thread_id}
          </span>
        </div>
        <ThreadStatusBadge status={summary.status} variant="full" />
      </div>
      <ThreadHistoryLanes
        messageLaneState={messageLaneState}
        handoffEvents={handoff.events}
        handoffEndpointAvailable={handoff.endpointAvailable}
      />
    </div>
  );
}

export function ThreadsView({ fetcher, messageLaneProvider, handoffFetcher = fetchHandoffLane }: Props) {
  const { threads, isLoading, error, endpointAvailable } = useThreadsList(fetcher);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Build the tree (flat today) once per thread-list change. Pure + sanitized.
  const tree = useMemo(() => buildThreadTree(threads), [threads]);
  const rows = useMemo(() => flattenTree(tree), [tree]);

  // Default-select the first thread once loaded (so the detail is never blank
  // when data exists). Kept as an effect so selection survives re-render.
  React.useEffect(() => {
    if (selectedId === null && rows.length > 0) setSelectedId(rows[0].summary.thread_id);
  }, [rows, selectedId]);

  const selected = rows.find((r) => r.summary.thread_id === selectedId)?.summary ?? null;

  return (
    <div className="flex-1 flex flex-col min-h-0" data-testid="threads-view">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b" style={{ borderColor: "var(--border-secondary)" }}>
        <Icon path={mdiSourceBranch} size={0.85} style={{ color: "var(--text-secondary)" }} />
        <div className="flex flex-col min-w-0">
          <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Threads</h2>
          <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
            durable delivery-threads · read-only · partial history (Tier-1)
          </span>
        </div>
        <span className="flex-1" />
        {!isLoading && !error && endpointAvailable && threads.length > 0 && (
          <span className="text-[10px] tabular-nums" style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }} data-testid="threads-count">
            {threads.length} {threads.length === 1 ? "thread" : "threads"}
          </span>
        )}
      </div>

      {/* Body: list (left) + detail (right). Single-column stacks on narrow. */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {isLoading ? (
          <p className="text-xs py-8 text-center" style={{ color: "var(--text-muted)" }} data-testid="threads-loading">
            Loading threads…
          </p>
        ) : error ? (
          <p className="text-xs py-8 text-center" style={{ color: "var(--accent-red)" }} data-testid="threads-error">
            {error}
          </p>
        ) : !endpointAvailable ? (
          <ThreadsEmpty
            testid="threads-unregistered"
            icon={mdiFolderNetworkOutline}
            title="Thread visibility not yet wired"
            body="The durable outbox + the Tier-1 read endpoints are in place but held until activation. No delivery-threads are being routed yet — when the held drain loop activates, they appear here with their current status and history lanes."
          />
        ) : threads.length === 0 ? (
          <ThreadsEmpty
            testid="threads-empty"
            icon={mdiTrayFull}
            title="No durable threads yet"
            body="The durable store is reachable but holds no delivery-threads yet. When a thread is created and its first delivery is injected, it appears here."
          />
        ) : (
          <div className="flex flex-col lg:flex-row gap-4 p-4 min-h-0">
            {/* List column */}
            <div className="lg:w-[320px] shrink-0 flex flex-col gap-1.5" data-testid="threads-list">
              {rows.map((node) => (
                <ThreadRow
                  key={node.summary.thread_id}
                  node={node}
                  selected={node.summary.thread_id === selectedId}
                  onSelect={setSelectedId}
                />
              ))}
              <p className="mt-1 px-1 text-[9px] leading-snug" style={{ color: "var(--text-muted)" }}>
                Flat today — no subthreads exist until Tier-2. The same data nests into a tree the instant a parent thread is stamped (no rework).
              </p>
            </div>
            {/* Detail column */}
            <div className="flex-1 min-w-0" data-testid="threads-detail-pane">
              {selected ? (
                <ThreadDetail
                  key={selected.thread_id}
                  summary={selected}
                  messageLaneProvider={messageLaneProvider}
                  handoffFetcher={handoffFetcher}
                />
              ) : (
                <p className="text-xs py-8 text-center" style={{ color: "var(--text-muted)" }}>
                  Select a thread to see its status + history lanes.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Shared empty / unregistered state — a calm, intentional placeholder (B5 shape). */
function ThreadsEmpty({ testid, icon, title, body }: { testid: string; icon: string; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-6" data-testid={testid}>
      <div
        className="mb-3 flex items-center justify-center rounded-full"
        style={{ width: 48, height: 48, background: "var(--bg-tertiary)", color: "var(--text-muted)" }}
      >
        <Icon path={icon} size={1} />
      </div>
      <p className="text-sm font-semibold mb-1" style={{ color: "var(--text-secondary)" }}>{title}</p>
      <p className="text-[11px] leading-snug max-w-md" style={{ color: "var(--text-muted)" }}>{body}</p>
    </div>
  );
}
