import { describe, expect, it, vi } from "vitest";
import { normalizePiAiModule, normalizePiAiOAuthModule } from "../registry-singleton.js";

function legacyShape() {
  return {
    registerBuiltInApiProviders: vi.fn(),
    getModels: vi.fn(() => []),
    getProviders: vi.fn(() => []),
    getModel: vi.fn(),
    registerApiProvider: vi.fn(),
    unregisterApiProviders: vi.fn(),
    streamSimple: vi.fn(),
  };
}

describe("pi-ai compatibility entrypoint", () => {
  it("uses an already-compatible legacy root module without another import", async () => {
    const root = legacyShape();
    const load = vi.fn();

    expect(await normalizePiAiModule(root as any, "/pkg/dist/index.js", load)).toBe(root);
    expect(load).not.toHaveBeenCalled();
  });

  it("loads dist/compat.js when the modern root omits the legacy model-proxy surface", async () => {
    const compat = legacyShape();
    const load = vi.fn(async () => compat);

    const result = await normalizePiAiModule({} as any, "/pkg/dist/index.js", load);

    expect(result).toBe(compat);
    expect(load).toHaveBeenCalledOnce();
    const calls = load.mock.calls as unknown as Array<[string]>;
    expect(String(calls[0][0])).toMatch(/\/pkg\/dist\/compat\.js$/);
  });

  it("fails clearly when neither root nor compat exposes the required surface", async () => {
    await expect(normalizePiAiModule({} as any, "/pkg/dist/index.js", async () => ({})))
      .rejects.toThrow("pi-ai compatibility surface unavailable");
  });
});

describe("pi-ai OAuth compatibility entrypoint", () => {
  it("keeps the legacy OAuth module when it exposes the expected functions", async () => {
    const legacy = { getOAuthProvider: vi.fn(), refreshOAuthToken: vi.fn() };
    const load = vi.fn();
    expect(await normalizePiAiOAuthModule(legacy, "/pkg/dist/index.js", load)).toBe(legacy);
    expect(load).not.toHaveBeenCalled();
  });

  it("adapts modern OAuth flow loaders to the legacy refresh contract", async () => {
    const refresh = vi.fn(async (credential) => ({
      ...credential,
      access: "copilot-access",
      expires: 456,
    }));
    const load = vi.fn(async () => ({
      loadGitHubCopilotOAuth: async () => ({ refresh }),
    }));
    const oauth = await normalizePiAiOAuthModule({}, "/pkg/dist/index.js", load);
    const provider = oauth?.getOAuthProvider("github-copilot");
    const result = await provider?.refreshToken({
      accessToken: "old-access",
      refreshToken: "github-refresh",
      expiresAt: 123,
    });

    const calls = load.mock.calls as unknown as Array<[string]>;
    expect(String(calls[0][0])).toMatch(/\/pkg\/dist\/auth\/oauth\/load\.js$/);
    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({
      type: "oauth",
      access: "old-access",
      refresh: "github-refresh",
      expires: 123,
    }));
    expect(result).toMatchObject({
      accessToken: "copilot-access",
      refreshToken: "github-refresh",
      expiresAt: 456,
    });
  });
});
