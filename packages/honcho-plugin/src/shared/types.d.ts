/**
 * Shared types for the honcho-plugin client + server.
 *
 * Mirrors `~/.honcho/config.json` shape used by the upstream pi-memory-honcho
 * extension, plus dashboard-plugin-only fields under `mode` and `selfHost`.
 *
 * See change: honcho-dashboard-plugin (specs honcho-memory-plugin, honcho-server-lifecycle).
 */
export type LlmSource = "pi-model-proxy" | "anthropic" | "openai" | "gemini" | "openai-compatible";
export interface HonchoLlmConfig {
    source?: LlmSource;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    embeddingModel?: string;
    summaryModel?: string;
    deriverModel?: string;
}
export type StorageBackend = "host-directory" | "docker-volume" | "loop-image";
export interface HonchoSelfHostConfig {
    autoStart?: boolean;
    /** Host port for the Honcho api service (default 8765, container side stays 8000). */
    apiPort?: number;
    /** Host port for Postgres (default 5455, container side stays 5432). */
    dbPort?: number;
    migrationsApplied?: boolean;
    storageBackend?: StorageBackend;
    llm?: HonchoLlmConfig;
}
export type RecallMode = "hybrid" | "context" | "tools";
export type SessionStrategy = "per-directory" | "git-branch" | "pi-session" | "per-repo" | "global";
export interface HonchoPiHostConfig {
    endpoint?: string;
    recallMode?: RecallMode;
    sessionStrategy?: SessionStrategy;
    sessions?: Record<string, string>;
    [key: string]: unknown;
}
export interface HonchoHostsConfig {
    pi?: HonchoPiHostConfig;
    [host: string]: unknown;
}
export interface HonchoPluginConfig {
    apiKey?: string;
    peerName?: string;
    workspace?: string;
    aiPeer?: string;
    linkedHosts?: string;
    mode?: "cloud" | "self-host";
    hosts?: HonchoHostsConfig;
    selfHost?: HonchoSelfHostConfig;
    [key: string]: unknown;
}
export type HonchoPluginState = "uninstalled" | "configured" | "connected" | "syncing" | "offline" | "docker-missing" | "port-conflict" | "starting" | "running" | "stopped";
export interface HonchoPluginStatus {
    id: "honcho";
    state: HonchoPluginState;
    mode: "cloud" | "self-host";
    endpoint: string;
    cacheChars: number;
    sessionKey: string | null;
    lastError?: string;
}
export interface RedactedHonchoLlmConfig extends Omit<HonchoLlmConfig, "apiKey"> {
    apiKeySet: boolean;
    apiKeyMasked: string | null;
}
export interface RedactedHonchoSelfHostConfig extends Omit<HonchoSelfHostConfig, "llm"> {
    llm?: RedactedHonchoLlmConfig;
}
/**
 * Redacted config returned by GET /config.
 *
 * Note: HonchoPluginConfig has `[key: string]: unknown` (index signature) which
 * causes `Omit<>` to lose explicit property types. We re-declare `hosts` and
 * other known fields explicitly.
 */
export interface RedactedHonchoPluginConfig {
    apiKeySet: boolean;
    apiKeyMasked: string | null;
    peerName?: string;
    workspace?: string;
    aiPeer?: string;
    linkedHosts?: string;
    mode?: "cloud" | "self-host";
    hosts?: HonchoHostsConfig;
    selfHost?: RedactedHonchoSelfHostConfig;
    [key: string]: unknown;
}
export interface InterviewRequest {
    content: string;
}
export interface InterviewResponse {
    ok: boolean;
    conclusionId?: string;
    error?: string;
}
export interface SessionUpsertRequest {
    cwd: string;
    name: string;
}
export interface SessionDeleteRequest {
    cwd: string;
}
export interface SessionMutateResponse {
    ok: boolean;
}
export interface DoctorCheck {
    id: string;
    status: "ok" | "warn" | "fail";
    detail?: string;
}
export interface DoctorResponse {
    checks: DoctorCheck[];
}
export interface SyncResponse {
    ok: boolean;
    forwarded: number;
}
export interface ServerLifecycleResponse {
    ok: boolean;
    status: HonchoPluginStatus;
    error?: string;
}
export interface ModelEntry {
    id: string;
    displayName: string;
    supportsTools: boolean;
    contextWindow?: number;
    notes?: string;
}
export interface SourceModelsResponse {
    available: boolean;
    reachable: boolean;
    stale: boolean;
    lastFetched: string | null;
    models: ModelEntry[];
    error?: string;
}
export interface AggregateModelsResponse {
    sources: Record<LlmSource, SourceModelsResponse>;
}
