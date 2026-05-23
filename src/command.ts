import { relative } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  type ConfigScope,
  DEFAULT_ENABLED,
  DEFAULT_FRESHNESS,
  DEFAULT_SEARCH_CONTEXT_SIZE,
  DEFAULT_TOOL_NAME,
  deleteConfig,
  type Freshness,
  getConfigPath,
  loadConfig,
  type PiCodexSearchConfig,
  type ResolvedConfig,
  saveConfig,
} from "./config.ts";
import type { SearchContextSize } from "./codex.ts";

const COMMAND_NAME = "codex-search-settings";
const SUBCOMMANDS = ["status", "reset"] as const;

export function registerSettingsCommand(pi: ExtensionAPI): void {
  pi.registerCommand(COMMAND_NAME, {
    description: "Configure pi-codex-search (tool name, model, defaults, freshness).",
    getArgumentCompletions(prefix) {
      const lower = prefix.toLowerCase();
      const matches = SUBCOMMANDS.filter((name) => name.startsWith(lower));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      try {
        if (!trimmed) {
          if (ctx.hasUI) {
            await openMainDialog(ctx);
            return;
          }
          await printStatus(ctx);
          return;
        }
        if (trimmed === "status") {
          await printStatus(ctx);
          return;
        }
        if (trimmed === "reset") {
          if (ctx.hasUI) {
            await openResetMenu(ctx);
          } else {
            notify(
              ctx,
              "`reset` requires interactive mode. Delete the config files manually.",
              "warning",
            );
          }
          return;
        }
        notify(
          ctx,
          `Unknown subcommand: ${trimmed}. Expected: ${SUBCOMMANDS.join(", ")}.`,
          "error",
        );
      } catch (error) {
        notify(ctx, (error as Error).message, "error");
      }
    },
  });
}

async function openMainDialog(ctx: ExtensionCommandContext): Promise<void> {
  let dirty = false;

  while (true) {
    const resolved = await loadConfig(ctx.cwd);
    const choice = await ctx.ui.select(buildMainTitle(resolved, ctx.cwd), [
      "Show current configuration",
      `Edit project config (${relative(ctx.cwd, getConfigPath("project", ctx.cwd))})`,
      `Edit home config (${homeRelative(getConfigPath("home", ctx.cwd))})`,
      "Reset configuration…",
      "Done",
    ]);

    if (!choice || choice === "Done") break;

    if (choice === "Show current configuration") {
      ctx.ui.notify(formatStatus(resolved, ctx.cwd));
      continue;
    }
    if (choice.startsWith("Edit project")) {
      if (await editScope(ctx, "project")) dirty = true;
      continue;
    }
    if (choice.startsWith("Edit home")) {
      if (await editScope(ctx, "home")) dirty = true;
      continue;
    }
    if (choice.startsWith("Reset")) {
      if (await openResetMenu(ctx)) dirty = true;
      continue;
    }
  }

  if (dirty) {
    // ctx is stale after reload — dialog is already closed at this point.
    await ctx.reload();
  }
}

