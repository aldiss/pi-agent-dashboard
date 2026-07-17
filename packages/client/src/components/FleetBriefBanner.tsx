/**
 * FleetBriefBanner — the depth-0 fleet-brief (build-2 P0 fix #12).
 *
 * "What needs me", surfaced REGARDLESS of tier / pin / collapse. THIS is the
 * global escalation lane — there is no second one. Each row is a click-through
 * that selects the session (or opens the surface url). Acknowledgement of the
 * finished-unseen window fires ONLY when the banner is actually visible
 * (`isVisible` — never on mount; the mobile shell keeps the depth-0 panel
 * mounted-but-aria-hidden at depth ≥ 1).
 *
 * Styled with the existing dashboard Tailwind tokens (var(--*) + the amber/red
 * accent language already used by ActiveOperatorSurfaces) so it reads native.
 *
 * See change: build-2-dashboard-v3.
 */
import React, { useEffect, useRef } from "react";
import { Icon } from "@mdi/react";
import { mdiAlertCircleOutline, mdiCommentQuestion, mdiClipboardCheckOutline, mdiChevronRight } from "@mdi/js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { FleetBriefItem } from "../lib/fleet-brief.js";
import { getSessionDisplayName } from "../lib/session-display-name.js";

interface Props {
  items: FleetBriefItem[];
  finishedUnseen: DashboardSession[];
  /** True when the banner is actually on-screen (depth-0 on mobile, always on
   *  desktop). Gates acknowledgement — never acknowledge while hidden. */
  isVisible: boolean;
  onSelect: (sessionId: string) => void;
  /** Persist "seen now" — the hook advances the finished-unseen window. */
  acknowledge: () => void;
}

/**
 * True if `el` or any ancestor is `aria-hidden="true"` (build-2 fix-cycle
 * FATAL 2). MobileShell marks the inactive depth-0 panel `aria-hidden` while it
 * slides off-screen, so an IntersectionObserver hit during the spring can still
 * be over a screen-reader-hidden node — this rejects it.
 */
function isAriaHidden(el: HTMLElement | null): boolean {
  let node: HTMLElement | null = el;
  while (node) {
    if (node.getAttribute("aria-hidden") === "true") return true;
    node = node.parentElement;
  }
  return false;
}

/**
 * Parse the translate x/y (px) out of a computed `transform` value. Returns
 * `{tx:0,ty:0}` for `none`/identity/empty. Handles `matrix(a,b,c,d,tx,ty)` and
 * `matrix3d(...)` (tx = index 12, ty = index 13). Build-2 fix-cycle-2 F2.
 */
function parseTranslate(transform: string): { tx: number; ty: number } {
  if (!transform || transform === "none") return { tx: 0, ty: 0 };
  const m2 = transform.match(/^matrix\(([^)]+)\)$/);
  if (m2) {
    const p = m2[1].split(",").map((n) => parseFloat(n.trim()));
    return { tx: p[4] || 0, ty: p[5] || 0 };
  }
  const m3 = transform.match(/^matrix3d\(([^)]+)\)$/);
  if (m3) {
    const p = m3[1].split(",").map((n) => parseFloat(n.trim()));
    return { tx: p[12] || 0, ty: p[13] || 0 };
  }
  return { tx: 0, ty: 0 };
}

/**
 * True iff the banner is geometrically SETTLED at rest AND on-screen (build-2
 * fix-cycle-2 F2). "Settled" means the spring animation has finished: NO
 * ancestor carries a non-trivial translate transform (mid-spring the panel is
 * at e.g. `matrix(1,0,0,1,-117.564,0)`), the banner's own rect sits within the
 * viewport with `left` at rest (≈0, not translated off-screen), and no ancestor
 * is `aria-hidden`. Gating the acknowledge cursor on THIS — not merely
 * IntersectionObserver-visible — stops the mid-spring false-ack.
 *
 * Exported for unit testing against injected geometry.
 */
export function isBannerSettled(
  el: HTMLElement | null,
  getStyle: (n: Element) => Pick<CSSStyleDeclaration, "transform"> = window.getComputedStyle,
  viewportWidth = window.innerWidth,
  viewportHeight = window.innerHeight,
): boolean {
  if (!el) return false;
  if (isAriaHidden(el)) return false;
  // Walk ancestors for an unsettled (translated) transform.
  let node: HTMLElement | null = el;
  const TRANSLATE_EPS = 1; // px — sub-pixel rest jitter tolerated
  while (node) {
    const { tx, ty } = parseTranslate(getStyle(node).transform);
    if (Math.abs(tx) > TRANSLATE_EPS || Math.abs(ty) > TRANSLATE_EPS) return false;
    node = node.parentElement;
  }
  // On-screen at rest: left settled near the viewport's left edge and the rect
  // overlaps the viewport with a positive area.
  const r = el.getBoundingClientRect();
  const REST_LEFT_EPS = 8; // px — the sidebar/panel rests at x≈0
  if (Math.abs(r.left) > REST_LEFT_EPS) return false;
  const onScreen = r.width > 0 && r.height > 0 && r.right > 0 && r.left < viewportWidth && r.bottom > 0 && r.top < viewportHeight;
  return onScreen;
}

