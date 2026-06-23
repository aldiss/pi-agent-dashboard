import React, { useState } from "react";
import { Icon } from "@mdi/react";
import { mdiCheck, mdiBellOutline, mdiBell, mdiRobotOutline, mdiHeadLightbulb } from "@mdi/js";
import { DialogPortal } from "./DialogPortal.js";
import type { ModelInfo } from "@blackbelt-technology/pi-dashboard-shared/types.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const BELL_ICON = { off: mdiBellOutline, on: mdiBell, auto: mdiRobotOutline } as const;
const BELL_LABEL = {
  off: { title: "Notifications off", desc: "no completion notification" },
  on: { title: "Notify on completion", desc: "push when this session finishes" },
  auto: { title: "Notify — auto", desc: "agent decides when to notify" },
} as const;

interface Props {
  /** Session display name, for the sheet subtitle. */
  sessionName?: string;
  /** Current model as "provider/id". */
  currentModel?: string;
  /** Available models for this session. */
  models?: ModelInfo[];
  /** Current thinking level. */
  thinkingLevel?: string;
  /** Per-session bell state. undefined → bell row hidden. */
  bellState?: "off" | "on" | "auto";
  /** Whether push is configured. false → bell row hidden. */
  pushEnabled?: boolean;
  onSelectModel: (model: string) => void;
  onSelectThinkingLevel: (level: string) => void;
  onCycleBell?: () => void;
  onClose: () => void;
}

/**
 * Mobile "Model & reasoning" bottom sheet — the mobile-parity MVP. Surfaces
 * the model picker + thinking segmented-control + per-session bell that were
 * desktop-only (gated `!isMobile` in the StatusBar). Springs up from the
 * tappable model row in the mobile chat header. Tokenized, so it wears the
 * editorial warm skin or the legacy skin automatically.
 */
