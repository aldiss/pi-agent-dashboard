import type { RedactedHonchoPluginConfig, HonchoPluginConfig, HonchoPluginStatus } from "../shared/types.js";
interface Props {
    config: RedactedHonchoPluginConfig;
    status: HonchoPluginStatus | null;
    onSave: (partial: Partial<HonchoPluginConfig>) => Promise<void>;
    saving: boolean;
    onRefreshStatus: () => void;
}
export declare function ServerSection({ config, status, onSave, saving, onRefreshStatus }: Props): import("react/jsx-runtime").JSX.Element;
export {};
