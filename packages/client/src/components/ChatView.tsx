import React, { useRef, useEffect, useCallback, useState, useMemo, forwardRef, useImperativeHandle } from "react";

import { Icon } from "@mdi/react";
import { mdiContentCopy, mdiTextBox, mdiChevronDown, mdiSourceFork } from "@mdi/js";
import { m, useReducedMotion } from "motion/react";
import { spring } from "../motion/index.js";
import { ErrorBanner } from "./ErrorBanner";
import { RetryBanner } from "./RetryBanner";
import type { SessionState, ChatImage, InteractiveUiRequest } from "../lib/event-reducer.js";
import type { ToolContext } from "./tool-renderers/index.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { CopyButton } from "./CopyButton.js";
import { ToolCallStep } from "./ToolCallStep.js";
import { ThinkingBlock } from "./ThinkingBlock.js";
import { BashOutputCard } from "./BashOutputCard.js";
import { CommandFeedbackCard } from "./CommandFeedbackCard.js";
import { RawEventCard } from "./RawEventCard.js";
import { formatMessageTime } from "../lib/format.js";
import { useMobile } from "../hooks/useMobile.js";
import { isDebugTool } from "../hooks/useDebugToolsVisible.js";
import { getInteractiveRenderer } from "./interactive-renderers/registry.js";
import { groupConsecutiveToolCalls, type ChatItem, type ToolCallGroup } from "../lib/group-tool-calls.js";
import { CollapsedToolGroup } from "./CollapsedToolGroup.js";
import { findRetriedErrorIds, findActiveInteractiveToolResultIds } from "../lib/collapse-retried-errors.js";
import { RetriedErrorBadge } from "./RetriedErrorBadge.js";
import { ImageLightbox } from "./ImageLightbox.js";
import { SkillInvocationCard } from "./SkillInvocationCard.js";
import { AttributionChip } from "./AttributionChip.js";
import { bubbleTintFor } from "../lib/attribution-color.js";
import { useAuthStatus } from "../hooks/useAuthStatus.js";
import { ChatSearch } from "./ChatSearch.js";
import {
  getMessageFilter,
  setMessageFilter,
  isDefaultMessageFilter,
  DEFAULT_MESSAGE_FILTER,
  type MessageFilter,
} from "../lib/message-filter-storage.js";
import {
  filterMessages as applyMessageFilter,
  countMessagesByCategory,
  isAllOn as isAllCategoriesOn,
} from "../lib/message-filter-classifier.js";
import { MessageFilterControls } from "./MessageFilterControls.js";
import { PinnedMessagesSection } from "./PinnedMessagesSection.js";
import { PinToggleButton } from "./PinToggleButton.js";
import {
  getPinnedEntryIds,
  setPinnedEntryIds as persistPinnedEntryIds,
  clearPinnedEntryIds,
  togglePinned,
  DEFAULT_PIN_CAP,
} from "../lib/pinned-messages-storage.js";

interface Props {
  sessionId?: string;
  state: SessionState;
  toolContext: ToolContext;
  onCancelPending?: () => void;
  onRespondToUi?: (requestId: string, result?: unknown, cancelled?: boolean) => void;
  onAbort?: () => void;
  onForceKill?: () => void;
  onForkFromMessage?: (entryId: string) => void;
  onDismissError?: () => void;
  onRetryAfterError?: () => void;
  /**
   * Message-queue (dashboard-message-queue/v1): retry a `failed` queued entry
   * (re-send) / dismiss an unconfirmed (`optimistic`|`failed`) queued entry.
   * Confirmed entries expose no dismiss (pi's real queue; no extension-API
   * removal). See change: dashboard-message-queue.
   */
  onRetryQueued?: (queueNonce: string) => void;
  onDismissQueued?: (queueNonce: string) => void;
  /**
   * Visibility of MessageFilterControls (Feature 2). Parent (App.tsx) owns
   * the toggle so a header button in SessionHeader can flip it without a
   * second copy of the controls. Controls render inline above the chat
   * scroll area when true.
   */
  showFilterControls?: boolean;
  onCloseFilterControls?: () => void;
}

const ImageAttachments = React.memo(function ImageAttachments({ images }: { images: ChatImage[] }) {
  const [lightboxSrc, setLightboxSrc] = useState<{ src: string; alt: string } | null>(null);
  return (
    <>
      <div className="flex gap-2 flex-wrap mb-2">
        {images.map((img, i) => {
          const src = `data:${img.mimeType};base64,${img.data}`;
          return (
            <img
              key={i}
              src={src}
              alt={`Attachment ${i + 1}`}
              className="max-w-[300px] max-h-[300px] rounded border border-white/20 object-contain cursor-pointer"
              onClick={() => setLightboxSrc({ src, alt: `Attachment ${i + 1}` })}
            />
          );
        })}
      </div>
      {lightboxSrc && (
        <ImageLightbox src={lightboxSrc.src} alt={lightboxSrc.alt} onClose={() => setLightboxSrc(null)} />
      )}
    </>
  );
});