export function ModelReasoningSheet({
  sessionName,
  currentModel,
  models,
  thinkingLevel,
  bellState,
  pushEnabled,
  onSelectModel,
  onSelectThinkingLevel,
  onCycleBell,
  onClose,
}: Props) {
  const [providerFilter, setProviderFilter] = useState<string>("");

  const providers = models ? [...new Set(models.map((m) => m.provider))].sort() : [];
  const filtered = models
    ? models.filter((m) => !providerFilter || m.provider === providerFilter)
    : [];

  const showBell = pushEnabled !== false && !!bellState && !!onCycleBell;
  const currentLevel = thinkingLevel ?? "off";

  return (
    <DialogPortal>
      {/* Scrim — tap to dismiss */}
      <div
        className="fixed inset-0 z-[60] bg-[var(--bg-overlay)] editorial-sheet-scrim"
        onClick={onClose}
        data-testid="model-sheet-scrim"
      />
      {/* Sheet */}
      <div
        className="fixed inset-x-0 bottom-0 z-[61] max-h-[88vh] flex flex-col rounded-t-3xl border-t border-[var(--border-secondary)] bg-[var(--bg-secondary)] shadow-2xl editorial-sheet"
        style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
        role="dialog"
        aria-label="Model and reasoning"
        data-testid="model-sheet"
      >
        {/* Grab handle */}
        <div className="shrink-0 pt-2.5 pb-1 flex justify-center">
          <span className="w-10 h-1.5 rounded-full bg-[var(--border-secondary)]" />
        </div>

        <div className="px-5 pb-1 shrink-0">
          <h3 className="editorial-heading text-xl font-semibold text-[var(--text-primary)]">
            Model &amp; reasoning
          </h3>
          <p className="editorial-meta text-[11px] text-[var(--text-tertiary)] mt-0.5">
            switch mid-session{sessionName ? ` · ${sessionName}` : ""}
          </p>
        </div>

        <div className="overflow-y-auto px-5 pt-3 flex-1">
          {/* Provider filter chips */}
          {providers.length > 1 && (
            <div className="flex gap-2 mb-3 flex-wrap" data-testid="sheet-provider-chips">
              <FilterChip label="All" active={providerFilter === ""} onClick={() => setProviderFilter("")} />
              {providers.map((p) => (
                <FilterChip key={p} label={p} active={providerFilter === p} onClick={() => setProviderFilter(p)} />
              ))}
            </div>
          )}

          {/* Model list */}
          <div className="space-y-1.5" data-testid="sheet-model-list">
            {filtered.length === 0 ? (
              <div className="text-sm text-[var(--text-muted)] py-3">No models available</div>
            ) : (
              filtered.map((m) => {
                const label = `${m.provider}/${m.id}`;
                const selected = label === currentModel;
                return (
                  <button
                    key={label}
                    onClick={() => {
                      onSelectModel(label);
                      onClose();
                    }}
                    className={`w-full flex items-center gap-2 min-h-[48px] px-3.5 rounded-xl border text-left transition-colors ${
                      selected
                        ? "border-[var(--accent-primary)] bg-[var(--accent-soft,var(--bg-tertiary))]"
                        : "border-[var(--border-secondary)] bg-[var(--bg-tertiary)] hover:bg-[var(--bg-hover)]"
                    }`}
                    data-testid={`sheet-model-${label}`}
                    aria-pressed={selected}
                  >
                    <span className={`editorial-meta text-[13px] truncate flex-1 ${selected ? "text-[var(--accent-primary)] font-semibold" : "text-[var(--text-primary)]"}`}>
                      {m.id}
                    </span>
                    <span className="editorial-meta text-[10px] text-[var(--text-tertiary)] shrink-0">{m.provider}</span>
                    {selected && <Icon path={mdiCheck} size={0.7} className="text-[var(--accent-primary)] shrink-0" />}
                  </button>
                );
              })
            )}
          </div>

          {/* Thinking level segmented control */}
          <div className="mt-5">
            <div className="editorial-meta text-[10px] uppercase tracking-[0.18em] text-[var(--text-tertiary)] mb-2 flex items-center gap-1.5">
              <Icon path={mdiHeadLightbulb} size={0.5} /> Thinking level
            </div>
            <div
              className="grid grid-cols-3 gap-1.5 p-1 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-secondary)]"
              data-testid="sheet-thinking-seg"
            >
              {THINKING_LEVELS.map((level) => {
                const active = level === currentLevel;
                return (
                  <button
                    key={level}
                    onClick={() => onSelectThinkingLevel(level)}
                    className={`min-h-[40px] rounded-lg text-[13px] font-medium transition-colors editorial-meta ${
                      active
                        ? "bg-[var(--status-think,var(--accent-primary))] text-white"
                        : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                    }`}
                    data-testid={`sheet-thinking-${level}`}
                    aria-pressed={active}
                  >
                    {level}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Bell toggle row */}
          {showBell && (
            <button
              onClick={onCycleBell}
              className="mt-5 w-full flex items-center gap-3 min-h-[56px] px-4 rounded-xl bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-left hover:bg-[var(--bg-hover)] transition-colors"
              data-testid="sheet-bell"
            >
              <Icon
                path={BELL_ICON[bellState!]}
                size={0.85}
                className={bellState === "off" ? "text-[var(--text-tertiary)]" : "text-[var(--accent-primary)]"}
              />
              <span className="flex-1">
                <span className="block text-sm font-semibold text-[var(--text-primary)]">{BELL_LABEL[bellState!].title}</span>
                <span className="editorial-meta block text-[11px] text-[var(--text-tertiary)] mt-0.5">{BELL_LABEL[bellState!].desc}</span>
              </span>
              <span className="editorial-meta text-[11px] uppercase tracking-wider text-[var(--accent-primary)] shrink-0">{bellState}</span>
            </button>
          )}
        </div>
      </div>
    </DialogPortal>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`editorial-meta px-3 py-1.5 rounded-full text-xs border transition-colors min-h-[36px] ${
        active
          ? "bg-[var(--accent-primary)] border-[var(--accent-primary)] text-white font-semibold"
          : "border-[var(--border-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
      }`}
    >
      {label}
    </button>
  );
}
