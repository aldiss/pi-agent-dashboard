/**
 * `<speaker>` wrap for the model-facing turn (multi-operator, Surface A).
 *
 * WHERE THIS RUNS: at the TERMINAL send boundary in the extension — the last
 * step before `pi.sendUserMessage(text)` — and NOWHERE else. The human text
 * stays RAW through the entire dashboard→server→bridge→queue path; the
 * `<speaker>` label is baked in ONLY here, STRICTLY downstream of all queue
 * logic (`queue-tracker.ts#classifyDequeue` matches RAW `text` by
 * exact-equality — folding the label in upstream would break dequeue, the
 * Contract-1 bite). The author identity itself rides the STRUCTURED `author`
 * field threaded parallel to `text`; this module renders it into the turn.
 *
 * WHY UUID-DELIMITED: the label must be UNFORGEABLE by the human whose text it
 * wraps. A fixed `<speaker>` tag could be spoofed — a human could type
 * `</speaker>...` and inject a second, forged speaker block. So each wrap mints
 * a fresh per-message nonce (unpredictable), stamps it on BOTH the open and the
 * close tag, and SANITIZES the human text to remove any literal occurrence of
 * the tag tokens or the nonce. A human cannot close (or reopen) the envelope
 * without the nonce they never see.
 *
 * The authoritative scheme (tag format, label semantics) is ALSO declared in
 * the repo `AGENTS.md`/`CLAUDE.md` (injected into every model turn, zero-code)
 * so the model READS the same contract this code WRITES. `name=` (a structured
 * pi-core model field) is a FUTURE option, NOT this build.
 */
import type { MessageAuthor } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { randomUUID } from "node:crypto";

/**
 * Escape a string for safe inclusion inside a double-quoted tag attribute.
 * Drops the characters that could break out of the attribute or the tag.
 */
function escapeAttr(value: string): string {
  return value.replace(/["<>\r\n]/g, " ").trim();
}

/**
 * Strip any literal delimiter tokens from the human text so the wrap envelope
 * is unforgeable: the human cannot open/close a `<speaker>` block nor guess the
 * nonce. Case-insensitive on the tag tokens; exact on the nonce.
 */
export function sanitizeSpeakerBody(text: string, nonce: string): string {
  let out = text;
  // Remove any literal nonce occurrence first (defense in depth — the nonce is
  // unpredictable, but never let it appear in the body).
  if (nonce) out = out.split(nonce).join("");
  // Neutralize any `<speaker` / `</speaker` token (case-insensitive) by
  // dropping the leading `<` so it can no longer parse as a tag: `<speaker` →
  // `speaker`, `</speaker` → `/speaker`. The human thus cannot open a forged
  // speaker block nor prematurely close this one.
  out = out.replace(/<(\/?\s*speaker\b)/gi, "$1");
  return out;
}

/**
 * Bake the `<speaker>` label into the model-facing turn. Pure: given the same
 * (text, author, nonce) it returns the same string.
 *
 * When `author` is undefined (single-operator, flag off) the text is returned
 * UNCHANGED — no wrap, byte-unchanged. The `nonce` MUST be a fresh
 * unguessable per-message id (see `wrapForSend`); it is a parameter here (not
 * minted inside) so this function stays pure + testable.
 */
export function wrapSpeaker(
  text: string,
  author: MessageAuthor | undefined,
  nonce: string,
): string {
  if (!author) return text;
  const id = escapeAttr(author.sub);
  const name = escapeAttr(author.display);
  const body = sanitizeSpeakerBody(text, nonce);
  return (
    `<speaker id="${id}" name="${name}" nonce="${nonce}">\n` +
    `${body}\n` +
    `</speaker nonce="${nonce}">`
  );
}

/**
 * Terminal-boundary convenience: mint a fresh per-message nonce and wrap. This
 * is the impure entry point call sites use — it owns the one non-deterministic
 * step (nonce mint) so `wrapSpeaker` stays pure/testable. When `author` is
 * undefined it returns `text` unchanged WITHOUT minting (byte-unchanged, and no
 * wasted entropy in single-operator mode).
 */
export function wrapForSend(text: string, author: MessageAuthor | undefined): string {
  if (!author) return text;
  return wrapSpeaker(text, author, randomUUID());
}
