import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SearchContextSize } from "./codex.ts";

export type SearchApi = "standalone" | "responses";

export type Freshness = "live" | "cached" | "indexed";

export type ConfigScope = "project" | "home";

export interface PiCodexSearchConfig {
  enabled?: boolean;
  toolName?: string;
  model?: string;
  baseUrl?: string;
  clientVersion?: string;
  searchContextSize?: SearchContextSize;
  freshness?: Freshness;
  searchApi?: SearchApi;
  standaloneEnabled?: boolean;
  batchSize?: number;
}

export interface ResolvedConfig {
  enabled: boolean;
  toolName: string;
  model?: string;
  baseUrl?: string;
  clientVersion?: string;
  defaultSearchContextSize: SearchContextSize;
  defaultFreshness: Freshness;
  searchApi: SearchApi;
  standaloneEnabled: boolean;
  batchSize: number;
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
export const DEFAULT_SEARCH_API: SearchApi = "responses";
export const DEFAULT_STANDALONE_ENABLED = false;
export const STANDALONE_TOOL_NAME = "codex_standalone_web";
export const DEFAULT_BATCH_SIZE = 5;
export const CONFIG_FILE_NAME = "pi-codex-search.json";
const TOOL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const CONTEXT_SIZES: readonly SearchContextSize[] = ["low", "medium", "high"] as const;
const FRESHNESS_VALUES: readonly Freshness[] = ["live", "cached", "indexed"] as const;
const SEARCH_API_VALUES: readonly SearchApi[] = ["standalone", "responses"] as const;
export const MIN_BATCH_SIZE = 1;
export const MAX_BATCH_SIZE = 32;

export function getConfigPath(scope: ConfigScope, cwd: string): string {
  if (scope === "project") return join(cwd, ".pi", CONFIG_FILE_NAME);
  return join(homedir(), ".pi", CONFIG_FILE_NAME);
}

export function isProjectTrustedContext(ctx: unknown): boolean {
  const maybe = ctx as { isProjectTrusted?: unknown };
  if (typeof maybe.isProjectTrusted === "boolean") return maybe.isProjectTrusted;
  if (typeof maybe.isProjectTrusted !== "function") return true;
  try {
    return Boolean(maybe.isProjectTrusted());
  } catch {
    return false;
  }
}

export async function loadConfig(cwd: string, isProjectTrusted = true): Promise<ResolvedConfig> {
  const homeConfig = await readConfigFile(getConfigPath("home", cwd));
  const projectConfig = isProjectTrusted
    ? await readConfigFile(getConfigPath("project", cwd))
    : undefined;
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
    searchApi: DEFAULT_SEARCH_API,
    standaloneEnabled:
      merged.standaloneEnabled ??
      (merged.searchApi === "standalone" ? true : DEFAULT_STANDALONE_ENABLED),
    batchSize: merged.batchSize ?? DEFAULT_BATCH_SIZE,
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
  const searchApi = trimmedEnv("PI_CODEX_WEB_SEARCH_API");
  if (searchApi !== undefined) env.searchApi = searchApi as SearchApi;
  const standaloneEnabled = booleanEnv("PI_CODEX_WEB_STANDALONE_ENABLED");
  if (standaloneEnabled !== undefined) env.standaloneEnabled = standaloneEnabled;
  const batchSize = integerEnv("PI_CODEX_WEB_SEARCH_BATCH_SIZE");
  if (batchSize !== undefined) env.batchSize = batchSize;

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
  if (config.standaloneEnabled !== undefined && typeof config.standaloneEnabled !== "boolean") {
    throw new Error(
      `Invalid standaloneEnabled in ${sourceLabel}: ${JSON.stringify(config.standaloneEnabled)}. Must be a boolean.`,
    );
  }
  if (config.searchApi !== undefined && !SEARCH_API_VALUES.includes(config.searchApi)) {
    throw new Error(
      `Invalid searchApi in ${sourceLabel}: ${JSON.stringify(config.searchApi)}. ` +
        `Expected one of ${SEARCH_API_VALUES.join(", ")}.`,
    );
  }
  if (config.batchSize !== undefined) {
    if (
      !Number.isInteger(config.batchSize) ||
      config.batchSize < MIN_BATCH_SIZE ||
      config.batchSize > MAX_BATCH_SIZE
    ) {
      throw new Error(
        `Invalid batchSize in ${sourceLabel}: ${JSON.stringify(config.batchSize)}. ` +
          `Expected an integer between ${MIN_BATCH_SIZE} and ${MAX_BATCH_SIZE}.`,
      );
    }
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

function integerEnv(name: string): number | undefined {
  const raw = trimmedEnv(name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Invalid ${name}: ${JSON.stringify(raw)}. Expected an integer.`);
  }
  return parsed;
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
