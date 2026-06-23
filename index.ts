import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import type { Static } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import {
  classifyError,
  CodexError,
  createRefStore,
  createTransport,
  extractAccountIdFromToken,
  fetchCodexModels,
  runResponsesSearch,
  runStandaloneCommands,
  selectDefaultModel,
  type CodexCitation,
  type CodexErrorKind,
  type CodexSearchCall,
  type SearchContextSize,
  type StandaloneCommandsOptions,
} from "./src/codex.ts";
import { registerSettingsCommand } from "./src/command.ts";
import { type Freshness, loadConfig, type ResolvedConfig } from "./src/config.ts";

const OPENAI_CODEX_PROVIDER = "openai-codex";

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

interface StandaloneCallPlan {
  query: string;
  options: StandaloneCommandsOptions;
  openedUrl?: string;
}

interface WebSearchFailureDetail {
  kind: CodexErrorKind;
  message: string;
}

interface WebSearchDetails {
  model: string;
  api: string;
  freshness: Freshness;
  searchContextSize: SearchContextSize;
  queryCount: number;
  queries: string[];
  failedQueryCount: number;
  successes: QuerySuccess[];
  failures: QueryFailure[];
  failure?: WebSearchFailureDetail;
  partial?: boolean;
  completed?: number;
  total?: number;
}

function buildToolDescription(config: ResolvedConfig): string {
  const toolName = config.toolName;
  if (config.searchApi === "standalone") {
    return `${toolName}: search the web, open/fetch webpages, and look up live information (finance, weather, sports, time, images) using the configured ChatGPT Codex subscription.`;
  }
  return `${toolName}: search the web using the configured ChatGPT Codex subscription. Web content lookup requires switching searchApi to "standalone" in settings.`;
}

function buildSearchParametersSchema(config: ResolvedConfig) {
  return Type.Object({
    queries: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: config.batchSize,
      description: `One or more search queries to run in parallel (max ${config.batchSize}).`,
    }),
    search_context_size: Type.Optional(
      StringEnum(["low", "medium", "high"] as const, {
        description: "Amount of web context to retrieve. Defaults to medium.",
      }),
    ),
    freshness: Type.Optional(
      StringEnum(["cached", "indexed", "live"] as const, {
        description:
          "Use 'live' for time-sensitive queries; 'indexed' for OpenAI-indexed web access; 'cached' for stable topics. Defaults to live.",
      }),
    ),
  });
}

const StandaloneParametersSchema = Type.Object({
  queries: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      maxItems: 4,
      description:
        "One or more search queries. Standalone mode sends each query as a separate Codex request.",
    }),
  ),
  search_context_size: Type.Optional(
    StringEnum(["low", "medium", "high"] as const, {
      description: "Amount of web context to retrieve. Defaults to medium.",
    }),
  ),
  freshness: Type.Optional(
    StringEnum(["cached", "indexed", "live"] as const, {
      description:
        "Use 'live' for time-sensitive queries; 'indexed' for OpenAI-indexed web access; 'cached' for stable topics. Defaults to live.",
    }),
  ),
  urls: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      description: "URLs to open/fetch directly.",
    }),
  ),
  find: Type.Optional(
    Type.Array(
      Type.Object({
        url: Type.String({ minLength: 1 }),
        pattern: Type.String({ minLength: 1 }),
      }),
      { description: "Find a pattern within a webpage." },
    ),
  ),
  click: Type.Optional(
    Type.Array(
      Type.Object({
        url: Type.String({ minLength: 1 }),
        id: Type.Integer({ minimum: 0 }),
      }),
      { description: "Follow a link id from a previously opened page." },
    ),
  ),
  screenshot: Type.Optional(
    Type.Array(
      Type.Object({
        url: Type.String({ minLength: 1 }),
        pageno: Type.Integer({ minimum: 0 }),
      }),
      { description: "Capture a screenshot of a previously opened page." },
    ),
  ),
  finance: Type.Optional(
    Type.Array(
      Type.Object({
        ticker: Type.String({ minLength: 1 }),
        type: StringEnum(["equity", "fund", "crypto", "index"] as const),
        market: Type.Optional(Type.String()),
      }),
      { description: "Look up stock/ETF/crypto/index prices." },
    ),
  ),
  weather: Type.Optional(
    Type.Array(
      Type.Object({
        location: Type.String({ minLength: 1 }),
        start: Type.Optional(Type.String()),
        duration: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
      { description: "Look up weather forecasts." },
    ),
  ),
  sports: Type.Optional(
    Type.Array(
      Type.Object({
        fn: StringEnum(["schedule", "standings"] as const),
        league: StringEnum([
          "nba",
          "wnba",
          "nfl",
          "nhl",
          "mlb",
          "epl",
          "ncaamb",
          "ncaawb",
          "ipl",
        ] as const),
        team: Type.Optional(Type.String()),
        opponent: Type.Optional(Type.String()),
        date_from: Type.Optional(Type.String()),
        date_to: Type.Optional(Type.String()),
        num_games: Type.Optional(Type.Integer({ minimum: 0 })),
        locale: Type.Optional(Type.String()),
      }),
      { description: "Look up sports schedules and standings." },
    ),
  ),
  time: Type.Optional(
    Type.Array(
      Type.Object({
        utc_offset: Type.String({ minLength: 1 }),
      }),
      { description: "Get time for UTC offsets." },
    ),
  ),
  image_queries: Type.Optional(
    Type.Array(Type.String({ minLength: 1 }), {
      description: "Image search queries.",
    }),
  ),
});

