/**
 * In-memory cache of each session's most-recently-pushed model catalogue.
 *
 * The bridge pushes a `models_list` `{ sessionId, models: ModelInfo[] }` over WS
 * on session_start/connect and on `request_models`. The server caches the latest
 * snapshot PER SESSION — this is the same source the dashboard model-picker uses,
 * and the faithful set of models a given session can actually switch to.
 *
 * Unlike `provider-catalogue-cache.ts` (one global catalogue, last-push-wins,
 * because a `ProviderInfo` catalogue is a property of machine auth/provider
 * config and identical across every bridge), the model catalogue is read here
 * keyed by sessionId: the resurrection verify-gate's alt-model resolver
 * (`defaultResolveAltModel`) needs the toggle target for ONE specific session,
 * and `ProviderInfo` carries no models field so the provider cache cannot serve
 * it. This cache has NO pi-ai dependency (contrast the server model registry,
 * which is unavailable on real machines where pi-ai is nested under managed
 * `pi-coding-agent`).
 *
 * See change: unend-mechanism-v2.
 */
import type { ModelInfo } from "@blackbelt-technology/pi-dashboard-shared/types.js";

const bySession = new Map<string, ModelInfo[]>();

/**
 * Replace the cached model catalogue for a session. Called from event-wiring.ts
 * on every `models_list` arrival (alongside the existing browser broadcast).
 */
export function setModelsForSession(sessionId: string, models: ModelInfo[]): void {
  bySession.set(sessionId, models);
}

/**
 * The session's most-recently-pushed model catalogue. Returns [] when no bridge
 * has pushed yet — callers treat that as "waiting for pi" and may issue a
 * `request_models` nudge to fetch one.
 */
export function getModelsForSession(sessionId: string): ModelInfo[] {
  return bySession.get(sessionId) ?? [];
}

/** Test-only: reset all cached state. */
export function _resetForTests(): void {
  bySession.clear();
}
