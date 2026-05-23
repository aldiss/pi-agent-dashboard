import React, { useRef, useEffect, useCallback, useState, useMemo, forwardRef, useImperativeHandle } from "react";
import { Icon } from "@mdi/react";
import { mdiContentCopy, mdiTextBox, mdiLoading, mdiChevronDown, mdiSourceFork } from "@mdi/js";
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
   * Visibility of MessageFilterControls (Feature 2). Parent (App.tsx) owns
   * the toggle so a header button in SessionHeader can flip it without a
   * second copy of the controls. Controls render inline above the chat
   * scroll area when true.
   */
  showFilterControls?: boolean;
  onCloseFilterControls?: () => void;
}

function ImageAttachments({ images }: { images: ChatImage[] }) {
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
}

function MessageBubble({ content, className, timestamp, entryId, onFork, isPinned, onTogglePin }: { content: string; className: string; timestamp?: number; entryId?: string; onFork?: (entryId: string) => void; isPinned?: boolean; onTogglePin?: (entryId: string) => void }) {
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
}

function InteractiveUiCard({ request, onRespondToUi }: {
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
}

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

export const ChatView = forwardRef<ChatViewHandle, Props>(function ChatView({ sessionId, state, toolContext, onCancelPending, onRespondToUi, onAbort, onForceKill, onForkFromMessage, onDismissError, onRetryAfterError, showFilterControls, onCloseFilterControls }, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNearBottom = useRef(true);
  const programmaticScroll = useRef(false);
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
    if (programmaticScroll.current) return;
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
  }, [state.messages.length, state.streamingText, state.pendingPrompt, markProgrammatic]);

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
          return (
            <div
              key={msg.id}
              className="mt-4 mb-4 flex justify-end"
              {...(msg.turnIndex != null ? { "data-turn": msg.turnIndex } : {})}
              {...(msg.entryId ? { "data-entry-id": msg.entryId } : {})}
            >
              <div className={`bg-blue-500/10 border border-blue-500/20 border-l-2 border-l-blue-400 rounded-xl shadow-md px-4 py-2 ${bubbleMax}`}>
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
          return (
            <ThinkingBlock
              key={msg.id}
              content={msg.content}
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

      {/* Optimistic pending prompt card */}
      {state.pendingPrompt && (
        <div data-testid="pending-prompt-card" className="mt-4 mb-4 flex justify-end">
          <div className={`bg-blue-500/10 border border-blue-500/20 border-l-2 border-l-blue-400 rounded-xl shadow-md px-4 py-2 ${bubbleMax}`}>
            {state.pendingPrompt.images && state.pendingPrompt.images.length > 0 && (
              <ImageAttachments images={state.pendingPrompt.images} />
            )}
            <div className="flex items-start gap-2">
              <div className="flex-1">
                <MarkdownContent content={state.pendingPrompt.text} />
              </div>
              <Icon path={mdiLoading} size={0.7} className="animate-spin text-blue-400 shrink-0 mt-0.5" />
            </div>
          </div>
        </div>
      )}

      {state.messages.length === 0 && !state.streamingText && !state.pendingPrompt && (
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