type StandaloneParameters = Static<typeof StandaloneParametersSchema>;

type ToolParameters = Partial<StandaloneParameters> & {
  queries?: string[];
  search_context_size?: SearchContextSize;
  freshness?: Freshness;
};

function buildToolParameters(config: ResolvedConfig) {
  return config.searchApi === "standalone"
    ? StandaloneParametersSchema
    : buildSearchParametersSchema(config);
}

function buildTool(config: ResolvedConfig) {
  return defineTool({
    name: config.toolName,
    label: "Codex Search",
    description: buildToolDescription(config),
    promptSnippet:
      config.searchApi === "standalone"
        ? `${config.toolName}: search the web, open/fetch webpages, find text in pages, follow page link ids, take screenshots, and look up finance/weather/sports/time using the configured ChatGPT Codex subscription.`
        : `${config.toolName}: search the web using the configured ChatGPT Codex subscription.`,
    promptGuidelines: [
      `Use ${config.toolName} when current or source-backed information is needed.`,
      config.searchApi === "standalone"
        ? "Standalone mode can search, open/fetch URLs, find text within opened pages, click link ids, take screenshots, and run finance/weather/sports/time lookups. Send each action serially as a separate Codex request; do not batch standalone actions into one backend call."
        : `Batch up to ${config.batchSize} related queries in one call when grouped comparison matters; use separate calls when independent results unblock the next step.`,
      config.searchApi === "standalone"
        ? "When the user asks to read or inspect a webpage, use urls/open plus follow-up find/click/screenshot actions instead of shelling out to curl."
        : "Webpage open/fetch actions require searchApi=standalone; responses mode supports search queries only.",
      "Choose freshness per request: use 'live' for news, prices, releases, availability, laws, schedules, or other time-sensitive facts; use 'cached' for stable facts and docs; use 'indexed' when OpenAI-indexed web access is enough but live browsing is not needed.",
      "Do not ask the user for an access token; the tool uses pi's configured OpenAI Codex subscription.",
    ],
    parameters: buildToolParameters(config),

    async execute(_toolCallId, params: ToolParameters, signal, onUpdate, ctx) {
      const queries = params.queries?.map((q) => q.trim()).filter((q) => q.length > 0) ?? [];
      const imageQueries =
        params.image_queries?.map((q) => q.trim()).filter((q) => q.length > 0) ?? [];
      const urls = params.urls?.map((u) => u.trim()).filter((u) => u.length > 0) ?? [];
      const findCommands = params.find?.filter((c) => c.url.trim() && c.pattern.trim()) ?? [];
      const clickCommands = params.click?.filter((c) => c.url.trim()) ?? [];
      const screenshotCommands = params.screenshot?.filter((c) => c.url.trim()) ?? [];
      const financeCommands = params.finance ?? [];
      const weatherCommands = params.weather ?? [];
      const sportsCommands = params.sports ?? [];
      const timeCommands = params.time?.map((c) => ({ utc_offset: c.utc_offset })) ?? [];
      if (
        queries.length === 0 &&
        imageQueries.length === 0 &&
        urls.length === 0 &&
        findCommands.length === 0 &&
        clickCommands.length === 0 &&
        screenshotCommands.length === 0 &&
        financeCommands.length === 0 &&
        weatherCommands.length === 0 &&
        sportsCommands.length === 0 &&
        timeCommands.length === 0
      ) {
        throw new CodexError(
          "schema",
          "At least one query, url, image query, or lookup command is required",
        );
      }

      const token = await ctx.modelRegistry.getApiKeyForProvider(OPENAI_CODEX_PROVIDER);
      if (!token) {
        const err = new CodexError(
          "auth",
          "OpenAI Codex subscription is not configured. Run `/login openai-codex` and choose ChatGPT Plus/Pro.",
        );
        throw err;
      }

      const accountId = getConfiguredAccountId(ctx, token);
      if (!accountId) {
        throw new CodexError(
          "auth",
          "OpenAI Codex account id was not found in stored credentials or access token. Re-run `/login openai-codex`.",
        );
      }

      const model = await resolveSearchModel(ctx, token, accountId, config, signal);
      const freshness = params.freshness ?? config.defaultFreshness;
      const searchContextSize = params.search_context_size ?? config.defaultSearchContextSize;

      const transport = createTransport({
        token,
        accountId,
        baseUrl: config.baseUrl,
      });

      if (config.searchApi === "standalone") {
        const refStore = createRefStore();
        const sessionDir = ctx.sessionManager.getSessionDir();
        await refStore.load(sessionDir);

        const resolvedUrls = await Promise.all(
          urls.map(async (url) => {
            const refId = refStore.resolveRefId(url) ?? url;
            return { url, refId };
          }),
        );
        const resolvedFind = await Promise.all(
          findCommands.map(async (c: { url: string; pattern: string }) => {
            const refId = refStore.resolveRefId(c.url) ?? c.url;
            return { url: c.url, refId, pattern: c.pattern };
          }),
        );
        const resolvedClick = await Promise.all(
          clickCommands.map(async (c: { url: string; id: number }) => {
            const refId = refStore.resolveRefId(c.url) ?? c.url;
            return { url: c.url, refId, id: c.id };
          }),
        );
        const resolvedScreenshot = await Promise.all(
          screenshotCommands.map(async (c: { url: string; pageno: number }) => {
            const refId = refStore.resolveRefId(c.url) ?? c.url;
            return { url: c.url, refId, pageno: c.pageno };
          }),
        );

        const baseStandaloneOptions = {
          model,
          transport,
          sessionId: ctx.sessionManager.getSessionId(),
          freshness,
          searchContextSize,
          maxOutputTokens: 8000,
          signal,
        };
        const standaloneCalls: StandaloneCallPlan[] = [
          ...queries.map((q) => ({
            query: q,
            options: { ...baseStandaloneOptions, searchQuery: [{ q }] },
          })),
          ...imageQueries.map((q) => ({
            query: `image: ${q}`,
            options: { ...baseStandaloneOptions, imageQuery: [{ q }] },
          })),
          ...resolvedUrls.map((u) => ({
            query: `open: ${u.url}`,
            openedUrl: u.url,
            options: { ...baseStandaloneOptions, open: [{ refId: u.refId }] },
          })),
          ...resolvedFind.map((c) => ({
            query: `find "${c.pattern}" in ${c.url}`,
            options: { ...baseStandaloneOptions, find: [{ refId: c.refId, pattern: c.pattern }] },
          })),
          ...resolvedClick.map((c) => ({
            query: `click ${c.id} in ${c.url}`,
            options: { ...baseStandaloneOptions, click: [{ refId: c.refId, id: c.id }] },
          })),
          ...resolvedScreenshot.map((c) => ({
            query: `screenshot ${c.pageno} of ${c.url}`,
            options: {
              ...baseStandaloneOptions,
              screenshot: [{ refId: c.refId, pageno: c.pageno }],
            },
          })),
          ...financeCommands.map((c) => ({
            query: `finance: ${c.ticker}`,
            options: { ...baseStandaloneOptions, finance: [c] },
          })),
          ...weatherCommands.map((c) => ({
            query: `weather: ${c.location}`,
            options: { ...baseStandaloneOptions, weather: [c] },
          })),
          ...sportsCommands.map((c) => ({
            query: `sports: ${c.fn} ${c.league}${c.team ? ` ${c.team}` : ""}`,
            options: { ...baseStandaloneOptions, sports: [c] },
          })),
          ...timeCommands.map((c) => ({
            query: `time: ${c.utc_offset}`,
            options: { ...baseStandaloneOptions, time: [c] },
          })),
        ];

        const total = standaloneCalls.length;
        let completed = 0;
        const emitPartial = (partialText: string) => {
          onUpdate?.({
            content: [{ type: "text", text: partialText }],
            details: buildDetails(config, model, freshness, searchContextSize, [], [], {
              partial: true,
              completed,
              total,
            }),
          });
        };
        if (total > 1) emitPartial(formatProgress(completed, total));

        const successes: QuerySuccess[] = [];
        const failures: QueryFailure[] = [];
        for (const call of standaloneCalls) {
          try {
            const result = await runStandaloneCommands(call.options);
            if (call.openedUrl) {
              const refId = Object.keys(result.refIds ?? {}).find((candidate) =>
                /\bturn\d+fetch\d+\b/.test(candidate),
              );
              if (refId) await refStore.remember(call.openedUrl, refId);
            }
            const success: QuerySuccess = {
              query: call.query,
              text: result.text,
              citations: result.citations,
              searchCalls: result.searchCalls,
            };
            if (result.usage) success.usage = result.usage;
            successes.push(success);
          } catch (error) {
            const kind = classifyError(error);
            const message = error instanceof Error ? error.message : String(error);
            failures.push({ query: call.query, kind, message });
          } finally {
            completed += 1;
            if (total > 1) emitPartial(formatProgress(completed, total));
          }
        }

        if (successes.length === 0) {
          const primary = failures[0];
          const summary =
            failures.length === 1
              ? (primary?.message ?? "Codex standalone request failed")
              : `All ${failures.length} ${config.toolName} standalone actions failed: ${failures
                  .map((f, i) => `${i + 1}. [${f.kind}] ${f.message}`)
                  .join("; ")}`;
          const err = new CodexError(primary?.kind ?? "unknown", summary) as CodexError & {
            failures?: QueryFailure[];
          };
          err.failures = failures;
          throw err;
        }

        return {
          content: [{ type: "text", text: formatToolText(successes, failures) }],
          details: buildDetails(config, model, freshness, searchContextSize, successes, failures),
        };
      }

      // Responses API path: only search queries are supported.
      if (
        urls.length > 0 ||
        findCommands.length > 0 ||
        clickCommands.length > 0 ||
        screenshotCommands.length > 0 ||
        imageQueries.length > 0 ||
        financeCommands.length > 0 ||
        weatherCommands.length > 0 ||
        sportsCommands.length > 0 ||
        timeCommands.length > 0
      ) {
        throw new CodexError(
          "schema",
          `Open webpage, image search, and domain lookups require searchApi="standalone". Current mode is "responses".`,
        );
      }

      const total = queries.length;
      let completed = 0;
      let streamedText = "";

      const emitPartial = (partialText: string) => {
        onUpdate?.({
          content: [{ type: "text", text: partialText }],
          details: buildDetails(config, model, freshness, searchContextSize, [], [], {
            partial: true,
            completed,
            total,
          }),
        });
      };

      if (total > 1) emitPartial(formatProgress(completed, total));

      const settled = await Promise.allSettled(
        queries.map(async (query: string) => {
          const onTextDelta =
            total === 1
              ? (delta: string) => {
                  streamedText += delta;
                  emitPartial(streamedText);
                }
              : undefined;
          try {
            return await runResponsesSearch({
              query,
              model,
              transport,
              externalWebAccess: freshness !== "cached",
              indexGatedWebAccess: freshness === "indexed" ? true : undefined,
              searchContextSize,
              sessionId: ctx.sessionManager.getSessionId(),
              threadId: ctx.sessionManager.getSessionId(),
              signal,
              onTextDelta,
            });
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
          const reason = outcome.reason;
          const kind = classifyError(reason);
          const message = reason instanceof Error ? reason.message : String(reason);
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
        const err = new CodexError(primary?.kind ?? "unknown", summary) as CodexError & {
          failures?: QueryFailure[];
        };
        err.failures = failures;
        throw err;
      }

      return {
        content: [{ type: "text", text: formatToolText(successes, failures) }],
        details: buildDetails(config, model, freshness, searchContextSize, successes, failures),
      };
    },

    renderCall(args, theme) {
      const fresh = (args.freshness as string | undefined) ?? config.defaultFreshness;
      const ctxSize =
        (args.search_context_size as string | undefined) ?? config.defaultSearchContextSize;
      const labels = buildCallLabels(args);

      let text = theme.fg("toolTitle", theme.bold(config.toolName));
      if (labels.length === 1) {
        text += ` ${theme.fg("accent", formatInline(labels[0] ?? "", 90))}`;
      } else {
        text += ` ${theme.fg("accent", `${labels.length} actions`)}`;
      }
      text += theme.fg("dim", ` [${config.searchApi}/${ctxSize}/${fresh}]`);
      if (labels.length > 1) {
        text += `\n${renderCallQueries(labels, theme)}`;
      }
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
      header += theme.fg(
        "muted",
        ` [${details.api}/${details.searchContextSize}/${details.freshness}]`,
      );

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
    const config = await loadConfig(ctx.cwd, ctx.isProjectTrusted());
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

  const models = await fetchCodexModels({
    token,
    accountId,
    baseUrl: config.baseUrl,
    clientVersion: config.clientVersion,
    signal,
  });
  const model = selectDefaultModel(models);
  if (!model) {
    throw new CodexError("unknown", "Codex model list is empty.");
  }
  return model;
}

function buildDetails(
  config: ResolvedConfig,
  model: string,
  freshness: Freshness,
  searchContextSize: SearchContextSize,
  successes: QuerySuccess[],
  failures: QueryFailure[],
  extra?: { partial?: boolean; completed?: number; total?: number },
): WebSearchDetails {
  const queries = successes.map((s) => s.query).concat(failures.map((f) => f.query));
  return {
    model,
    api: config.searchApi,
    freshness,
    searchContextSize,
    queryCount: queries.length,
    queries,
    failedQueryCount: failures.length,
    successes,
    failures,
    ...extra,
  };
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
  const lines: string[] = [];
  const queriesPreview = renderQueriesPreview(details.queries, theme);
  if (queriesPreview) lines.push(queriesPreview);

  const firstFailure = details.failures[0];
  if (firstFailure) {
    lines.push(theme.fg("dim", formatInline(firstFailure.message, 110)));
  }
  return lines.join("\n");
}

function renderQueriesPreview(queries: string[], theme: Theme): string {
  if (queries.length === 0) return "";
  if (queries.length === 1) {
    return theme.fg("accent", `Query: ${formatInline(queries[0], 120)}`);
  }
  return [theme.fg("accent", "Queries:"), renderCallQueries(queries, theme)].join("\n");
}

function renderCallQueries(queries: unknown[], theme: Theme): string {
  const iconPrefix = "  ⌕";
  return formatQueryPreviewLines(queries)
    .map(
      (line) =>
        `${theme.fg("accent", iconPrefix)}${theme.fg("dim", line.slice(iconPrefix.length))}`,
    )
    .join("\n");
}

export function formatQueryPreviewLines(queries: unknown[], maxLength = 110): string[] {
  return queries.map((query, index) => `  ⌕ ${index + 1}. ${formatInline(query, maxLength)}`);
}

function buildRequestLabels(input: {
  queries: string[];
  imageQueries: string[];
  urls: string[];
  findCommands: Array<{ url: string; pattern: string }>;
  clickCommands: Array<{ url: string; id: number }>;
  screenshotCommands: Array<{ url: string; pageno: number }>;
  financeCommands: Array<{ ticker: string }>;
  weatherCommands: Array<{ location: string }>;
  sportsCommands: Array<{ fn: string; league: string; team?: string }>;
  timeCommands: Array<{ utc_offset: string }>;
}): string[] {
  return [
    ...input.queries,
    ...input.imageQueries.map((q) => `image: ${q}`),
    ...input.urls.map((url) => `open: ${url}`),
    ...input.findCommands.map((c) => `find "${c.pattern}" in ${c.url}`),
    ...input.clickCommands.map((c) => `click ${c.id} in ${c.url}`),
    ...input.screenshotCommands.map((c) => `screenshot ${c.pageno} of ${c.url}`),
    ...input.financeCommands.map((c) => `finance: ${c.ticker}`),
    ...input.weatherCommands.map((c) => `weather: ${c.location}`),
    ...input.sportsCommands.map((c) => `sports: ${c.fn} ${c.league}${c.team ? ` ${c.team}` : ""}`),
    ...input.timeCommands.map((c) => `time: ${c.utc_offset}`),
  ];
}

function buildCallLabels(args: Record<string, unknown>): string[] {
  return buildRequestLabels({
    queries: Array.isArray(args.queries) ? args.queries.filter(isString) : [],
    imageQueries: Array.isArray(args.image_queries) ? args.image_queries.filter(isString) : [],
    urls: Array.isArray(args.urls) ? args.urls.filter(isString) : [],
    findCommands: Array.isArray(args.find)
      ? args.find.filter(isFindArg).map((c) => ({ url: c.url, pattern: c.pattern }))
      : [],
    clickCommands: Array.isArray(args.click)
      ? args.click.filter(isClickArg).map((c) => ({ url: c.url, id: c.id }))
      : [],
    screenshotCommands: Array.isArray(args.screenshot)
      ? args.screenshot.filter(isScreenshotArg).map((c) => ({ url: c.url, pageno: c.pageno }))
      : [],
    financeCommands: Array.isArray(args.finance)
      ? args.finance.filter(isFinanceArg).map((c) => ({ ticker: c.ticker }))
      : [],
    weatherCommands: Array.isArray(args.weather)
      ? args.weather.filter(isWeatherArg).map((c) => ({ location: c.location }))
      : [],
    sportsCommands: Array.isArray(args.sports)
      ? args.sports.filter(isSportsArg).map((c) => ({ fn: c.fn, league: c.league, team: c.team }))
      : [],
    timeCommands: Array.isArray(args.time)
      ? args.time.filter(isTimeArg).map((c) => ({ utc_offset: c.utc_offset }))
      : [],
  });
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFindArg(value: unknown): value is { url: string; pattern: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { url?: unknown }).url === "string" &&
    typeof (value as { pattern?: unknown }).pattern === "string"
  );
}

function isClickArg(value: unknown): value is { url: string; id: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { url?: unknown }).url === "string" &&
    typeof (value as { id?: unknown }).id === "number"
  );
}

function isScreenshotArg(value: unknown): value is { url: string; pageno: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { url?: unknown }).url === "string" &&
    typeof (value as { pageno?: unknown }).pageno === "number"
  );
}

function isFinanceArg(value: unknown): value is { ticker: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { ticker?: unknown }).ticker === "string"
  );
}

function isWeatherArg(value: unknown): value is { location: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { location?: unknown }).location === "string"
  );
}

function isSportsArg(value: unknown): value is { fn: string; league: string; team?: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { fn?: unknown }).fn === "string" &&
    typeof (value as { league?: unknown }).league === "string" &&
    ((value as { team?: unknown }).team === undefined ||
      typeof (value as { team?: unknown }).team === "string")
  );
}

function isTimeArg(value: unknown): value is { utc_offset: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { utc_offset?: unknown }).utc_offset === "string"
  );
}

function formatInline(value: unknown, maxLength = 90): string {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
