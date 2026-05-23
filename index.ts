import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  classifyError,
  type CodexCitation,
  type CodexErrorKind,
  type CodexSearchCall,
  extractAccountIdFromToken,
  fetchCodexModels,
  fetchCodexWebSearch,
  selectDefaultModel,
  type SearchContextSize,
} from "./src/codex.ts";
import { registerSettingsCommand } from "./src/command.ts";
import { type Freshness, loadConfig, type ResolvedConfig } from "./src/config.ts";

const OPENAI_CODEX_PROVIDER = "openai-codex";
const MAX_QUERIES = 5;

interface QuerySuccess {
  query: string;
  text: string;
  citations: CodexCitation[];
  searchCalls: CodexSearchCall[];
  responseId?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

interface QueryFailure {
  query: string;
  kind: CodexErrorKind;
  message: string;
}

interface WebSearchFailureDetail {
  kind: CodexErrorKind;
  message: string;
}

interface WebSearchDetails {
  model: string;
  freshness: Freshness;
  searchContextSize: SearchContextSize;
  queryCount: number;
  failedQueryCount: number;
  successes: QuerySuccess[];
  failures: QueryFailure[];
  failure?: WebSearchFailureDetail;
  partial?: boolean;
  completed?: number;
  total?: number;
}

function buildTool(config: ResolvedConfig) {
  return defineTool({
    name: config.toolName,
    label: "Codex Search",
    description:
      "Search the web using the user's configured ChatGPT Codex subscription. Accepts one or more queries in a single call; results are returned grouped by query with sources.",
    promptSnippet: `${config.toolName}: search the web using the configured ChatGPT Codex subscription.`,
    promptGuidelines: [
      `Use ${config.toolName} when current or source-backed information is needed.`,
      `Batch up to ${MAX_QUERIES} related queries in one call when grouped comparison matters; use separate calls when independent results unblock the next step.`,
      "Do not ask the user for an access token; the tool uses pi's configured OpenAI Codex subscription.",
    ],
    parameters: Type.Object({
      queries: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        maxItems: MAX_QUERIES,
        description: `One or more search queries to run in parallel (max ${MAX_QUERIES}).`,
      }),
      search_context_size: Type.Optional(
        StringEnum(["low", "medium", "high"] as const, {
          description: `Amount of web context to retrieve. Defaults to ${config.defaultSearchContextSize}.`,
        }),
      ),
      freshness: Type.Optional(
        StringEnum(["cached", "live"] as const, {
          description: `Use 'live' for time-sensitive queries; 'cached' for stable topics. Defaults to ${config.defaultFreshness}.`,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const queries = params.queries.map((q) => q.trim()).filter((q) => q.length > 0);
      if (queries.length === 0) {
        throw new Error("queries must contain at least one non-empty entry");
      }

      const token = await ctx.modelRegistry.getApiKeyForProvider(OPENAI_CODEX_PROVIDER);
      if (!token) {
        const err = new Error(
          "OpenAI Codex subscription is not configured. Run `/login openai-codex` and choose ChatGPT Plus/Pro.",
        );
        (err as Error & { kind?: CodexErrorKind }).kind = "auth";
        throw err;
      }

      const accountId = getConfiguredAccountId(ctx, token);
      if (!accountId) {
        const err = new Error(
          "OpenAI Codex account id was not found in stored credentials or access token. Re-run `/login openai-codex`.",
        );
        (err as Error & { kind?: CodexErrorKind }).kind = "auth";
        throw err;
      }

      const model = await resolveSearchModel(ctx, token, accountId, config, signal);
      const freshness = params.freshness ?? config.defaultFreshness;
      const searchContextSize = params.search_context_size ?? config.defaultSearchContextSize;

      const total = queries.length;
      let completed = 0;
      let streamedText = "";

      const emitPartial = (partialText: string) => {
        onUpdate?.({
          content: [{ type: "text", text: partialText }],
          details: {
            model,
            freshness,
            searchContextSize,
            queryCount: total,
            failedQueryCount: 0,
            successes: [],
            failures: [],
            partial: true,
            completed,
            total,
          } satisfies WebSearchDetails,
        });
      };

      if (total > 1) emitPartial(formatProgress(completed, total));

      const settled = await Promise.allSettled(
        queries.map(async (query) => {
          const onTextDelta =
            total === 1
              ? (delta: string) => {
                  streamedText += delta;
                  emitPartial(streamedText);
                }
              : undefined;
          const fetchOpts: Parameters<typeof fetchCodexWebSearch>[0] = {
            query,
            token,
            accountId,
            model,
            externalWebAccess: freshness === "live",
            searchContextSize,
          };
          if (config.baseUrl !== undefined) fetchOpts.baseUrl = config.baseUrl;
          if (signal) fetchOpts.signal = signal;
          if (onTextDelta) fetchOpts.onTextDelta = onTextDelta;

          try {
            return await fetchCodexWebSearch(fetchOpts);
          } finally {
            completed += 1;
            if (total > 1) emitPartial(formatProgress(completed, total));
          }
        }),
      );

      const successes: QuerySuccess[] = [];
      const failures: QueryFailure[] = [];

      settled.forEach((outcome, index) => {
        const query = queries[index] ?? "";
        if (outcome.status === "fulfilled") {
          const success: QuerySuccess = {
            query,
            text: outcome.value.text,
            citations: outcome.value.citations,
            searchCalls: outcome.value.searchCalls,
          };
          if (outcome.value.responseId !== undefined) success.responseId = outcome.value.responseId;
          if (outcome.value.usage !== undefined) success.usage = outcome.value.usage;
          successes.push(success);
        } else {
          const kind = classifyError(outcome.reason);
          const message =
            outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
          failures.push({ query, kind, message });
        }
      });

      if (successes.length === 0) {
        const primary = failures[0];
        const summary =
          failures.length === 1
            ? (primary?.message ?? "Codex web search failed")
            : `All ${failures.length} ${config.toolName} queries failed: ${failures
                .map((f, i) => `${i + 1}. [${f.kind}] ${f.message}`)
                .join("; ")}`;
        const err = new Error(summary) as Error & {
          kind?: CodexErrorKind;
          failures?: QueryFailure[];
        };
        err.kind = primary?.kind ?? "unknown";
        err.failures = failures;
        throw err;
      }

      return {
        content: [{ type: "text", text: formatToolText(successes, failures) }],
        details: {
          model,
          freshness,
          searchContextSize,
          queryCount: total,
          failedQueryCount: failures.length,
          successes,
          failures,
        } satisfies WebSearchDetails,
      };
    },

    renderCall(args, theme) {
      const queries = Array.isArray(args.queries) ? args.queries : [];
      const fresh = (args.freshness as string | undefined) ?? config.defaultFreshness;
      const ctxSize =
        (args.search_context_size as string | undefined) ?? config.defaultSearchContextSize;

      let text = theme.fg("toolTitle", theme.bold(`${config.toolName} `));
      if (queries.length === 1) {
        text += theme.fg("accent", formatInline(queries[0] ?? "", 90));
      } else {
        text += theme.fg("accent", `${queries.length} queries`);
      }
      text += theme.fg("dim", ` [${ctxSize}/${fresh}]`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as WebSearchDetails | undefined;

      if (isPartial) {
        return new Text(renderPartial(details, theme), 0, 0);
      }

      if (!details) {
        const content = result.content.find((part) => part.type === "text");
        const text = content?.type === "text" ? content.text : "";
        return new Text(text || theme.fg("success", "✓ Web search finished"), 0, 0);
      }

      const total = details.queryCount;
      const failed = details.failedQueryCount;
      const ok = total - failed;
      const sourceCount = details.successes.reduce((acc, s) => acc + s.citations.length, 0);

      let header: string;
      if (ok === 0) {
        header = theme.fg("warning", `⚠ Web search failed (${details.failure?.kind ?? "unknown"})`);
      } else if (failed > 0) {
        header = theme.fg(
          "warning",
          `⚠ ${ok}/${total} queries succeeded · ${sourceCount} source${sourceCount === 1 ? "" : "s"}`,
        );
      } else {
        const querySuffix = total === 1 ? "" : ` across ${total} queries`;
        header = theme.fg(
          "success",
          `✓ ${sourceCount} source${sourceCount === 1 ? "" : "s"}${querySuffix}`,
        );
      }
      header += theme.fg("muted", ` [${details.searchContextSize}/${details.freshness}]`);

      if (!expanded) {
        const preview = renderCollapsedPreview(details, theme);
        return new Text(preview ? `${header}\n${preview}` : header, 0, 0);
      }

      const content = result.content.find((part) => part.type === "text");
      const body = content?.type === "text" ? content.text : "";

      let text = header;
      text += `\n${theme.fg("muted", `Model: ${details.model}`)}`;
      if (failed > 0) {
        text += `\n${theme.fg("warning", `Failures (${failed}):`)}`;
        for (const [i, f] of details.failures.entries()) {
          text += `\n${theme.fg("dim", `  ${i + 1}. [${f.kind}] ${formatInline(f.query, 60)} — ${formatInline(f.message, 100)}`)}`;
        }
      }
      if (body) {
        text += `\n\n${body
          .split("\n")
          .map((line) => theme.fg("toolOutput", line))
          .join("\n")}`;
      }
      return new Text(text, 0, 0);
    },
  });
}

export default function codexWebSearchExtension(pi: ExtensionAPI) {
  registerSettingsCommand(pi);

  pi.on("session_start", async (_event, ctx) => {
    const config = await loadConfig(ctx.cwd);
    if (!config.enabled) return;
    pi.registerTool(buildTool(config));
  });
}

function getConfiguredAccountId(ctx: ExtensionContext, token: string): string | undefined {
  const credential = ctx.modelRegistry.authStorage.get(OPENAI_CODEX_PROVIDER);
  if (credential?.type === "oauth" && typeof credential.accountId === "string") {
    return credential.accountId;
  }
  return extractAccountIdFromToken(token);
}

async function resolveSearchModel(
  ctx: ExtensionContext,
  token: string,
  accountId: string,
  config: ResolvedConfig,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (config.model) return config.model;
  if (ctx.model?.provider === OPENAI_CODEX_PROVIDER) return ctx.model.id;

  const fetchOpts: Parameters<typeof fetchCodexModels>[0] = {
    token,
    accountId,
  };
  if (config.baseUrl !== undefined) fetchOpts.baseUrl = config.baseUrl;
  if (config.clientVersion !== undefined) fetchOpts.clientVersion = config.clientVersion;
  if (signal) fetchOpts.signal = signal;

  const models = await fetchCodexModels(fetchOpts);
  const model = selectDefaultModel(models);
  if (!model) {
    throw new Error("Codex model list is empty.");
  }
  return model;
}

function formatProgress(completed: number, total: number): string {
  return `Searching ${completed}/${total} ${completed === total ? "complete" : "in progress"}`;
}

function formatToolText(successes: QuerySuccess[], failures: QueryFailure[]): string {
  const blocks: string[] = [];
  const total = successes.length + failures.length;
  const multiple = total > 1;

  for (const success of successes) {
    blocks.push(formatSuccessBlock(success, multiple));
  }
  for (const failure of failures) {
    blocks.push(formatFailureBlock(failure, multiple));
  }

  return blocks.join("\n\n");
}

function formatSuccessBlock(success: QuerySuccess, multiple: boolean): string {
  const text = success.text || "(no response text)";
  const sourceLines = success.citations.map((citation, index) => {
    const title = citation.title?.trim() || citation.url;
    return `${index + 1}. ${title}: ${citation.url}`;
  });
  const body = sourceLines.length > 0 ? `${text}\n\nSources:\n${sourceLines.join("\n")}` : text;
  return multiple ? `## Query: ${success.query}\n\n${body}` : body;
}

function formatFailureBlock(failure: QueryFailure, multiple: boolean): string {
  const body = `[${failure.kind}] ${failure.message}`;
  return multiple ? `## Query: ${failure.query}\n\nFAILED: ${body}` : `FAILED: ${body}`;
}

function renderPartial(details: WebSearchDetails | undefined, theme: Theme): string {
  if (!details) return theme.fg("warning", "Searching the web…");
  const completed = details.completed ?? 0;
  const total = details.total ?? details.queryCount;
  const header = theme.fg("warning", `Searching ${completed}/${total}`);
  const trailingDot = completed < total ? theme.fg("dim", " …") : theme.fg("dim", " (finalizing)");
  return header + trailingDot;
}

function renderCollapsedPreview(details: WebSearchDetails, theme: Theme): string {
  const firstSuccess = details.successes[0];
  if (firstSuccess) {
    const snippet = formatInline(firstSuccess.text, 110);
    if (snippet) return theme.fg("dim", snippet);
  }
  const firstFailure = details.failures[0];
  if (firstFailure) {
    return theme.fg("dim", formatInline(firstFailure.message, 110));
  }
  return "";
}

function formatInline(value: unknown, maxLength = 90): string {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
