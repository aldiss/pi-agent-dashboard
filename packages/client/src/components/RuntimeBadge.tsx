import React from "react";
import type { SessionRuntime } from "@blackbelt-technology/pi-dashboard-shared/types.js";

export function RuntimeBadge({ runtime }: { runtime?: SessionRuntime }) {
  if (runtime !== "codex") return null;
  return (
    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-emerald-500/15 text-emerald-300 border-emerald-500/40 shrink-0" title="Codex app-server">
      Codex
    </span>
  );
}
