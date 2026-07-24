import React, { useState, type ReactNode } from "react";
import { Icon } from "@mdi/react";
import { mdiLoading, mdiCheck, mdiAlertCircle, mdiChevronRight, mdiChevronDown, mdiStop, mdiAlert, mdiHelpCircleOutline } from "@mdi/js";
import { getToolRenderer, type ToolContext } from "./tool-renderers/index.js";
import type { ChatImage } from "../lib/event-reducer.js";
import { useMobile } from "../hooks/useMobile.js";
import { ElapsedBadge } from "./ElapsedBadge.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { PinToggleButton } from "./PinToggleButton.js";
import type { PinContext } from "./ThinkingBlock.js";
import {
  isOperatorProseTool,
  operatorProseToolLabel,
} from "@blackbelt-technology/pi-dashboard-shared/operator-tool-visibility.js";

type StopState = "idle" | "aborting" | "killing";

interface Props {
  toolName: string;
  toolCallId: string;
  args?: Record<string, unknown>;
  status: "running" | "complete" | "error";
  result?: string;
  images?: ChatImage[];
  context: ToolContext;
  startedAt?: number;
  duration?: number;
  toolDetails?: Record<string, unknown>;
  onAbort?: () => void;
  onForceKill?: () => void;
  /** Optional Feature 3 pin-context. When set + entryId resolvable, the
   *  tool-call header renders a pin-toggle button before the chevron.
   *  Operator may pin a long tool-result whose output they need later.
   *  Cell: pi-agent-dashboard-ux-message-discoverability/v1 (W4.3). */
  pinContext?: PinContext;
}

const toolSummaries: Record<string, (args?: Record<string, unknown>) => string> = {
  read: (args) => `Read ${args?.path ?? "file"}`,
  bash: (args) => `$ ${String(args?.command ?? "").slice(0, 60)}`,
  edit: (args) => `Edit ${args?.path ?? "file"}`,
  write: (args) => `Write ${args?.path ?? "file"}`,
  grep: (args) => `Grep ${args?.pattern ?? ""}`,
  find: (args) => `Find ${args?.glob ?? ""}`,
  ls: (args) => `ls ${args?.path ?? "."}`,
  ask_user: () => "Question",
  Agent: (args) => `${args?.subagent_type ?? "Agent"}: ${String(args?.description ?? "").slice(0, 60)}`,
  get_subagent_result: (args) => `Get result: ${String(args?.agent_id ?? "").slice(0, 30)}`,
  steer_subagent: (args) => `Steer: ${String(args?.agent_id ?? "").slice(0, 30)}`,
};

function getSummary(toolName: string, args?: Record<string, unknown>): string {
  const fn = toolSummaries[toolName];
  if (fn) return fn(args);
  return toolName;
}

const statusIcons: Record<string, ReactNode> = {
  running: <Icon path={mdiLoading} size={0.55} spin />,
  complete: <Icon path={mdiCheck} size={0.55} />,
  error: <Icon path={mdiAlertCircle} size={0.55} />,
};

export function ToolCallStep({ toolName, toolCallId, args, status, result, images, context, startedAt, duration, toolDetails, onAbort, onForceKill, pinContext }: Props) {
  const isMobile = useMobile();
  const hasImages = images && images.length > 0;
  const isAgentRunning = toolName === "Agent" && status === "running";
  const isAskUser = toolName === "ask_user";
  const isProtectedOperatorTool = isOperatorProseTool(toolName);
  const protectedLabel = operatorProseToolLabel(toolName);
  const isFailedAskUser = isAskUser && status === "error";
  const [expanded, setExpanded] = useState(!isProtectedOperatorTool && (hasImages || isAgentRunning || (isAskUser && !isFailedAskUser)));
  const [stopState, setStopState] = useState<StopState>("idle");
  const Renderer = getToolRenderer(toolName);

  // Reset stop state when tool finishes
  React.useEffect(() => {
    if (status !== "running") setStopState("idle");
  }, [status]);

  const showPin = !!pinContext?.entryId && !!pinContext?.onTogglePin;

  return (
    <div
      className={`${isMobile ? "mx-2" : "mx-4"} border-l-2 border-[var(--border-secondary)] pl-3`}
      {...(pinContext?.entryId ? { "data-entry-id": pinContext.entryId } : {})}
    >
      <button
        onClick={() => { if (!isProtectedOperatorTool) setExpanded(!expanded); }}
        className={`flex items-center gap-1.5 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] w-full text-left ${isMobile ? "min-h-[44px] py-2" : ""}`}
      >
        <span className={`inline-flex ${
          status === "error"
            ? "text-red-400"
            : isAskUser
              ? "text-sky-400"
              : status === "complete"
                ? "text-green-400"
                : "text-yellow-400"
        }`}>
          {isAskUser && status !== "error" && status !== "running"
            ? <Icon path={mdiHelpCircleOutline} size={0.55} />
            : statusIcons[status]}
        </span>
        <span className="truncate">{protectedLabel ?? getSummary(toolName, args)}</span>
        <ElapsedBadge startedAt={startedAt} duration={duration} />
        {status === "running" && onAbort && stopState === "idle" && (
          <span
            role="button"
            data-testid="tool-stop-button"
            onClick={(e) => { e.stopPropagation(); onAbort(); if (onForceKill) setStopState("aborting"); }}
            className="ml-1 p-0.5 rounded text-red-400 hover:text-red-300 hover:bg-red-900/30 inline-flex"
            title="Stop"
          >
            <Icon path={mdiStop} size={0.45} />
          </span>
        )}
        {status === "running" && onForceKill && stopState === "aborting" && (
          <span
            role="button"
            data-testid="tool-force-stop-button"
            onClick={(e) => { e.stopPropagation(); onForceKill(); setStopState("killing"); }}
            className="ml-1 p-0.5 rounded text-orange-400 hover:text-orange-300 hover:bg-orange-900/30 animate-pulse inline-flex"
            title="Force Stop — kill the process"
          >
            <Icon path={mdiAlert} size={0.45} />
          </span>
        )}
        {showPin && (
          <span className="ml-1 inline-flex">
            <PinToggleButton
              entryId={pinContext!.entryId!}
              isPinned={pinContext!.isPinned}
              onToggle={pinContext!.onTogglePin}
              size={0.5}
              dimWhenNotPinned
            />
          </span>
        )}
        {!isProtectedOperatorTool && (
          <span className="ml-auto text-[var(--text-muted)] inline-flex">
            <Icon path={expanded ? mdiChevronDown : mdiChevronRight} size={0.6} />
          </span>
        )}
      </button>
      {expanded && !isProtectedOperatorTool && (
        <div className="mt-1 ml-4 p-2 bg-[var(--bg-secondary)] rounded-xl shadow-md border border-[var(--border-subtle)] text-xs text-[var(--text-secondary)] overflow-x-auto">
          <ErrorBoundary>
            <Renderer
              toolName={toolName}
              args={args}
              status={status}
              result={result}
              images={images}
              context={context}
              toolDetails={toolDetails}
            />
          </ErrorBoundary>
        </div>
      )}
    </div>
  );
}
