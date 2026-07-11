/**
 * N-3 — huddle phrase-alias classification (CLIENT-SIDE).
 *
 * Maps a natural composer phrase ("hold on" / "ok agent, come back") to the
 * TYPED huddle action the client emits (`huddle_start` / `huddle_recall`). Per
 * design N-3 this classification MUST be client-side: the client emits the typed
 * action, which the server gates operator-only at the ONE chokepoint (C2). It is
 * NEVER a pre-gate SERVER text-match — a guest typing "hold on" as a raw prompt
 * must flow as a normal co-drive `send_prompt`, not trigger a huddle (the v1-F4
 * hole). This helper returns a typed action ONLY for an EXACT operator-intent
 * phrase; anything else returns null → the composer sends it as a normal prompt.
 *
 * Pure: no I/O, no state. The caller (an operator's composer) decides whether to
 * emit the action; op-2 emitting it is refused at the server chokepoint anyway.
 */

export type HuddlePhraseAction = "huddle_start" | "huddle_recall";

/** Exact start phrases (normalized: trimmed, lowercased, trailing punctuation dropped). */
const START_PHRASES: ReadonlySet<string> = new Set([
  "hold on",
  "hold on agent",
  "hold on a sec",
  "one moment",
  "pause",
  "huddle",
  "let's huddle",
  "let me confer",
]);

/** Exact recall phrases. */
const RECALL_PHRASES: ReadonlySet<string> = new Set([
  "ok agent, come back",
  "ok agent come back",
  "come back",
  "we're back",
  "were back",
  "resume",
  "unpause",
  "end huddle",
  "recall",
]);

/**
 * Normalize a composer phrase for exact matching: trim, collapse internal
 * whitespace, lowercase, and strip trailing sentence punctuation. Deliberately
 * CONSERVATIVE — only an exact normalized match maps to an action, so a longer
 * sentence that merely CONTAINS "pause" ("don't pause the deploy") is NOT a
 * match (returns the raw text unchanged → normal prompt).
 */
export function normalizeHuddlePhrase(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/[.!?]+$/, "")
    .trim();
}

/**
 * Classify a composer phrase into a typed huddle action, or null when it is not
 * an exact operator-intent phrase. EXACT-match only (after normalization) — never
 * a substring/loose match, so an ordinary prompt that happens to contain a
 * keyword is never hijacked.
 */
export function classifyHuddlePhrase(text: string): HuddlePhraseAction | null {
  if (typeof text !== "string" || !text) return null;
  // A multi-line message is never a phrase-alias (it is real content).
  if (text.includes("\n")) return null;
  const norm = normalizeHuddlePhrase(text);
  if (!norm) return null;
  if (START_PHRASES.has(norm)) return "huddle_start";
  if (RECALL_PHRASES.has(norm)) return "huddle_recall";
  return null;
}
