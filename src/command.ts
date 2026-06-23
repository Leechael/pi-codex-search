import { relative } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Input,
  type SelectItem,
  SelectList,
  type SettingItem,
  SettingsList,
} from "@earendil-works/pi-tui";
import { type CodexModel, extractAccountIdFromToken, fetchCodexModels } from "./codex.ts";
import {
  type ConfigScope,
  DEFAULT_BATCH_SIZE,
  DEFAULT_ENABLED,
  DEFAULT_FRESHNESS,
  DEFAULT_SEARCH_API,
  DEFAULT_SEARCH_CONTEXT_SIZE,
  DEFAULT_TOOL_NAME,
  deleteConfig,
  getConfigPath,
  loadConfig,
  MAX_BATCH_SIZE,
  MIN_BATCH_SIZE,
  type PiCodexSearchConfig,
  type ResolvedConfig,
  saveConfig,
} from "./config.ts";

const COMMAND_NAME = "codex-search-settings";
const SUBCOMMANDS = ["status", "reset"] as const;
const OPENAI_CODEX_PROVIDER = "openai-codex";

const DEFAULT_SUFFIX = " (default)";
const defaultTag = (value: string): string => `${value}${DEFAULT_SUFFIX}`;
const isDefaultTag = (value: string): boolean => value.endsWith(DEFAULT_SUFFIX);

interface CycleField {
  id: string;
  label: string;
  description: string;
  values: string[];
  get(cfg: PiCodexSearchConfig): string;
  apply(cfg: PiCodexSearchConfig, value: string): void;
}

interface TextField {
  id: string;
  label: string;
  description: string;
  /** Shown (tagged as default) when the field is not set in the active scope. */
  defaultDisplay: string;
  get(cfg: PiCodexSearchConfig): string | undefined;
  apply(cfg: PiCodexSearchConfig, value: string): void;
}

// The default value is shown first as "<value> (default)"; selecting it clears the field.
const CYCLE_FIELDS: CycleField[] = [
  {
    id: "enabled",
    label: "Enabled",
    description: "Register the search tool at session start",
    values: [defaultTag(String(DEFAULT_ENABLED)), "false"],
    get: (c) =>
      c.enabled === undefined || c.enabled === DEFAULT_ENABLED
        ? defaultTag(String(DEFAULT_ENABLED))
        : String(c.enabled),
    apply: (c, v) => {
      if (isDefaultTag(v)) delete c.enabled;
      else c.enabled = v === "true";
    },
  },
  {
    id: "searchApi",
    label: "Search API",
    description: "responses (default, stable) or standalone (experimental) backend",
    values: [defaultTag(DEFAULT_SEARCH_API), "standalone"],
    get: (c) =>
      c.searchApi === undefined || c.searchApi === DEFAULT_SEARCH_API
        ? defaultTag(DEFAULT_SEARCH_API)
        : c.searchApi,
    apply: (c, v) => {
      if (isDefaultTag(v)) delete c.searchApi;
      else c.searchApi = v as PiCodexSearchConfig["searchApi"];
    },
  },
  {
    id: "freshness",
    label: "Freshness",
    description: "live / indexed / cached web access",
    values: [defaultTag(DEFAULT_FRESHNESS), "cached", "indexed"],
    get: (c) =>
      c.freshness === undefined || c.freshness === DEFAULT_FRESHNESS
        ? defaultTag(DEFAULT_FRESHNESS)
        : c.freshness,
    apply: (c, v) => {
      if (isDefaultTag(v)) delete c.freshness;
      else c.freshness = v as PiCodexSearchConfig["freshness"];
    },
  },
  {
    id: "searchContextSize",
    label: "Search context size",
    description: "Amount of web context to retrieve",
    values: [defaultTag(DEFAULT_SEARCH_CONTEXT_SIZE), "low", "high"],
    get: (c) =>
      c.searchContextSize === undefined || c.searchContextSize === DEFAULT_SEARCH_CONTEXT_SIZE
        ? defaultTag(DEFAULT_SEARCH_CONTEXT_SIZE)
        : c.searchContextSize,
    apply: (c, v) => {
      if (isDefaultTag(v)) delete c.searchContextSize;
      else c.searchContextSize = v as PiCodexSearchConfig["searchContextSize"];
    },
  },
];

