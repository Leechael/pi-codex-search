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
  classifyError,
  classifyHttpStatus,
  type CodexTransport,
  type CodexWebSearchResult,
  type Freshness,
  type SearchContextSize,
  type StandaloneCommandsOptions,
} from "../src/codex.ts";
import { CREDENTIAL_SOURCES, type CodexCredentialSource } from "../src/pi-auth.ts";

const PROVIDER = "openai-codex";
const DEFAULT_AUTH_PATH = join(homedir(), ".pi", "agent", "auth.json");
const DEFAULT_QUERY = "OpenAI Codex release notes";
const FRESHNESS_VALUES: readonly Freshness[] = ["live", "indexed", "cached"];
const CONTEXT_VALUES: readonly SearchContextSize[] = ["low", "medium", "high"];
const API_VALUES = ["responses", "standalone", "platform"] as const;
const SUITE_VALUES = ["matrix", "actions", "session", "concurrency", "platform"] as const;

type SearchApi = (typeof API_VALUES)[number];
type E2eSuite = (typeof SUITE_VALUES)[number];

interface CliOptions {
  authPath: string;
  credential: CodexCredentialSource;
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
  type?: unknown;
  access?: unknown;
  accountId?: unknown;
  expires?: unknown;
}

interface AuthFile {
  [provider: string]: AuthCredential | undefined;
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
  const results: E2eResult[] = [];

  // The platform probe talks to api.openai.com/v1 with the openai credential
  // and never touches the Codex backend, so it runs before the Codex runtime
  // is built (which would fail at /codex/models for the openai credential).
  if (options.suites.includes("platform")) {
    const result = await runPlatformProbe(options);
    results.push(result);
    printResult(result);
  }
  options.suites = options.suites.filter((suite) => suite !== "platform");
  if (options.suites.length === 0) {
    const skipped = results.filter((result) => result.skipped).length;
    const failed = results.filter((result) => !result.ok && !result.skipped).length;
    const ok = results.filter((result) => result.ok && !result.skipped).length;
    console.log(`summary: ${ok}/${results.length} ok, ${skipped} skipped`);
    if (failed > 0) process.exitCode = 1;
    return;
  }

