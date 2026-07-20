/**
 * Thread-view SEED fixtures — demonstration data covering EVERY lifecycle state.
 *
 * The durable outbox is EMPTY until the held drain loop activates (routes no
 * real prompts yet), so the thread-view is demonstrated with this fixture: one
 * delivery per display state (`injecting → queued_executing → observed →
 * accepted → executed → delivered`, plus `failed` and `indeterminate`) matching
 * the exact `ThreadDeliverySnapshot` REST shape, plus a clean empty thread.
 *
 * Shape-faithful to `thread-view-routes.ts`: each row is a real
 * `ThreadDeliverySnapshot` (`+ lease?` for the live indeterminate overlay).
 */
import type { ThreadDeliveriesResult } from "./thread-view-api.js";
import type { ThreadViewDelivery } from "./thread-view-api.js";

const THREAD_ID = "thread-ledger-demo";
const BASE_TS = 1_752_000_000_000; // fixed (no Date.now — deterministic fixture)

/** One delivery per lifecycle state, in rail order + the two off-rail terminals. */
export const SEED_DELIVERIES: ThreadViewDelivery[] = [
  {
    delivery_id: "dlv-0001-injecting",
    thread_id: THREAD_ID,
    attempt: 1,
    state: "injecting",
    revision: 0,
    delivered: false,
    updated_at: BASE_TS + 1_000,
  },
  {
    delivery_id: "dlv-0002-queued",
    thread_id: THREAD_ID,
    attempt: 1,
    state: "queued_executing",
    revision: 1,
    delivered: false,
    updated_at: BASE_TS + 2_000,
  },
  {
    delivery_id: "dlv-0003-observed",
    thread_id: THREAD_ID,
    attempt: 1,
    state: "observed",
    revision: 2,
    delivered: false,
    entry_id: "entry-3a9f",
    updated_at: BASE_TS + 3_000,
  },
  {
    delivery_id: "dlv-0004-accepted",
    thread_id: THREAD_ID,
    attempt: 1,
    state: "accepted",
    revision: 3,
    delivered: false,
    entry_id: "entry-71c4",
    updated_at: BASE_TS + 4_000,
  },
  {
    delivery_id: "dlv-0005-executed",
    thread_id: THREAD_ID,
    attempt: 1,
    state: "executed",
    revision: 4,
    delivered: false,
    entry_id: "entry-88be",
    updated_at: BASE_TS + 5_000,
  },
  {
    delivery_id: "dlv-0006-delivered",
    thread_id: THREAD_ID,
    attempt: 1,
    state: "executed",
    revision: 5,
    delivered: true, // the barrier promotes executed → delivered (exactly-once)
    entry_id: "entry-0feb",
    updated_at: BASE_TS + 6_000,
  },
  {
    delivery_id: "dlv-0007-failed",
    thread_id: THREAD_ID,
    attempt: 2, // re-armed to attempt 2 after a correlated failure
    state: "failed",
    revision: 6,
    delivered: false,
    updated_at: BASE_TS + 7_000,
  },
  {
    delivery_id: "dlv-0008-indeterminate",
    thread_id: THREAD_ID,
    attempt: 1,
    state: "queued_executing", // outbox row holds its durable state…
    revision: 2,
    delivered: false,
    lease: "indeterminate", // …the live lease overlay surfaces it (never dropped)
    updated_at: BASE_TS + 8_000,
  },
];

/** The demo thread id the seed deliveries belong to. */
export const SEED_THREAD_ID = THREAD_ID;

/** A populated fetcher result (all eight states) for stories/tests. */
export const SEED_RESULT: ThreadDeliveriesResult = {
  deliveries: SEED_DELIVERIES,
  endpointAvailable: true,
};

/** An empty-but-registered thread (clean "no deliveries yet" state). */
export const EMPTY_RESULT: ThreadDeliveriesResult = {
  deliveries: [],
  endpointAvailable: true,
};

/** An unregistered endpoint (held-until-A4/B3) — graceful degrade state. */
export const UNREGISTERED_RESULT: ThreadDeliveriesResult = {
  deliveries: [],
  endpointAvailable: false,
};

/** Injectable fetchers for stories/tests (no live server). */
export const seedFetcher = async () => SEED_RESULT;
export const emptyFetcher = async () => EMPTY_RESULT;
export const unregisteredFetcher = async () => UNREGISTERED_RESULT;