const TEXT_FIELDS: TextField[] = [
  {
    id: "toolName",
    label: "Tool name",
    description: "Tool name exposed to the LLM",
    defaultDisplay: DEFAULT_TOOL_NAME,
    get: (c) => c.toolName,
    apply: (c, v) => {
      if (v) c.toolName = v;
      else delete c.toolName;
    },
  },
  {
    id: "model",
    label: "Model",
    description: "Pick from models loaded via /codex/models (default = auto-select)",
    defaultDisplay: "auto",
    get: (c) => c.model,
    apply: (c, v) => {
      if (v) c.model = v;
      else delete c.model;
    },
  },
  {
    id: "baseUrl",
    label: "Base URL",
    description: "Codex backend base URL",
    defaultDisplay: "built-in",
    get: (c) => c.baseUrl,
    apply: (c, v) => {
      if (v) c.baseUrl = v;
      else delete c.baseUrl;
    },
  },
  {
    id: "clientVersion",
    label: "Client version",
    description: "Client version sent to /codex/models",
    defaultDisplay: "built-in",
    get: (c) => c.clientVersion,
    apply: (c, v) => {
      if (v) c.clientVersion = v;
      else delete c.clientVersion;
    },
  },
  {
    id: "batchSize",
    label: "Max batch size",
    description: `Max queries per tool call (${MIN_BATCH_SIZE}-${MAX_BATCH_SIZE})`,
    defaultDisplay: String(DEFAULT_BATCH_SIZE),
    get: (c) => (c.batchSize === undefined ? undefined : String(c.batchSize)),
    apply: (c, v) => {
      const trimmed = v.trim();
      if (!trimmed) {
        delete c.batchSize;
        return;
      }
      const parsed = Number(trimmed);
      if (!Number.isInteger(parsed) || parsed < MIN_BATCH_SIZE || parsed > MAX_BATCH_SIZE) {
        throw new Error(
          `Max batch size must be an integer between ${MIN_BATCH_SIZE} and ${MAX_BATCH_SIZE}.`,
        );
      }
      c.batchSize = parsed;
    },
  },
];

function textDisplay(field: TextField, cfg: PiCodexSearchConfig): string {
  return field.get(cfg) ?? defaultTag(field.defaultDisplay);
}