  const runtime = await buildRuntime(options);
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
  const provider = options.credential;
  const auth = await loadAuth(options.authPath, provider);
  if (provider === "openai") {
    if (auth.type !== "oauth") {
      throw new Error(
        `The "openai" entry in ${options.authPath} is not an OAuth (Sign in with ChatGPT) credential. Run /login openai in Pi and choose "Sign in with ChatGPT" first.`,
      );
    }
  }
  const token = readString(auth.access, `${provider}.access`);
  if (provider === "openai" && token.startsWith("sk-")) {
    throw new Error(
      `The "openai" entry in ${options.authPath} holds an API key, not a Sign in with ChatGPT token; refusing to send it to the ChatGPT backend.`,
    );
  }
  let accountId = readOptionalString(auth.accountId) ?? extractAccountIdFromToken(token) ?? "";
  if (!accountId) {
    console.warn(
      `warning: no ChatGPT account id for the ${provider} credential; continuing without the ChatGPT-Account-ID header to probe whether the backend accepts the token`,
    );
  }
  warnIfExpired(auth.expires, provider);
  const model =
    options.model ?? (await resolveModel(token, accountId || undefined, options.baseUrl));
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

/**
 * Probe the hosted Responses API on api.openai.com/v1 with the openai provider's
 * "Sign in with ChatGPT" credential. This is the migration target if OpenAI ever
 * sunsets the Codex backend (chatgpt.com/backend-api/codex/*): the new credential
 * is verified rejected there, but pi itself streams chat through api.openai.com/v1
 * with the same token. Open questions this probe answers: is the hosted web_search
 * tool enabled for subscription-shared tokens, and does it hit a usage/billing wall?
 */
async function runPlatformProbe(options: CliOptions): Promise<E2eResult> {
  const started = Date.now();
  const base = {
    suite: "platform" as E2eSuite,
    name: "web_search",
    api: "platform" as SearchApi,
    context: "medium" as SearchContextSize,
    freshness: "live" as Freshness,
  };
  if (options.credential !== "openai") {
    return {
      ...base,
      ok: true,
      skipped: true,
      ms: 0,
      message: "platform probe requires --credential openai (the Sign in with ChatGPT token)",
    };
  }
  try {
    const auth = await loadAuth(options.authPath, "openai");
    if (auth.type !== "oauth") {
      return {
        ...base,
        ok: false,
        ms: Date.now() - started,
        kind: "auth",
        message: "the openai entry is not an OAuth (Sign in with ChatGPT) credential",
      };
    }
    const token = readString(auth.access, "openai.access");
    if (token.startsWith("sk-")) {
      return {
        ...base,
        ok: false,
        ms: Date.now() - started,
        kind: "auth",
        message: "refusing to probe with an sk- platform key",
      };
    }
    warnIfExpired(auth.expires, "openai");
    const model = options.model ?? "gpt-5";

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), options.timeoutMs);
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({
          model,
          instructions: "You are a concise web search assistant.",
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: options.query }],
            },
          ],
          tools: [{ type: "web_search", search_context_size: "medium" }],
          tool_choice: "required",
          stream: true,
          store: false,
        }),
        signal: ctrl.signal,
      });
      if (!response.ok) {
        const text = (await response.text()).slice(0, 300).replace(/\s+/g, " ");
        return {
          ...base,
          ok: false,
          ms: Date.now() - started,
          kind: classifyHttpStatus(response.status),
          status: response.status,
          message: text,
        };
      }
      if (!response.body) {
        return {
          ...base,
          ok: false,
          ms: Date.now() - started,
          kind: "unknown" as const,
          message: "no body",
        };
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let citationCount = 0;
      let outcome: E2eResult | undefined;
      try {
        while (!outcome) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          citationCount += (buffer.match(/"type"\s*:\s*"url_citation"/g) ?? []).length;
          if (buffer.includes("response.failed") || buffer.includes('"type":"error"')) {
            const snippet = buffer.slice(0, 300).replace(/\s+/g, " ");
            outcome = {
              ...base,
              ok: false,
              ms: Date.now() - started,
              kind: "unknown" as const,
              message: `stream error: ${snippet}`,
            };
          } else if (buffer.includes("response.completed")) {
            outcome = {
              ...base,
              ok: true,
              ms: Date.now() - started,
              textLength: buffer.length,
              citationCount,
              message: `api.openai.com/v1 accepted the ChatGPT sign-in token for hosted web_search (model ${model})`,
            };
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      return (
        outcome ?? {
          ...base,
          ok: false,
          ms: Date.now() - started,
          kind: "timeout" as const,
          message: "stream ended without response.completed",
        }
      );
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return {
      ...base,
      ok: false,
      ms: Date.now() - started,
      kind: classifyError(error),
      message: summarizeError(error),
    };
  }
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
          indexedWebAccess: input.freshness === "indexed" ? true : undefined,
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
  accountId: string | undefined,
  baseUrl: string | undefined,
): Promise<string> {
  const models = await fetchCodexModels({ token, accountId, baseUrl });
  const model = selectDefaultModel(models);
  if (!model) throw new Error("Codex model list is empty");
  return model;
}

async function loadAuth(path: string, provider: CodexCredentialSource): Promise<AuthCredential> {
  const raw = await readFile(path, "utf-8");
  const parsed = JSON.parse(raw) as AuthFile;
  const credential = parsed[provider];
  if (!credential || typeof credential !== "object") {
    throw new Error(`${provider} credential not found in ${path}`);
  }
  return credential;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    authPath: DEFAULT_AUTH_PATH,
    credential: PROVIDER,
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
      case "--credential": {
        const value = next();
        if (!CREDENTIAL_SOURCES.includes(value as CodexCredentialSource)) {
          throw new Error(
            `Invalid credential: ${value}. Expected one of ${CREDENTIAL_SOURCES.join(", ")}`,
          );
        }
        options.credential = value as CodexCredentialSource;
        break;
      }
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
  if (api === "platform") {
    return {
      suite,
      name,
      api,
      context,
      freshness,
      ok: true,
      skipped: true,
      ms: 0,
      message: "platform runs only in the platform suite (--suite platform)",
    };
  }
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

function warnIfExpired(value: unknown, provider: CodexCredentialSource): void {
  const expires = typeof value === "number" ? value : undefined;
  if (expires !== undefined && expires <= Date.now()) {
    console.warn(
      `warning: stored ${provider} access token appears expired; run /login ${provider} in Pi if requests fail with auth errors`,
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
  --credential NAME        Auth entry to use: openai-codex (default) or openai.
                           Use "openai" after /login openai (Sign in with ChatGPT)
                           to probe whether that token works with the Codex backend.
  --suite LIST             matrix, actions, session, concurrency, or comma list (default: all)
  --api LIST               responses, standalone, or comma list (default: both)
  --context LIST           low, medium, high, or comma list (default: all)
  --freshness LIST         live, indexed, cached, or comma list (default: all)
  --query TEXT             Query to run (default: ${DEFAULT_QUERY})
  --model MODEL            Codex model id; otherwise resolves /codex/models default
  --base-url URL           Override Codex base URL
  --timeout-ms N           Per-case timeout (default: 45000)
  --concurrency LIST       Parallel requests per concurrency combo, e.g. 2,4,8 (default: 2,4)

Suite "platform" probes api.openai.com/v1/responses with the hosted web_search
tool using the openai credential — the migration target if the Codex backend is
ever sunset. It requires --credential openai and does not touch the Codex backend:

  node scripts/codex-e2e.ts --credential openai --suite platform [--model gpt-5]
`);
}

main().catch((error: unknown) => {
  console.error(summarizeError(error));
  process.exit(1);
});
