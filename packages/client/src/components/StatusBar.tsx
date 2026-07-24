import React from "react";
import { Icon } from "@mdi/react";
import { mdiLoading, mdiFlash } from "@mdi/js";
import { ModelSelector } from "./ModelSelector.js";
import { ThinkingLevelSelector } from "./ThinkingLevelSelector.js";
import { BellToggle } from "./BellToggle.js";
import type { ModelInfo, RoleInfo } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import {
  composeStatusString,
  renderOperatorString,
  type OperatorString,
} from "@blackbelt-technology/pi-dashboard-shared/operator-string.js";
import { operatorProseToolLabel } from "@blackbelt-technology/pi-dashboard-shared/operator-tool-visibility.js";

interface Props {
  model?: string;
  models?: ModelInfo[];
  roles?: RoleInfo;
  thinkingLevel?: string;
  status: "idle" | "streaming" | "ended";
  currentTool?: string;
  streamingText?: string;
  onSelectModel: (model: string) => void;
  onSelectThinkingLevel: (level: string) => void;
  onRoleSet?: (role: string, modelId: string) => void;
  onPresetLoad?: (presetName: string) => void;
  onPresetSave?: (presetName: string) => void;
  onPresetDelete?: (presetName: string) => void;
  /** Per-session bell toggle state */
  bellState?: "off" | "on" | "auto";
  /** Called when bell is clicked — cycles to next state */
  onBellClick?: () => void;
  /** Whether push is enabled/configured. Bell hidden when false. */
  pushEnabled?: boolean;
}

export function StatusBar({ model, models, roles, thinkingLevel, status, currentTool, streamingText, onSelectModel, onSelectThinkingLevel, onRoleSet, onPresetLoad, onPresetSave, onPresetDelete, bellState, onBellClick, pushEnabled }: Props) {
  // statusLabel is an OperatorString (Phase-2 / Ruling #3): it is constructible
  // ONLY via composeStatusString(typed StatusKind) — a raw string assigned here
  // fails to typecheck (the nominal brand). This binds the OperatorString
  // primitive to the real status renderer (F6).
  let statusLabel: OperatorString | null = null;
  let statusIcon = mdiLoading;
  let toolHighlight = false;

  if (status === "streaming") {
    if (currentTool) {
      statusLabel = composeStatusString({
        kind: "running",
        tool: operatorProseToolLabel(currentTool) ?? currentTool,
      });
      statusIcon = mdiFlash;
      toolHighlight = true;
    } else if (streamingText) {
      statusLabel = composeStatusString({ kind: "generating" });
    } else {
      statusLabel = composeStatusString({ kind: "thinking" });
    }
  }

  return (
    <div className="flex items-center justify-between px-4 py-1 border-t border-[var(--border-primary)] text-xs" data-testid="status-bar">
      <div className="flex items-center gap-2">
        <ModelSelector current={model} models={models} roles={roles} onSelect={onSelectModel} onRoleSet={onRoleSet} onPresetLoad={onPresetLoad} onPresetSave={onPresetSave} onPresetDelete={onPresetDelete} />
        <ThinkingLevelSelector current={thinkingLevel} onSelect={onSelectThinkingLevel} />
        {status !== "ended" && pushEnabled !== false && bellState && onBellClick && (
          <BellToggle state={bellState} onClick={onBellClick} />
        )}
      </div>

      <div className="flex items-center gap-2">
        {statusLabel && (
          <div className="flex items-center gap-1.5 text-[var(--text-secondary)]" data-testid="working-status">
            <Icon
              path={statusIcon}
              size={0.5}
              spin={statusIcon === mdiLoading}
              className={toolHighlight ? "text-yellow-400" : ""}
            />
            <span>{renderOperatorString(statusLabel)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