function reasonIcon(reason: FleetBriefItem["reason"]): string {
  if (reason === "server-error") return mdiAlertCircleOutline;
  if (reason === "ask-user") return mdiCommentQuestion;
  return mdiClipboardCheckOutline;
}

function reasonAccent(reason: FleetBriefItem["reason"]): string {
  if (reason === "server-error") return "text-red-400";
  if (reason === "ask-user") return "text-purple-400";
  return "text-amber-400";
}

function reasonLabel(reason: FleetBriefItem["reason"]): string {
  switch (reason) {
    case "server-error": return "error";
    case "ask-user": return "needs input";
    case "decide": return "decide";
    case "ratify": return "ratify";
    case "review": return "review";
    case "push": return "push";
    default: return reason;
  }
}

export function FleetBriefBanner({
  items,
  finishedUnseen,
  isVisible,
  onSelect,
  acknowledge,
}: Props): React.ReactElement | null {
  const total = items.length + finishedUnseen.length;

  // Settled-geometry acknowledge gate (build-2 fix-cycle-2 F2). The route-depth
  // `isVisible` prop and an IntersectionObserver hit are BOTH insufficient — on
  // mobile the depth-0 panel is IO-visible and NOT aria-hidden WHILE it springs
  // back on-screen (e.g. `transform: matrix(1,0,0,1,-117.564,0)`), so acking on
  // those wrote the cursor mid-spring. Instead we poll `requestAnimationFrame`
  // (Framer springs are JS-driven — no `transitionend`) until the banner is
  // geometrically SETTLED at rest (`isBannerSettled`: identity transforms +
  // on-screen + not aria-hidden), then acknowledge EXACTLY ONCE. Never while
  // zero rows render, never mid-spring.
  const bannerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Only arm when there is something to acknowledge and the route says visible.
    if (total <= 0 || !isVisible) return;
    let raf = 0;
    let done = false;
    const tick = () => {
      if (done) return;
      if (isBannerSettled(bannerRef.current)) {
        done = true;
        acknowledge();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { done = true; cancelAnimationFrame(raf); };
    // Re-arm when the unseen set changes while visible (a new item after a prior
    // ack must be acknowledged too, once its render is settled).
  }, [total, isVisible, acknowledge, items.length, finishedUnseen.length]);

  if (total === 0) return null;

  return (
    <div
      ref={bannerRef}
      className="border-b border-[var(--border-color)] bg-[var(--bg-secondary)] flex-shrink-0"
      data-testid="fleet-brief-banner"
    >
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <span className="text-xs font-semibold text-[var(--text-primary)] flex-1">
          Needs you
          <span className="text-[var(--text-secondary)] ml-1" data-testid="fleet-brief-count">
            ({total})
          </span>
        </span>
      </div>
      <ul className="list-none p-0 m-0">
        {items.map((item) => (
          <li key={`${item.kind}:${item.id}`}>
            <button
              onClick={() => {
                if (item.kind === "session") {
                  onSelect(item.id);
                } else if (item.surface?.url && /^https?:\/\//i.test(item.surface.url)) {
                  window.open(item.surface.url, "_blank", "noopener,noreferrer");
                }
              }}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-left border-b border-[var(--border-color)] last:border-b-0 hover:bg-[var(--bg-surface)] transition-colors"
              data-testid={`fleet-brief-item-${item.kind}`}
              data-reason={item.reason}
            >
              <Icon path={reasonIcon(item.reason)} size={0.6} className={`shrink-0 ${reasonAccent(item.reason)}`} />
              <span className="flex-1 min-w-0">
                <span className="block text-xs font-medium text-[var(--text-primary)] truncate">
                  {item.label}
                </span>
                <span className={`text-[10px] uppercase tracking-wider ${reasonAccent(item.reason)}`}>
                  {reasonLabel(item.reason)}
                </span>
              </span>
              <Icon path={mdiChevronRight} size={0.6} className="shrink-0 text-[var(--text-tertiary)]" />
            </button>
          </li>
        ))}
        {finishedUnseen.length > 0 && (
          <li className="px-2 py-1 border-b border-[var(--border-color)] last:border-b-0">
            <span className="text-[10px] text-[var(--text-tertiary)]">
              {finishedUnseen.length} recently finished
            </span>
            <div className="mt-0.5 flex flex-col gap-0.5">
              {finishedUnseen.map((s) => (
                <button
                  key={s.id}
                  onClick={() => onSelect(s.id)}
                  className="w-full text-left text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] truncate transition-colors"
                  data-testid="fleet-brief-finished-item"
                >
                  {getSessionDisplayName(s)}
                </button>
              ))}
            </div>
          </li>
        )}
      </ul>
    </div>
  );
}
