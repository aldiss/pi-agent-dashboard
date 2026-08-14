import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon } from "@mdi/react";
import {
  mdiArrowLeft,
  mdiChevronDown,
  mdiClose,
  mdiContentCopy,
  mdiEyeOutline,
  mdiMagnify,
  mdiRefresh,
  mdiWrap,
  mdiWrapDisabled,
} from "@mdi/js";
import {
  fetchExternalSessionCapture,
  type ExternalRuntime,
  type ExternalSessionCapture,
  type ExternalSessionState,
} from "../lib/external-sessions-api.js";

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const SCROLL_THRESHOLD_PX = 64;
const WRAP_PREF_KEY = "dashboard:externalOutputWrap";

/** Remembered wrap choice; falls back to wrap-on-mobile when unset. */
function readWrapPref(isMobile: boolean): boolean {
  try {
    const stored = window.localStorage.getItem(WRAP_PREF_KEY);
    if (stored === "true") return true;
    if (stored === "false") return false;
  } catch {
    /* ignore */
  }
  return isMobile;
}

function writeWrapPref(value: boolean): void {
  try {
    window.localStorage.setItem(WRAP_PREF_KEY, String(value));
  } catch {
    /* ignore */
  }
}

export interface ExternalSessionDetailProps {
  sessionId: string;
  tmuxSession: string;
  runtime: ExternalRuntime;
  title: string;
  model?: string | null;
  effort?: string | null;
  state: ExternalSessionState;
  endedAt?: number | null;
  isMobile?: boolean;
  onBack?: () => void;
  /** Exposed for deterministic focused tests. Production uses the 2s default. */
  pollIntervalMs?: number;
}

interface CapturedView extends ExternalSessionCapture {
  sessionId: string;
}

