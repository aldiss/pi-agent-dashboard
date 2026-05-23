import React, { useState, useEffect, useRef, useCallback } from "react";
import Fuse from "fuse.js";
import { Icon } from "@mdi/react";
import { mdiChevronUp, mdiChevronDown, mdiClose } from "@mdi/js";

/**
 * ChatSearch — floating search bar that highlights matches inside the
 * ChatView's scroll container.
 *
 * Sister-shape adapt of MarkdownSearch.tsx (used by the MarkdownContent
 * viewer). The same TreeWalker-based DOM mark-injection strategy applies
 * unchanged; only the highlight class names + props differ so the two
 * search overlays can coexist (e.g., an open MarkdownSearch on a long
 * assistant message AND a chat-level ChatSearch over the whole transcript).
 *
 * Indexing strategy: client-side Fuse.js fuzzy search over leaf text
 * elements (p, li, h1-h6, td, th, dt, dd, blockquote, pre) inside the
 * passed `containerRef`. Re-indexes whenever `entriesCount` changes;
 * exact substring is preferred over fuzzy, identical to MarkdownSearch.
 *
 * Cell: pi-agent-dashboard-ux-message-discoverability/v1 (W4.1 Feature 1).
 * Server-side fallback for very long sessions is a V0.5+ stub per W3 Q1
 * substrate-author resolution; this V0 ships client-side only.
 */

const HIGHLIGHT_CLASS = "chat-search-highlight";
const ACTIVE_HIGHLIGHT_CLASS = "chat-search-highlight-active";

interface Props {
  /** Ref to the scrollable container holding rendered chat messages. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Number of entries currently rendered. Used as the re-index trigger. */
  entriesCount: number;
  /** Session id. When it changes the cleanup effect strips highlights. */
  sessionId?: string;
  /** Called when the user dismisses the bar (Escape, X, or external toggle). */
  onClose: () => void;
  /**
   * Called immediately before a programmatic scrollIntoView so the parent
   * (ChatView) can raise its `programmaticScroll` guard. Without this the
   * onScroll handler in ChatView would misread the search-driven scroll
   * as a user gesture and disable auto-scroll-to-bottom for the rest of
   * the session.
   */
  onBeforeScroll?: () => void;
}

interface SearchableItem {
  text: string;
  /** The DOM element this text came from */
  element: Element;
}

/** Extract leaf text-bearing elements from the chat container for indexing. */
function extractTextBlocks(container: HTMLElement): SearchableItem[] {
  const items: SearchableItem[] = [];
  const elements = container.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, td, th, dt, dd, blockquote, pre");
  for (const el of elements) {
    const text = el.textContent?.trim();
    if (text && text.length > 0) {
      items.push({ text, element: el });
    }
  }
  return items;
}

/** Strip every chat-search mark from the container (used on close + re-index). */
function clearHighlights(container: HTMLElement) {
  const marks = container.querySelectorAll(`mark.${HIGHLIGHT_CLASS}`);
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (parent) {
      parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
      parent.normalize();
    }
  }
}

/** TreeWalker-based mark injection. Skips text already inside a chat-search mark. */
function highlightTextInElement(element: Element, searchTerms: string[]): number {
  let count = 0;
  const escaped = searchTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (escaped.length === 0) return 0;
  const pattern = new RegExp(`(${escaped.join("|")})`, "gi");

  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if (node.parentElement?.closest(`mark.${HIGHLIGHT_CLASS}`)) continue;
    if (pattern.test(node.data)) {
      textNodes.push(node);
    }
    pattern.lastIndex = 0;
  }

  for (const textNode of textNodes) {
    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(textNode.data)) !== null) {
      if (match.index > lastIndex) {
        frag.appendChild(document.createTextNode(textNode.data.slice(lastIndex, match.index)));
      }
      const mark = document.createElement("mark");
      mark.className = HIGHLIGHT_CLASS;
      mark.textContent = match[0];
      frag.appendChild(mark);
      count++;
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < textNode.data.length) {
      frag.appendChild(document.createTextNode(textNode.data.slice(lastIndex)));
    }
    textNode.parentNode?.replaceChild(frag, textNode);
  }

  return count;
}

