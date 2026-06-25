#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CodexError,
  createTransport,
  extractAccountIdFromToken,
  fetchCodexModels,
  isUnsupportedStandaloneCombination,
  runResponsesSearch,
  runStandaloneCommands,
  selectDefaultModel,
  type CodexTransport,
  type CodexWebSearchResult,
  type Freshness,
  type SearchContextSize,
  type StandaloneCommandsOptions,
} from "../src/codex.ts";

const PROVIDER = "openai-codex";
const DEFAULT_AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");
const DEFAULT_QUERY = "OpenAI Codex release notes";
const FRESHNESS_VALUES: readonly Freshness[] = ["live", "indexed", "cached"];
const CONTEXT_VALUES: readonly SearchContextSize[] = ["low", "medium", "high"];
const API_VALUES = ["responses", "standalone"] as const;
const SUITE_VALUES = ["matrix", "actions", "session", "concurrency"] as const;

type SearchApi = (typeof API_VALUES)[number];
type E2eSuite = (typeof SUITE_VALUES)[number];

interface CliOptions {
  authPath: string;
  apis: SearchApi[];
  contexts: SearchContextSize[];
  freshnesses: Freshness[];
  suites: E2eSuite[];
  query: string;
  model?: string;
  baseUrl?: string;
  timeoutMs: number;
  concurrencyValues: number[];
}

interface AuthCredential {
  access?: unknown;
  accountId?: unknown;
  expires?: unknown;
}

interface AuthFile {
  [PROVIDER]?: AuthCredential;
}

interface E2eResult {
  suite: E2eSuite;
  name: string;
  api?: SearchApi;
  context?: SearchContextSize;
  freshness?: Freshness;
  ok: boolean;
  skipped?: boolean;
  status?: number;
  kind?: string;
  ms: number;
  citationCount?: number;
  refCount?: number;
  textLength?: number;
  message?: string;
}

interface Runtime {
  token: string;
  accountId: string;
  model: string;
  baseUrl?: string;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const runtime = await buildRuntime(options);
  const results: E2eResult[] = [];

  if (options.suites.includes("matrix")) {
    for (const api of options.apis) {
      for (const context of options.contexts) {
        for (const freshness of options.freshnesses) {
          const unsupported = unsupportedResult("matrix", "search", api, context, freshness);
          const result =
            unsupported ??
            (await runSearchCase({
              suite: "matrix",
              name: "search",
              api,
              context,
              freshness,
              query: options.query,
              runtime,
              timeoutMs: options.timeoutMs,
            }));
          results.push(result);
          printResult(result);
        }
      }
    }
  }

  if (options.suites.includes("actions") && options.apis.includes("standalone")) {
    for (const result of await runStandaloneActionSuite(runtime, options)) {
      results.push(result);
      printResult(result);
    }
  }

  if (options.suites.includes("session") && options.apis.includes("standalone")) {
    for (const result of await runStandaloneSessionSuite(runtime, options)) {
      results.push(result);
      printResult(result);
    }
  }

  if (options.suites.includes("concurrency")) {
    for (const api of options.apis) {
      for (const context of options.contexts) {
        for (const freshness of options.freshnesses) {
          for (const concurrency of options.concurrencyValues) {
            const unsupported = unsupportedResult(
              "concurrency",
              `search/${concurrency}x`,
              api,
              context,
              freshness,
            );
            if (unsupported) {
              results.push(unsupported);
              printResult(unsupported);
              continue;
            }
            const concurrencyResults = await runConcurrencyCase({
              api,
              context,
              freshness,
              query: options.query,
              runtime,
              timeoutMs: options.timeoutMs,
              concurrency,
            });
            for (const result of concurrencyResults) {
              results.push(result);
              printResult(result);
            }
          }
        }
      }
    }
  }

  const skipped = results.filter((result) => result.skipped).length;
  const failed = results.filter((result) => !result.ok && !result.skipped).length;
  const ok = results.filter((result) => result.ok && !result.skipped).length;
  console.log(`summary: ${ok}/${results.length} ok, ${skipped} skipped`);
  if (failed > 0) process.exitCode = 1;
}

