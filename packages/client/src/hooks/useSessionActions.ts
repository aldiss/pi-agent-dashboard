/**
 * Session action callbacks extracted from App.tsx.
 * Handles send, abort, resume, spawn, hide, rename, shutdown, terminal, and selection actions.
 */
import { useCallback, useRef } from "react";
import { createInitialState, resolveInteractiveRequest, removeQueueEntry, type SessionState } from "../lib/event-reducer.js";
import { encodePromptAnswer } from "../lib/prompt-answer-encoder.js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { TerminalSession } from "@blackbelt-technology/pi-dashboard-shared/terminal-types.js";
import type { ImageContent } from "@blackbelt-technology/pi-dashboard-shared/types.js";

export interface SessionActionDeps {
  selectedId: string | undefined;
  send: (msg: any) => void;
  navigate: (to: string) => void;
  setMobileOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSessions: React.Dispatch<React.SetStateAction<Map<string, DashboardSession>>>;
  setSessionStates: React.Dispatch<React.SetStateAction<Map<string, SessionState>>>;
  setSpawningCwds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setTerminals: React.Dispatch<React.SetStateAction<Map<string, TerminalSession>>>;
  clearSpawningCwd: (cwd: string) => void;
  spawnTimeoutsRef: React.MutableRefObject<Map<string, ReturnType<typeof setTimeout>>>;
  pendingTerminalCwdRef: React.MutableRefObject<string | null>;
  terminals: Map<string, TerminalSession>;
  /**
   * Maps client-minted `requestId` → originating click metadata. Populated
   * by `handleSpawnSession` / `handleResumeSession`; consumed by
   * `useMessageHandler.session_added` for exact auto-select correlation.
   * See change: spawn-correlation-token.
   */
  pendingSpawnsRef: React.MutableRefObject<Map<string, { cwd: string; kind: "spawn" | "resume" }>>;
}

