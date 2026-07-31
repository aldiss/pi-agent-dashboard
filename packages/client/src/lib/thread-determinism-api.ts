/**
 * Tier-1 read-only visibility — the DETERMINISM overlay client contract +
 * fetcher (dl-13423). The `/threads` view and the NOS determinism-model are "two
 * halves of one thing": the thread shows how work is being done; this fetcher
 * reads the model's `project(thread_id)` fold so the overlay can show each
 * thread's `stage` + its deterministic-vs-judgment pending edges.
 *
 * Sister-shape to `thread-handoff-lane-api.ts`: an injectable fetcher whose
 * default is the live REST read, swapped for a fixture-backed fetcher in the
 * demo + tests. READ-ONLY — it fetches + renders, it drives nothing and confers
 * no authority.
 *
 * The projection types are imported TYPE-ONLY from shared: the runtime fixture
 * loader is Node/fs and must never enter the browser bundle. This module is
 * browser-safe (fetch + types).
 */
import { getApiBase } from "./api-context.js";
import type { DeterminismProjection } from "@blackbelt-technology/pi-dashboard-shared/thread-durability/tier1/determinism-projection.js";

export type {
  DeterminismProjection,
  PendingTransition,
  DeterministicPending,
  JudgmentPending,
  TransitionKind,
  DegradeKind,
  DeterminismStage,
} from "@blackbelt-technology/pi-dashboard-shared/thread-durability/tier1/determinism-projection.js";

/**
 * An injectable determinism fetcher: `threadId → the thread's projection`, or
 * `null` when the model is not bound (endpoint unregistered / held activation).
 * The live client resolves this to the REST read; the demo/tests resolve it to
 * the frozen fixture. Same injectable shape as `handoffFetcher`.
 *
 * A `null` result means "no determinism binding available" (render nothing); a
 * non-null projection with `degrade:"unmapped"` means "bound, but this thread is
 * not in the machine yet" (render the honest not-mapped badge). The two are
 * distinct: absent binding vs. present-but-unmapped.
 */
export type DeterminismFetcher = (threadId: string) => Promise<DeterminismProjection | null>;

/**
 * Fetch one thread's determinism projection (read-only). Degrades GRACEFULLY:
 * an unregistered route (held-activation — the fixture-backed route is not wired
 * into `server.ts` yet) 404s → `null` (the overlay renders nothing), never a
 * crash. A malformed body degrades the same way. A present-but-unmapped thread
 * comes back as a real projection with `degrade:"unmapped"` — that is NOT null
 * and NOT an error.
 */
export async function fetchDeterminism(threadId: string): Promise<DeterminismProjection | null> {
  const res = await fetch(`${getApiBase()}/api/threads/${encodeURIComponent(threadId)}/determinism`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`determinism request failed (${res.status})`);
  const body = await res.json();
  if (!body?.success || !body.data?.projection) return null;
  return body.data.projection as DeterminismProjection;
}
