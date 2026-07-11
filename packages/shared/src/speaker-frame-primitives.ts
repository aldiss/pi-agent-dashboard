/**
 * Speaker-frame authenticity SUB-primitives — the ONE shared unit (dl-6754 /
 * v2.1.1 §5 convergence).
 *
 * These three primitives are the load-bearing anti-forgery unit for EVERY
 * server-composed attributed frame in the multi-operator surface:
 *   - the single-author `<speaker>` wrap (`packages/extension/speaker-wrap.ts`),
 *   - the huddle per-turn catch-up frame (`packages/server/huddle-catchup.ts`, C4),
 *   - (future) the operator-channel-token / ledger-authenticity floor.
 *
 * v2.1.1 §5 (Bert NOTE-1) retargeted the "converge on ONE nonce module"
 * recommendation FROM `wrapSpeaker` (which is single-author — id/name/nonce only)
 * TO these `sanitize`+`escape`+`mint` sub-primitives — the actually-shared unit.
 * The huddle C4 frame reuses THESE inside a RICHER server-composed role+origin
 * frame; it does NOT call `wrapSpeaker` verbatim. Keeping the primitives here
 * (imported by both the extension wrap and the server composer) proves the
 * who-authentication guarantee ONCE, not per-fork.
 *
 * Pure + dependency-light (only `node:crypto` for the mint). No pi, no fs.
 */
import { randomUUID } from "node:crypto";

/**
 * Escape a string for safe inclusion inside a double-quoted tag attribute.
 * Drops the characters that could break out of the attribute or the tag
 * (`"`, `<`, `>`, CR, LF) and trims. So an author `display`/`sub` — or a huddle
 * frame's `role`/`origin` — cannot inject attributes or close the tag.
 */
export function escapeAttr(value: string): string {
  return value.replace(/["<>\r\n]/g, " ").trim();
}

/**
 * Strip any literal delimiter tokens from human text so the enclosing frame is
 * UNFORGEABLE: the human cannot open/close a `<speaker>` block nor guess the
 * per-message nonce. Case-insensitive on the tag tokens; exact on the nonce.
 *
 * 1. Remove any literal `nonce` occurrence (defense in depth — the nonce is
 *    unpredictable, but never let it appear in the body so a close-tag cannot be
 *    forged even if the nonce leaked).
 * 2. Neutralize any `<speaker` / `</speaker` token by dropping the leading `<`
 *    so it can no longer parse as a tag (`<speaker` → `speaker`).
 */
export function sanitizeSpeakerBody(text: string, nonce: string): string {
  let out = text;
  if (nonce) out = out.split(nonce).join("");
  out = out.replace(/<(\/?\s*speaker\b)/gi, "$1");
  return out;
}

/**
 * Mint a fresh, unguessable per-message nonce. The impure step, isolated here so
 * the framing functions that consume it stay pure/testable (they take the nonce
 * as a parameter). Each attributed frame mints its OWN nonce — the human never
 * sees it, so they cannot close/reopen the frame around forged content.
 */
export function mintNonce(): string {
  return randomUUID();
}
