export interface AppendBoundMessageEndForwarderOptions<EventPayload> {
  /** Runs before persistence and may mutate the exact message being appended. */
  prepare: (payload: EventPayload, message: object) => void;
  resolveFallbackEntryId: (message: object, payload: EventPayload) => string | undefined;
  send: (
    payload: EventPayload,
    message: object,
    entryId: string | undefined,
    nonce: string,
  ) => void;
}

interface PendingMessageEnd<EventPayload> {
  token: string;
  markedMessage: object;
  payload: EventPayload;
  nonce: string;
  prepared: boolean;
  authoritativeMessage?: object;
}

export interface PreparedAppend {
  nonce: string;
}

export const MESSAGE_END_CORRELATION_FIELD = "__piDashboardMessageEndToken";

/** Pi persists these message roles through sessionManager.appendMessage. */
export function isAppendMessageRole(message: unknown): message is object {
  if (!message || typeof message !== "object") return false;
  const role = (message as { role?: unknown }).role;
  return role === "user" || role === "assistant" || role === "toolResult";
}

/**
 * Binds message_end forwarding to appendMessage rather than handler timing.
 * This makes extension handler order irrelevant: all awaited handlers finish,
 * then prepare runs on the final shared message immediately before persistence.
 */
export function createAppendBoundMessageEndForwarder<EventPayload>(
  options: AppendBoundMessageEndForwarderOptions<EventPayload>,
) {
  const pending = new Map<string, PendingMessageEnd<EventPayload>>();
  const preparedAppendMessages = new WeakMap<object, string>();
  let tokenCounter = 0;

  const prepare = (record: PendingMessageEnd<EventPayload>, message: object): void => {
    if (record.prepared) return;
    record.authoritativeMessage = message;
    options.prepare(record.payload, message);
    record.prepared = true;
  };

  const clearMarker = (message: object): void => {
    try { delete (message as Record<string, unknown>)[MESSAGE_END_CORRELATION_FIELD]; } catch { /* best effort */ }
  };

  const flush = (token: string, message: object, entryId?: string): boolean => {
    const record = pending.get(token);
    if (!record) return false;
    pending.delete(token);
    clearMarker(message);
    clearMarker(record.markedMessage);
    prepare(record, message);
    const authoritativeMessage = record.authoritativeMessage ?? message;
    options.send(
      record.payload,
      authoritativeMessage,
      entryId ?? options.resolveFallbackEntryId(authoritativeMessage, record.payload),
      record.nonce,
    );
    return true;
  };

  return {
    hold(message: object, payload: EventPayload, nonce: string): void {
      const carriedToken = (message as Record<string, unknown>)[MESSAGE_END_CORRELATION_FIELD];
      const token = typeof carriedToken === "string"
        ? carriedToken
        : `dashboard-end-${++tokenCounter}-${Date.now()}`;
      const record: PendingMessageEnd<EventPayload> = {
        token,
        markedMessage: message,
        payload,
        nonce,
        prepared: false,
      };
      Object.defineProperty(message, MESSAGE_END_CORRELATION_FIELD, {
        value: token,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      pending.set(token, record);
    },

    /** Invoke immediately before the wrapped original appendMessage. */
    beforeAppend(message: object): PreparedAppend | undefined {
      const token = (message as Record<string, unknown>)[MESSAGE_END_CORRELATION_FIELD];
      if (typeof token !== "string") return undefined;
      const record = pending.get(token);
      if (!record) return undefined;
      clearMarker(message);
      clearMarker(record.markedMessage);
      preparedAppendMessages.set(message, token);
      prepare(record, message);
      return { nonce: record.nonce };
    },

    /** Invoke after persistence and after entry_persisted forwarding. */
    afterAppend(message: object, entryId?: string): boolean {
      const token = preparedAppendMessages.get(message);
      if (!token) return false;
      preparedAppendMessages.delete(message);
      return flush(token, message, entryId);
    },

    has(message: object): boolean {
      const token = (message as Record<string, unknown>)[MESSAGE_END_CORRELATION_FIELD];
      return typeof token === "string" && pending.has(token);
    },
  };
}
