/**
 * makeCollisionSafeOptions — guards `ask_user` select/multiselect against
 * indistinguishable option labels (A4).
 *
 * The `ask_user` picker sends a plain `string[]` of labels and the client
 * returns the chosen *label* string. If two labels are identical (after
 * trimming), a returned label is ambiguous — it could map to a different
 * hidden option than the one the operator actually clicked. A click must
 * NEVER resolve to a different option than the one shown.
 *
 * Fix: when (and only when) a collision exists, render disambiguated display
 * labels ("Deploy", "Deploy (2)", …) so what the operator sees is 1:1 with a
 * concrete option, and keep an exact display-label → original-{index,value}
 * map so the returned label round-trips to the precise intended option.
 *
 * No collision → display labels are byte-identical to the input and `resolve`
 * is an index-preserving passthrough (zero behavior change for the 99% case).
 */

export interface OptionResolution {
  /** Index of the matched option in the ORIGINAL options array. */
  index: number;
  /** The ORIGINAL (pre-disambiguation) option label at that index. */
  value: string;
}

export interface CollisionSafeOptions {
  /** Labels to render — unique after trimming; equal to input when no collision. */
  displayOptions: string[];
  /** True when at least two input labels were identical after trimming. */
  hadCollision: boolean;
  /**
   * Map a client-returned label back to its exact original option.
   * Accepts a disambiguated display label OR a raw original label.
   * Returns undefined when nothing matches.
   */
  resolve(returned: string): OptionResolution | undefined;
}

export function makeCollisionSafeOptions(options: string[]): CollisionSafeOptions {
  const displayOptions: string[] = [];
  // display label → original {index, value}
  const displayToOriginal = new Map<string, OptionResolution>();
  // trimmed display label → true (uniqueness ledger)
  const usedTrimmed = new Set<string>();
  let hadCollision = false;

  options.forEach((original, index) => {
    const trimmed = original.trim();
    let display = original;
    if (usedTrimmed.has(trimmed)) {
      hadCollision = true;
      // Find the lowest suffix that is unique after trimming.
      let n = 2;
      let candidate = `${original} (${n})`;
      while (usedTrimmed.has(candidate.trim())) {
        n += 1;
        candidate = `${original} (${n})`;
      }
      display = candidate;
    }
    usedTrimmed.add(display.trim());
    displayOptions.push(display);
    displayToOriginal.set(display, { index, value: original });
  });

  const resolve = (returned: string): OptionResolution | undefined => {
    const direct = displayToOriginal.get(returned);
    if (direct) return direct;
    // Fall back to a raw original-label match (client returned the pre-
    // disambiguation label). First exact hit wins — only reachable when no
    // collision applied to that label, so it is unambiguous.
    const idx = options.indexOf(returned);
    if (idx >= 0) return { index: idx, value: options[idx] };
    return undefined;
  };

  return { displayOptions, hadCollision, resolve };
}