export function useSessionActions(deps: SessionActionDeps) {
  const {
    selectedId, send, navigate, setMobileOpen,
    setSessions, setSessionStates, setSpawningCwds, setTerminals,
    clearSpawningCwd, spawnTimeoutsRef, pendingTerminalCwdRef, terminals,
    pendingSpawnsRef,
  } = deps;

  // Native crypto.randomUUID is widely available; fall back to a Math.random
  // UUIDish for legacy environments without it.
  const mintRequestId = (): string => {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    // Best-effort fallback (unlikely to hit in supported browsers).
    return `rq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  };

  const handleAbort = useCallback(() => {
    if (selectedId) send({ type: "abort", sessionId: selectedId });
  }, [selectedId, send]);

  const handleForceKill = useCallback(() => {
    if (selectedId) send({ type: "force_kill", sessionId: selectedId });
  }, [selectedId, send]);

  const handleCancelPending = useCallback(() => {
    if (selectedId) {
      setSessionStates((prev) => {
        const next = new Map(prev);
        const current = next.get(selectedId);
        if (current?.pendingPrompt) {
          next.set(selectedId, { ...current, pendingPrompt: undefined });
        }
        return next;
      });
      send({ type: "abort", sessionId: selectedId });
    }
  }, [selectedId, send, setSessionStates]);

  const handleRespondToUi = useCallback((requestId: string, result?: unknown, cancelled?: boolean) => {
    if (selectedId) {
      send({ type: "extension_ui_response", sessionId: selectedId, requestId, result, cancelled });
      // Also send via PromptBus protocol for new-style prompts.
      // Encoding precedence (multiselect-aware): see prompt-answer-encoder.ts.
      // Fix: change fix-multiselect-auto-cancel-on-dashboard.
      const answer = encodePromptAnswer(result, cancelled);
      send({ type: "prompt_response", sessionId: selectedId, promptId: requestId, answer, cancelled, source: "dashboard-default" } as any);
      setSessionStates((prev) => {
        const next = new Map(prev);
        const current = next.get(selectedId);
        if (current) {
          next.set(selectedId, resolveInteractiveRequest(current, requestId, result, cancelled));
        }
        return next;
      });
      setSessions((prev) => {
        const next = new Map(prev);
        const session = next.get(selectedId);
        if (session?.currentTool === "ask_user") {
          next.set(selectedId, { ...session, currentTool: undefined });
        }
        return next;
      });
    }
  }, [selectedId, send, setSessionStates, setSessions]);

  const handleFlowAction = useCallback((sessionId: string, action: string, opts?: { flowName?: string; task?: string; description?: string }) => {
    send({
      type: "flow_management",
      sessionId,
      action,
      flowName: opts?.flowName,
      task: opts?.task,
      description: opts?.description,
    });
  }, [send]);

  /**
   * Double-submit guard (dashboard-message-queue/v1 AMEND #2). The composer can
   * fire `onSend` twice for ONE user action (keydown+click, an Enter
   * double-fire, or MobileComposer + parent both firing). Each `handleSend`
   * mints a FRESH queueNonce, so the same-nonce optimistic-push guard does NOT
   * catch it → two cards + two real `send_prompt`s (the agent may get the
   * message twice). Floor: drop a same-`(session+text+images)` send that lands inside
   * a short window. Genuine intentional re-sends are far slower than a
   * double-fire; a real duplicate inside 600ms is virtually always the bug.
   */
  const lastSendRef = useRef<{ key: string; at: number } | null>(null);
  const DOUBLE_SUBMIT_WINDOW_MS = 600;

  const handleSend = useCallback((text: string, images?: ImageContent[]) => {
    if (selectedId) {
      // Double-submit guard: suppress an identical (session+text+images)
      // send that arrives within the window. The key is a JSON-encoded tuple
      // — a printable, NUL-free, collision-safe delimiter (AMEND #3 F2/N1; an
      // earlier template-literal separator emitted a literal NUL byte that made
      // this .ts binary to git). The image signature (mimeType + data length per
      // image) distinguishes same-text/different-image sends. See lastSendRef above.
      const now = Date.now();
      const imageSignature = (images ?? []).map((img) => `${img.mimeType}:${img.data.length}`);
      const sendKey = JSON.stringify([selectedId, text, imageSignature]);
      const prevSend = lastSendRef.current;
      if (prevSend && prevSend.key === sendKey && now - prevSend.at < DOUBLE_SUBMIT_WINDOW_MS) {
        return;
      }
      lastSendRef.current = { key: sendKey, at: now };
      // Message-queue (dashboard-message-queue/v1): mint a queueNonce so a
      // queued-while-streaming send can be reconciled by exact match when the
      // bridge acks it (`message_enqueued`) and dispatched when pi pulls it
      // into work (`message_start(queueNonce)`). The nonce rides on send_prompt
      // → server → bridge. For the immediate (non-streaming) send it's simply
      // unused. See change: dashboard-message-queue.
      const queueNonce = mintRequestId();
      send({ type: "send_prompt", sessionId: selectedId, text, images, queueNonce });
      setSessionStates((prev) => {
        const next = new Map(prev);
        const current = next.get(selectedId) ?? createInitialState();
        const chatImages = images?.map((img) => ({ data: img.data, mimeType: img.mimeType }));
        if (current.isStreaming || current.status === "streaming") {
          // Streaming → promote to the visible queue. Push an optimistic entry
          // for instant 0ms feedback; the bridge confirms/reconciles it. Guard
          // against a double-push (StrictMode / rapid re-send) by queueNonce.
          if (current.queue.some((q) => q.queueNonce === queueNonce)) return prev;
          next.set(selectedId, {
            ...current,
            queue: [
              ...current.queue,
              {
                queueNonce,
                text,
                ...(chatImages && chatImages.length > 0 ? { images: chatImages } : {}),
                state: "optimistic" as const,
                source: "dashboard" as const,
                createdAt: Date.now(),
              },
            ],
          });
        } else {
          // Idle → degenerate 0-queue case: keep today's single-slot
          // optimistic pendingPrompt behavior unchanged.
          next.set(selectedId, {
            ...current,
            pendingPrompt: { text, images: chatImages },
          });
        }
        return next;
      });
    }
  }, [selectedId, send, setSessionStates]);

  const handleSelect = useCallback((id: string) => {
    navigate(`/session/${id}`);
    setMobileOpen(false);
  }, [navigate, setMobileOpen]);

  // ── Message-queue retry / dismiss (dashboard-message-queue/v1) ──
  // Retry a failed queued entry: re-send (with a fresh queueNonce) and reset
  // it to optimistic so the stuck-timeout re-arms. Honest-removal: dismiss is
  // only offered for unconfirmed (optimistic/failed) entries — a confirmed
  // entry sits in pi's real queue and the extension API exposes no removal.
  const handleRetryQueued = useCallback((queueNonce: string) => {
    if (!selectedId) return;
    setSessionStates((prev) => {
      const current = prev.get(selectedId);
      const entry = current?.queue.find((q) => q.queueNonce === queueNonce);
      if (!current || !entry || entry.state !== "failed") return prev;
      const newNonce = mintRequestId();
      const images = entry.images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
      send({ type: "send_prompt", sessionId: selectedId, text: entry.text, images, queueNonce: newNonce });
      // AMEND #5 (f) idempotency-guard: re-key OLD→NEW + re-send, AND record the
      // OLD nonce as retry-superseded so a LATE confirmation for it is inert in
      // the reducer (no flip-flop back to OLD, no duplicate card, no second
      // dispatch). "failed" is the 30s stuck-timeout, a PROXY for "reached pi"
      // that cannot distinguish "disconnected (never reached pi)" from
      // "connected-but-slow (reached pi, slow confirm)". In the connected-slow
      // case the OLD send DID reach pi's follow-up queue and will confirm late.
      //
      // HONEST RESIDUAL (do not pretend otherwise): the client CANNOT abort the
      // OLD send already enqueued in pi — the extension API exposes no
      // per-message removal (the deferred control-tail). So when this race fires
      // (connected-slow + retry-in-window), pi holds BOTH the OLD and NEW
      // messages and the agent processes the text twice. This guard makes the
      // CLIENT STATE correct (one card, NEW nonce, no flip-flop) but cannot
      // un-send the pi-side duplicate. (Follow-on: a WS-aware stuck-timeout
      // would cut the false-fail frequency → fewer retries → fewer pi doubles;
      // it needs its own pass since a connected WS ≠ guaranteed-reached-pi.)
      const supersededNonces = new Set(current.supersededNonces);
      supersededNonces.add(queueNonce);
      const next = new Map(prev);
      next.set(selectedId, {
        ...current,
        supersededNonces,
        queue: current.queue.map((q) =>
          q.queueNonce === queueNonce
            ? { ...q, queueNonce: newNonce, state: "optimistic" as const, createdAt: Date.now() }
            : q,
        ),
      });
      return next;
    });
  }, [selectedId, send, setSessionStates]);

  const handleDismissQueued = useCallback((queueNonce: string) => {
    if (!selectedId) return;
    setSessionStates((prev) => {
      const current = prev.get(selectedId);
      if (!current) return prev;
      const next = new Map(prev);
      next.set(selectedId, removeQueueEntry(current, queueNonce));
      return next;
    });
  }, [selectedId, setSessionStates]);

  const handleRenameSession = useCallback((sessionId: string, name: string) => {
    send({ type: "rename_session", sessionId, name });
  }, [send]);

  const handleShutdownSession = useCallback((sessionId: string) => {
    send({ type: "shutdown", sessionId });
  }, [send]);

  const handleKillProcess = useCallback((sessionId: string, pgid: number) => {
    send({ type: "kill_process", sessionId, pgid });
  }, [send]);

  const handleSendPromptToSession = useCallback(
    (sessionId: string, text: string, images?: ImageContent[]) => {
      send({ type: "send_prompt", sessionId, text, images });
    },
    [send],
  );

  const handleResumeSession = useCallback((sessionId: string, mode: "continue" | "fork", entryId?: string) => {
    setSessions((prev) => {
      const next = new Map(prev);
      const existing = next.get(sessionId);
      if (existing) next.set(sessionId, { ...existing, resuming: true });
      return next;
    });
    // Mint requestId so session_added (for fork mode) carries spawnRequestId
    // and the client can auto-select the new fork. cwd is left empty here
    // because resume's parent-session lookup happens server-side; we only
    // need requestId for the eventual session_added match.
    // See change: spawn-correlation-token.
    const requestId = mintRequestId();
    pendingSpawnsRef.current.set(requestId, { cwd: "", kind: "resume" });
    // Explicit "front" placement: matches today's default but makes the
    // intent visible at the wire level. See change:
    // differentiate-resume-intent-by-trigger.
    send({ type: "resume_session", sessionId, mode, placement: "front", requestId, ...(entryId ? { entryId } : {}) });
  }, [send, setSessions, pendingSpawnsRef]);

  /**
   * Drag-to-resume entry point. The drop position was just persisted via
   * `reorder_sessions`, so the resume MUST NOT clobber it — send placement
   * "keep" so the server's ended→alive branch leaves sessionOrder alone.
   * See change: differentiate-resume-intent-by-trigger.
   */
  const handleResumeSessionKeepPosition = useCallback((sessionId: string) => {
    setSessions((prev) => {
      const next = new Map(prev);
      const existing = next.get(sessionId);
      if (existing) next.set(sessionId, { ...existing, resuming: true });
      return next;
    });
    const requestId = mintRequestId();
    pendingSpawnsRef.current.set(requestId, { cwd: "", kind: "resume" });
    send({ type: "resume_session", sessionId, mode: "continue", placement: "keep", requestId });
  }, [send, setSessions, pendingSpawnsRef]);

  const handleSpawnSession = useCallback((cwd: string, attachProposal?: string) => {
    setSpawningCwds((prev) => {
      const next = new Set(prev);
      next.add(cwd);
      return next;
    });
    const timer = setTimeout(() => {
      spawnTimeoutsRef.current.delete(cwd);
      clearSpawningCwd(cwd);
    }, 30_000);
    spawnTimeoutsRef.current.set(cwd, timer);
    // Mint requestId for exact auto-select correlation when session_added
    // arrives. See change: spawn-correlation-token.
    const requestId = mintRequestId();
    pendingSpawnsRef.current.set(requestId, { cwd, kind: "spawn" });
    // The optional `attachProposal` field is consumed server-side and applied
    // when the bridge issues `session_register`. See change:
    // add-folder-task-checker-and-spawn-attach.
    send({
      type: "spawn_session",
      cwd,
      requestId,
      ...(attachProposal ? { attachProposal } : {}),
    });
  }, [send, clearSpawningCwd, setSpawningCwds, spawnTimeoutsRef, pendingSpawnsRef]);

  const handleHideSession = useCallback((sessionId: string) => {
    setSessions((prev) => {
      const next = new Map(prev);
      const existing = next.get(sessionId);
      if (existing) next.set(sessionId, { ...existing, hidden: true });
      return next;
    });
    send({ type: "hide_session", sessionId });
  }, [send, setSessions]);

  const handleUnhideSession = useCallback((sessionId: string) => {
    setSessions((prev) => {
      const next = new Map(prev);
      const existing = next.get(sessionId);
      if (existing) next.set(sessionId, { ...existing, hidden: false });
      return next;
    });
    send({ type: "unhide_session", sessionId });
  }, [send, setSessions]);

  const handleCreateTerminal = useCallback((cwd: string) => {
    pendingTerminalCwdRef.current = cwd;
    send({ type: "create_terminal", cwd });
  }, [send, pendingTerminalCwdRef]);

  const handleKillTerminal = useCallback((terminalId: string) => {
    send({ type: "kill_terminal", terminalId });
  }, [send]);

  const handleRenameTerminal = useCallback((terminalId: string, title: string) => {
    setTerminals((prev) => {
      const next = new Map(prev);
      const existing = next.get(terminalId);
      if (existing) next.set(terminalId, { ...existing, title, manuallyRenamed: true });
      return next;
    });
    send({ type: "rename_terminal", terminalId, title });
  }, [send, setTerminals]);

  const handleTerminalTitle = useCallback((terminalId: string, title: string) => {
    setTerminals((prev) => {
      const existing = prev.get(terminalId);
      if (!existing || existing.manuallyRenamed) return prev;
      const next = new Map(prev);
      next.set(terminalId, { ...existing, title });
      return next;
    });
    const t = terminals.get(terminalId);
    if (!t?.manuallyRenamed) {
      send({ type: "rename_terminal", terminalId, title });
    }
  }, [send, terminals, setTerminals]);

  const handleListFiles = useCallback((query: string) => {
    if (selectedId) send({ type: "list_files", sessionId: selectedId, query });
  }, [selectedId, send]);

  /**
   * A1 render-lifecycle ACK (Pete dl-13358 B1). Sends `prompt_rendered` for a
   * promptId when its interactive dialog card actually mounts. Idempotency
   * (exactly once per promptId across remount / reconnect) is enforced upstream
   * by the module-level ledger in `usePromptRenderedAck`; this handler is a thin
   * server-bound sender. Carries no answer — a pure lifecycle signal.
   */
  const handleRenderedAck = useCallback((requestId: string) => {
    if (selectedId) {
      send({ type: "prompt_rendered", sessionId: selectedId, promptId: requestId } as any);
    }
  }, [selectedId, send]);

  return {
    handleAbort, handleForceKill, handleCancelPending, handleRespondToUi, handleRenderedAck, handleFlowAction, handleSend,
    handleSelect, handleRenameSession, handleShutdownSession, handleKillProcess,
    handleRetryQueued, handleDismissQueued,
    handleSendPromptToSession, handleResumeSession, handleResumeSessionKeepPosition, handleSpawnSession,
    handleHideSession, handleUnhideSession,
    handleCreateTerminal, handleKillTerminal, handleRenameTerminal, handleTerminalTitle,
    handleListFiles,
  };
}
