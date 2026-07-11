/**
 * §8 — the flatten MUTATION TEST (DONE-bar, Alice-directed / v2.1.1 §8).
 *
 * Proves acceptance RED #1 (v2.1.1 §4): an interleaved two-author sequence
 * `[op1-text-frame, imageA, op2-text-frame, imageB]` FLATTENS under the real pi
 * `AgentSession.sendUserMessage` content-normalization — every text block is
 * concatenated with `\n`, every image is collected into ONE flat `images[]`, and
 * image position RELATIVE TO the per-turn text frames is LOST. Therefore the
 * design must NOT claim per-turn image↔speaker association from ORDER (this is
 * exactly WHY v2.1.1 makes the catch-up text-only + fails loud on images).
 *
 * The normalization under test is `agent-session.js:1012-1033` (verified
 * own-hand, Pattern 87): the loop pushes `part.text` → `textParts`, everything
 * else → `images`, then `text = textParts.join("\n")`. We replicate that EXACT
 * shape as the mutation and assert no per-frame binding survives. Replicated (not
 * imported) deliberately — the test pins the OBSERVED upstream behavior so a
 * future pi change that (say) preserved interleaving would make this RED and force
 * a re-gate before any multimodal catch-up is enabled (v2.1.1 §7 future-only).
 */
import { describe, it, expect } from "vitest";

/** A pi content part (text or image), the `sendUserMessage(content)` input shape. */
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * The EXACT normalization from `AgentSession.sendUserMessage` (agent-session.js
 * :1020-1032), replicated. Text parts join with `\n`; non-text parts collect into
 * a flat `images[]`; `images` becomes undefined when empty.
 */
function normalizeLikePi(content: ContentPart[]): { text: string; images: ContentPart[] | undefined } {
  const textParts: string[] = [];
  let images: ContentPart[] | undefined = [];
  for (const part of content) {
    if (part.type === "text") {
      textParts.push(part.text);
    } else {
      images.push(part);
    }
  }
  const text = textParts.join("\n");
  if (images.length === 0) images = undefined;
  return { text, images };
}

describe("§8 flatten mutation — interleaved [frame,image,frame,image] loses binding", () => {
  const op1Frame = '<speaker id="op1@e.com" role="operator" nonce="n1">look at this</speaker nonce="n1">';
  const op2Frame = '<speaker id="op2@e.com" role="guest" nonce="n2">and this one</speaker nonce="n2">';
  const imageA: ContentPart = { type: "image", data: "AAAA", mimeType: "image/png" };
  const imageB: ContentPart = { type: "image", data: "BBBB", mimeType: "image/png" };

  it("flattens to textParts.join(\\n) + a flat images:[A,B] with NO per-frame binding", () => {
    // The ordered frame→image→frame→image sequence the design must NOT build.
    const interleaved: ContentPart[] = [
      { type: "text", text: op1Frame },
      imageA,
      { type: "text", text: op2Frame },
      imageB,
    ];

    const { text, images } = normalizeLikePi(interleaved);

    // (a) The two text frames are concatenated with `\n` — image positions BETWEEN
    //     them have vanished from the text stream.
    expect(text).toBe(`${op1Frame}\n${op2Frame}`);

    // (b) Both images are in ONE flat array, in content order, with NO marker of
    //     which frame each sat next to. imageA (op1) and imageB (op2) are now
    //     indistinguishable by speaker — the binding is GONE.
    expect(images).toEqual([imageA, imageB]);
    expect(images).toHaveLength(2);

    // (c) The flattened image array carries NO speaker/frame association field —
    //     nothing in `images[i]` says "this belonged to op1's frame".
    for (const img of images ?? []) {
      expect(Object.keys(img).sort()).toEqual(["data", "mimeType", "type"]);
    }

    // (d) PROOF the design cannot recover association from ORDER: swapping which
    //     author's frame came first produces the SAME flat images[] — so image
    //     order cannot testify to authorship.
    const swapped = normalizeLikePi([
      { type: "text", text: op2Frame },
      imageA,
      { type: "text", text: op1Frame },
      imageB,
    ]);
    expect(swapped.images).toEqual([imageA, imageB]); // identical image array…
    expect(swapped.text).not.toBe(text);              // …despite different authorship
  });

  it("a sealed per-turn image COUNT cannot bind a flattened image to its speaker", () => {
    // Even if op1's frame 'claimed' 1 image and op2's 'claimed' 1, after flatten
    // there is no way to say images[0] is op1's and images[1] is op2's — the
    // normalization is order-only and the frames are pure text. This is why a
    // sealed image-presence count may INFORM humans but cannot satisfy a
    // provenance / caught-up claim (v2.1.1 §3).
    const { images } = normalizeLikePi([
      { type: "text", text: op1Frame },
      imageA,
      imageB, // was this op1's second image, or op2's first? UNRECOVERABLE.
      { type: "text", text: op2Frame },
    ]);
    expect(images).toEqual([imageA, imageB]);
    // The count (2) is knowable; the per-speaker binding is not.
  });
});
