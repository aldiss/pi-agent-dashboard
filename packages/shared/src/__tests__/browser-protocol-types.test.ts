/**
 * Type-level tests ensuring PromptBus messages are included in ServerToBrowserMessage.
 *
 * These tests prevent the regression where `case "prompt_request" as any:` etc.
 * in switch statements were dead-code eliminated by esbuild because the message
 * types were not in the ServerToBrowserMessage union.
 */
import { describe, it, expect } from "vitest";
import { TRANSLATION_WARNING_CODES } from "../browser-protocol.js";
import type {
  ServerToBrowserMessage,
  BrowserPromptRequestMessage,
  BrowserPromptDismissMessage,
  BrowserPromptCancelMessage,
  BrowserExtUiDecoratorMessage,
  BrowserAssetRegisterMessage,
  TranslationResultMessage,
  SetSessionTranslationBrowserMessage,
  BrowserToServerMessage,
  TranslationWarningCode,
} from "../browser-protocol.js";
import type {
  ExtensionToServerMessage,
  ExtUiDecoratorMessage,
  AssetRegisterMessage,
} from "../protocol.js";
import type { DecoratorDescriptor } from "../types.js";

// Type-level assertion: if these types are NOT in the union, this will fail to compile.
type AssertExtends<T, U> = T extends U ? true : never;
type _PromptRequestInUnion = AssertExtends<BrowserPromptRequestMessage, ServerToBrowserMessage>;
type _PromptDismissInUnion = AssertExtends<BrowserPromptDismissMessage, ServerToBrowserMessage>;
type _PromptCancelInUnion = AssertExtends<BrowserPromptCancelMessage, ServerToBrowserMessage>;
// Phase-2 (add-extension-ui-decorations): ext_ui_decorator must be a member of
// BOTH the extension→server union and the server→browser union, otherwise
// esbuild strips the switch arms in production builds.
type _ExtUiDecoratorInExtensionUnion = AssertExtends<ExtUiDecoratorMessage, ExtensionToServerMessage>;
type _ExtUiDecoratorInBrowserUnion   = AssertExtends<BrowserExtUiDecoratorMessage, ServerToBrowserMessage>;
// chat-markdown-local-images-and-math: asset_register must live in BOTH the
// extension→server union (so the server's switch arm survives esbuild) AND
// the server→browser union (so the client's reducer arm survives esbuild).
type _AssetRegisterInExtensionUnion = AssertExtends<AssetRegisterMessage, ExtensionToServerMessage>;
type _AssetRegisterInBrowserUnion   = AssertExtends<BrowserAssetRegisterMessage, ServerToBrowserMessage>;
type _TranslationResultInBrowserUnion = AssertExtends<TranslationResultMessage, ServerToBrowserMessage>;
type _SetSessionTranslationInBrowserUnion = AssertExtends<SetSessionTranslationBrowserMessage, BrowserToServerMessage>;

// Runtime verification that the type discriminants are reachable in a switch
function extractPromptType(msg: ServerToBrowserMessage): string | null {
  switch (msg.type) {
    case "prompt_request": return msg.promptId;
    case "prompt_dismiss": return msg.promptId;
    case "prompt_cancel": return msg.promptId;
    default: return null;
  }
}

describe("ServerToBrowserMessage includes PromptBus messages", () => {
  it("prompt_request is a valid discriminant", () => {
    const msg: BrowserPromptRequestMessage = {
      type: "prompt_request",
      sessionId: "s1",
      promptId: "p1",
      prompt: { question: "Q?", type: "input" },
      component: { type: "generic-dialog", props: {} },
      placement: "inline",
    };
    expect(extractPromptType(msg)).toBe("p1");
  });

  it("prompt_dismiss is a valid discriminant", () => {
    const msg: BrowserPromptDismissMessage = {
      type: "prompt_dismiss",
      sessionId: "s1",
      promptId: "p1",
    };
    expect(extractPromptType(msg)).toBe("p1");
  });

  it("prompt_cancel is a valid discriminant", () => {
    const msg: BrowserPromptCancelMessage = {
      type: "prompt_cancel",
      sessionId: "s1",
      promptId: "p1",
    };
    expect(extractPromptType(msg)).toBe("p1");
  });
});

// Phase-2: ext_ui_decorator switch-arm reachability.
function extractDecoratorKey(msg: ServerToBrowserMessage): string | null {
  switch (msg.type) {
    case "ext_ui_decorator":
      return `${msg.descriptor.kind}:${msg.descriptor.namespace}:${msg.descriptor.id}`;
    default:
      return null;
  }
}