async function buildRuntime(options: CliOptions): Promise<Runtime> {
  const auth = await loadAuth(options.authPath);
  const token = readString(auth.access, `${PROVIDER}.access`);
  const accountId = readOptionalString(auth.accountId) ?? extractAccountIdFromToken(token);
  if (!accountId) {
    throw new Error(`${PROVIDER}.accountId is missing and could not be decoded from access token`);
  }
  warnIfExpired(auth.expires);
  const model = options.model ?? (await resolveModel(token, accountId, options.baseUrl));
  return { token, accountId, model, baseUrl: options.baseUrl };
}

function createRuntimeTransport(runtime: Runtime): CodexTransport {
  return createTransport({
    token: runtime.token,
    accountId: runtime.accountId,
    baseUrl: runtime.baseUrl,
  });
}

function createRecordingTransport(runtime: Runtime, requestIds: string[]): CodexTransport {
  return createTransport({
    token: runtime.token,
    accountId: runtime.accountId,
    baseUrl: runtime.baseUrl,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const id = readBodyId(init?.body);
      if (id) requestIds.push(id);
      return await fetch(input, init);
    }) as typeof fetch,
  });
}

async function runSearchCase(input: {
  suite: E2eSuite;
  name: string;
  api: SearchApi;
  context: SearchContextSize;
  freshness: Freshness;
  query: string;
  runtime: Runtime;
  timeoutMs: number;
}): Promise<E2eResult> {
  return withTimedResult(input, async (signal) => {
    const transport = createRuntimeTransport(input.runtime);
    return input.api === "standalone"
      ? await runStandaloneCommands({
          model: input.runtime.model,
          transport,
          sessionId: makeSessionId("standalone"),
          searchQuery: [{ q: input.query }],
          freshness: input.freshness,
          searchContextSize: input.context,
          signal,
        })
      : await runResponsesSearch({
          query: input.query,
          model: input.runtime.model,
          transport,
          externalWebAccess: input.freshness !== "cached",
          searchContextSize: input.context,
          sessionId: makeSessionId("responses"),
          threadId: makeSessionId("thread"),
          signal,
        });
  });
}

async function runStandaloneActionSuite(
  runtime: Runtime,
  options: CliOptions,
): Promise<E2eResult[]> {
  const results: E2eResult[] = [];
  const context = pickSupportedStandaloneContext(options.contexts);
  if (!context) {
    return [skippedStandaloneSuite("actions", options.freshnesses)];
  }
  const freshness = pickSupportedStandaloneFreshness(options.freshnesses, context);

  const actionCases: Array<{ name: string; options: StandaloneCommandsOptions }> = [
    {
      name: "finance",
      options: standaloneOptions(runtime, freshness, context, {
        finance: [{ ticker: "AMD", type: "equity", market: "USA" }],
      }),
    },
    {
      name: "weather",
      options: standaloneOptions(runtime, freshness, context, {
        weather: [{ location: "San Francisco, CA" }],
      }),
    },
    {
      name: "sports",
      options: standaloneOptions(runtime, freshness, context, {
        sports: [{ fn: "schedule", league: "epl", num_games: 1 }],
      }),
    },
    {
      name: "time",
      options: standaloneOptions(runtime, freshness, context, { time: [{ utc_offset: "+03:00" }] }),
    },
  ];

  for (const actionCase of actionCases) {
    results.push(
      await runStandaloneActionCase(
        actionCase.name,
        actionCase.options,
        context,
        freshness,
        options.timeoutMs,
      ),
    );
  }

  const openResult = await runStandaloneActionCase(
    "open",
    standaloneOptions(runtime, freshness, context, { open: [{ refId: "https://openai.com" }] }),
    context,
    freshness,
    options.timeoutMs,
  );
  results.push(openResult);
  const openRef = openResult.ok ? firstRefFromResult(openResult) : undefined;
  const pageRef = openRef ?? "https://openai.com";

  for (const actionCase of [
    {
      name: "find",
      options: standaloneOptions(runtime, freshness, context, {
        find: [{ refId: pageRef, pattern: "OpenAI" }],
      }),
    },
    {
      name: "click",
      options: standaloneOptions(runtime, freshness, context, {
        click: [{ refId: pageRef, id: 0 }],
      }),
    },
    {
      name: "screenshot",
      options: standaloneOptions(runtime, freshness, context, {
        screenshot: [{ refId: pageRef, pageno: 0 }],
      }),
    },
  ]) {
    results.push(
      await runStandaloneActionCase(
        actionCase.name,
        actionCase.options,
        context,
        freshness,
        options.timeoutMs,
      ),
    );
  }

  return results;
}