const MessageBubble = React.memo(function MessageBubble({ content, className, timestamp, entryId, onFork, isPinned, onTogglePin }: { content: string; className: string; timestamp?: number; entryId?: string; onFork?: (entryId: string) => void; isPinned?: boolean; onTogglePin?: (entryId: string) => void }) {
  const contentRef = useRef<HTMLDivElement>(null);

  const getPlainText = useCallback(() => {
    return contentRef.current?.innerText ?? content;
  }, [content]);

  return (
    <div
      className={className}
      {...(entryId ? { "data-entry-id": entryId } : {})}
    >
      <div ref={contentRef}>
        <MarkdownContent content={content} />
      </div>
      <div className="border-t border-[var(--border-secondary)] mt-2 pt-1.5 flex justify-end items-center gap-0.5 opacity-50 hover:opacity-100 transition-opacity">
        {timestamp != null && (
          <span className="text-[10px] text-[var(--text-tertiary)] mr-auto">{formatMessageTime(timestamp)}</span>
        )}
        <CopyButton text={content} icon={<Icon path={mdiContentCopy} size={0.6} />} title="Copy as Markdown" />
        <CopyButton text={getPlainText()} icon={<Icon path={mdiTextBox} size={0.6} />} title="Copy as plain text" />
        {entryId && onFork && (
          <button
            onClick={() => onFork(entryId)}
            title="Fork from here"
            className="p-0.5 rounded hover:bg-[var(--bg-secondary)] text-[var(--text-secondary)]"
          >
            <Icon path={mdiSourceFork} size={0.6} />
          </button>
        )}
        {entryId && onTogglePin && (
          <PinToggleButton
            entryId={entryId}
            isPinned={!!isPinned}
            onToggle={onTogglePin}
            size={0.6}
            dimWhenNotPinned
          />
        )}
      </div>
    </div>
  );
});

/**
 * Message-queue (dashboard-message-queue/v1): one visible queued follow-up
 * card in the stack below the live transcript. Dimmed/"pending" with a
 * "queued · #N" marker + blue pulse (the MobileComposer blue-pulse vocabulary).
 * The HEAD card is the next to dispatch; on dispatch it's removed from the
 * queue and the committed user bubble renders in its place (ChatView's
 * lift→reconcile spring). `failed` entries surface "failed — tap to retry".
 */
const QueuedMessageCard = React.memo(function QueuedMessageCard({
  entry,
  position,
  bubbleMax,
  reducedMotion,
  onRetry,
  onDismiss,
}: {
  entry: import("../lib/event-reducer.js").QueuedMessage;
  position: number;
  bubbleMax: string;
  reducedMotion: boolean;
  onRetry?: (queueNonce: string) => void;
  onDismiss?: (queueNonce: string) => void;
}) {
  const failed = entry.state === "failed";
  const unconfirmed = entry.state === "optimistic";
  return (
    <m.div
      data-testid="queued-message-card"
      data-queue-state={entry.state}
      className="mt-2 mb-2 flex justify-end"
      initial={reducedMotion ? false : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reducedMotion ? undefined : { opacity: 0, y: -8 }}
      transition={spring.smooth}
    >
      <div
        className={`relative rounded-xl shadow-sm px-4 py-2 ${bubbleMax} border ${
          failed
            ? "bg-[var(--accent-red)]/10 border-[var(--accent-red)]/40 border-l-2 border-l-[var(--accent-red)]"
            : "bg-blue-500/5 border-blue-500/15 border-l-2 border-l-blue-400/60 opacity-80"
        }`}
      >
        <div className="flex items-center gap-1.5 mb-1 text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">
          {failed ? (
            <span className="text-[var(--accent-red)] font-medium">failed</span>
          ) : (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" aria-hidden="true" />
              <span>queued · #{position}</span>
              {unconfirmed && <span className="text-[var(--text-tertiary)]/60">· sending…</span>}
            </>
          )}
        </div>
        {entry.images && entry.images.length > 0 && (
          <ImageAttachments images={entry.images} />
        )}
        <MarkdownContent content={entry.text} />
        {(failed || unconfirmed) && (
          <div className="mt-1.5 flex items-center justify-end gap-2 text-[11px]">
            {failed && onRetry && (
              <button
                type="button"
                onClick={() => onRetry(entry.queueNonce)}
                className="px-2 py-0.5 rounded bg-[var(--accent-red)]/20 hover:bg-[var(--accent-red)]/30 text-[var(--accent-red)]"
                data-testid="queued-retry"
              >
                Tap to retry
              </button>
            )}
            {onDismiss && (
              <button
                type="button"
                onClick={() => onDismiss(entry.queueNonce)}
                className="px-1.5 py-0.5 rounded hover:bg-[var(--bg-secondary)] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                aria-label="Dismiss queued message"
                data-testid="queued-dismiss"
              >
                ✕
              </button>
            )}
          </div>
        )}
      </div>
    </m.div>
  );
});

const InteractiveUiCard = React.memo(function InteractiveUiCard({ request, onRespondToUi }: {
  request: InteractiveUiRequest;
  onRespondToUi?: (requestId: string, result?: unknown, cancelled?: boolean) => void;
}) {
  const Renderer = getInteractiveRenderer(request.method);
  return (
    <Renderer
      requestId={request.requestId}
      method={request.method}
      params={request.params}
      status={request.status}
      result={request.result}
      onRespond={(result) => onRespondToUi?.(request.requestId, result)}
      onCancel={() => onRespondToUi?.(request.requestId, undefined, true)}
    />
  );
});