export function registerSettingsCommand(pi: ExtensionAPI): void {
  pi.registerCommand(COMMAND_NAME, {
    description: "Configure pi-codex-search (tool name, model, API, defaults, freshness).",
    getArgumentCompletions(prefix) {
      const lower = prefix.toLowerCase();
      const matches = SUBCOMMANDS.filter((name) => name.startsWith(lower));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      try {
        if (!trimmed) {
          if (ctx.mode === "tui") {
            await openSettingsMenu(ctx);
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
            await openResetMenu(ctx, ctx.isProjectTrusted());
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

async function openSettingsMenu(ctx: ExtensionCommandContext): Promise<void> {
  const isProjectTrusted = ctx.isProjectTrusted();
  const resolved = await loadConfig(ctx.cwd, isProjectTrusted);
  const drafts: Record<ConfigScope, PiCodexSearchConfig> = {
    project: { ...resolved.sources.project },
    home: { ...resolved.sources.home },
  };
  let scope: ConfigScope = isProjectTrusted ? "project" : "home";
  let dirty = false;
  let saveQueue: Promise<void> = Promise.resolve();

  let models: CodexModel[] = [];

  await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
    const settingsTheme = buildSettingsTheme(theme);
    const selectTheme = buildSelectTheme(theme);

    let list: SettingsList;

    const refreshDisplays = () => {
      scopeItem.description = formatScopeDescription(scope, ctx.cwd);
      for (const f of CYCLE_FIELDS) list.updateValue(f.id, f.get(drafts[scope]));
      for (const f of TEXT_FIELDS) list.updateValue(f.id, textDisplay(f, drafts[scope]));
    };

    const save = () => {
      if (scope === "project" && !isProjectTrusted) {
        ctx.ui.notify("Project config cannot be saved until the project is trusted.", "warning");
        return;
      }
      const currentScope = scope;
      const currentDraft = { ...drafts[scope] };
      saveQueue = saveQueue.then(async () => {
        try {
          await saveConfig(currentScope, ctx.cwd, currentDraft);
          dirty = true;
        } catch (error: unknown) {
          ctx.ui.notify((error as Error).message, "error");
        }
      });
    };

    const onChange = (id: string, newValue: string) => {
      if (id === "scope") {
        scope = newValue as ConfigScope;
        refreshDisplays();
        return;
      }
      const cycle = CYCLE_FIELDS.find((f) => f.id === id);
      if (cycle) {
        cycle.apply(drafts[scope], newValue);
        save();
        return;
      }
      const text = TEXT_FIELDS.find((f) => f.id === id);
      if (text) {
        try {
          text.apply(drafts[scope], newValue.trim());
        } catch (error: unknown) {
          ctx.ui.notify((error as Error).message, "error");
          list.updateValue(id, textDisplay(text, drafts[scope]));
          return;
        }
        list.updateValue(id, textDisplay(text, drafts[scope]));
        save();
      }
    };

    const scopeItem: SettingItem = {
      id: "scope",
      label: "Config scope",
      description: isProjectTrusted
        ? formatScopeDescription(scope, ctx.cwd)
        : "Project config disabled until the project is trusted; editing home config only",
      currentValue: scope,
      values: isProjectTrusted ? ["project", "home"] : ["home"],
    };

    const items: SettingItem[] = [
      scopeItem,
      ...CYCLE_FIELDS.map(
        (f): SettingItem => ({
          id: f.id,
          label: f.label,
          description: f.description,
          currentValue: f.get(drafts[scope]),
          values: f.values,
        }),
      ),
      ...TEXT_FIELDS.map(
        (f): SettingItem => ({
          id: f.id,
          label: f.label,
          description: f.description,
          currentValue: textDisplay(f, drafts[scope]),
          submenu:
            f.id === "model"
              ? (_current, submenuDone) =>
                  buildModelSelect(models, drafts[scope].model, selectTheme, submenuDone)
              : (_current, submenuDone) => {
                  const input = new Input();
                  input.setValue(f.get(drafts[scope]) ?? "");
                  input.onSubmit = (value) => submenuDone(value);
                  input.onEscape = () => submenuDone();
                  return input;
                },
        }),
      ),
    ];

    const modelItem = items.find((i) => i.id === "model");
    if (modelItem) modelItem.description = "Loading models via /codex/models…";

    loadModels(ctx, resolved)
      .then((loaded) => {
        models = loaded;
        if (modelItem) {
          modelItem.description =
            loaded.length === 0
              ? "No models loaded from /codex/models (default = auto-select)"
              : `Pick from ${loaded.length} model${loaded.length === 1 ? "" : "s"} loaded via /codex/models (default = auto-select)`;
        }
        list.invalidate();
      })
      .catch((error: unknown) => {
        if (modelItem) {
          modelItem.description =
            "Could not load models from /codex/models (default = auto-select)";
        }
        list.invalidate();
        ctx.ui.notify(`Could not load model list: ${(error as Error).message}`, "warning");
      });

    list = new SettingsList(items, items.length, settingsTheme, onChange, () => done(), {
      enableSearch: true,
    });
    return list as Component;
  });

  await saveQueue;
  if (dirty) await ctx.reload();
}

function buildSettingsTheme(theme: Theme) {
  return {
    label: (text: string, selected: boolean) => (selected ? theme.fg("accent", text) : text),
    value: (text: string, selected: boolean) =>
      selected ? theme.bold(theme.fg("accent", text)) : theme.fg("muted", text),
    description: (text: string) => theme.fg("dim", text),
    cursor: theme.fg("accent", "> "),
    hint: (text: string) => theme.fg("dim", text),
  };
}

function buildSelectTheme(theme: Theme) {
  return {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.bold(theme.fg("accent", text)),
    description: (text: string) => theme.fg("dim", text),
    scrollInfo: (text: string) => theme.fg("dim", text),
    noMatch: (text: string) => theme.fg("warning", text),
  };
}

function buildModelSelect(
  models: CodexModel[],
  current: string | undefined,
  theme: ReturnType<typeof buildSelectTheme>,
  done: (value?: string) => void,
): Component {
  const items: SelectItem[] = [
    { value: "", label: defaultTag("auto"), description: "Auto-select from /codex/models" },
    ...models.map((m): SelectItem => ({ value: m.id, label: m.id, description: m.name })),
  ];
  const select = new SelectList(items, Math.min(items.length, 10), theme);
  const currentIndex = items.findIndex((i) => i.value === (current ?? ""));
  if (currentIndex >= 0) select.setSelectedIndex(currentIndex);
  select.onSelect = (item) => done(item.value);
  select.onCancel = () => done();
  return select;
}

async function loadModels(
  ctx: ExtensionCommandContext,
  resolved: ResolvedConfig,
): Promise<CodexModel[]> {
  const token = await ctx.modelRegistry.getApiKeyForProvider(OPENAI_CODEX_PROVIDER);
  if (!token) return [];
  const credential = ctx.modelRegistry.authStorage.get(OPENAI_CODEX_PROVIDER);
  const accountId =
    credential?.type === "oauth" && typeof credential.accountId === "string"
      ? credential.accountId
      : extractAccountIdFromToken(token);
  if (!accountId) return [];

  const opts: Parameters<typeof fetchCodexModels>[0] = { token, accountId };
  if (resolved.baseUrl !== undefined) opts.baseUrl = resolved.baseUrl;
  if (resolved.clientVersion !== undefined) opts.clientVersion = resolved.clientVersion;
  return fetchCodexModels(opts);
}

async function openResetMenu(
  ctx: ExtensionCommandContext,
  isProjectTrusted: boolean,
): Promise<boolean> {
  let removed = false;

  while (true) {
    const options = [
      ...(isProjectTrusted
        ? [`Delete project config (${relative(ctx.cwd, getConfigPath("project", ctx.cwd))})`]
        : []),
      `Delete home config (${homeRelative(getConfigPath("home", ctx.cwd))})`,
      "Back",
    ];
    const choice = await ctx.ui.select("Reset configuration", options);

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

async function printStatus(ctx: ExtensionCommandContext): Promise<void> {
  const resolved = await loadConfig(ctx.cwd, ctx.isProjectTrusted());
  notify(ctx, formatStatus(resolved, ctx.cwd));
}

export function formatStatus(resolved: ResolvedConfig, cwd: string): string {
  const lines = ["Codex Search settings:"];
  lines.push(`  enabled             = ${resolved.enabled}`);
  lines.push(`  toolName            = ${resolved.toolName}`);
  lines.push(`  model               = ${resolved.model ?? "(auto from /codex/models)"}`);
  lines.push(`  baseUrl             = ${resolved.baseUrl ?? "(default)"}`);
  lines.push(`  clientVersion       = ${resolved.clientVersion ?? "(default)"}`);
  lines.push(`  searchContextSize   = ${resolved.defaultSearchContextSize}`);
  lines.push(`  freshness           = ${resolved.defaultFreshness}`);
  lines.push(
    `  searchApi           = ${resolved.searchApi}${resolved.searchApi === "standalone" ? " (experimental)" : ""}`,
  );
  lines.push(`  maxBatchSize        = ${resolved.batchSize}`);
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

function formatScopeDescription(scope: ConfigScope, cwd: string): string {
  const filePath = getConfigPath(scope, cwd);
  const displayPath = scope === "home" ? homeRelative(filePath) : relative(cwd, filePath);
  return `Writes to the ${scope} config file: ${displayPath}`;
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