async function runStandaloneSessionSuite(
  runtime: Runtime,
  options: CliOptions,
): Promise<E2eResult[]> {
  const context = pickSupportedStandaloneContext(options.contexts);
  if (!context) {
    return [skippedStandaloneSuite("session", options.freshnesses)];
  }
  const freshness = pickSupportedStandaloneFreshness(options.freshnesses, context);
  const sessionId = makeSessionId("conversation");
  const requestIds: string[] = [];
  const transport = createRecordingTransport(runtime, requestIds);
  const results: E2eResult[] = [];

  const open = await runStandaloneActionCase(
    "open-same-session",
    standaloneOptions(runtime, freshness, context, {
      transport,
      sessionId,
      open: [{ refId: "https://openai.com" }],
    }),
    context,
    freshness,
    options.timeoutMs,
    "session",
  );
  results.push(open);
  const refId = firstRefFromResult(open) ?? "https://openai.com";

  results.push(
    await runStandaloneActionCase(
      "find-same-session",
      standaloneOptions(runtime, freshness, context, {
        transport,
        sessionId,
        find: [{ refId, pattern: "OpenAI" }],
      }),
      context,
      freshness,
      options.timeoutMs,
      "session",
    ),
  );

  const reused = requestIds.length >= 2 && requestIds.every((id) => id === sessionId);
  results.push({
    suite: "session",
    name: "request-id-reused-across-turns",
    api: "standalone",
    context,
    freshness,
    ok: reused,
    ms: 0,
    message: reused
      ? `sessionId=${sessionId}`
      : `expected all request ids to equal ${sessionId}; got ${requestIds.join(",")}`,
  });

  const isolatedIds: string[] = [];
  const isolatedTransport = createRecordingTransport(runtime, isolatedIds);
  const firstSession = makeSessionId("isolated-a");
  const secondSession = makeSessionId("isolated-b");
  await Promise.all([
    runStandaloneCommands(
      standaloneOptions(runtime, freshness, context, {
        transport: isolatedTransport,
        sessionId: firstSession,
        time: [{ utc_offset: "+00:00" }],
      }),
    ).catch(() => undefined),
    runStandaloneCommands(
      standaloneOptions(runtime, freshness, context, {
        transport: isolatedTransport,
        sessionId: secondSession,
        time: [{ utc_offset: "+01:00" }],
      }),
    ).catch(() => undefined),
  ]);
  const isolated = isolatedIds.includes(firstSession) && isolatedIds.includes(secondSession);
  results.push({
    suite: "session",
    name: "parallel-sessions-use-distinct-ids",
    api: "standalone",
    context,
    freshness,
    ok: isolated,
    ms: 0,
    message: isolated
      ? `sessionIds=${firstSession},${secondSession}`
      : `missing expected ids; got ${isolatedIds.join(",")}`,
  });

  return results;
}

function standaloneOptions(
  runtime: Runtime,
  freshness: Freshness,
  context: SearchContextSize,
  commands: Partial<StandaloneCommandsOptions>,
): StandaloneCommandsOptions {
  return {
    model: runtime.model,
    transport: commands.transport ?? createRuntimeTransport(runtime),
    sessionId: commands.sessionId ?? makeSessionId("action"),
    freshness,
    searchContextSize: context,
    maxOutputTokens: 8000,
    ...commands,
  };
}

async function runStandaloneActionCase(
  name: string,
  options: StandaloneCommandsOptions,
  context: SearchContextSize,
  freshness: Freshness,
  timeoutMs: number,
  suite: E2eSuite = "actions",
): Promise<E2eResult> {
  return withTimedResult(
    {
      suite,
      name,
      api: "standalone",
      context,
      freshness,
      timeoutMs,
    },
    async (signal) => await runStandaloneCommands({ ...options, signal }),
  );
}

