import React, { useState, useRef, useEffect } from "react";
import { Icon } from "@mdi/react";
import {
  mdiDotsVertical,
  mdiPencilOutline,
  mdiEyeOffOutline,
  mdiEyeOutline,
  mdiPlay,
  mdiSourceFork,
  mdiOpenInNew,
  mdiHeartPulse,
  mdiSourceBranch,
  mdiLinkVariant,
  mdiCompassOutline,
  mdiFastForward,
  mdiPlayCircleOutline,
  mdiCheckCircleOutline,
  mdiArchiveOutline,
  mdiChevronRight,
  mdiRefresh,
} from "@mdi/js";
import type { DashboardSession, OpenSpecChange, ImageContent } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { ChangeState, deriveChangeState } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { DetectedEditor } from "../lib/editor-api.js";
import { ExploreDialog } from "./ExploreDialog.js";
import { NewChangeDialog } from "./NewChangeDialog.js";
import { DialogPortal } from "./DialogPortal.js";
import { ContextUsageBar } from "./ContextUsageBar.js";

interface Props {
  session: DashboardSession;
  editors?: DetectedEditor[];
  openspecChanges?: OpenSpecChange[];
  onRename?: () => void;
  onHide?: () => void;
  onUnhide?: () => void;
  onResume?: (mode: "continue" | "fork") => void;
  /** Read-only liveness re-check (build-2 fix-cycle FATAL 3). Replaces the
   *  removed destructive `onShutdown`/Exit for dark/unknown sessions. */
  onCheckLiveness?: () => void;
  onOpenEditor?: (editorId: string) => void;
  onAttachProposal?: (changeName: string) => void;
  onDetachProposal?: () => void;
  onSendPrompt?: (text: string, images?: ImageContent[]) => void;
  onReadArtifact?: (changeName: string, artifactId: string) => void;
  onRefresh?: () => void;
  /**
   * Mobile session-status drill (Feature 4.4.1; cell
   * pi-agent-dashboard-ux-message-discoverability/v1 W4.4.1 scope-creep per
   * operator-direct verdict 2026-05-23 ~23:15 CEST). Closes the broken promise
   * left by sister-cell mobile-pwa-chatgpt-style-restructure/v1 (MintOwl;
   * commit ccd79aa9 2026-05-21) whose rationale stated
   *   "Context-usage + cost remain drillable via mobile kebab (MobileActionMenu)"
   * but never wired the drill. Operator empirically caught the gap
   * 2026-05-23 ~22:25 CEST (verbatim, typo `u` preserved):
   *   "there are some regressions i started seeing: i cannot see context
   *    usage in the session".
   * Shapes intentionally match desktop TokenStatsBar's contextUsage prop and
   * SessionState.cost so wiring at App.tsx is a direct pass-through.
   */
  contextUsage?: { tokens: number | null; contextWindow: number };
  cost?: number;
}

