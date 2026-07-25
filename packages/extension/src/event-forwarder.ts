import type {
  EventForwardMessage,
  OperatorDeliveryEventData,
} from "@blackbelt-technology/pi-dashboard-shared/protocol.js";

/**
 * Extract only JSON-serializable fields from an event object.
 * Strips functions, AbortSignals, and other non-serializable values.
 */
function extractSerializable(obj: Record<string, unknown>): OperatorDeliveryEventData {
  const result: OperatorDeliveryEventData = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) {
      result[key] = value;
      continue;
    }
    if (typeof value === "function") continue;
    if (value instanceof AbortSignal) continue;
    if (typeof value === "object" && "aborted" in (value as object)) continue;
    result[key] = value;
  }
  return result;
}

/**
 * Map a pi event object to an event_forward protocol message.
 */
export function mapEventToProtocol(
  sessionId: string,
  piEvent: Record<string, unknown>,
): EventForwardMessage {
  const serializable: OperatorDeliveryEventData = extractSerializable(piEvent);

  return {
    type: "event_forward",
    sessionId,
    event: {
      eventType: (piEvent.type as string) ?? "unknown",
      timestamp: Date.now(),
      data: serializable,
    },
  };
}