describe("ext_ui_decorator is a member of both protocol unions", () => {
  const sample: DecoratorDescriptor = {
    kind: "footer-segment",
    namespace: "judo",
    id: "model-state",
    payload: { text: "3 mut" },
  };

  it("server→browser ext_ui_decorator is a valid discriminant", () => {
    const msg: BrowserExtUiDecoratorMessage = {
      type: "ext_ui_decorator",
      sessionId: "s1",
      descriptor: sample,
    };
    expect(extractDecoratorKey(msg)).toBe("footer-segment:judo:model-state");
  });

  it("removed flag round-trips through the union", () => {
    const msg: BrowserExtUiDecoratorMessage = {
      type: "ext_ui_decorator",
      sessionId: "s1",
      descriptor: sample,
      removed: true,
    };
    expect(extractDecoratorKey(msg)).toBe("footer-segment:judo:model-state");
    // Round-trip via JSON to confirm `removed` survives serialization.
    const parsed = JSON.parse(JSON.stringify(msg)) as BrowserExtUiDecoratorMessage;
    expect(parsed.removed).toBe(true);
  });

  it("extension→server ext_ui_decorator carries the same shape", () => {
    const msg: ExtUiDecoratorMessage = {
      type: "ext_ui_decorator",
      sessionId: "s1",
      descriptor: sample,
    };
    expect(msg.type).toBe("ext_ui_decorator");
    expect(msg.descriptor.kind).toBe("footer-segment");
  });
});

// chat-markdown-local-images-and-math: asset_register switch-arm reachability.
function extractAssetHash(msg: ServerToBrowserMessage): string | null {
  switch (msg.type) {
    case "asset_register":
      return msg.hash;
    default:
      return null;
  }
}

describe("asset_register is a member of both protocol unions", () => {
  it("server→browser asset_register is a valid discriminant", () => {
    const msg: BrowserAssetRegisterMessage = {
      type: "asset_register",
      sessionId: "s1",
      hash: "abc1234567890123",
      mimeType: "image/png",
      data: "iVBORw0KGgo=",
    };
    expect(extractAssetHash(msg)).toBe("abc1234567890123");
  });

  it("extension→server asset_register carries the same shape", () => {
    const msg: AssetRegisterMessage = {
      type: "asset_register",
      sessionId: "s1",
      hash: "abc1234567890123",
      mimeType: "image/svg+xml",
      data: "PHN2Zy8+",
    };
    expect(msg.type).toBe("asset_register");
    expect(msg.hash).toBe("abc1234567890123");
    expect(msg.mimeType).toBe("image/svg+xml");
  });
});

describe("translation_result is a typed server-to-browser carrier", () => {
  it("keeps the result switch arm reachable in production builds", () => {
    const msg: TranslationResultMessage = {
      type: "translation_result",
      sessionId: "s1",
      entryId: "entry-a1",
      sourceHash: "abc123",
      status: "translated",
      text: "Plain English",
    };
    const throughUnion: ServerToBrowserMessage = msg;
    expect(throughUnion.type).toBe("translation_result");
  });

  it("exports the complete bounded warning-code vocabulary", () => {
    const expected = [
      "numbers-changed",
      "negation-changed",
      "negation-attachment-changed",
      "known-pattern",
      "meaning-judge-rejected",
    ] as const satisfies readonly TranslationWarningCode[];

    expect(TRANSLATION_WARNING_CODES).toEqual(expected);
  });

  it("carries named warnings only on a rendered translation", () => {
    const msg: TranslationResultMessage = {
      type: "translation_result",
      sessionId: "s1",
      entryId: "entry-a1",
      sourceHash: "abc123",
      status: "translated",
      text: "Plain English with operator review needed.",
      warnings: ["numbers-changed", "meaning-judge-rejected"],
    };
    const parsed = JSON.parse(JSON.stringify(msg)) as TranslationResultMessage;

    expect(parsed.status).toBe("translated");
    if (parsed.status !== "translated") throw new Error("expected translated carrier");
    expect(parsed.warnings).toEqual(["numbers-changed", "meaning-judge-rejected"]);
  });
});

describe("set_session_translation is a typed browser-to-server carrier", () => {
  it("keeps the stage-1 gate switch arm reachable", () => {
    const msg: BrowserToServerMessage = {
      type: "set_session_translation",
      sessionId: "s1",
      enabled: true,
    };
    expect(msg.type).toBe("set_session_translation");
  });
});
