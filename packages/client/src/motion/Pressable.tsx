import { forwardRef, type ComponentPropsWithoutRef, type ElementType, type PointerEvent } from "react";
import { m } from "motion/react";
import { spring } from "./springs.js";
import { useReducedMotion } from "motion/react";
import { haptic, type HapticKind } from "./haptic.js";

/**
 * <Pressable> — the universal press primitive. Wraps any tappable so it scales
 * down under the finger and springs back with the `smooth` token, plus an
 * optional haptic tick on press. This replaces the scattered `active:scale-*`
 * CSS utilities with ONE consistent, reduced-motion-aware behavior.
 *
 * Polymorphic via `as` (default "button"); forwards ref; spreads aria / onClick
 * / className straight through to the underlying element. The press-scale is the
 * ONLY thing it owns — every visual (color, padding, radius) stays in the
 * caller's className, so it drops in over an existing button with no restyle.
 *
 * Reduced-motion: when the user prefers reduced motion, the scale is dropped
 * (no `whileTap`) so the element never travels — the haptic still fires, since a
 * tactile tick is an accessibility *aid*, not motion.
 *
 * Press feel: scale 0.97 by default (subtle; matches the approved prototype).
 * Larger surfaces (a whole session card) can pass a gentler `pressScale` like
 * 0.985 so the lift reads as a settle, not a shrink.
 */
type PressableOwnProps<E extends ElementType> = {
  /** Element/tag to render. Default "button". */
  as?: E;
  /** Scale at full press. Default 0.97. */
  pressScale?: number;
  /**
   * Haptic to fire on press. Default "selection". Pass `false` to silence
   * (e.g. a press inside a row that already fires its own haptic on commit).
   */
  haptic?: HapticKind | false;
};

export type PressableProps<E extends ElementType> = PressableOwnProps<E> &
  Omit<ComponentPropsWithoutRef<E>, keyof PressableOwnProps<E>>;

// The set of intrinsic tags we actually press in the app. Mapping to the `m.*`
// namespace keeps the motion feature bundle small (press gesture lives in
// domAnimation) and keeps types honest without fighting motion's generics.
const PRESS_TAGS = {
  button: m.button,
  div: m.div,
  li: m.li,
  a: m.a,
  span: m.span,
} as const;

type PressTag = keyof typeof PRESS_TAGS;

function PressableInner<E extends PressTag = "button">(
  { as, pressScale = 0.97, haptic: hapticKind = "selection", onPointerDown, children, ...rest }: PressableProps<E>,
  ref: React.Ref<Element>,
) {
  const reduced = useReducedMotion() ?? false;
  const Tag = (PRESS_TAGS[(as as PressTag) ?? "button"] ?? m.button) as ElementType;
  // A disabled control must not scale or tick — it isn't actionable.
  const isDisabled =
    (rest as { disabled?: boolean; "aria-disabled"?: boolean | "true" }).disabled === true ||
    (rest as { "aria-disabled"?: boolean | "true" })["aria-disabled"] === true ||
    (rest as { "aria-disabled"?: boolean | "true" })["aria-disabled"] === "true";

  const handlePointerDown = (e: PointerEvent) => {
    if (!isDisabled && hapticKind !== false) haptic(hapticKind);
    (onPointerDown as ((ev: PointerEvent) => void) | undefined)?.(e);
  };

  return (
    <Tag
      ref={ref}
      onPointerDown={handlePointerDown}
      whileTap={reduced || isDisabled ? undefined : { scale: pressScale }}
      transition={spring.smooth}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/**
 * forwardRef wrapper. The generic is preserved on the exported component so
 * callers get prop-checking for the chosen `as` element.
 */
export const Pressable = forwardRef(PressableInner) as <E extends PressTag = "button">(
  props: PressableProps<E> & { ref?: React.Ref<Element> },
) => React.ReactElement;