function MenuRow({ icon, label, onClick, danger, disabled }: {
  icon: string;
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center gap-3 px-4 py-3 text-sm text-left min-h-[44px] ${
        disabled
          ? "text-[var(--text-muted)] opacity-40 cursor-not-allowed"
          : danger
            ? "text-red-400 hover:bg-red-500/10"
            : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
      }`}
    >
      <Icon path={icon} size={0.7} />
      <span>{label}</span>
    </button>
  );
}

export function MobileActionMenu({ session, editors, openspecChanges, onRename, onHide, onUnhide, onResume, onCheckLiveness, onOpenEditor, onAttachProposal, onDetachProposal, onSendPrompt, onReadArtifact, onRefresh, contextUsage, cost }: Props) {
  const [open, setOpen] = useState(false);
  const [exploreOpen, setExploreOpen] = useState(false);
  const [newChangeOpen, setNewChangeOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const isAlive = session.status !== "ended";
  const isHidden = !!session.hidden;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Also close on touch outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: TouchEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("touchstart", handler);
    return () => document.removeEventListener("touchstart", handler);
  }, [open]);

  function act(fn: () => void) {
    setOpen(false);
    fn();
  }

  return (
    <>
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="p-2 min-w-[44px] min-h-[44px] flex items-center justify-center text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        aria-label="Session actions"
        data-testid="mobile-kebab-btn"
      >
        <Icon path={mdiDotsVertical} size={0.8} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-64 bg-[var(--bg-secondary)] border border-[var(--border-secondary)] rounded-xl shadow-lg z-50 overflow-hidden" data-testid="mobile-action-menu">
          {/* Session status row (W4.4.1 mobile-kebab context-usage drill
              per cell pi-agent-dashboard-ux-message-discoverability/v1).
              Renders only when there is data to show; matches the show/hide
              guards used by desktop TokenStatsBar (contextWindow > 0 for
              the bar; cost > 0 for the cost line). */}
          {((contextUsage && contextUsage.contextWindow > 0) || (cost != null && cost > 0)) && (
            <div
              className="px-4 py-2 border-b border-[var(--border-primary)] space-y-1.5"
              data-testid="mobile-kebab-session-status"
            >
              <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">
                Session status
              </div>
              {contextUsage && contextUsage.contextWindow > 0 && (
                <div className="flex items-center gap-2 text-[10px] text-[var(--text-tertiary)]">
                  <span className="min-w-[52px]">Context</span>
                  <div className="flex-1">
                    <ContextUsageBar
                      tokens={contextUsage.tokens}
                      contextWindow={contextUsage.contextWindow}
                    />
                  </div>
                </div>
              )}
              {cost != null && cost > 0 && (
                <div
                  className="flex items-center gap-2 text-[10px] text-[var(--text-tertiary)]"
                  data-testid="mobile-kebab-cost"
                >
                  <span className="min-w-[52px]">Cost</span>
                  <span className="tabular-nums">${cost.toFixed(2)}</span>
                </div>
              )}
            </div>
          )}
          {/* Git info row (non-interactive) */}
          {session.gitBranch && (
            <div className="px-4 py-2 text-xs text-[var(--text-tertiary)] flex items-center gap-2 border-b border-[var(--border-primary)]">
              <Icon path={mdiSourceBranch} size={0.55} />
              <span className="truncate">{session.gitBranch}</span>
              {session.gitPrNumber != null && (
                <>
                  <span>·</span>
                  {session.gitPrUrl ? (
                    <a href={session.gitPrUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline flex items-center gap-0.5">
                      #{session.gitPrNumber} <Icon path={mdiLinkVariant} size={0.4} />
                    </a>
                  ) : (
                    <span>#{session.gitPrNumber}</span>
                  )}
                </>
              )}
            </div>
          )}

          {/* Rename */}
          {isAlive && onRename && (
            <MenuRow icon={mdiPencilOutline} label="Rename" onClick={() => act(onRename)} />
          )}

          {/* Hide / Unhide */}
          {isHidden ? (
            onUnhide && <MenuRow icon={mdiEyeOutline} label="Show session" onClick={() => act(onUnhide)} />
          ) : (
            onHide && <MenuRow icon={mdiEyeOffOutline} label="Hide session" onClick={() => act(onHide)} />
          )}

          {/* Resume / Fork */}
          {onResume && session.sessionFile && (
            <>
              {(!isAlive || isHidden) && (
                <MenuRow icon={mdiPlay} label="Resume" onClick={() => act(() => onResume("continue"))} />
              )}
              <MenuRow icon={mdiSourceFork} label="Fork" onClick={() => act(() => onResume("fork"))} />
            </>
          )}

          {/* Editors */}
          {editors?.map((editor) => (
            <MenuRow
              key={editor.id}
              icon={mdiOpenInNew}
              label={`Open in ${editor.name}`}
              onClick={() => act(() => onOpenEditor?.(editor.id))}
            />
          ))}

          {/* OpenSpec commands (unattached: Explore + New Change) */}
          {!session.attachedProposal && isAlive && onSendPrompt && (
            <>
              <div className="px-4 py-1.5 text-[10px] text-[var(--text-muted)] uppercase tracking-wider border-t border-[var(--border-primary)]">
                OpenSpec
              </div>
              <MenuRow icon={mdiCompassOutline} label="Explore" onClick={() => act(() => setExploreOpen(true))} />
              <MenuRow icon={mdiChevronRight} label="+ New Change" onClick={() => act(() => setNewChangeOpen(true))} />
            </>
          )}

          {/* OpenSpec commands (when a change is attached) */}
          {session.attachedProposal && openspecChanges && (() => {
            const attached = session.attachedProposal;
            const change = openspecChanges.find((c) => c.name === attached);
            if (!change) return null;
            const state = deriveChangeState(change);
            return (
              <>
                <div className="px-4 py-1.5 text-[10px] text-[var(--text-muted)] uppercase tracking-wider border-t border-[var(--border-primary)]">
                  OpenSpec: {attached}
                </div>
                {(() => {
                  const actionsDisabled = session.status === "streaming";
                  return (
                    <>
                      {onSendPrompt && (
                        <MenuRow icon={mdiCompassOutline} label="Explore" onClick={() => act(() => onSendPrompt(`/skill:openspec-explore ${attached}`))} disabled={actionsDisabled} />
                      )}
                      {state === ChangeState.PLANNING && onSendPrompt && (
                        <>
                          <MenuRow icon={mdiChevronRight} label="Continue" onClick={() => act(() => onSendPrompt(`/opsx:continue ${attached}`))} disabled={actionsDisabled} />
                          <MenuRow icon={mdiFastForward} label="Fast-Forward" onClick={() => act(() => onSendPrompt(`/opsx:ff ${attached}`))} disabled={actionsDisabled} />
                        </>
                      )}
                      {(state === ChangeState.READY || state === ChangeState.IMPLEMENTING) && onSendPrompt && (
                        <MenuRow icon={mdiPlayCircleOutline} label="Apply" onClick={() => act(() => onSendPrompt(`/opsx:apply ${attached}`))} disabled={actionsDisabled} />
                      )}
                      {state === ChangeState.COMPLETE && onSendPrompt && (
                        <>
                          <MenuRow icon={mdiCheckCircleOutline} label="Verify" onClick={() => act(() => onSendPrompt(`/opsx:verify ${attached}`))} disabled={actionsDisabled} />
                          <MenuRow icon={mdiArchiveOutline} label="Archive" onClick={() => act(() => onSendPrompt(`/opsx:archive ${attached}`))} disabled={actionsDisabled} />
                        </>
                      )}
                    </>
                  );
                })()}
              </>
            );
          })()}

          {/* OpenSpec detach */}
          {session.attachedProposal && onDetachProposal && (
            <MenuRow icon={mdiLinkVariant} label={`Detach: ${session.attachedProposal}`} onClick={() => act(onDetachProposal)} />
          )}

          {/* Refresh Chat */}
          {onRefresh && (
            <MenuRow icon={mdiRefresh} label="Refresh Chat" onClick={() => act(onRefresh)} />
          )}

          {/* Check liveness (build-2 fix-cycle FATAL 3): read-only re-verify.
              REPLACES the removed destructive "Exit session" — that path called
              `shutdown` which unregisters without death verification (the kill-0
              hole) and would falsely claim a dark / kill-0-live / unknown CC
              target dead. Check-liveness re-runs server hygiene and never
              retires. Confirmed terminate→verify-dead→retire stays P1. */}
          {isAlive && onCheckLiveness && (
            <MenuRow icon={mdiHeartPulse} label="Check liveness" onClick={() => act(onCheckLiveness)} />
          )}
        </div>
      )}
    </div>

      {/* Dialogs rendered outside the menu via portal */}
      {exploreOpen && (
        <DialogPortal><ExploreDialog
          changeName=""
          onSend={(text, images) => {
            onSendPrompt?.(`/skill:openspec-explore\n${text}`, images);
            setExploreOpen(false);
          }}
          onClose={() => setExploreOpen(false)}
        /></DialogPortal>
      )}
      {newChangeOpen && (
        <DialogPortal><NewChangeDialog
          onSend={(prompt) => {
            onSendPrompt?.(prompt);
            setNewChangeOpen(false);
          }}
          onClose={() => setNewChangeOpen(false)}
        /></DialogPortal>
      )}
    </>
  );
}
