/**
 * Client-side fetch helpers for the honcho plugin REST API.
 *
 * All endpoints scoped under /api/plugins/honcho/.
 */
import type { RedactedHonchoPluginConfig, HonchoPluginConfig, HonchoPluginStatus, DoctorResponse, SyncResponse, InterviewResponse, ServerLifecycleResponse, AggregateModelsResponse } from "../shared/types.js";
export declare function fetchConfig(): Promise<RedactedHonchoPluginConfig>;
export declare function saveConfig(partial: Partial<HonchoPluginConfig>): Promise<RedactedHonchoPluginConfig>;
export declare function upsertSessionMapping(cwd: string, name: string): Promise<{
    ok: boolean;
}>;
export declare function deleteSessionMapping(cwd: string): Promise<{
    ok: boolean;
}>;
export declare function runDoctor(): Promise<DoctorResponse>;
export declare function triggerSync(): Promise<SyncResponse>;
export declare function submitInterview(content: string): Promise<InterviewResponse>;
export declare function fetchStatus(): Promise<HonchoPluginStatus>;
export declare function serverStart(): Promise<ServerLifecycleResponse>;
export declare function serverStop(): Promise<ServerLifecycleResponse>;
export declare function serverRestart(): Promise<ServerLifecycleResponse>;
export declare function fetchModels(): Promise<AggregateModelsResponse>;
export declare function refreshModels(source?: string): Promise<{
    ok: boolean;
}>;
export declare function checkExtensionInstalled(): Promise<boolean>;
export declare function installExtension(): Promise<void>;
