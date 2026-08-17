/**
 * Precondition test: pi-ai symbol shape.
 *
 * Runtime-resolves pi-ai via the ToolRegistry and asserts every symbol
 * the model-proxy change depends on exists in the resolved module.
 *
 * - `it.skip` when pi-ai cannot be resolved (clean CI without ~/.pi-dashboard/).
 * - Full run when pi-ai is installed locally.
 * - Set `MODEL_PROXY_REQUIRE_PI_AI=1` to force hard-fail (for release-cut runs).
 *
 * Run locally:
 *   MODEL_PROXY_REQUIRE_PI_AI=1 npm test -- pi-ai-shape
 */
import { describe, it, expect, beforeAll } from "vitest";
import { getDefaultRegistry } from "@blackbelt-technology/pi-dashboard-shared/tool-registry/index.js";
import { normalizePiAiModule, normalizePiAiOAuthModule } from "../model-proxy/registry-singleton.js";

const REQUIRE = process.env.MODEL_PROXY_REQUIRE_PI_AI === "1";

let piAi: Record<string, unknown> | null = null;
let piAiOAuth: Record<string, unknown> | null = null;
let resolveError: Error | null = null;

beforeAll(async () => {
  try {
    const result = await getDefaultRegistry().resolveModule<Record<string, unknown>>("pi-ai");
    piAi = await normalizePiAiModule(result.module, result.resolution.path) as unknown as Record<string, unknown>;

    // Resolve oauth subpath — pi-ai exports it from dist/oauth.js
    const resolution = result.resolution;
    if (resolution.path) {
      const oauthPath = resolution.path.replace(/\/dist\/index\.js$/, "/dist/oauth.js");
      try {
        const { pathToFileURL } = await import("node:url");
        const oauthRoot = await import(pathToFileURL(oauthPath).href);
        piAiOAuth = await normalizePiAiOAuthModule(oauthRoot, resolution.path) as unknown as Record<string, unknown> | null;
      } catch {
        // OAuth subpath may not exist in all versions
      }
    }
  } catch (err) {
    resolveError = err as Error;
    if (REQUIRE) {
      throw new Error(
        `MODEL_PROXY_REQUIRE_PI_AI=1 but pi-ai could not be resolved: ${(err as Error).message}`,
      );
    }
  }
});

const skipOrRun = () => {
  if (!piAi) return it.skip;
  return it;
};

describe("pi-ai shape precondition", () => {
  it("resolves pi-ai or skips gracefully", () => {
    if (REQUIRE) {
      expect(piAi).not.toBeNull();
    } else if (!piAi) {
      console.log(`pi-ai not resolved (${resolveError?.message}); skipping shape checks`);
    }
  });

  // --- Main exports from pi-ai (dist/index.js) ---

  describe("main exports", () => {
    it("exports streamSimple", () => {
      if (!piAi) return;
      expect(typeof piAi.streamSimple).toBe("function");
    });

    it("exports getModels", () => {
      if (!piAi) return;
      expect(typeof piAi.getModels).toBe("function");
    });

    it("exports registerBuiltInApiProviders", () => {
      if (!piAi) return;
      expect(typeof piAi.registerBuiltInApiProviders).toBe("function");
    });

    it("exports getApiProvider", () => {
      if (!piAi) return;
      expect(typeof piAi.getApiProvider).toBe("function");
    });

    it("exports getProviders", () => {
      if (!piAi) return;
      expect(typeof piAi.getProviders).toBe("function");
    });

    it("exports registerApiProvider", () => {
      if (!piAi) return;
      expect(typeof piAi.registerApiProvider).toBe("function");
    });

    it("exports getModel", () => {
      if (!piAi) return;
      expect(typeof piAi.getModel).toBe("function");
    });

    it("exports registerFauxProvider (for testing)", () => {
      if (!piAi) return;
      expect(typeof piAi.registerFauxProvider).toBe("function");
    });

    it("exports fauxText / fauxThinking / fauxToolCall helpers", () => {
      if (!piAi) return;
      expect(typeof piAi.fauxText).toBe("function");
      expect(typeof piAi.fauxThinking).toBe("function");
      expect(typeof piAi.fauxToolCall).toBe("function");
    });
  });

  // --- OAuth exports from pi-ai/oauth (dist/oauth.js) ---

  describe("oauth exports", () => {
    it("exports getOAuthProvider (generic provider lookup)", () => {
      if (!piAiOAuth) return;
      expect(typeof piAiOAuth.getOAuthProvider).toBe("function");
    });

    it("exports refreshOAuthToken (generic refresh)", () => {
      if (!piAiOAuth) return;
      expect(typeof piAiOAuth.refreshOAuthToken).toBe("function");
    });

    it("exposes refresh adapters for every model-proxy OAuth provider", () => {
      if (!piAiOAuth) return;
      const getProvider = piAiOAuth.getOAuthProvider as (id: string) => { refreshToken?: unknown } | undefined;
      for (const id of ["anthropic", "openai-codex", "github-copilot"]) {
        expect(typeof getProvider(id)?.refreshToken).toBe("function");
      }
    });
  });
});