export function ChatSearch({ containerRef, entriesCount, sessionId, onClose, onBeforeScroll }: Props) {
  const [query, setQuery] = useState("");
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const fuseRef = useRef<Fuse<SearchableItem> | null>(null);
  const itemsRef = useRef<SearchableItem[]>([]);
  const queryRef = useRef("");

  // Auto-focus + select on mount so the operator can immediately type.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Cleanup on unmount or sessionId switch: strip highlights so the next
  // open doesn't inherit stale marks. The parent (ChatView) re-mounts
  // ChatSearch on toggle, so this also runs on close.
  useEffect(() => {
    return () => {
      const container = containerRef.current;
      if (container) clearHighlights(container);
    };
  }, [containerRef, sessionId]);

  const scrollToMatch = useCallback((container: HTMLElement, index: number) => {
    const marks = container.querySelectorAll(`mark.${HIGHLIGHT_CLASS}`);
    for (const m of marks) m.classList.remove(ACTIVE_HIGHLIGHT_CLASS);
    if (index >= 0 && index < marks.length) {
      marks[index].classList.add(ACTIVE_HIGHLIGHT_CLASS);
      // Raise ChatView's programmatic-scroll guard BEFORE scrollIntoView so
      // the subsequent onScroll is ignored — matches the markProgrammatic()
      // discipline used by scrollToTurn + scrollToBottom in ChatView.tsx.
      onBeforeScroll?.();
      marks[index].scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [onBeforeScroll]);

  const performSearch = useCallback((searchQuery: string) => {
    const container = containerRef.current;
    if (!container) return;
    clearHighlights(container);

    if (!searchQuery.trim() || !fuseRef.current) {
      setMatchCount(0);
      setCurrentMatch(0);
      return;
    }

    // Prefer exact substring; fall back to Fuse fuzzy. Sister to MarkdownSearch.
    const queryLower = searchQuery.toLowerCase();
    const exactMatches = itemsRef.current.filter((item) =>
      item.text.toLowerCase().includes(queryLower),
    );

    let terms: Set<string>;
    let matchedElements: Set<Element>;

    if (exactMatches.length > 0) {
      terms = new Set([searchQuery]);
      matchedElements = new Set(exactMatches.map((m) => m.element));
    } else {
      const results = fuseRef.current.search(searchQuery);
      terms = new Set<string>();
      for (const result of results) {
        if (result.matches) {
          for (const m of result.matches) {
            if (m.value) {
              for (const [start, end] of m.indices ?? []) {
                const matchedText = m.value.slice(start, end + 1);
                if (matchedText.length >= 2) {
                  terms.add(matchedText);
                }
              }
            }
          }
        }
      }
      if (terms.size === 0) terms.add(searchQuery);
      matchedElements = new Set(results.map((r) => r.item.element));
    }

    let totalHighlights = 0;
    for (const element of matchedElements) {
      totalHighlights += highlightTextInElement(element, [...terms]);
    }
    setMatchCount(totalHighlights);
    setCurrentMatch(totalHighlights > 0 ? 1 : 0);
    if (totalHighlights > 0) {
      scrollToMatch(container, 0);
    }
  }, [containerRef, scrollToMatch]);

  // Keep a ref of the latest query so the re-index effect can re-run it
  // without taking performSearch as a dep (which would re-run it on every
  // input change).
  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  // Re-build the Fuse index when the visible message count changes.
  // The 100ms delay matches MarkdownSearch — gives React a tick to paint
  // newly streamed content before we index its DOM.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const timer = setTimeout(() => {
      const items = extractTextBlocks(container);
      itemsRef.current = items;
      fuseRef.current = new Fuse(items, {
        keys: ["text"],
        threshold: 0.4,
        ignoreLocation: true,
        includeMatches: true,
      });
      if (queryRef.current) {
        performSearch(queryRef.current);
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [entriesCount, containerRef, performSearch]);

  const handleQueryChange = useCallback((value: string) => {
    setQuery(value);
    performSearch(value);
  }, [performSearch]);

  const goToNext = useCallback(() => {
    if (matchCount === 0) return;
    const container = containerRef.current;
    if (!container) return;
    const next = currentMatch >= matchCount ? 1 : currentMatch + 1;
    setCurrentMatch(next);
    scrollToMatch(container, next - 1);
  }, [matchCount, currentMatch, containerRef, scrollToMatch]);

  const goToPrev = useCallback(() => {
    if (matchCount === 0) return;
    const container = containerRef.current;
    if (!container) return;
    const prev = currentMatch <= 1 ? matchCount : currentMatch - 1;
    setCurrentMatch(prev);
    scrollToMatch(container, prev - 1);
  }, [matchCount, currentMatch, containerRef, scrollToMatch]);

  const handleClose = useCallback(() => {
    const container = containerRef.current;
    if (container) clearHighlights(container);
    onClose();
  }, [containerRef, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) goToPrev(); else goToNext();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleClose();
    }
  }, [goToNext, goToPrev, handleClose]);

  return (
    <div
      className="absolute top-2 right-2 z-50 flex items-center gap-1 bg-[var(--bg-secondary)] border border-[var(--border-secondary)] rounded-lg shadow-lg px-2 py-1"
      data-testid="chat-search"
      role="search"
    >
      <span className="text-[var(--text-muted)] text-xs" aria-hidden>🔍</span>
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => handleQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search in chat..."
        aria-label="Search in current session"
        className="text-xs bg-[var(--bg-primary)] border border-[var(--border-secondary)] rounded px-2 py-0.5 text-[var(--text-primary)] placeholder-[var(--text-muted)] w-40 focus:outline-none focus:border-blue-500/50"
        data-testid="chat-search-input"
      />
      <span
        className="text-[10px] text-[var(--text-muted)] whitespace-nowrap min-w-[3ch] text-right"
        data-testid="chat-search-counter"
      >
        {query ? (matchCount > 0 ? `${currentMatch}/${matchCount}` : "0") : ""}
      </span>
      <button
        type="button"
        onClick={goToPrev}
        disabled={matchCount === 0}
        className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] disabled:opacity-30"
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
        data-testid="chat-search-prev"
      >
        <Icon path={mdiChevronUp} size={0.6} />
      </button>
      <button
        type="button"
        onClick={goToNext}
        disabled={matchCount === 0}
        className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] disabled:opacity-30"
        title="Next match (Enter)"
        aria-label="Next match"
        data-testid="chat-search-next"
      >
        <Icon path={mdiChevronDown} size={0.6} />
      </button>
      <button
        type="button"
        onClick={handleClose}
        className="text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
        title="Close search (Escape)"
        aria-label="Close search"
        data-testid="chat-search-close"
      >
        <Icon path={mdiClose} size={0.5} />
      </button>
    </div>
  );
}
