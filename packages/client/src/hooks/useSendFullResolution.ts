// ---------------------------------------------------------------------------
// useSendFullResolution — global, localStorage-backed "send full-resolution"
// override for attached images.
//
// Default false → images are downscaled at send-time (see lib/image-resize.ts).
// Flip true to send originals untouched (rare — when the model needs full
// detail). Backed by a module-level value + listener set so a plain getter is
// available at send-time (App reads getSendFullResolution() without a React
// subscription) while the toggle UI stays reactive via useSyncExternalStore.
// ---------------------------------------------------------------------------

import { useSyncExternalStore } from "react";

const STORAGE_KEY = "dashboard:send-full-resolution"; // matches existing "dashboard:skin" style

function read(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

let current = read();
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/** Plain read (no React) — used at send-time. */
export function getSendFullResolution(): boolean {
  return current;
}

/** Writes localStorage + notifies subscribers (and, via the storage event,
 *  other tabs). */
export function setSendFullResolution(next: boolean): void {
  current = next;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, next ? "true" : "false");
    }
  } catch {
    /* noop */
  }
  notify();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // Best-effort cross-tab sync: pick up writes from other tabs.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    current = event.newValue === "true";
    onChange();
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  return () => {
    listeners.delete(onChange);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

/** Reactive [value, setter] for UI. */
export function useSendFullResolution(): [boolean, (next: boolean) => void] {
  const value = useSyncExternalStore(subscribe, getSendFullResolution, getSendFullResolution);
  return [value, setSendFullResolution];
}