function formatClock(timestamp: number | null | undefined): string | null {
  if (timestamp == null || !Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function findMatches(output: string, query: string): number[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const haystack = output.toLocaleLowerCase();
  const matches: number[] = [];
  let cursor = 0;
  while (cursor <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index < 0) break;
    matches.push(index);
    cursor = index + Math.max(needle.length, 1);
  }
  return matches;
}

/**
 * Read-only detail surface for a tmux-hosted Codex or Claude Code session.
 * Only GET capture polling and clipboard writes exist here; no pane write API
 * is imported or accepted through props.
 */
export function ExternalSessionDetail({
  sessionId,
  tmuxSession,
  runtime,
  title,
  model,
  effort,
  state,
  endedAt,
  isMobile = false,
  onBack,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: ExternalSessionDetailProps): React.ReactElement {
  const [capture, setCapture] = useState<CapturedView | null>(null);
  const [frozenSessionId, setFrozenSessionId] = useState<string | null>(null);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const [error, setError] = useState<{ sessionId: string; message: string } | null>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  // Line wrapping. A tmux capture is 180-206 columns wide; on a phone that runs
  // off the right edge and the operator has to pan horizontally to read a
  // sentence. Wrap defaults ON for narrow viewports and OFF on desktop, where
  // exact column alignment (box-drawing, tables) is worth the horizontal scroll.
  // The choice is remembered once made.
  const [wrap, setWrap] = useState<boolean>(() => readWrapPref(isMobile));
  const toggleWrap = useCallback(() => {
    setWrap((prev) => {
      const next = !prev;
      writeWrapPref(next);
      return next;
    });
  }, []);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");

  const outputRef = useRef<HTMLPreElement>(null);
  const activeMatchRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const inFlightGenerationRef = useRef<number | null>(null);
  const currentSessionIdRef = useRef(sessionId);
  const parentEndedRef = useRef(state === "ended");
  const hasCaptureRef = useRef(false);
  const frozenRef = useRef(false);
  const isNearBottomRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const programmaticTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  currentSessionIdRef.current = sessionId;
  parentEndedRef.current = state === "ended";

  const currentCapture = capture?.sessionId === sessionId ? capture : null;
  hasCaptureRef.current = currentCapture != null;
  const captureEnded = currentCapture?.state === "ended";
  const ended = state === "ended" || captureEnded || frozenSessionId === sessionId;
  const endedClock = formatClock(endedAt);
  const output = currentCapture?.output ?? "";
  const displayOutput = currentCapture
    ? output || "(no output captured)"
    : loadingSessionId === sessionId
      ? "Loading output…"
      : "(no output captured)";
  const attachCommand = `tmux -L pi attach -t ${tmuxSession}`;
  const runtimeModel = model?.startsWith(`${runtime}/`)
    ? model
    : `${runtime}/${model ?? "unknown model"}`;
  const modelLabel = `${runtimeModel}${effort ? ` (${effort})` : ""}`;

  const matches = useMemo(
    () => findMatches(output, searchQuery),
    [output, searchQuery],
  );
  const visibleMatch = matches.length === 0 ? 0 : Math.min(activeMatch, matches.length - 1);

  const markProgrammatic = useCallback(() => {
    programmaticScrollRef.current = true;
    if (programmaticTimerRef.current) clearTimeout(programmaticTimerRef.current);
    programmaticTimerRef.current = setTimeout(() => {
      programmaticScrollRef.current = false;
      programmaticTimerRef.current = null;
    }, 150);
  }, []);

  const loadCapture = useCallback(async (id: string, generation: number): Promise<void> => {
    if (inFlightGenerationRef.current === generation) return;
    const keepAliveOnly = frozenRef.current
      || (parentEndedRef.current && hasCaptureRef.current);

    inFlightGenerationRef.current = generation;
    if (mountedRef.current && !keepAliveOnly) setLoadingSessionId(id);
    try {
      const next = await fetchExternalSessionCapture(id);
      if (
        !mountedRef.current
        || generation !== generationRef.current
        || id !== currentSessionIdRef.current
      ) return;

      // Parent list polling is authoritative enough to freeze immediately.
      // Ignore an in-flight result after that transition so neither bytes nor
      // scroll position jump while the operator is reading frozen output.
      if (keepAliveOnly || (parentEndedRef.current && hasCaptureRef.current)) {
        frozenRef.current = true;
        setFrozenSessionId(id);
        setError(null);
        return;
      }

      setCapture({ ...next, sessionId: id });
      hasCaptureRef.current = true;
      setError(null);
      if (next.state === "ended" || parentEndedRef.current) {
        frozenRef.current = true;
        setFrozenSessionId(id);
      }
    } catch (caught) {
      if (
        !keepAliveOnly
        &&
        mountedRef.current
        && generation === generationRef.current
        && id === currentSessionIdRef.current
      ) {
        setError({
          sessionId: id,
          message: caught instanceof Error ? caught.message : String(caught),
        });
      }
    } finally {
      if (inFlightGenerationRef.current === generation) {
        inFlightGenerationRef.current = null;
      }
      if (
        mountedRef.current
        && generation === generationRef.current
        && id === currentSessionIdRef.current
      ) {
        setLoadingSessionId(null);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (programmaticTimerRef.current) clearTimeout(programmaticTimerRef.current);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    inFlightGenerationRef.current = null;
    frozenRef.current = false;
    hasCaptureRef.current = false;
    isNearBottomRef.current = true;
    setCapture(null);
    setFrozenSessionId(null);
    setLoadingSessionId(null);
    setError(null);
    setShowScrollButton(false);
    setSearchOpen(false);
    setSearchQuery("");
    setActiveMatch(0);
    setCopyStatus("idle");

    void loadCapture(sessionId, generation);
    const interval = window.setInterval(() => {
      void loadCapture(sessionId, generation);
    }, pollIntervalMs);
    return () => window.clearInterval(interval);
  }, [loadCapture, pollIntervalMs, sessionId]);

  useEffect(() => {
    if (state !== "ended" || !currentCapture) return;
    frozenRef.current = true;
    setFrozenSessionId(sessionId);
  }, [currentCapture, sessionId, state]);

  // Tail-follow must depend on growing capture content, not message count.
  useEffect(() => {
    if (!currentCapture || !isNearBottomRef.current) return;
    requestAnimationFrame(() => {
      const element = outputRef.current;
      if (!element || !isNearBottomRef.current) return;
      markProgrammatic();
      element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
    });
  }, [currentCapture?.output.length, markProgrammatic, sessionId]);

  useEffect(() => {
    if (!searchQuery || matches.length === 0) return;
    activeMatchRef.current?.scrollIntoView?.({ block: "center", inline: "center" });
  }, [matches.length, searchQuery, visibleMatch]);

  const handleScroll = useCallback(() => {
    if (programmaticScrollRef.current) return;
    const element = outputRef.current;
    if (!element) return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < SCROLL_THRESHOLD_PX;
    isNearBottomRef.current = nearBottom;
    setShowScrollButton(!nearBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    const element = outputRef.current;
    if (!element) return;
    markProgrammatic();
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    isNearBottomRef.current = true;
    setShowScrollButton(false);
  }, [markProgrammatic]);

  const toggleSearch = useCallback(() => {
    setSearchOpen((open) => {
      const next = !open;
      if (next) requestAnimationFrame(() => searchInputRef.current?.focus());
      return next;
    });
  }, []);

  const moveToNextMatch = useCallback(() => {
    if (matches.length === 0) return;
    setActiveMatch((index) => (index + 1) % matches.length);
  }, [matches.length]);

  const copyAttachCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(attachCommand);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopyStatus("idle"), 1_500);
  }, [attachCommand]);

  let outputNode: React.ReactNode = displayOutput;
  if (searchQuery.trim() && matches.length > 0 && currentCapture) {
    const start = matches[visibleMatch];
    const end = start + searchQuery.trim().length;
    outputNode = (
      <>
        {output.slice(0, start)}
        <mark
          ref={activeMatchRef}
          className="bg-[var(--accent-yellow)]/35 text-inherit outline outline-1 outline-[var(--accent-yellow)]"
        >
          {output.slice(start, end)}
        </mark>
        {output.slice(end)}
      </>
    );
  }

  const copyLabel = copyStatus === "copied"
    ? "Copied"
    : copyStatus === "failed"
      ? "Copy failed"
      : "Copy tmux attach command";

  return (
    <div
      className="flex-1 flex flex-col min-w-0 min-h-0 h-full bg-[var(--bg-primary)]"
      data-testid="external-session-detail"
      data-state={ended ? "ended" : "live"}
    >
      <header className="shrink-0 border-b border-[var(--border-primary)] bg-[var(--bg-primary)]">
        <div className={`${isMobile ? "min-h-[44px] px-2" : "px-4 py-2"} flex items-center gap-2 text-sm min-w-0`}>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className={`${isMobile ? "min-w-[44px] min-h-[44px]" : "p-1"} flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)]`}
              aria-label="Back"
            >
              <Icon path={mdiArrowLeft} size={isMobile ? 0.75 : 0.65} />
            </button>
          )}
          <span className={`editorial-name ${ended ? "text-[var(--text-secondary)]" : "text-[var(--text-primary)]"} truncate min-w-0`}>
            {title || tmuxSession}
          </span>
          {!isMobile && (
            <span className="editorial-meta text-xs text-[var(--text-secondary)] truncate min-w-0">
              {modelLabel}
            </span>
          )}
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border border-[var(--border-subtle)] text-[var(--text-tertiary)] shrink-0">
            <Icon path={mdiEyeOutline} size={0.45} />
            read-only
          </span>
          <span className="flex-1" />
          {!isMobile && ended && (
            <span className="text-[11px] text-[var(--text-tertiary)] shrink-0 tabular-nums">
              {endedClock ? `Ended · ${endedClock}` : "Ended"}
            </span>
          )}
          <button
            type="button"
            onClick={toggleWrap}
            className={`${isMobile ? "min-w-[44px] min-h-[44px]" : "p-1"} flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)]`}
            aria-label={wrap ? "Show exact lines (no wrapping)" : "Wrap long lines"}
            aria-pressed={wrap}
            title={wrap ? "Wrapping on — tap for exact lines" : "Exact lines — tap to wrap"}
            data-testid="external-session-wrap-toggle"
          >
            <Icon path={wrap ? mdiWrap : mdiWrapDisabled} size={isMobile ? 0.75 : 0.65} />
          </button>
          <button
            type="button"
            onClick={toggleSearch}
            className={`${isMobile ? "min-w-[44px] min-h-[44px]" : "p-1"} flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)]`}
            aria-label={searchOpen ? "Close output search" : "Search output"}
            title={searchOpen ? "Close output search" : "Search output"}
          >
            <Icon path={searchOpen ? mdiClose : mdiMagnify} size={isMobile ? 0.75 : 0.65} />
          </button>
          <button
            type="button"
            onClick={() => void loadCapture(sessionId, generationRef.current)}
            disabled={ended || loadingSessionId === sessionId}
            className={`${isMobile ? "min-w-[44px] min-h-[44px]" : "p-1"} flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-40`}
            aria-label="Refresh output"
            title={ended ? "Output frozen" : "Refresh output"}
          >
            <Icon
              path={mdiRefresh}
              size={isMobile ? 0.75 : 0.65}
              className={loadingSessionId === sessionId ? "animate-spin" : ""}
            />
          </button>
        </div>
        {isMobile && (
          <div className="flex items-center gap-1.5 px-3 pb-1 min-w-0">
            <span className="editorial-meta text-[10px] text-[var(--text-tertiary)] truncate">
              {modelLabel}
            </span>
            <span className="flex-1" />
            {ended && (
              <span className="text-[10px] text-[var(--text-tertiary)] shrink-0 tabular-nums">
                {endedClock ? `Ended · ${endedClock}` : "Ended"}
              </span>
            )}
          </div>
        )}
        {searchOpen && (
          <div className="px-3 py-2 border-t border-[var(--border-subtle)] flex items-center gap-2">
            <input
              ref={searchInputRef}
              type="search"
              value={searchQuery}
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setActiveMatch(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  moveToNextMatch();
                } else if (event.key === "Escape") {
                  setSearchOpen(false);
                }
              }}
              placeholder="Search captured output"
              aria-label="Search external session output"
              className="flex-1 min-w-0 rounded border border-[var(--border-secondary)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
            />
            {searchQuery.trim() && (
              <span className="text-[10px] text-[var(--text-tertiary)] tabular-nums shrink-0">
                {matches.length === 0 ? "No matches" : `${visibleMatch + 1} / ${matches.length}`}
              </span>
            )}
          </div>
        )}
      </header>

      {ended && (
        <div className="shrink-0 px-4 py-2 border-b border-[var(--border-primary)] bg-[var(--bg-secondary)] text-[12px] text-[var(--text-secondary)]">
          {endedClock
            ? <>This session ended at <strong className="tabular-nums">{endedClock}</strong>. Output below is frozen.</>
            : "This session ended. Output below is frozen."}
        </div>
      )}

      <div className="flex-1 min-h-0 relative bg-[var(--bg-code)]">
        <pre
          ref={outputRef}
          onScroll={handleScroll}
          className={`absolute inset-0 m-0 overflow-auto ${wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre"} font-mono text-[11px] leading-snug text-[var(--text-secondary)] ${ended ? "opacity-60" : ""}`}
          data-testid="external-session-output"
          aria-label="Captured terminal output"
        >
          <code
            className={`min-h-full ${wrap ? "w-full" : "min-w-max"} flex flex-col justify-end p-3`}
            data-testid="external-session-output-content"
          >
            <span>{outputNode}</span>
          </code>
        </pre>
        {ended && (
          <span className="absolute top-2 right-3 pointer-events-none text-[9px] uppercase tracking-widest font-semibold px-1.5 py-0.5 rounded bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[var(--text-tertiary)]">
            frozen — no further output
          </span>
        )}
        {error?.sessionId === sessionId && (
          <span
            className="absolute top-2 left-3 max-w-[70%] truncate text-[10px] px-2 py-1 rounded bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] text-[var(--accent-red)]"
            title={error.message}
          >
            Capture refresh failed
          </span>
        )}
        {showScrollButton && (
          <button
            type="button"
            onClick={scrollToBottom}
            data-testid="external-session-scroll-to-bottom"
            className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] rounded-full p-2 shadow-lg hover:bg-[var(--bg-surface)] transition-colors"
            title="Scroll to bottom"
            aria-label="Scroll to bottom"
          >
            <Icon path={mdiChevronDown} size={0.8} className="text-[var(--text-secondary)]" />
          </button>
        )}
      </div>

      {isMobile ? (
        <div
          className="shrink-0 px-3 pt-2 bg-[var(--bg-secondary)] pb-[max(0.5rem,env(safe-area-inset-bottom,0.5rem))]"
          data-testid="external-session-mobile-footer"
        >
          <div className="min-h-[48px] bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded-3xl px-3 py-2 flex items-center gap-2 shadow-lg">
            <Icon path={mdiEyeOutline} size={0.65} className="text-[var(--text-tertiary)] shrink-0" />
            <span className="text-[12px] text-[var(--text-tertiary)] flex-1 min-w-0 truncate">
              {ended ? "Read-only — session ended" : "Read-only — runs in a tmux pane"}
            </span>
            {!ended && (
              <button
                type="button"
                onClick={() => void copyAttachCommand()}
                className="w-9 h-9 rounded-full bg-[var(--bg-tertiary)] flex items-center justify-center text-[var(--text-tertiary)] shrink-0"
                aria-label="Copy tmux attach command"
                title={copyLabel}
              >
                <Icon path={mdiContentCopy} size={0.6} />
              </button>
            )}
          </div>
        </div>
      ) : (
        <div
          className="shrink-0 border-t border-[var(--border-primary)] p-3 flex items-center gap-2.5 bg-[var(--bg-secondary)]"
          data-testid="external-session-desktop-footer"
        >
          <Icon path={mdiEyeOutline} size={0.65} className="text-[var(--text-tertiary)] shrink-0" />
          <span className="text-[12px] text-[var(--text-tertiary)] shrink-0">
            {ended
              ? "Read-only — session ended. The pane is gone; this is its last captured output."
              : "Read-only — this session runs in a tmux pane."}
          </span>
          {!ended && (
            <>
              <span className="flex-1" />
              <code className="editorial-meta text-[var(--text-muted)] px-2 py-1 rounded bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] truncate">
                {attachCommand}
              </code>
              <button
                type="button"
                onClick={() => void copyAttachCommand()}
                className="text-[var(--text-tertiary)] shrink-0 p-1 rounded hover:bg-[var(--bg-hover)]"
                aria-label="Copy tmux attach command"
                title={copyLabel}
              >
                <Icon path={mdiContentCopy} size={0.6} />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