async function editScope(ctx: ExtensionCommandContext, scope: ConfigScope): Promise<boolean> {
  const filePath = getConfigPath(scope, ctx.cwd);
  const displayPath = scope === "home" ? homeRelative(filePath) : relative(ctx.cwd, filePath);
  let saved = false;

  while (true) {
    const resolved = await loadConfig(ctx.cwd);
    const current: PiCodexSearchConfig = { ...resolved.sources[scope] };

    const choice = await ctx.ui.select(`Edit ${scope} config (${displayPath})`, [
      `Enabled → ${formatValue(current.enabled?.toString(), String(DEFAULT_ENABLED))}`,
      `Tool name → ${formatValue(current.toolName, DEFAULT_TOOL_NAME)}`,
      `Model → ${formatValue(current.model, "auto")}`,
      `Base URL → ${formatValue(current.baseUrl, "default")}`,
      `Client version → ${formatValue(current.clientVersion, "default")}`,
      `Search context size → ${formatValue(current.searchContextSize, DEFAULT_SEARCH_CONTEXT_SIZE)}`,
      `Freshness → ${formatValue(current.freshness, DEFAULT_FRESHNESS)}`,
      "Back",
    ]);

    if (!choice || choice === "Back") return saved;

    if (choice.startsWith("Enabled")) {
      const value = await ctx.ui.select("Enabled", ["true", "false", "Clear"]);
      if (!value) continue;
      const next = value === "Clear" ? undefined : value === "true";
      if (await applyBooleanField(ctx, scope, current, "enabled", next)) saved = true;
      continue;
    }
    if (choice.startsWith("Tool name")) {
      const value = await ctx.ui.input("Tool name (empty to clear)", current.toolName ?? "");
      if (value === undefined) continue;
      if (await applyTextField(ctx, scope, current, "toolName", value)) saved = true;
      continue;
    }
    if (choice.startsWith("Model")) {
      const value = await ctx.ui.input("Codex model id (empty to clear)", current.model ?? "");
      if (value === undefined) continue;
      if (await applyTextField(ctx, scope, current, "model", value)) saved = true;
      continue;
    }
    if (choice.startsWith("Base URL")) {
      const value = await ctx.ui.input(
        "Codex backend base URL (empty to clear)",
        current.baseUrl ?? "",
      );
      if (value === undefined) continue;
      if (await applyTextField(ctx, scope, current, "baseUrl", value)) saved = true;
      continue;
    }
    if (choice.startsWith("Client version")) {
      const value = await ctx.ui.input(
        "Client version sent to /codex/models (empty to clear)",
        current.clientVersion ?? "",
      );
      if (value === undefined) continue;
      if (await applyTextField(ctx, scope, current, "clientVersion", value)) saved = true;
      continue;
    }
    if (choice.startsWith("Search context size")) {
      const value = await ctx.ui.select("Search context size", ["low", "medium", "high", "Clear"]);
      if (!value) continue;
      const next = value === "Clear" ? undefined : (value as SearchContextSize);
      if (await applyEnumField(ctx, scope, current, "searchContextSize", next)) saved = true;
      continue;
    }
    if (choice.startsWith("Freshness")) {
      const value = await ctx.ui.select("Freshness", ["live", "cached", "Clear"]);
      if (!value) continue;
      const next = value === "Clear" ? undefined : (value as Freshness);
      if (await applyEnumField(ctx, scope, current, "freshness", next)) saved = true;
      continue;
    }
  }
}

async function openResetMenu(ctx: ExtensionCommandContext): Promise<boolean> {
  let removed = false;

  while (true) {
    const choice = await ctx.ui.select("Reset configuration", [
      `Delete project config (${relative(ctx.cwd, getConfigPath("project", ctx.cwd))})`,
      `Delete home config (${homeRelative(getConfigPath("home", ctx.cwd))})`,
      "Back",
    ]);

    if (!choice || choice === "Back") return removed;

    const scope: ConfigScope = choice.startsWith("Delete project") ? "project" : "home";
    const filePath = getConfigPath(scope, ctx.cwd);
    const confirmed = await ctx.ui.confirm("Delete config", `Remove ${filePath}?`);
    if (!confirmed) continue;
    try {
      const deleted = await deleteConfig(scope, ctx.cwd);
      if (deleted) {
        ctx.ui.notify(`Deleted ${filePath}.`);
        removed = true;
      } else {
        ctx.ui.notify(`${filePath} did not exist.`, "warning");
      }
    } catch (error) {
      ctx.ui.notify(`Failed to delete ${filePath}: ${(error as Error).message}`, "error");
    }
  }
}

async function applyTextField(
  ctx: ExtensionCommandContext,
  scope: ConfigScope,
  current: PiCodexSearchConfig,
  key: "toolName" | "model" | "baseUrl" | "clientVersion",
  value: string,
): Promise<boolean> {
  const next: PiCodexSearchConfig = { ...current };
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    delete next[key];
  } else {
    next[key] = trimmed;
  }
  return await persist(ctx, scope, next, key);
}

