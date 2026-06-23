import { type ReactNode } from "react";
import { m } from "motion/react";
import { useSwipeBack } from "../hooks/useSwipeBack.js";

interface Props {
  /** 0 = list, 1 = detail, 2 = preview (same panel as detail) */
  depth: number;
  listPanel: ReactNode;
  detailPanel: ReactNode;
  /** Called when swipe-back completes */
  onBack?: () => void;
}

/**
 * Two-panel mobile shell with spring slide transitions and swipe-back.
 * Both panels stay mounted; a motion value slides between them. Depth 2
 * (preview) swaps content within the detail panel — no extra slide.
 *
 * Motion: the slide (forward-nav AND swipe-back release) is driven by the
 * `detailX` motion value from useSwipeBack on the GENTLE spring — interruptible,
 * velocity-aware, with rubber-band over-drag and a commit haptic. The list trails
 * at −30% via `listX` (the same parallax as before, now spring-locked to the
 * detail panel). See change: deep-slickness-motion (Wave 1 nav gesture).
 */
export function MobileShell({ depth, listPanel, detailPanel, onBack }: Props) {
  const showDetail = depth >= 1;

  const { containerRef, detailX, listX } = useSwipeBack({
    enabled: showDetail && !!onBack,
    shown: showDetail,
    onBack: () => onBack?.(),
  });

  return (
    <div ref={containerRef} className="fixed inset-0 overflow-hidden bg-[var(--bg-primary)]">
      {/* Panel 0: Session list */}
      <m.div
        className="absolute inset-0 overflow-y-auto"
        style={{ x: listX }}
        aria-hidden={showDetail}
      >
        {listPanel}
      </m.div>

      {/* Panel 1: Session detail (or preview at depth 2) */}
      <m.div
        className="absolute inset-0 bg-[var(--bg-primary)] flex flex-col"
        style={{ x: detailX }}
        aria-hidden={!showDetail}
      >
        {detailPanel}
      </m.div>
    </div>
  );
}
