import type { RedactedHonchoPluginConfig, HonchoPluginStatus } from "../shared/types.js";
/** Poll-based config fetcher. Refreshes on `deps` change or manual trigger. */
export declare function useHonchoConfig(): {
    config: RedactedHonchoPluginConfig | null;
    loading: boolean;
    error: string | null;
    refresh: () => Promise<void>;
};
/** Fetch plugin status once. */
export declare function useHonchoStatus(): {
    status: HonchoPluginStatus | null;
    refresh: () => Promise<void>;
};
/** Check if pi-memory-honcho extension is installed. */
export declare function useExtensionInstalled(): {
    installed: boolean | null;
    checking: boolean;
    recheck: () => Promise<void>;
};
