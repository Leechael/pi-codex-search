import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SearchContextSize } from "./codex.ts";

export type Freshness = "live" | "cached";

export type ConfigScope = "project" | "home";

export interface PiCodexSearchConfig {
  enabled?: boolean;
  toolName?: string;
  model?: string;
  baseUrl?: string;
  clientVersion?: string;
  searchContextSize?: SearchContextSize;
  freshness?: Freshness;
}

export interface ResolvedConfig {
  enabled: boolean;
  toolName: string;
  model?: string;
  baseUrl?: string;
  clientVersion?: string;
  defaultSearchContextSize: SearchContextSize;
  defaultFreshness: Freshness;
  sources: {
    project?: PiCodexSearchConfig;
    home?: PiCodexSearchConfig;
    env?: PiCodexSearchConfig;
  };
}

export const DEFAULT_ENABLED = true;
export const DEFAULT_TOOL_NAME = "codex_search";
export const DEFAULT_SEARCH_CONTEXT_SIZE: SearchContextSize = "medium";
export const DEFAULT_FRESHNESS: Freshness = "live";
export const CONFIG_FILE_NAME = "pi-codex-search.json";
const TOOL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const CONTEXT_SIZES: readonly SearchContextSize[] = ["low", "medium", "high"] as const;
const FRESHNESS_VALUES: readonly Freshness[] = ["live", "cached"] as const;

export function getConfigPath(scope: ConfigScope, cwd: string): string {
  if (scope === "project") return join(cwd, ".pi", CONFIG_FILE_NAME);
  return join(homedir(), ".pi", CONFIG_FILE_NAME);
}

export async function loadConfig(cwd: string): Promise<ResolvedConfig> {
  const homeConfig = await readConfigFile(getConfigPath("home", cwd));
  const projectConfig = await readConfigFile(getConfigPath("project", cwd));
  const envConfig = readEnvConfig();

  const merged: PiCodexSearchConfig = {
    ...homeConfig,
    ...projectConfig,
    ...envConfig,
  };

  const resolved: ResolvedConfig = {
    enabled: merged.enabled ?? DEFAULT_ENABLED,
    toolName: merged.toolName ?? DEFAULT_TOOL_NAME,
    defaultSearchContextSize: merged.searchContextSize ?? DEFAULT_SEARCH_CONTEXT_SIZE,
    defaultFreshness: merged.freshness ?? DEFAULT_FRESHNESS,
    sources: {},
  };
  if (merged.model !== undefined) resolved.model = merged.model;
  if (merged.baseUrl !== undefined) resolved.baseUrl = merged.baseUrl;
  if (merged.clientVersion !== undefined) resolved.clientVersion = merged.clientVersion;
  if (homeConfig) resolved.sources.home = homeConfig;
  if (projectConfig) resolved.sources.project = projectConfig;
  if (envConfig && Object.keys(envConfig).length > 0) resolved.sources.env = envConfig;

  return resolved;
}

export async function saveConfig(
  scope: ConfigScope,
  cwd: string,
  config: PiCodexSearchConfig,
): Promise<string> {
  validateConfig(config, `<save:${scope}>`);
  const filePath = getConfigPath(scope, cwd);
  const clean = stripUndefined(config);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(clean, null, 2)}\n`, "utf-8");
  return filePath;
}

export async function deleteConfig(scope: ConfigScope, cwd: string): Promise<boolean> {
  const filePath = getConfigPath(scope, cwd);
  try {
    await unlink(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readConfigFile(filePath: string): Promise<PiCodexSearchConfig | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Failed to read ${filePath}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${filePath}: ${(error as Error).message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Invalid config in ${filePath}: expected a JSON object`);
  }
  const config = parsed as PiCodexSearchConfig;
  validateConfig(config, filePath);
  return config;
}

function readEnvConfig(): PiCodexSearchConfig | undefined {
  const env: PiCodexSearchConfig = {};
  const enabled = booleanEnv("PI_CODEX_WEB_SEARCH_ENABLED");
  if (enabled !== undefined) env.enabled = enabled;
  const toolName = trimmedEnv("PI_CODEX_WEB_SEARCH_TOOL_NAME");
  if (toolName !== undefined) env.toolName = toolName;
  const model = trimmedEnv("PI_CODEX_WEB_SEARCH_MODEL");
  if (model !== undefined) env.model = model;
  const baseUrl = trimmedEnv("PI_CODEX_WEB_SEARCH_BASE_URL");
  if (baseUrl !== undefined) env.baseUrl = baseUrl;
  const clientVersion = trimmedEnv("PI_CODEX_WEB_SEARCH_CLIENT_VERSION");
  if (clientVersion !== undefined) env.clientVersion = clientVersion;
  const searchContextSize = trimmedEnv("PI_CODEX_WEB_SEARCH_CONTEXT_SIZE");
  if (searchContextSize !== undefined) {
    env.searchContextSize = searchContextSize as SearchContextSize;
  }
  const freshness = trimmedEnv("PI_CODEX_WEB_SEARCH_FRESHNESS");
  if (freshness !== undefined) env.freshness = freshness as Freshness;

  if (Object.keys(env).length === 0) return undefined;
  validateConfig(env, "<env>");
  return env;
}

function validateConfig(config: PiCodexSearchConfig, sourceLabel: string): void {
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    throw new Error(
      `Invalid enabled in ${sourceLabel}: ${JSON.stringify(config.enabled)}. Must be a boolean.`,
    );
  }
  if (config.toolName !== undefined && !TOOL_NAME_PATTERN.test(config.toolName)) {
    throw new Error(
      `Invalid toolName in ${sourceLabel}: ${JSON.stringify(config.toolName)}. ` +
        `Must match ${TOOL_NAME_PATTERN.source}.`,
    );
  }
  if (config.model !== undefined && !isNonEmptyString(config.model)) {
    throw new Error(`Invalid model in ${sourceLabel}: must be a non-empty string.`);
  }
  if (config.baseUrl !== undefined && !isNonEmptyString(config.baseUrl)) {
    throw new Error(`Invalid baseUrl in ${sourceLabel}: must be a non-empty string.`);
  }
  if (config.clientVersion !== undefined && !isNonEmptyString(config.clientVersion)) {
    throw new Error(`Invalid clientVersion in ${sourceLabel}: must be a non-empty string.`);
  }
  if (config.searchContextSize !== undefined && !CONTEXT_SIZES.includes(config.searchContextSize)) {
    throw new Error(
      `Invalid searchContextSize in ${sourceLabel}: ${JSON.stringify(config.searchContextSize)}. ` +
        `Expected one of ${CONTEXT_SIZES.join(", ")}.`,
    );
  }
  if (config.freshness !== undefined && !FRESHNESS_VALUES.includes(config.freshness)) {
    throw new Error(
      `Invalid freshness in ${sourceLabel}: ${JSON.stringify(config.freshness)}. ` +
        `Expected one of ${FRESHNESS_VALUES.join(", ")}.`,
    );
  }
}

function trimmedEnv(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function booleanEnv(name: string): boolean | undefined {
  const raw = trimmedEnv(name);
  if (raw === undefined) return undefined;
  const lower = raw.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  throw new Error(`Invalid ${name}: ${JSON.stringify(raw)}. Expected 'true' or 'false'.`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stripUndefined(config: PiCodexSearchConfig): PiCodexSearchConfig {
  const clean: PiCodexSearchConfig = {};
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) {
      (clean as Record<string, unknown>)[key] = value;
    }
  }
  return clean;
}
