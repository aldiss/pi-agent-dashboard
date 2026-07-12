import type { RedactedHonchoPluginConfig, HonchoPluginConfig } from "../shared/types.js";
interface Props {
    config: RedactedHonchoPluginConfig;
    onSave: (partial: Partial<HonchoPluginConfig>) => Promise<void>;
    saving: boolean;
}
export declare function ModeSection({ config, onSave, saving }: Props): import("react/jsx-runtime").JSX.Element;
export {};
