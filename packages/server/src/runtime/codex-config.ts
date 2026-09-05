import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validateCodexRuntimeConfig, type CodexRuntimeConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";

export function prepareCodexConfig(config: CodexRuntimeConfig, parentEnv: NodeJS.ProcessEnv = process.env) {
  const error = validateCodexRuntimeConfig(config);
  if (error) throw new Error(error);
  if (!config.enabled) throw new Error("Codex runtime is disabled");
  const home = path.join(os.homedir(), ".pi", "dashboard", "codex-home");
  const modelProvider = config.modelProvider ?? "dashboard";
  const quote = JSON.stringify;
  const content = [
    `model_provider = ${quote(modelProvider)}`,
    ...(config.model ? [`model = ${quote(config.model)}`] : []),
    ...(config.reasoningEffort ? [`model_reasoning_effort = ${quote(config.reasoningEffort)}`] : []),
    ...(config.modelCatalogJson ? [`model_catalog_json = ${quote(config.modelCatalogJson)}`] : []),
    'approval_policy = "never"',
    'sandbox_mode = "workspace-write"',
    "",
    `[model_providers.${quote(modelProvider)}]`,
    `name = ${quote(modelProvider)}`,
    `base_url = ${quote(config.baseUrl ?? "https://api.openai.com/v1")}`,
    `env_key = ${quote(config.envKey ?? "OPENAI_API_KEY")}`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    "",
  ].join("\n");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, "config.toml");
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  const env: NodeJS.ProcessEnv = { ...parentEnv, CODEX_HOME: home };
  delete env.CODEX_THREAD_ID;
  return { home, modelProvider, env };
}
