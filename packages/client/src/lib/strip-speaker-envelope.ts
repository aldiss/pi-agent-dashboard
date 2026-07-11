/**
 * Strip the model-facing `<speaker …>` envelope from message content for
 * DISPLAY ONLY, so the per-message auth nonce NEVER renders in a chat bubble.
 *
 * The multi-operator speaker wrap (extension `speaker-wrap.ts`) bakes an
 * envelope into the MODEL-facing turn:
 *
 *     <speaker id="…" name="…" nonce="X">\n{body}\n</speaker nonce="X">
 *
 * The per-message nonce is stamped on BOTH the open AND the (nonce-bearing)
 * close tag. This util is DISPLAY chrome only — it does not touch the
 * agent-facing content or any auth/wrap/server code (the nonce-in-agent-content
 * question is a separate, server-side concern, out of scope here).
 *
 * SECURITY PROPERTY: the nonce must NEVER survive to render — even on
 * malformed / partial / multiple / nested envelopes. Nonce-safe BY
 * CONSTRUCTION + strip-conservative: it removes every `<speaker` / `</speaker`
 * tag context through the tag's closing `>` — or, when the tag is MALFORMED
 * (no `>` before a newline or end-of-input), through that newline/end — so the
 * nonce, which only ever lives inside a speaker tag, is always carried away
 * with the tag. A naive `</speaker>`-only strip MISSES the nonce-bearing close
 * `</speaker nonce="X">`; that omission is the exact bug this fixes. It prefers
 * over-stripping a malformed edge to ever leaking a nonce.
 *
 * Pure + framework-free (unit-testable without a DOM).
 */
export function stripSpeakerEnvelopeForDisplay(content: string): string {
  if (!content) return content;
  // Fast path: no speaker-tag token at all → return unchanged (cheap, and
  // avoids touching the overwhelming majority of messages).
  if (!/<\/?\s*speaker\b/i.test(content)) return content;
  // Remove every open/close speaker tag (case-insensitive). `[^>\n]*` consumes
  // the attributes (id/name/nonce) up to the tag's `>`; the alternation also
  // terminates the tag at a NEWLINE (malformed: `>` missing) or END-OF-INPUT,
  // so a nonce-bearing tag that lost its `>` still cannot leak the nonce. An
  // adjacent newline on either side is consumed so the envelope's own line
  // breaks don't leave blank lines around the body. `g` = all occurrences
  // (multiple / nested); `i` = case-insensitive (matches the extension's
  // sanitize discipline).
  return content.replace(/\n?<\/?\s*speaker\b[^>\n]*(?:>|(?=\n)|$)\n?/gi, "");
}