async function applyEnumField<K extends "searchContextSize" | "freshness">(
  ctx: ExtensionCommandContext,
  scope: ConfigScope,
  current: PiCodexSearchConfig,
  key: K,
  value: PiCodexSearchConfig[K] | undefined,
): Promise<boolean> {
  const next: PiCodexSearchConfig = { ...current };
  if (value === undefined) {
    delete next[key];
  } else {
    next[key] = value;
  }
  return await persist(ctx, scope, next, key);
}

async function applyBooleanField(
  ctx: ExtensionCommandContext,
  scope: ConfigScope,
  current: PiCodexSearchConfig,
  key: "enabled",
  value: boolean | undefined,
): Promise<boolean> {
  const next: PiCodexSearchConfig = { ...current };
  if (value === undefined) {
    delete next[key];
  } else {
    next[key] = value;
  }
  return await persist(ctx, scope, next, key);
}

async function persist(
  ctx: ExtensionCommandContext,
  scope: ConfigScope,
  next: PiCodexSearchConfig,
  field: string,
): Promise<boolean> {
  try {
    const filePath = await saveConfig(scope, ctx.cwd, next);
    ctx.ui.notify(`Saved ${field} to ${filePath}.`);
    return true;
  } catch (error) {
    ctx.ui.notify((error as Error).message, "error");
    return false;
  }
}

async function printStatus(ctx: ExtensionCommandContext): Promise<void> {
  const resolved = await loadConfig(ctx.cwd);
  notify(ctx, formatStatus(resolved, ctx.cwd));
}

function buildMainTitle(resolved: ResolvedConfig, cwd: string): string {
  return [
    "Codex Search settings",
    `Effective: enabled=${resolved.enabled}, tool=${resolved.toolName}, model=${resolved.model ?? "(auto)"}, freshness=${resolved.defaultFreshness}, contextSize=${resolved.defaultSearchContextSize}`,
    `Project file: ${relative(cwd, getConfigPath("project", cwd))}${resolved.sources.project ? "" : " (absent)"}`,
    `Home file: ${homeRelative(getConfigPath("home", cwd))}${resolved.sources.home ? "" : " (absent)"}`,
  ].join("\n");
}

function formatStatus(resolved: ResolvedConfig, cwd: string): string {
  const lines = ["Codex Search settings:"];
  lines.push(`  enabled             = ${resolved.enabled}`);
  lines.push(`  toolName            = ${resolved.toolName}`);
  lines.push(`  model               = ${resolved.model ?? "(auto from /codex/models)"}`);
  lines.push(`  baseUrl             = ${resolved.baseUrl ?? "(default)"}`);
  lines.push(`  clientVersion       = ${resolved.clientVersion ?? "(default)"}`);
  lines.push(`  searchContextSize   = ${resolved.defaultSearchContextSize}`);
  lines.push(`  freshness           = ${resolved.defaultFreshness}`);
  lines.push("");
  lines.push("Sources (env > project > home):");
  lines.push(`  env     = ${describeSource(resolved.sources.env)}`);
  lines.push(
    `  project = ${describeSource(resolved.sources.project)} (${relative(cwd, getConfigPath("project", cwd))})`,
  );
  lines.push(
    `  home    = ${describeSource(resolved.sources.home)} (${homeRelative(getConfigPath("home", cwd))})`,
  );
  return lines.join("\n");
}

function describeSource(config: PiCodexSearchConfig | undefined): string {
  if (!config) return "(none)";
  const keys = Object.keys(config);
  if (keys.length === 0) return "(empty)";
  return keys.sort().join(", ");
}

function formatValue(value: string | undefined, fallback: string): string {
  return value ?? `(default: ${fallback})`;
}

function homeRelative(filePath: string): string {
  const home = process.env.HOME ?? "";
  return home && filePath.startsWith(`${home}/`)
    ? `~/${filePath.slice(home.length + 1)}`
    : filePath;
}

function notify(
  ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">,
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
    return;
  }
  if (level === "error") console.error(message);
  else console.log(message);
}
