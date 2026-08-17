/**
 * Singleton accessor for the server-resident model registry.
 *
 * Lazy initialization: on first call, resolves pi-ai via ToolRegistry,
 * constructs InternalAuthStorage + InternalRegistry, and caches the instance.
 *
 * See change: add-dashboard-model-proxy, design §1.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { getDefaultRegistry, ModuleResolutionError } from "@blackbelt-technology/pi-dashboard-shared/tool-registry/index.js";
import { InternalRegistry, type PiAiModule, type CustomProviderEntry, type CustomModelEntry } from "./internal-registry.js";
import { InternalAuthStorage, type PiAiOAuthModule } from "./internal-auth-storage.js";
import { readAuthJson } from "../provider-auth-storage.js";

let cachedRegistry: InternalRegistry | null = null;
let cachedPiAi: PiAiModule | null = null;
let lastError: string | null = null;

type ModuleLoader = (href: string) => Promise<unknown>;

function hasCompatSurface(value: unknown): value is PiAiModule {
  if (!value || typeof value !== "object") return false;
  const module = value as Record<string, unknown>;
  return [
    "registerBuiltInApiProviders",
    "getModels",
    "getProviders",
    "getModel",
    "registerApiProvider",
    "unregisterApiProviders",
    "streamSimple",
  ].every((name) => typeof module[name] === "function");
}

/**
 * pi-ai 0.83 moved the legacy model-proxy API from its root export to
 * `dist/compat.js`. Older versions still expose it at `dist/index.js`.
 */
