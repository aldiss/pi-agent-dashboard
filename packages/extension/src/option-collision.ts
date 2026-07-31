/**
 * assertDistinctOptions — A4 fail-closed guard for `ask_user`
 * select/multiselect option labels.
 *
 * The `ask_user` picker sends a plain `string[]` of labels and the client
 * returns the chosen *label* string. If two labels are identical (after
 * trimming), the returned label is ambiguous — it cannot be mapped back to a
 * single intended option, so the chosen action can silently become a DIFFERENT
 * hidden option than the one shown, across single select, batch sub-questions,
 * AND multiselect.
 *
 * DEFAULT = FAIL-CLOSED REJECTION (Pete dl-13350 + Lane, both prefer it): if
 * two option labels are identical after trimming, REJECT the ask with a clear
 * error BEFORE rendering — never silently disambiguate/map. The superseded
 * display-rename approach (`makeCollisionSafeOptions`) is removed: Pete ruled
 * details-only index-carry insufficient, and both gatekeepers prefer rejection
 * over the high bar of model-visible index-carry across all three methods.
 */

/** Thrown when two option labels collide after trimming. */
export class DuplicateOptionError extends Error {
  constructor(
    /** The trimmed label that appeared more than once. */
    public readonly label: string,
    /** The original (untrimmed) option strings that collided. */
    public readonly collidingOriginals: string[],
    /** The 0-based indices in the options array that share the trimmed label. */
    public readonly indices: number[],
  ) {
    super(
      `ask_user: option labels must be distinct — ${JSON.stringify(label)} appears ` +
        `${indices.length} times (at indices ${indices.join(", ")}). ` +
        `Duplicate labels are rejected because a click could not be mapped back to the ` +
        `exact intended option. Give each option a distinct label.`,
    );
    this.name = "DuplicateOptionError";
  }
}

/**
 * Reject the ask if any two labels are identical after trimming. No-op (returns
 * the options unchanged) when all labels are distinct. `context` prefixes the
 * error for batch sub-questions / multiselect so the agent can locate the ask.
 */
export function assertDistinctOptions(options: string[], context?: string): string[] {
  // trimmed label → list of original indices carrying it
  const byTrimmed = new Map<string, number[]>();
  options.forEach((original, index) => {
    const trimmed = original.trim();
    const arr = byTrimmed.get(trimmed);
    if (arr) arr.push(index);
    else byTrimmed.set(trimmed, [index]);
  });

  for (const [trimmed, indices] of byTrimmed) {
    if (indices.length > 1) {
      const collidingOriginals = indices.map((i) => options[i]);
      const err = new DuplicateOptionError(trimmed, collidingOriginals, indices);
      if (context) err.message = `${context}: ${err.message}`;
      throw err;
    }
  }
  return options;
}
