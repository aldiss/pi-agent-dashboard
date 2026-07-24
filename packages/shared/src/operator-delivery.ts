import { sha256 } from "@noble/hashes/sha2.js";
import type { Audience } from "./vendor/operator-voice-audience/audience-core.js";

export const MAX_OPERATOR_DELIVERY_TEXT_CHARS = 64_000;

export const OPERATOR_DELIVERY_FALLBACK =
  "I couldn't translate this update into plain language, so the original message is hidden.";

const SHA256_HEX = /^[a-f0-9]{64}$/;
const READY_KEYS = ["version", "sourceSha256", "status", "text", "checks"] as const;
const AGENT_KEYS = ["version", "sourceSha256", "status"] as const;
const PRESENTATION_KEYS = ["version", "deliverySha256", "text"] as const;
const CHECK_KEYS = ["plain", "anchorsPreserved"] as const;
const TRUSTED_ASSET_DESTINATION = /^pi-asset:[a-f0-9]{16}$/;
const MARKDOWN_IMAGE_RE = /!\[([^\]\n]*)\]\(([^)\n\s]+)\)/g;
const TRUSTED_MARKDOWN_ASSET_IMAGE_RE = /!\[([^\]\n]*)\]\((pi-asset:[a-f0-9]{16})\)/g;
const ASSET_TRANSPORT_ID_RE = /pi-asset:[A-Za-z0-9_/-]*(?:\.[A-Za-z0-9_/-]+)*/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

/** Synchronous SHA-256 for shared browser/server selection without Node crypto. */
export function sha256Hex(text: string): string {
  const digest = sha256(new TextEncoder().encode(text));
  let hex = "";
  for (const byte of digest) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Exact finalized assistant prose used by digest verification and display selection. */
export function extractFinalizedAssistantProse(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => (
      isRecord(block) && block.type === "text" && typeof block.text === "string"
    ))
    .map((block) => block.text)
    .join("");
}

/** Remove only a trusted image destination; alt text remains subject to checks. */
function withoutTrustedAssetDestinations(text: string): string {
  return text.replace(
    TRUSTED_MARKDOWN_ASSET_IMAGE_RE,
    (_token, alt: string) => `![${alt}]()`,
  );
}

function containsResidualAssetTransportId(text: string): boolean {
  return /pi-asset:/i.test(withoutTrustedAssetDestinations(text));
}

function containsStandaloneHexHash(text: string): boolean {
  const withoutTrustedAssets = withoutTrustedAssetDestinations(text);
  const tokens = withoutTrustedAssets.match(/\b[a-f0-9]{7,64}\b/gi) ?? [];
  return tokens.some((token) => /[a-f]/i.test(token));
}