export async function normalizePiAiModule(
  rootModule: unknown,
  resolutionPath: string | null,
  load: ModuleLoader = (href) => import(href),
): Promise<PiAiModule> {
  if (hasCompatSurface(rootModule)) return rootModule;
  if (!resolutionPath) throw new Error("pi-ai compatibility surface unavailable: resolved module has no path");
  const compatPath = join(dirname(resolutionPath), "compat.js");
  let compatModule: unknown;
  try {
    compatModule = await load(pathToFileURL(compatPath).href);
  } catch (error) {
    throw new Error(
      `pi-ai compatibility surface unavailable at ${compatPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!hasCompatSurface(compatModule)) {
    throw new Error(`pi-ai compatibility surface unavailable at ${compatPath}`);
  }
  return compatModule;
}

function hasLegacyOAuthSurface(value: unknown): value is PiAiOAuthModule {
  if (!value || typeof value !== "object") return false;
  const module = value as Record<string, unknown>;
  return typeof module.getOAuthProvider === "function" && typeof module.refreshOAuthToken === "function";
}

interface ModernOAuthFlow {
  refresh(credential: Record<string, unknown>): Promise<Record<string, unknown>>;
}

interface ModernOAuthLoaders {
  loadAnthropicOAuth?: () => Promise<ModernOAuthFlow>;
  loadOpenAICodexOAuth?: () => Promise<ModernOAuthFlow>;
  loadGitHubCopilotOAuth?: () => Promise<ModernOAuthFlow>;
}

/** Adapt pi-ai 0.83 OAuth loaders to the legacy refresh surface. */
export async function normalizePiAiOAuthModule(
  rootModule: unknown,
  resolutionPath: string | null,
  load: ModuleLoader = (href) => import(href),
): Promise<PiAiOAuthModule | null> {
  if (hasLegacyOAuthSurface(rootModule)) return rootModule;
  if (!resolutionPath) return null;
  const loadersPath = join(dirname(resolutionPath), "auth", "oauth", "load.js");
  let loaders: ModernOAuthLoaders;
  try {
    loaders = await load(pathToFileURL(loadersPath).href) as ModernOAuthLoaders;
  } catch {
    return null;
  }
  const byProvider: Record<string, (() => Promise<ModernOAuthFlow>) | undefined> = {
    anthropic: loaders.loadAnthropicOAuth,
    "openai-codex": loaders.loadOpenAICodexOAuth,
    "github-copilot": loaders.loadGitHubCopilotOAuth,
  };

  const refresh = async (providerId: string, credentials: any): Promise<any> => {
    const loadFlow = byProvider[providerId];
    if (!loadFlow) throw new Error(`No OAuth refresh loader for "${providerId}"`);
    const flow = await loadFlow();
    const refreshed = await flow.refresh({
      type: "oauth",
      access: credentials.accessToken,
      refresh: credentials.refreshToken,
      expires: credentials.expiresAt,
      ...(credentials.enterpriseUrl ? { enterpriseUrl: credentials.enterpriseUrl } : {}),
    });
    return {
      ...refreshed,
      accessToken: refreshed.access,
      refreshToken: refreshed.refresh,
      expiresAt: refreshed.expires,
    };
  };

  return {
    getOAuthProvider(providerId) {
      return byProvider[providerId]
        ? { refreshToken: (credentials) => refresh(providerId, credentials) }
        : undefined;
    },
    refreshOAuthToken: refresh,
  };
}

// ── Disk readers ──────────────────────────────────────────────────────────────

const PROVIDERS_PATH = join(homedir(), ".pi", "agent", "providers.json");
const MODELS_PATH = join(homedir(), ".pi", "agent", "models.json");

function readProviders(): Record<string, CustomProviderEntry> {
  if (!existsSync(PROVIDERS_PATH)) return {};
  try {
    const raw = JSON.parse(readFileSync(PROVIDERS_PATH, "utf-8"));
    return raw.providers ?? {};
  } catch {
    return {};
  }
}

function readModels(): CustomModelEntry[] {
  if (!existsSync(MODELS_PATH)) return [];
  try {
    const raw = JSON.parse(readFileSync(MODELS_PATH, "utf-8"));
    if (Array.isArray(raw)) return raw;
    if (raw.models && Array.isArray(raw.models)) return raw.models;
    return [];
  } catch {
    return [];
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function getModelRegistry(): Promise<InternalRegistry> {
  if (cachedRegistry) return cachedRegistry;

  try {
    const { resolution, module: rootModule } = await getDefaultRegistry().resolveModule<unknown>("pi-ai");
    const piAi = await normalizePiAiModule(rootModule, resolution.path);

    // Resolve oauth subpath
    let oauthModule: PiAiOAuthModule | null = null;
    if (resolution.path) {
      const oauthPath = join(dirname(resolution.path), "oauth.js");
      let oauthRoot: unknown = null;
      try {
        oauthRoot = await import(pathToFileURL(oauthPath).href);
      } catch {
        // OAuth subpath may not exist; non-fatal
      }
      oauthModule = await normalizePiAiOAuthModule(oauthRoot, resolution.path);
    }

    const authStorage = new InternalAuthStorage(oauthModule);
    cachedPiAi = piAi;
    cachedRegistry = new InternalRegistry(piAi, authStorage, {
      readProviders,
      readModels,
      readAuth: readAuthJson,
    });
    lastError = null;
    return cachedRegistry;
  } catch (err) {
    const msg = err instanceof ModuleResolutionError
      ? err.message
      : (err as Error).message;
    lastError = msg;
    throw err;
  }
}

export async function refreshModelRegistry(): Promise<void> {
  if (!cachedRegistry) return;
  await cachedRegistry.refresh();
}

export function disposeModelRegistry(): void {
  cachedRegistry = null;
  cachedPiAi = null;
  lastError = null;
}

/**
 * Returns pi-ai's streamSimple after registry is initialized.
 * Throws if registry has not been initialized.
 */
export function getStreamSimpleFn(): PiAiModule["streamSimple"] | null {
  return cachedPiAi?.streamSimple ?? null;
}

export function getModelProxyStatus(): { status: "ready" | "degraded"; reason?: string } {
  if (cachedRegistry) return { status: "ready" };
  if (lastError) return { status: "degraded", reason: lastError };
  return { status: "degraded", reason: "Model registry not yet initialized" };
}