async function runConcurrencyCase(input: {
  api: SearchApi;
  context: SearchContextSize;
  freshness: Freshness;
  query: string;
  runtime: Runtime;
  timeoutMs: number;
  concurrency: number;
}): Promise<E2eResult[]> {
  const promises = Array.from({ length: input.concurrency }, (_, index) =>
    runSearchCase({
      suite: "concurrency",
      name: `search#${index + 1}/${input.concurrency}`,
      api: input.api,
      context: input.context,
      freshness: input.freshness,
      query: `${input.query} ${index + 1}`,
      runtime: input.runtime,
      timeoutMs: input.timeoutMs,
    }),
  );
  return await Promise.all(promises);
}

async function withTimedResult(
  input: {
    suite: E2eSuite;
    name: string;
    api?: SearchApi;
    context?: SearchContextSize;
    freshness?: Freshness;
    timeoutMs: number;
  },
  run: (signal: AbortSignal) => Promise<CodexWebSearchResult>,
): Promise<E2eResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const result = await run(controller.signal);
    return {
      suite: input.suite,
      name: input.name,
      api: input.api,
      context: input.context,
      freshness: input.freshness,
      ok: true,
      ms: Date.now() - started,
      citationCount: result.citations.length,
      refCount: Object.keys(result.refIds ?? {}).length,
      textLength: result.text.length,
      message: firstRefFromWebResult(result),
    };
  } catch (error) {
    return {
      suite: input.suite,
      name: input.name,
      api: input.api,
      context: input.context,
      freshness: input.freshness,
      ok: false,
      status: error instanceof CodexError ? error.status : undefined,
      kind:
        error instanceof CodexError ? error.kind : error instanceof Error ? error.name : "unknown",
      ms: Date.now() - started,
      message: summarizeError(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveModel(
  token: string,
  accountId: string,
  baseUrl: string | undefined,
): Promise<string> {
  const models = await fetchCodexModels({ token, accountId, baseUrl });
  const model = selectDefaultModel(models);
  if (!model) throw new Error("Codex model list is empty");
  return model;
}

async function loadAuth(path: string): Promise<AuthCredential> {
  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw) as AuthFile;
  const credential = parsed[PROVIDER];
  if (!credential || typeof credential !== "object") {
    throw new Error(`${PROVIDER} credential not found in ${path}`);
  }
  return credential;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    authPath: DEFAULT_AUTH_PATH,
    apis: [...API_VALUES],
    contexts: [...CONTEXT_VALUES],
    freshnesses: [...FRESHNESS_VALUES],
    suites: [...SUITE_VALUES],
    query: DEFAULT_QUERY,
    timeoutMs: 45_000,
    concurrencyValues: [2, 4],
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = () => {
      const value = args[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case "--auth":
        options.authPath = next();
        break;
      case "--api":
        options.apis = parseList(next(), API_VALUES, "api");
        break;
      case "--context":
        options.contexts = parseList(next(), CONTEXT_VALUES, "context");
        break;
      case "--freshness":
        options.freshnesses = parseList(next(), FRESHNESS_VALUES, "freshness");
        break;
      case "--suite":
        options.suites = parseList(next(), SUITE_VALUES, "suite");
        break;
      case "--query":
        options.query = next();
        break;
      case "--model":
        options.model = next();
        break;
      case "--base-url":
        options.baseUrl = next();
        break;
      case "--timeout-ms":
        options.timeoutMs = parsePositiveInteger(next(), "--timeout-ms");
        break;
      case "--concurrency":
        options.concurrencyValues = parseIntegerList(next(), "--concurrency");
        break;
      case "--help":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function unsupportedResult(
  suite: E2eSuite,
  name: string,
  api: SearchApi,
  context: SearchContextSize,
  freshness: Freshness,
): E2eResult | undefined {
  if (api === "standalone" && (suite === "matrix" || suite === "concurrency")) {
    return {
      suite,
      name,
      api,
      context,
      freshness,
      ok: true,
      skipped: true,
      ms: 0,
      message: "standalone search_query is disabled; use responses/codex_search",
    };
  }
  if (api === "standalone" && isUnsupportedStandaloneCombination(context, freshness)) {
    return {
      suite,
      name,
      api,
      context,
      freshness,
      ok: true,
      skipped: true,
      ms: 0,
      message: "standalone/low is intentionally disabled",
    };
  }
  return undefined;
}

function skippedStandaloneSuite(suite: E2eSuite, freshnesses: Freshness[]): E2eResult {
  return {
    suite,
    name: suite,
    api: "standalone",
    freshness: freshnesses[0],
    ok: true,
    skipped: true,
    ms: 0,
    message:
      'standalone actions require search_context_size "medium" or "high"; pass --context medium',
  };
}

function parseList<T extends string>(value: string, allowed: readonly T[], label: string): T[] {
  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (parsed.length === 0) {
    throw new Error(`Invalid ${label}: expected at least one of ${allowed.join(", ")}`);
  }
  for (const item of parsed) {
    if (!allowed.includes(item as T)) {
      throw new Error(`Invalid ${label}: ${item}. Expected one of ${allowed.join(", ")}`);
    }
  }
  return parsed as T[];
}

function parseIntegerList(value: string, label: string): number[] {
  const parsed = value.split(",").map((item) => parsePositiveInteger(item.trim(), label));
  return [...new Set(parsed)];
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function readString(value: unknown, label: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`${label} is missing`);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readBodyId(body: BodyInit | null | undefined): string | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const parsed = JSON.parse(body) as { id?: unknown };
    return typeof parsed.id === "string" ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

function warnIfExpired(value: unknown): void {
  const expires = typeof value === "number" ? value : undefined;
  if (expires !== undefined && expires <= Date.now()) {
    console.warn(
      "warning: stored openai-codex access token appears expired; run /login openai-codex in Pi if requests fail with auth errors",
    );
  }
}

function pickSupportedStandaloneContext(
  values: SearchContextSize[],
): SearchContextSize | undefined {
  if (values.includes("medium")) return "medium";
  return values.find((value) => value !== "low");
}

function pickSupportedStandaloneFreshness(
  values: Freshness[],
  context: SearchContextSize,
): Freshness {
  if (context !== "low" && values.includes("live")) return "live";
  return values.find((value) => value !== "live") ?? "indexed";
}

function makeSessionId(prefix: string): string {
  return `pi-codex-e2e-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function firstRefFromResult(result: E2eResult): string | undefined {
  return result.message?.startsWith("ref=") ? result.message.slice("ref=".length) : undefined;
}

function firstRefFromWebResult(result: CodexWebSearchResult): string | undefined {
  const first = Object.keys(result.refIds ?? {})[0];
  return first ? `ref=${first}` : undefined;
}

function summarizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 240);
}

function printResult(result: E2eResult): void {
  const parts = [result.suite, result.name, result.api, result.context, result.freshness].filter(
    Boolean,
  );
  const prefix = parts.join("/");
  if (result.skipped) {
    console.log(`skip ${prefix} ${result.message ?? "skipped"}`);
    return;
  }
  if (result.ok) {
    console.log(
      `ok   ${prefix} ${result.ms}ms text=${result.textLength ?? 0} citations=${result.citationCount ?? 0} refs=${result.refCount ?? 0}${result.message ? ` ${result.message}` : ""}`,
    );
    return;
  }
  const status = result.status === undefined ? "" : ` http=${result.status}`;
  console.log(
    `fail ${prefix} ${result.ms}ms kind=${result.kind ?? "unknown"}${status} ${result.message ?? ""}`,
  );
}

function printHelp(): void {
  console.log(`Usage: node scripts/codex-e2e.ts [options]

Default runs matrix, standalone action, standalone session, and concurrency suites.
standalone/low is intentionally skipped because low-context standalone requests trigger Cloudflare.

Options:
  --auth PATH              Pi auth file (default: ~/.pi/agent/auth.json)
  --suite LIST             matrix, actions, session, concurrency, or comma list (default: all)
  --api LIST               responses, standalone, or comma list (default: both)
  --context LIST           low, medium, high, or comma list (default: all)
  --freshness LIST         live, indexed, cached, or comma list (default: all)
  --query TEXT             Query to run (default: ${DEFAULT_QUERY})
  --model MODEL            Codex model id; otherwise resolves /codex/models default
  --base-url URL           Override Codex base URL
  --timeout-ms N           Per-case timeout (default: 45000)
  --concurrency LIST       Parallel requests per concurrency combo, e.g. 2,4,8 (default: 2,4)
`);
}

main().catch((error: unknown) => {
  console.error(summarizeError(error));
  process.exit(1);
});