/** Defense-in-depth only; the producer's checks remain the primary proof. */
export function hasObviousInternalJargon(text: string): boolean {
  if (containsResidualAssetTransportId(text)) return true;
  if (/\b(?:dl|id|vm|run|job|tenure|cell|task|ticket|issue|message|msg|commit|sha|t)[-_:#]?\d+[A-Za-z0-9._-]*\b/i.test(text)) return true;
  if (text.includes("§")) return true;
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(text)) return true;
  if (containsStandaloneHexHash(text)) return true;
  if (/\[\[|\]\]/.test(text)) return true;
  if (/\b[A-Z]{2,12}-\d+[A-Za-z0-9._-]*\b/.test(text)) return true;
  if (/\b(?:[A-Z][A-Za-z0-9]*|[a-z]+wright)-\d+[A-Za-z0-9._-]*\b/.test(text)) return true;
  if (/\b(?:CommsReset|Voicewright|Dashwright|Commwright|Door[- ]\d+|Contract-[A-Z0-9]+|Pattern\s+\d+|Track[- ]\d+|build[- ]\d+)\b/i.test(text)) return true;
  if (/\b(?:orchestrat(?:e|ed|es|ing|ion)|recompose|recomposition|agent[- ](?:willingness|compliance|handoff|artifact)|subagent[- ]handoff|parent agent|child agent|parent process|child process|strict[- ]spec|outcome gate|review gate|gate theater|follow[- ]?up directive|render[- ]hide belt|render belt|internal ledger|mesh|reducer|delivery seam|canary promotion|control plane|shard|backpressure|fanout path|quorum rollback|hot path|blue[- ]green cutover|worker pool|coordinator|checkpoint(?:ed|s|ing)?|work queue|queue pressure|scatter[- ]gather|fenc(?:e|ed|es|ing)|stale lease|lease|artifact|convergence|promotion|hydrate|context window|next turn|standing crew|reconcile|lane|fleet hold|drain(?:s|ed|ing)?|ratify)\b/i.test(text)) return true;
  if (/\b(?:I (?:was asked to|have|just) rewrit(?:e|ten)|this (?:plain[- ]language )?(?:rewrite|version)|the (?:original|source) (?:message|text)|plain[- ]language version|I removed (?:the )?(?:ids|jargon|citations))\b/i.test(text)) return true;
  if (/\b(?:here is (?:the )?(?:plain[- ]language )?rewrite|operator[- ]voice)\b/i.test(text)) return true;
  if (/\bresponse[_ -]?token\b/i.test(text)) return true;
  if (/\b(?:ignore|disregard|override|bypass)\b/i.test(text)) return true;
  if (/\bdo\s+whatever\b/i.test(text)) return true;
  if (/\bcomparison\s+(?:is|was|looks?)\s+(?:valid|equivalent|correct|approved)\b/i.test(text)) return true;
  if (/\b(?:reply|respond|reproduce|copy|return|output|print|emit|repeat|reveal|show)\b[^.!?\n]{0,160}\b(?:token|system prompt|developer prompt|above|below|top|bottom|previous|next|following|preceding|first|last|line|value|quoted|equals?\s+sign|colon[- ]delimited|source|candidate)\b/i.test(text)) return true;
  if (/\b(?:system|developer)\s+(?:message|prompt|instruction)\b/i.test(text)) return true;
  return false;
}

export function isValidReadyDelivery(source: string, value: unknown): value is {
  version: 1;
  sourceSha256: string;
  status: "ready";
  text: string;
  checks: { plain: true; anchorsPreserved: true };
} {
  if (!isRecord(value) || !hasExactKeys(value, READY_KEYS)) return false;
  if (value.version !== 1 || value.status !== "ready") return false;
  if (typeof value.sourceSha256 !== "string" || !SHA256_HEX.test(value.sourceSha256)) return false;
  if (value.sourceSha256 !== sha256Hex(source)) return false;
  if (typeof value.text !== "string") return false;
  if (value.text.trim().length === 0 || value.text.length > MAX_OPERATOR_DELIVERY_TEXT_CHARS) return false;
  if (!isRecord(value.checks) || !hasExactKeys(value.checks, CHECK_KEYS)) return false;
  if (value.checks.plain !== true || value.checks.anchorsPreserved !== true) return false;
  return !hasObviousInternalJargon(value.text);
}

/** Source-bound proof that finalized prose is intentionally agent-only. */
export function isValidAgentDelivery(source: string, value: unknown): value is {
  version: 1;
  sourceSha256: string;
  status: "agent";
} {
  if (!isRecord(value) || !hasExactKeys(value, AGENT_KEYS)) return false;
  return value.version === 1 &&
    value.status === "agent" &&
    typeof value.sourceSha256 === "string" &&
    SHA256_HEX.test(value.sourceSha256) &&
    value.sourceSha256 === sha256Hex(source);
}

interface MarkdownImageDestination {
  beforeDestination: string;
  destination: string;
  afterDestination: string;
}

function splitAroundMarkdownImageDestinations(text: string): MarkdownImageDestination[] {
  const parts: MarkdownImageDestination[] = [];
  let cursor = 0;
  MARKDOWN_IMAGE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKDOWN_IMAGE_RE.exec(text)) !== null) {
    const token = match[0];
    const destination = match[2] ?? "";
    const destinationOffset = token.lastIndexOf(destination);
    parts.push({
      beforeDestination: text.slice(cursor, match.index + destinationOffset),
      destination,
      afterDestination: token.slice(destinationOffset + destination.length),
    });
    cursor = match.index + token.length;
  }
  parts.push({ beforeDestination: text.slice(cursor), destination: "", afterDestination: "" });
  return parts;
}

function isReplaceableLocalImageDestination(destination: string): boolean {
  return destination.length > 0 &&
    !destination.startsWith("data:") &&
    !destination.startsWith("blob:") &&
    !destination.startsWith("http://") &&
    !destination.startsWith("https://") &&
    !destination.startsWith("pi-asset:") &&
    !destination.startsWith("#");
}