/** Check if markdown content contains a mermaid code block */
function hasMermaid(content: string): boolean {
  return /```mermaid\b/.test(content);
}

const SCROLL_THRESHOLD = 50;

// Per-session scroll state, persisted across session switches
const scrollStateMap = new Map<string, { scrollTop: number; nearBottom: boolean }>();

export interface ChatViewHandle {
  scrollToTurn: (turnIndex: number) => void;
  /**
   * Toggle the in-chat search overlay. Wired into SessionHeader's search
   * button (App.tsx) AND the document-level Cmd/Ctrl+F listener installed
   * below. Sister-shape to scrollToTurn — both are imperative entry points
   * the parent triggers without lifting state.
   * Cell: pi-agent-dashboard-ux-message-discoverability/v1 (W4.1 Feature 1).
   */
  toggleSearch: () => void;
}

export const ChatView = forwardRef<ChatViewHandle, Props>(function ChatView({ sessionId, state, toolContext, onCancelPending, onRespondToUi, onAbort, onForceKill, onForkFromMessage, onDismissError, onRetryAfterError, onRetryQueued, onDismissQueued, showFilterControls, onCloseFilterControls }, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNearBottom = useRef(true);
  const reducedMotion = useReducedMotion() ?? false;
  // Viewer identity for "You vs them" attribution labeling (multi-operator,
  // Surface A — Option B). The verified principal's `sub` is the email in the
  // current provider set, so `authStatus.user?.email` ≈ the author `sub` the
  // server stamps. Undefined when auth is off/loading → AttributionChip shows
  // display names only (no "You"), which is the correct single-operator behavior.
  const { authStatus } = useAuthStatus();
  const viewerSub = authStatus?.user?.email;
  const programmaticScroll = useRef(false);
  // viewportResizing — true during the iOS-rotation / keyboard-show / address-bar-collapse
  // animation envelope (~350 ms). iOS Safari fires multiple onScroll events during a
  // viewport-resize sequence as layout reflows; without this gate handleScroll would
  // misread mid-flux geometry and flip isNearBottom to false, defeating the re-stick
  // logic in the viewport-resize useEffect below.
  // Sister-shape to programmaticScroll; see fix-mobile-chat-scroll-orientation-flip
  // (operator empirical 2026-05-29 iPhone PWA orientation flip).
  const viewportResizing = useRef(false);
  // Race-safe across multi-batch event_replay: when ChatView itself initiates a
  // scroll, the resulting onScroll can fire after another replay batch has grown
  // scrollHeight, making handleScroll misread the geometry as "user scrolled up".
  // markProgrammatic() raises programmaticScroll for ~150ms so handleScroll
  // ignores any onScroll attributable to our own scrollTo call.
  const programmaticTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markProgrammatic = useCallback(() => {
    programmaticScroll.current = true;
    if (programmaticTimeout.current) clearTimeout(programmaticTimeout.current);
    programmaticTimeout.current = setTimeout(() => {
      programmaticScroll.current = false;
      programmaticTimeout.current = null;
    }, 150);
  }, []);
  useEffect(() => () => {
    if (programmaticTimeout.current) clearTimeout(programmaticTimeout.current);
  }, []);
  const [showScrollButton, setShowScrollButton] = useState(false);
  // Search overlay active-state. Owned by ChatView so a session switch (or
  // an unmount) tears the overlay down with the parent — sister to the
  // scrollStateMap discipline above. ChatSearch handles its own query +
  // match-index state internally; we only track is-it-open here.
  // Cell: pi-agent-dashboard-ux-message-discoverability/v1 (W4.1 Feature 1).
  const [searchActive, setSearchActive] = useState(false);
  const [showDebugTools] = useState(() => {
    try { return localStorage.getItem("show-debug-tools") === "true"; } catch { return false; }
  });
  const prevSessionRef = useRef(sessionId);
  const isMobile = useMobile();
  const bubbleMax = isMobile ? "max-w-[95%]" : "max-w-[80%]";
  /** Force wide when message contains a mermaid diagram */
  const bubbleWide = isMobile ? "w-[95%]" : "w-[95%]";

  const handleScroll = useCallback(() => {
    // Suppress scroll measurements caused by our own programmatic scrollTo. The
    // onScroll event lags scrollTo and can fire after the next replay batch has
    // grown scrollHeight; measuring then would falsely conclude the user scrolled
    // away from the bottom. Only real user gestures should reach this code path.
    // viewportResizing extends the same suppression to the iOS-rotation / keyboard
    // / address-bar viewport-resize animation envelope (see useEffect below).
    if (programmaticScroll.current || viewportResizing.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD;
    isNearBottom.current = nearBottom;
    setShowScrollButton(!nearBottom);
    // Persist scroll position for this session
    if (sessionId) {
      scrollStateMap.set(sessionId, { scrollTop: el.scrollTop, nearBottom });
    }
  }, [sessionId]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    isNearBottom.current = true;
    setShowScrollButton(false);
    if (sessionId) {
      scrollStateMap.set(sessionId, { scrollTop: el.scrollHeight, nearBottom: true });
    }
  }, [sessionId]);

  // Save scroll state when leaving, restore when arriving
  useEffect(() => {
    if (sessionId !== prevSessionRef.current) {
      // Save outgoing session scroll position
      const prevId = prevSessionRef.current;
      if (prevId && scrollRef.current) {
        scrollStateMap.set(prevId, {
          scrollTop: scrollRef.current.scrollTop,
          nearBottom: isNearBottom.current,
        });
      }
      prevSessionRef.current = sessionId;

      // Restore incoming session scroll state
      const saved = sessionId ? scrollStateMap.get(sessionId) : undefined;
      if (saved && !saved.nearBottom) {
        // Scroll-locked: restore exact position
        isNearBottom.current = false;
        setShowScrollButton(true);
        requestAnimationFrame(() => {
          markProgrammatic();
          scrollRef.current?.scrollTo(0, saved.scrollTop);
        });
      } else {
        // Near bottom or first visit: scroll to end
        isNearBottom.current = true;
        setShowScrollButton(false);
        requestAnimationFrame(() => {
          markProgrammatic();
          scrollRef.current?.scrollTo(0, scrollRef.current!.scrollHeight);
        });
      }
    }
  }, [sessionId]);

  // Auto-scroll on new content when near bottom. We deliberately do NOT gate on
  // programmaticScroll here — repeated replay batches must keep chasing the tail.
  // The flag is only consulted inside handleScroll to ignore the spurious onScroll
  // events that follow each scrollTo. scrollToTurn opts out by setting
  // isNearBottom.current = false, which still gates this effect.
  useEffect(() => {
    if (isNearBottom.current) {
      requestAnimationFrame(() => {
        markProgrammatic();
        scrollRef.current?.scrollTo(0, scrollRef.current!.scrollHeight);
      });
    }
  }, [state.messages.length, state.streamingText, state.pendingPrompt, state.queue.length, markProgrammatic]);

  // Re-anchor scroll position to bottom after viewport resize (iOS-rotation,
  // keyboard show/hide, address-bar collapse/expand).
  //
  // iOS Safari preserves scrollTop (not scrollBottom) across viewport changes.
  // When iPhone rotates vertical→horizontal, the chat scroll container's
  // clientHeight shrinks AND content reflows (lines wrap differently → different
  // scrollHeight). A user who was at the bottom of a long chat lands mid-chat
  // post-rotation with no auto-recovery: the auto-scroll effect above only
  // re-runs on messages.length / streamingText change, neither of which fires
  // on rotation.
  //
  // Operator empirical 2026-05-29 (Pattern 87 verbatim, typos preserved):
  //   "when i flip the screen from bertical to horizonataæ and back i end up
  //   in the midddle of the session and then has to scroll for a minite to
  //   actialæy go to the bottom"
  //
  // Strategy:
  //   1. Snapshot isNearBottom SYNCHRONOUSLY on first resize event of a sequence
  //      (before handleScroll misreads mid-flux geometry and flips it to false).
  //      Also raise viewportResizing so handleScroll ignores racing onScroll
  //      events during the animation envelope.
  //   2. Debounce settle: visualViewport.resize fires repeatedly during the
  //      rotation animation; clear+reschedule the settle timer so only the final
  //      geometry triggers the re-scroll.
  //   3. On settle (~350 ms — iOS rotation animation ~300 ms + buffer for
  //      safe-area-inset finalization), if was-near-bottom, scroll to new
  //      scrollHeight. If operator scrolled up pre-rotation, preserve their
  //      position (no snap-to-bottom).
  //
  // Composes with useKeyboardInsets (r29.1 baseline-subtraction) at sister
  // layer: useKeyboardInsets owns the --keyboard-h CSS-var for paddingBottom
  // accounting; THIS effect owns the chat-scroll-anchor restoration.
  //
  // See fix-mobile-chat-scroll-orientation-flip.
  useEffect(() => {
    let wasNearBottomAtResizeStart: boolean | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const handleViewportResize = () => {
      if (wasNearBottomAtResizeStart === null) {
        wasNearBottomAtResizeStart = isNearBottom.current;
        viewportResizing.current = true;
      }
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        const snapshot = wasNearBottomAtResizeStart;
        wasNearBottomAtResizeStart = null;
        settleTimer = null;
        viewportResizing.current = false;
        if (!snapshot) return; // operator scrolled up pre-resize — preserve their position
        const el = scrollRef.current;
        if (!el) return;
        markProgrammatic();
        el.scrollTo(0, el.scrollHeight);
        isNearBottom.current = true;
        setShowScrollButton(false);
        if (sessionId) {
          scrollStateMap.set(sessionId, { scrollTop: el.scrollHeight, nearBottom: true });
        }
      }, 350);
    };
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    vv?.addEventListener("resize", handleViewportResize);
    // orientationchange is deprecated but fires earlier than visualViewport.resize
    // on some iOS versions; listening to both is harmless (debounce coalesces).
    if (typeof window !== "undefined") {
      window.addEventListener("orientationchange", handleViewportResize);
    }
    return () => {
      vv?.removeEventListener("resize", handleViewportResize);
      if (typeof window !== "undefined") {
        window.removeEventListener("orientationchange", handleViewportResize);
      }
      if (settleTimer) clearTimeout(settleTimer);
      viewportResizing.current = false;
    };
  }, [sessionId, markProgrammatic]);

  // Group consecutive repeated tool calls for cleaner display
  const filteredMessages = useMemo(() => {
    if (showDebugTools) return state.messages;
    return state.messages.filter((m) => m.role !== "toolResult" || !isDebugTool(m.toolName ?? ""));
  }, [state.messages, showDebugTools]);
  const groupedMessages = useMemo(() => groupConsecutiveToolCalls(filteredMessages), [filteredMessages]);
  const retriedErrorIds = useMemo(() => findRetriedErrorIds(filteredMessages), [filteredMessages]);
  const hiddenToolResultIds = useMemo(() => findActiveInteractiveToolResultIds(filteredMessages), [filteredMessages]);

  // Feature 2: message-type filter. State owned here; persisted via
  // setMessageFilter on every change. Resets to the persisted snapshot
  // when sessionId changes so two open sessions keep independent filters.
  // See cell pi-agent-dashboard-ux-message-discoverability/v1 W4.2.
  const [messageFilter, setMessageFilterState] = useState<MessageFilter>(() =>
    sessionId ? getMessageFilter(sessionId) : { ...DEFAULT_MESSAGE_FILTER }
  );
  useEffect(() => {
    setMessageFilterState(sessionId ? getMessageFilter(sessionId) : { ...DEFAULT_MESSAGE_FILTER });
  }, [sessionId]);
  const handleFilterChange = useCallback((next: MessageFilter) => {
    setMessageFilterState(next);
    if (sessionId) setMessageFilter(sessionId, next);
  }, [sessionId]);
  const categoryCounts = useMemo(() => countMessagesByCategory(groupedMessages), [groupedMessages]);

  // Feature 3 (W4.3) — pinned messages state. ChatView owns the canonical
  // Set<entryId>; storage is per-session localStorage. State + storage are
  // kept in lock-step via handleTogglePin / handleUnpinAll (one setState +
  // one persistPinnedEntryIds per mutation). Loading the persisted set on
  // sessionId change is sister-shape to the messageFilter pattern above.
  // Cell: pi-agent-dashboard-ux-message-discoverability/v1.
  const [pinnedEntryIds, setPinnedEntryIdsState] = useState<Set<string>>(() =>
    sessionId ? getPinnedEntryIds(sessionId) : new Set()
  );
  // Transient cap-hit notification — fires when togglePinned returns
  // "cap-hit" because the session is already at DEFAULT_PIN_CAP. Auto-
  // dismisses after ~3s via the useEffect below. A boolean is sufficient
  // since the message text is fixed.
  const [pinCapHit, setPinCapHit] = useState(false);
  useEffect(() => {
    setPinnedEntryIdsState(sessionId ? getPinnedEntryIds(sessionId) : new Set());
    setPinCapHit(false);
  }, [sessionId]);
  useEffect(() => {
    if (!pinCapHit) return;
    const timer = setTimeout(() => setPinCapHit(false), 3000);
    return () => clearTimeout(timer);
  }, [pinCapHit]);
  const handleTogglePin = useCallback((entryId: string) => {
    if (!sessionId) return;
    const result = togglePinned(sessionId, entryId);
    if (result.action === "cap-hit") {
      setPinCapHit(true);
      return;
    }
    setPinnedEntryIdsState(result.newSet);
    persistPinnedEntryIds(sessionId, result.newSet);
  }, [sessionId]);
  const handleUnpinAll = useCallback(() => {
    if (!sessionId) return;
    setPinnedEntryIdsState(new Set());
    clearPinnedEntryIds(sessionId);
    setPinCapHit(false);
  }, [sessionId]);
  const handleScrollToMessage = useCallback((entryId: string) => {
    const container = scrollRef.current;
    if (!container) return;
    const el = container.querySelector(`[data-entry-id="${entryId}"]`) as HTMLElement | null;
    if (!el) return;
    // Suppress auto-scroll during the programmatic scroll — sister-shape
    // to scrollToTurn's discipline above. Without this the resulting
    // onScroll could be misread as the operator scrolling away from the
    // bottom and pop the scroll-to-bottom button.
    markProgrammatic();
    isNearBottom.current = false;
    setShowScrollButton(true);
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    // Flash highlight — .pinned-message-flash keyframe @ ~1.5s. Remove the
    // class slightly after the animation so consecutive jumps to the same
    // message can re-trigger the animation by re-adding the class.
    el.classList.add("pinned-message-flash");
    setTimeout(() => {
      el.classList.remove("pinned-message-flash");
    }, 1600);
  }, [markProgrammatic]);

  const visibleMessages = useMemo(() => {
    if (isAllCategoriesOn(messageFilter)) return groupedMessages;
    return applyMessageFilter(groupedMessages, messageFilter, { alwaysVisibleEntryIds: pinnedEntryIds });
  }, [groupedMessages, messageFilter, pinnedEntryIds]);
  const isFilterActive = !isDefaultMessageFilter(messageFilter);
  const hiddenCount = groupedMessages.length - visibleMessages.length;

  useImperativeHandle(ref, () => ({
    scrollToTurn(turnIndex: number) {
      const container = scrollRef.current;
      if (!container) return;
      const el = container.querySelector(`[data-turn="${turnIndex}"]`) as HTMLElement | null;
      if (!el) return;
      // Suppress auto-scroll during programmatic navigation
      programmaticScroll.current = true;
      isNearBottom.current = false;
      setShowScrollButton(true);
      // Use getBoundingClientRect for reliable position calculation
      const containerRect = container.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const targetTop = container.scrollTop + (elRect.top - containerRect.top);
      container.scrollTo({ top: targetTop, behavior: "instant" });
      // Re-enable auto-scroll after a delay
      setTimeout(() => { programmaticScroll.current = false; }, 200);
    },
    toggleSearch() {
      setSearchActive((prev) => !prev);
    },
  }), []);

  // Document-level Cmd/Ctrl+F intercept. We deliberately replace the browser
  // find-in-page behavior with our chat-aware search because the browser's
  // built-in find walks the entire DOM (including the sidebar, status bar,
  // and floating composer-pill) and has no concept of which messages are
  // visible vs collapsed in CollapsedToolGroup. ChatSearch indexes only the
  // ChatView scroll container's rendered text. The listener is installed
  // once at mount; ChatView is only mounted when a session is selected so
  // the intercept is naturally scoped to session-detail views.
  // Cell: pi-agent-dashboard-ux-message-discoverability/v1 (W4.1 Feature 1).
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f" && !e.shiftKey && !e.altKey) {
        // Don't intercept when the user is editing an unrelated input/textarea
        // (e.g., the composer or InlineRenameInput). The chat search input
        // itself handles Cmd+F inside its own keydown — re-pressing while the
        // search is open just re-focuses, which is fine.
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName?.toLowerCase();
        const isEditableTarget = tag === "input" || tag === "textarea" || target?.isContentEditable;
        if (isEditableTarget && !target?.closest('[data-testid="chat-search"]')) return;
        e.preventDefault();
        setSearchActive((prev) => !prev);
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, []);

  // Close search when the selected session changes — query state is
  // session-scoped (no value in carrying "foo" over from a different
  // transcript) and ChatSearch's own cleanup effect strips highlights from
  // the prior scroll container.
  useEffect(() => {
    setSearchActive(false);
  }, [sessionId]);

  return (
    <div className="flex-1 relative overflow-hidden flex flex-col">
    {showFilterControls && (
      <MessageFilterControls
        sessionId={sessionId ?? ""}
        filter={messageFilter}
        onFilterChange={handleFilterChange}
        counts={categoryCounts}
        onClose={onCloseFilterControls}
      />
    )}
    {isFilterActive && hiddenCount > 0 && !showFilterControls && (
      <div
        className="px-3 py-1 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[10px] text-[var(--text-secondary)] flex items-center gap-2"
        data-testid="message-filter-banner"
      >
        <span>Showing {visibleMessages.length} of {groupedMessages.length} messages — filter active</span>
        <button
          type="button"
          onClick={() => handleFilterChange({ ...DEFAULT_MESSAGE_FILTER })}
          className="underline hover:text-[var(--text-primary)]"
          data-testid="message-filter-banner-reset"
        >
          Reset filters
        </button>
      </div>
    )}
    {pinCapHit && (
      <div
        className="px-3 py-1 border-b border-amber-500/40 bg-amber-500/15 text-[10px] text-amber-300 flex items-center gap-2"
        data-testid="pin-cap-hit-banner"
      >
        <span>Pin cap reached ({DEFAULT_PIN_CAP}). Unpin a message to pin a new one.</span>
        <button
          type="button"
          onClick={() => setPinCapHit(false)}
          className="ml-auto px-1 py-0.5 rounded hover:bg-amber-500/20 text-amber-300/80 hover:text-amber-200"
          aria-label="Dismiss pin cap notification"
        >
          ×
        </button>
      </div>
    )}
    {/* W7 fade-mask + bottom-padding for floating-composer-pill overlap zone
        (Bert tenure-2 W3 Q4 verdict 2026-05-20 ~23:55 CEST RATIFY 80px mask-image).
        Cell: mobile-pwa-chatgpt-style-restructure/v1. Mobile only.
        - paddingBottom 100px: floats few-message sessions above composer pill's
          ~80px effective height + 20px buffer (composes with bottom-anchor
          justify-end below; messages stick above pill, not behind it)
        - mask-image 80px gradient: messages scrolled INTO the bottom 80px
          visually fade to transparent (graceful degradation when long-session
          scrolling pushes messages into the composer's translucent overlap)
        - theme-agnostic per Q4: alpha-only mask, no color coupling
        - desktop layout unchanged (isMobile gate) */}
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className={`flex-1 min-h-0 overflow-y-auto ${isMobile ? "p-2" : "p-4"}`}
      style={isMobile ? {
        paddingBottom: "100px",
        WebkitMaskImage: "linear-gradient(to bottom, black 0%, black calc(100% - 80px), transparent 100%)",
        maskImage: "linear-gradient(to bottom, black 0%, black calc(100% - 80px), transparent 100%)",
      } : undefined}
    >
      {/* Tier-A operator-direct 2026-05-20 (follow-up to cd70e4dd content-header-sticky
          relocation): bottom-anchor messages so few-message sessions don't leave a large
          empty band between the last message and the composer. `min-h-full flex flex-col
          justify-end` keeps content at the bottom when scrollHeight < clientHeight; when
          content overflows, the wrapper grows past 100% and overflow-y-auto on the parent
          provides normal upward scrolling. `space-y-1` (formerly on the parent) moved here
          so the spacing utility composes with the new flex layout instead of fighting it. */}
      <div className="min-h-full flex flex-col justify-end space-y-1">
      {/* Pinned messages section (Feature 3, W4.3) — lives inside the scroll
          container per W4.3 brief (scrolls WITH messages, not sticky). The
          flex-col + justify-end above bottom-anchors short sessions; adding
          the section as the first child means it sits above the message
          stream when content > viewport, and gets pushed visually up when
          content < viewport. Returns null when nothing is pinned, so the
          section never reserves space for an empty header. */}
      {sessionId && pinnedEntryIds.size > 0 && (
        <PinnedMessagesSection
          sessionId={sessionId}
          entries={state.messages}
          pinnedEntryIds={pinnedEntryIds}
          onUnpinAll={handleUnpinAll}
          onScrollToMessage={handleScrollToMessage}
          onTogglePin={handleTogglePin}
        />
      )}
      {visibleMessages.map((item, idx) => {
        // Collapsed group of repeated tool calls
        if ((item as ToolCallGroup).type === "group") {
          const group = item as ToolCallGroup;
          return <CollapsedToolGroup key={`group-${idx}`} group={group} toolContext={toolContext} />;
        }

        const msg = item as import("../lib/event-reducer.js").ChatMessage;

        if (msg.role === "turnSeparator") {
          return <div key={msg.id} className="mx-4 my-2 border-t border-[var(--border-subtle)]" />;
        }

        if (msg.role === "user") {
          // Skill invocations render as a distinct collapsible card so chat
          // doesn't show walls of expanded skill body. Plain user messages
          // continue to render as the existing blue bubble.
          // See change: render-skill-invocations-collapsibly.
          if (msg.skill) {
            return (
              <div
                key={msg.id}
                className="mt-4 mb-4 flex justify-end"
                {...(msg.turnIndex != null ? { "data-turn": msg.turnIndex } : {})}
                {...(msg.entryId ? { "data-entry-id": msg.entryId } : {})}
              >
                <div className={bubbleMax}>
                  {msg.author && (
                    <div className="flex justify-end">
                      <AttributionChip author={msg.author} viewerSub={viewerSub} />
                    </div>
                  )}
                  {msg.images && msg.images.length > 0 && (
                    <div className="mb-2">
                      <ImageAttachments images={msg.images} />
                    </div>
                  )}
                  <SkillInvocationCard
                    skill={msg.skill}
                    rawContent={msg.content}
                    timestamp={msg.timestamp}
                    entryId={msg.entryId}
                    onFork={onForkFromMessage}
                  />
                </div>
              </div>
            );
          }
          // Level-3 full-bubble tint (multi-operator, Surface A — Option B).
          // A user turn that carries an author gets a ROLE-anchored tint
          // (operator → amber, guest → violet). To beat the editorial skin's
          // `.editorial-userbubble { ... !important }` background/border rule
          // (inline style loses to !important), the tinted branch DROPS the
          // `editorial-userbubble` + blue Tailwind classes entirely and paints
          // via inline style — with no matching class, no !important rule fires,
          // so the inline tint wins. A no-author turn keeps the class + blue
          // classes BYTE-UNCHANGED (single-operator / flag-off path).
          const userTint = msg.author ? bubbleTintFor(msg.author) : null;
          return (
            <div
              key={msg.id}
              className="mt-4 mb-4 flex flex-col items-end"
              {...(msg.turnIndex != null ? { "data-turn": msg.turnIndex } : {})}
              {...(msg.entryId ? { "data-entry-id": msg.entryId } : {})}
            >
              {msg.author && <AttributionChip author={msg.author} viewerSub={viewerSub} />}
              <div
                className={
                  userTint
                    ? `border border-l-2 rounded-xl shadow-md px-4 py-2 ${bubbleMax}`
                    : `editorial-userbubble bg-blue-500/10 border border-blue-500/20 border-l-2 border-l-blue-400 rounded-xl shadow-md px-4 py-2 ${bubbleMax}`
                }
                {...(userTint
                  ? { style: { backgroundColor: userTint.bg, borderColor: userTint.border, color: userTint.text } }
                  : {})}
                data-attribution-tint={userTint ? (msg.author?.isOperator ? "operator" : "guest") : undefined}
              >
                {msg.images && msg.images.length > 0 && (
                  <ImageAttachments images={msg.images} />
                )}
                {msg.content && (
                  <MessageBubble
                    content={msg.content}
                    className=""
                    timestamp={msg.timestamp}
                    entryId={msg.entryId}
                    onFork={onForkFromMessage}
                    isPinned={msg.entryId ? pinnedEntryIds.has(msg.entryId) : false}
                    onTogglePin={handleTogglePin}
                  />
                )}
              </div>
            </div>
          );
        }

        if (msg.role === "thinking") {
          // A committed thinking row stays expanded only while it is the
          // latest committed message (model still actively reasoning OR
          // thinking-just-finished-but-no-final-text-yet). Once the model
          // moves on — any subsequent non-thinking, non-turnSeparator
          // item exists in `visibleMessages` after this row — the row
          // auto-collapses on next render. Turn separators are layout-
          // only and don't count as "model moved on"; a collapsed tool-
          // call group does count (it's downstream model output).
          //
          // The `-latest` | `-older` key suffix forces React to remount
          // the ThinkingBlock when the latest→older transition occurs,
          // so the new `defaultExpanded={false}` takes effect. Once a
          // row is keyed `-older`, subsequent newer messages don't
          // re-fire the key change (still `-older`), preserving the
          // user's manual-toggle state if they expanded the older block
          // by hand.
          //
          // The live-streaming branch below (~line 748) remains
          // unconditional `defaultExpanded` — it renders
          // `state.streamingThinking` directly and unmounts when the
          // streaming block finishes.
          //
          // See investigations:
          //   pi-dashboard-thinking-block-streaming-state-loss-
          //   investigation-2026-05-25 (Bert commit 22978a8 first-pass
          //   sticky-expanded fix) +
          //   thinking-block-auto-collapse-cell-DONE-2026-05-25 (this
          //   follow-up per operator chat 2026-05-25).
          const isLatestThinking = !visibleMessages.slice(idx + 1).some((next) => {
            if ((next as ToolCallGroup).type === "group") return true;
            const nextRole = (next as import("../lib/event-reducer.js").ChatMessage).role;
            return nextRole !== "thinking" && nextRole !== "turnSeparator";
          });
          return (
            <ThinkingBlock
              key={`${msg.id}-${isLatestThinking ? "latest" : "older"}`}
              content={msg.content}
              defaultExpanded={isLatestThinking}
              startedAt={msg.startedAt}
              duration={msg.duration}
              pinContext={msg.entryId ? {
                entryId: msg.entryId,
                isPinned: pinnedEntryIds.has(msg.entryId),
                onTogglePin: handleTogglePin,
              } : undefined}
            />
          );
        }

        if (msg.role === "toolResult") {
          if (!showDebugTools && isDebugTool(msg.toolName ?? "")) return null;
          if (hiddenToolResultIds.has(msg.id)) return null;
          if (retriedErrorIds.has(msg.id)) {
            return (
              <RetriedErrorBadge
                key={msg.id}
                toolName={msg.toolName ?? "unknown"}
                toolCallId={msg.toolCallId ?? msg.id}
                args={msg.args}
                result={msg.result}
                context={toolContext}
                startedAt={msg.startedAt}
                duration={msg.duration}
                toolDetails={msg.toolDetails}
              />
            );
          }
          return (
            <ToolCallStep
              key={msg.id}
              toolName={msg.toolName ?? "unknown"}
              toolCallId={msg.toolCallId ?? msg.id}
              args={msg.args}
              status={msg.toolStatus ?? "running"}
              result={msg.result}
              images={msg.images}
              context={toolContext}
              startedAt={msg.startedAt}
              duration={msg.duration}
              toolDetails={msg.toolDetails}
              onAbort={msg.toolStatus === "running" ? onAbort : undefined}
              onForceKill={msg.toolStatus === "running" ? onForceKill : undefined}
              pinContext={msg.entryId ? {
                entryId: msg.entryId,
                isPinned: pinnedEntryIds.has(msg.entryId),
                onTogglePin: handleTogglePin,
              } : undefined}
            />
          );
        }

        if (msg.role === "bashOutput") {
          const args = msg.args as any;
          return (
            <BashOutputCard
              key={msg.id}
              command={args?.command ?? ""}
              output={msg.content}
              exitCode={args?.exitCode ?? 0}
              excludeFromContext={args?.excludeFromContext ?? false}
              timestamp={msg.timestamp}
            />
          );
        }

        if (msg.role === "commandFeedback") {
          const args = msg.args as any;
          return (
            <CommandFeedbackCard
              key={msg.id}
              command={args?.command ?? ""}
              status={args?.status ?? "started"}
              message={msg.content || undefined}
            />
          );
        }

        if (msg.role === "interactiveUi") {
          const args = msg.args as any;
          const request: InteractiveUiRequest = {
            requestId: args.requestId,
            method: args.method,
            params: args.params,
            status: args.status,
            result: args.result,
          };
          return (
            <InteractiveUiCard
              key={msg.id}
              request={request}
              onRespondToUi={onRespondToUi}
            />
          );
        }

        if (msg.role === "rawEvent") {
          if (!showDebugTools) return null;
          return (
            <RawEventCard
              key={msg.id}
              eventType={msg.toolName ?? "unknown"}
              content={msg.content}
              timestamp={msg.timestamp}
            />
          );
        }

        // assistant
        const bMax = hasMermaid(msg.content) ? bubbleWide : bubbleMax;
        return (
          <div
            key={msg.id}
            className="mt-4 mb-4 flex justify-start"
            {...(msg.entryId ? { "data-entry-id": msg.entryId } : {})}
          >
            <MessageBubble
              content={msg.content}
              className={`bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] rounded-xl shadow-md px-4 py-2 ${bMax}`}
              timestamp={msg.timestamp}
              entryId={msg.entryId}
              onFork={onForkFromMessage}
              isPinned={msg.entryId ? pinnedEntryIds.has(msg.entryId) : false}
              onTogglePin={handleTogglePin}
            />
          </div>
        );
      })}

      {/* Streaming thinking */}
      {state.streamingThinking && (
        <ThinkingBlock
          content={state.streamingThinking}
          isStreaming
          defaultExpanded
          startedAt={state.thinkingStartedAt}
        />
      )}

      {/* Streaming text */}
      {state.streamingText && (
        <div className="flex justify-start">
          <div className={`bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] rounded-xl shadow-md px-4 py-2 ${hasMermaid(state.streamingText) ? bubbleWide : bubbleMax}`}>
            <MarkdownContent content={state.streamingText} />
            <span className="inline-block w-1.5 h-4 bg-[var(--bg-surface)] animate-pulse ml-0.5" />
          </div>
        </div>
      )}

      {/* Retry banner — visible while a synthesized provider retry is in flight.
          Bridge sends `delayMs: -1` / `maxAttempts: -1` sentinels (pi does not
          expose its retry settings); RetryBanner renders an indeterminate state.
          See change: fix-provider-retry-infinite-loop. */}
      {state.retryState && (
        <RetryBanner retryState={state.retryState} onAbort={onAbort} />
      )}

      {/* Error banner */}
      {state.lastError && (
        <ErrorBanner
          message={state.lastError.message}
          onDismiss={onDismissError}
          onRetry={onRetryAfterError}
        />
      )}

      {/* Optimistic pending prompt card — lifts into place the instant you send
          (smooth spring, translateY→0 + fade). The lift IS the feedback, so
          there's no spinner; the card reconciles into the committed user bubble
          when the server acks (pendingPrompt clears, the real bubble renders in
          its place). Reduced-motion: appears in place, no travel. */}
      {state.pendingPrompt && (
        <m.div
          data-testid="pending-prompt-card"
          className="mt-4 mb-4 flex justify-end"
          initial={reducedMotion ? false : { opacity: 0, y: 22 }}
          animate={{ opacity: 1, y: 0 }}
          transition={spring.smooth}
        >
          <div className={`editorial-userbubble bg-blue-500/10 border border-blue-500/20 border-l-2 border-l-blue-400 rounded-xl shadow-md px-4 py-2 ${bubbleMax}`}>
            {state.pendingPrompt.images && state.pendingPrompt.images.length > 0 && (
              <ImageAttachments images={state.pendingPrompt.images} />
            )}
            <MarkdownContent content={state.pendingPrompt.text} />
          </div>
        </m.div>
      )}

      {/* Message-queue visible stack (dashboard-message-queue/v1) — each queued
          follow-up as a distinct dimmed "queued · #N" card below the live
          transcript. The head is next to dispatch; on dispatch the reducer
          removes it and the committed user bubble renders above. Generalizes
          the single optimistic pending-prompt card to N. See change:
          dashboard-message-queue. */}
      {state.queue.map((entry, i) => (
        <QueuedMessageCard
          key={entry.queueNonce}
          entry={entry}
          position={i + 1}
          bubbleMax={bubbleMax}
          reducedMotion={reducedMotion}
          onRetry={onRetryQueued}
          onDismiss={onDismissQueued}
        />
      ))}

      {state.messages.length === 0 && !state.streamingText && !state.pendingPrompt && state.queue.length === 0 && (
        <div className="flex items-center justify-center h-full text-[var(--text-tertiary)]">
          <p>No messages yet</p>
        </div>
      )}
      </div>
    </div>
    {showScrollButton && (
      <button
        data-testid="scroll-to-bottom"
        onClick={scrollToBottom}
        className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] rounded-full p-2 shadow-lg hover:bg-[var(--bg-surface)] transition-colors"
        title="Scroll to bottom"
      >
        <Icon path={mdiChevronDown} size={0.8} className="text-[var(--text-secondary)]" />
      </button>
    )}
    {/* Chat search overlay — sibling of scrollRef so it stays anchored to
        the top-right of the chat view (doesn't scroll with content).
        markProgrammatic() is passed as onBeforeScroll so search-driven
        scrollIntoView calls don't trip the user-scroll detection in
        handleScroll above. Sister-shape pattern to scrollToTurn's
        programmatic-scroll guard discipline.
        Cell: pi-agent-dashboard-ux-message-discoverability/v1 (W4.1 Feature 1). */}
    {searchActive && (
      <ChatSearch
        containerRef={scrollRef}
        entriesCount={state.messages.length}
        sessionId={sessionId}
        onClose={() => setSearchActive(false)}
        onBeforeScroll={markProgrammatic}
      />
    )}
    </div>
  );
});
