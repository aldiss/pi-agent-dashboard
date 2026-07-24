/**
 * Build a push notification payload from a session and triggering event.
 * Pure helper — no I/O, no side effects.
 * See change: add-server-push-notifications.
 */
import type { DashboardSession, DashboardEvent } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { PushPayload } from "./push-types.js";
import { operatorProseToolLabel } from "@blackbelt-technology/pi-dashboard-shared/operator-tool-visibility.js";
import { hasObviousInternalJargon } from "@blackbelt-technology/pi-dashboard-shared/operator-delivery.js";

export function buildPushPayload(
  session: DashboardSession,
  event: DashboardEvent,
): PushPayload {
  const sessionId = session.id;
  const sessionLabel = typeof session.name === "string" && session.name.trim().length > 0 &&
    !hasObviousInternalJargon(session.name)
    ? session.name.trim()
    : "This session";

  // Determine title and body from event + session context
  let title: string;
  let body: string;

  if (event.eventType === "agent_end") {
    const error = (event.data as { error?: unknown } | undefined)?.error;
    if (error) {
      title = "Session crashed";
      body = truncate(
        `${sessionLabel} stopped unexpectedly. Open the session for details.`,
        500,
      );
    } else {
      // Successful completion
      title = "Session completed";
      body = truncate(
        `${sessionLabel} — finished successfully`,
        500,
      );
    }
  } else {
    // Operator-prose tool transition. Fixed labels are the only tool names
    // allowed into notification chrome.
    const toolName = event.data?.toolName
      ? String(event.data.toolName)
      : session.currentTool || "unknown";
    const toolLabel = operatorProseToolLabel(toolName);
    if (toolName.toLowerCase() === "push_notify_user") {
      title = "Device notification";
      body = truncate(`${sessionLabel} — sent a device notification`, 500);
    } else {
      title = "Response needed";
      body = truncate(
        `${sessionLabel} — waiting for your response${toolLabel ? ` (${toolLabel})` : ""}`,
        500,
      );
    }
  }

  return {
    type: "session_attention",
    sessionId,
    title: truncate(title, 200),
    body: truncate(body, 500),
    url: `/session/${sessionId}`,
  };
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}
