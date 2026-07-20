/**
 * Tier-1 /threads DEMO harness (dev-only). Mounts the read-only ThreadsView in
 * its three demo postures — SEED / EMPTY / BUILDING — with the injectable
 * fixtures (no live server, no network). Used to render-and-look the surface
 * across form factors; NOT part of the production rollup input (index.html is
 * the sole prod entry), so this is additive + demo-scoped.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "./components/ThemeProvider.js";
import { SkinProvider } from "./components/SkinProvider.js";
import { MobileProvider } from "./hooks/useMobile.js";
import { ThreadsView } from "./components/ThreadsView.js";
import {
  seedThreadsListFetcher,
  emptyThreadsListFetcher,
  buildingThreadsListFetcher,
  seedHandoffLaneFetcher,
  buildingHandoffLaneFetcher,
  seedDeliveredManager,
  SEED_THREAD_DELIVERED,
} from "./lib/tier1-threads-seed.js";
import type { ReadonlySessionManagerLike } from "@blackbelt-technology/pi-dashboard-shared/thread-durability/tier1/cloned-session-facade.js";
import "./index.css";

/** Only the delivered seed thread has a durable message lane in the demo. */
const seedManagerProvider = (threadId: string): ReadonlySessionManagerLike | null =>
  threadId === SEED_THREAD_DELIVERED ? seedDeliveredManager() : null;

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div
      className="rounded-xl border overflow-hidden flex flex-col"
      style={{ borderColor: "var(--border-secondary)", background: "var(--bg-primary)", height: 720 }}
    >
      <div className="px-4 py-2 border-b" style={{ borderColor: "var(--border-secondary)", background: "var(--bg-secondary)" }}>
        <div className="text-xs font-bold" style={{ color: "var(--text-primary)" }}>{title}</div>
        <div className="text-[10px]" style={{ color: "var(--text-muted)" }}>{subtitle}</div>
      </div>
      <div className="flex-1 min-h-0 flex flex-col">{children}</div>
    </div>
  );
}

function ThreadsDemo() {
  return (
    <div style={{ background: "var(--bg-primary)", minHeight: "100vh" }} className="p-4">
      <h1 className="text-base font-bold mb-1" style={{ color: "var(--text-primary)" }}>
        Tier-1 /threads — read-only visibility (demo)
      </h1>
      <p className="text-[11px] mb-4" style={{ color: "var(--text-muted)" }}>
        Additive, read-only, partial history. Seed / empty / building-degrade — no live server.
      </p>
      <div className="flex flex-col gap-6">
        <Section title="SEED" subtitle="threads + per-thread status + the 3 labeled lanes (message via P1 facade, status/hand-off empty)">
          <ThreadsView
            fetcher={seedThreadsListFetcher}
            messageLaneProvider={seedManagerProvider}
            handoffFetcher={seedHandoffLaneFetcher}
          />
        </Section>
        <Section title="EMPTY" subtitle="registered-but-empty durable store — clean empty-state">
          <ThreadsView fetcher={emptyThreadsListFetcher} />
        </Section>
        <Section title="BUILDING / NOT YET WIRED" subtitle="endpoints unregistered (held activation) — graceful degrade">
          <ThreadsView fetcher={buildingThreadsListFetcher} handoffFetcher={buildingHandoffLaneFetcher} />
        </Section>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <SkinProvider>
        <MobileProvider>
          <ThreadsDemo />
        </MobileProvider>
      </SkinProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