function isImageDestinationOnlyRewrite(source: string, presented: string): boolean {
  const sourceParts = splitAroundMarkdownImageDestinations(source);
  const presentedParts = splitAroundMarkdownImageDestinations(presented);
  if (sourceParts.length !== presentedParts.length) return false;

  let changed = false;
  for (let index = 0; index < sourceParts.length; index++) {
    const original = sourceParts[index];
    const candidate = presentedParts[index];
    if (original.beforeDestination !== candidate.beforeDestination ||
        original.afterDestination !== candidate.afterDestination) return false;
    if (original.destination === candidate.destination) continue;
    if (!isReplaceableLocalImageDestination(original.destination) ||
        !TRUSTED_ASSET_DESTINATION.test(candidate.destination)) return false;
    changed = true;
  }
  if (!changed) return false;

  // A transport identifier is allowed only as a complete Markdown image
  // destination. Bare ids, links, HTML attributes, and malformed tokens deny
  // the sidecar rather than becoming operator-visible prose.
  const withoutTrustedImages = presented.replace(
    TRUSTED_MARKDOWN_ASSET_IMAGE_RE,
    (_token, alt: string) => alt,
  );
  return !/pi-asset:/i.test(withoutTrustedImages);
}

/**
 * Validate the bridge-owned display sidecar without weakening certification.
 * `deliveryText` remains byte-identical; only local Markdown image destinations
 * may be replaced with bounded dashboard asset references.
 */
export function isValidOperatorDeliveryPresentation(
  deliveryText: string,
  value: unknown,
): value is { version: 1; deliverySha256: string; text: string } {
  if (!isRecord(value) || !hasExactKeys(value, PRESENTATION_KEYS)) return false;
  if (value.version !== 1) return false;
  if (typeof value.deliverySha256 !== "string" || !SHA256_HEX.test(value.deliverySha256)) return false;
  if (value.deliverySha256 !== sha256Hex(deliveryText)) return false;
  if (typeof value.text !== "string" || value.text.length === 0 ||
      value.text.length > MAX_OPERATOR_DELIVERY_TEXT_CHARS) return false;
  return isImageDestinationOnlyRewrite(deliveryText, value.text);
}

function selectBoundPresentationText(deliveryText: string, presentation: unknown): string {
  return isValidOperatorDeliveryPresentation(deliveryText, presentation)
    ? presentation.text
    : deliveryText;
}

/** Strict operator-visible selection: verified plain delivery or exact fallback. */
export function selectOperatorVisibleAssistantText(
  source: string,
  operatorDelivery: unknown,
  operatorDeliveryPresentation?: unknown,
): string {
  return isValidReadyDelivery(source, operatorDelivery)
    ? operatorDeliveryTextForChat(
        selectBoundPresentationText(operatorDelivery.text, operatorDeliveryPresentation),
      )
    : OPERATOR_DELIVERY_FALLBACK;
}

/** Chat selection retains source only for a source-bound explicit-agent pair. */
export function selectFinalAssistantText(
  source: string,
  audience: Audience | undefined,
  operatorDelivery: unknown,
  operatorDeliveryPresentation?: unknown,
): string {
  if (audience === "agent" && isValidAgentDelivery(source, operatorDelivery)) {
    return operatorDeliveryTextForChat(
      selectBoundPresentationText(source, operatorDeliveryPresentation),
    );
  }
  return selectOperatorVisibleAssistantText(
    source,
    operatorDelivery,
    operatorDeliveryPresentation,
  );
}

function scrubAssetTransportIds(text: string): string {
  return text.replace(ASSET_TRANSPORT_ID_RE, "[attached image]");
}

/** Remove transport-only image ids from previews and copied operator prose. */
export function operatorDeliveryTextForPresentation(text: string): string {
  const withoutMarkdownAssets = text.replace(
    TRUSTED_MARKDOWN_ASSET_IMAGE_RE,
    (_token, alt: string) => {
      const cleanAlt = scrubAssetTransportIds(alt).trim();
      return cleanAlt && cleanAlt !== "[attached image]"
        ? `[image: ${cleanAlt}]`
        : "[attached image]";
    },
  );
  return scrubAssetTransportIds(withoutMarkdownAssets);
}

/** Keep renderable Markdown images, but neutralize transport ids everywhere else. */
export function operatorDeliveryTextForChat(text: string): string {
  const images: string[] = [];
  const protectedImages = text.replace(
    TRUSTED_MARKDOWN_ASSET_IMAGE_RE,
    (_imageMarkdown, alt: string, destination: string) => {
      const marker = `\uE000operator-image-${images.length}\uE001`;
      images.push(`![${scrubAssetTransportIds(alt)}](${destination})`);
      return marker;
    },
  );
  let safe = scrubAssetTransportIds(protectedImages);
  images.forEach((imageMarkdown, index) => {
    safe = safe.replace(`\uE000operator-image-${index}\uE001`, imageMarkdown);
  });
  return safe;
}
