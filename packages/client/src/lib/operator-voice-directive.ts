/**
 * Render-hide belt — operator-voice recompose-directive detector.
 *
 * DEFENSE-IN-DEPTH backstop. The pi-operator-voice extension injects a
 * voice-recompose directive as a `role:"user"` message whose content LEADS
 * WITH the marker below. Post the over-tag fix (ba93d55) that directive is
 * agent-audience, but the dashboard classifier keys on ROLE not audience, so
 * it still classifies as `meshChatter` (shown by default) — and the "Show all
 * activity" path bypasses the category filter entirely. This belt hides the
 * directive from the operator's view UNCONDITIONALLY (regardless of category
 * filter, pin-exemption, or the all-on toggle).
 *
 * CONTRACT SOURCE OF TRUTH: the marker + leading-token semantics mirror the
 * extension's pi-operator-voice/src/turn-origin.ts:
 *   - DIRECTIVE_MARKER (turn-origin.ts:34)
 *   - isLeadingToken(s, marker) = s.trimStart().startsWith(marker)
 * Kept INDEPENDENT (not an extension import) on purpose: the belt exists to
 * backstop the extension mis-stamping audience, so it must not share the
 * extension's code/failure path. A marker change is a documented two-file
 * update (extension + this belt), mirrored by the auth-free JSONL-reconstruction.
 *
 * LEADING-TOKEN-ONLY is anti-injection: a mid-body MENTION of the marker
 * (a real operator message or agent reasoning quoting it) must NOT be hidden,
 * else the belt becomes a censorship weapon on genuine content.
 */
import type { ChatMessage } from "./event-reducer.js";
import type { ChatItem, ToolCallGroup } from "./group-tool-calls.js";

/** The extension's injected recompose-directive marker (leading token). Mirrors turn-origin.ts:34. */
export const DIRECTIVE_MARKER = "[[operator-voice recompose-for=";

/**
 * TRUE iff `content` LEADS WITH the directive marker (mid-body mentions
 * excluded). Mirrors the extension's isLeadingToken (trimStart + startsWith).
 */
export function isHiddenDirectiveContent(content: string): boolean {
  return content.trimStart().startsWith(DIRECTIVE_MARKER);
}

/**
 * TRUE iff a rendered ChatItem is an injected operator-voice directive the
 * belt hides. Only a `role:"user"` ChatMessage qualifies — a ToolCallGroup is
 * never a directive, and an assistant row that quotes the marker is visible
 * model output, not the injected directive.
 */
export function isHiddenDirectiveItem(item: ChatItem): boolean {
  if ((item as ToolCallGroup).type === "group") return false;
  const m = item as ChatMessage;
  return m.role === "user" && isHiddenDirectiveContent(m.content);
}
