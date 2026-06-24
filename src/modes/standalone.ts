import { CodexError, classifyHttpStatus, formatHttpErrorBody } from "../errors.ts";
import type { CodexTransport } from "../transport.ts";
import type {
  CodexWebSearchResult,
  CodexCitation,
  CodexSearchCall,
  SearchContextSize,
  Freshness,
  StandaloneExternalWebAccess,
  ResponseLength,
} from "./types.ts";

export interface SearchQuery {
  q: string;
  recency?: number;
  domains?: string[];
}

export interface OpenCommand {
  refId: string;
  lineno?: number;
}

export interface FindCommand {
  refId: string;
  pattern: string;
}

export interface ClickCommand {
  refId: string;
  id: number;
}

export interface ScreenshotCommand {
  refId: string;
  pageno: number;
}

export interface FinanceCommand {
  ticker: string;
  type: "equity" | "fund" | "crypto" | "index";
  market?: string;
}

export interface WeatherCommand {
  location: string;
  start?: string;
  duration?: number;
}

export type SportsLeague =
  | "nba"
  | "wnba"
  | "nfl"
  | "nhl"
  | "mlb"
  | "epl"
  | "ncaamb"
  | "ncaawb"
  | "ipl";

export interface SportsCommand {
  fn: "schedule" | "standings";
  league: SportsLeague;
  team?: string;
  opponent?: string;
  date_from?: string;
  date_to?: string;
  num_games?: number;
  locale?: string;
}

export interface TimeCommand {
  utc_offset: string;
}

export interface StandaloneCommandsOptions {
  model: string;
  transport: CodexTransport;
  sessionId: string;
  searchQuery?: SearchQuery[];
  imageQuery?: SearchQuery[];
  open?: OpenCommand[];
  find?: FindCommand[];
  click?: ClickCommand[];
  screenshot?: ScreenshotCommand[];
  finance?: FinanceCommand[];
  weather?: WeatherCommand[];
  sports?: SportsCommand[];
  time?: TimeCommand[];
  freshness: Freshness;
  searchContextSize?: SearchContextSize;
  responseLength?: ResponseLength;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

interface StandaloneSearchResponse {
  encrypted_output?: string;
  output?: string;
}

export function externalWebAccessForFreshness(freshness: Freshness): StandaloneExternalWebAccess {
  if (freshness === "cached") return false;
  if (freshness === "indexed") return "indexed";
  return true;
}

export function hasAnyCommand(options: StandaloneCommandsOptions): boolean {
  return countCommands(options) > 0;
}

export function isUnsupportedStandaloneCombination(
  searchContextSize: SearchContextSize | undefined,
  _freshness: Freshness,
): boolean {
  return (searchContextSize ?? "medium") === "low";
}

export function assertSupportedStandaloneCombination(
  searchContextSize: SearchContextSize | undefined,
  freshness: Freshness,
): void {
  if (isUnsupportedStandaloneCombination(searchContextSize, freshness)) {
    throw new CodexError(
      "schema",
      'standalone/low is disabled because Codex returns Cloudflare challenges for low-context standalone requests. Use search_context_size "medium" or "high".',
    );
  }
}

function countCommands(options: StandaloneCommandsOptions): number {
  return (
    (options.searchQuery?.length ?? 0) +
    (options.imageQuery?.length ?? 0) +
    (options.open?.length ?? 0) +
    (options.find?.length ?? 0) +
    (options.click?.length ?? 0) +
    (options.screenshot?.length ?? 0) +
    (options.finance?.length ?? 0) +
    (options.weather?.length ?? 0) +
    (options.sports?.length ?? 0) +
    (options.time?.length ?? 0)
  );
}

export async function runStandaloneCommands(
  options: StandaloneCommandsOptions,
): Promise<CodexWebSearchResult> {
  if (!hasAnyCommand(options)) {
    throw new CodexError("schema", "Codex standalone commands require at least one command");
  }
  if (countCommands(options) > 1) {
    throw new CodexError("schema", "Codex standalone actions must be sent one per request");
  }
  assertSupportedStandaloneCombination(options.searchContextSize, options.freshness);

  const {
    transport,
    model,
    sessionId,
    freshness,
    searchContextSize,
    responseLength,
    maxOutputTokens,
    signal,
  } = options;
  const headers = transport.buildHeaders("application/json");
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("content-type", "application/json");

  const commands: Record<string, unknown> = {};
  if (options.searchQuery?.length) commands.search_query = options.searchQuery;
  if (options.imageQuery?.length) commands.image_query = options.imageQuery;
  if (options.open?.length)
    commands.open = options.open.map((c) => ({ ref_id: c.refId, lineno: c.lineno }));
  if (options.find?.length)
    commands.find = options.find.map((c) => ({ ref_id: c.refId, pattern: c.pattern }));
  if (options.click?.length)
    commands.click = options.click.map((c) => ({ ref_id: c.refId, id: c.id }));
  if (options.screenshot?.length) {
    commands.screenshot = options.screenshot.map((c) => ({ ref_id: c.refId, pageno: c.pageno }));
  }
  if (options.finance?.length) {
    commands.finance = options.finance.map((c) => ({
      ticker: c.ticker,
      type: c.type,
      market: c.market,
    }));
  }
  if (options.weather?.length) {
    commands.weather = options.weather.map((c) => ({
      location: c.location,
      start: c.start,
      duration: c.duration,
    }));
  }
  if (options.sports?.length) {
    commands.sports = options.sports.map((c) => ({
      fn: c.fn,
      league: c.league,
      team: c.team,
      opponent: c.opponent,
      date_from: c.date_from,
      date_to: c.date_to,
      num_games: c.num_games,
      locale: c.locale,
    }));
  }
  if (options.time?.length) commands.time = options.time.map((c) => ({ utc_offset: c.utc_offset }));
  if (responseLength) commands.response_length = responseLength;

  const body: Record<string, unknown> = {
    id: sessionId,
    model,
    input: buildInput(options),
    commands,
    settings: {
      search_context_size: searchContextSize ?? "medium",
      allowed_callers: ["direct"],
      external_web_access: externalWebAccessForFreshness(freshness),
    },
  };
  body.max_output_tokens = maxOutputTokens ?? 8000;

  const response = await transport.fetch(transport.resolveSearchEndpoint(), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const status = response.status;
    const text = formatHttpErrorBody(await response.text(), "standalone");
    throw new CodexError(
      classifyHttpStatus(status),
      `Codex standalone search request failed: HTTP ${status}: ${text}`,
      status,
    );
  }

  const data = (await response.json()) as StandaloneSearchResponse;
  const text = typeof data.output === "string" ? data.output : "";
  const refIds = extractRefIds(text);
  const searchCalls = inferSearchCalls(options);

  const result: CodexWebSearchResult = {
    model,
    text,
    searchCalls,
    citations: extractMarkdownCitations(text),
    refIds,
  };
  if (data.encrypted_output !== undefined) result.encryptedOutput = data.encrypted_output;
  return result;
}

function buildInput(options: StandaloneCommandsOptions): unknown[] {
  const texts: string[] = [];
  options.searchQuery?.forEach((q) => texts.push(q.q));
  options.imageQuery?.forEach((q) => texts.push(q.q));
  options.open?.forEach((c) => texts.push(c.refId));
  options.find?.forEach((c) => texts.push(`find "${c.pattern}" in ${c.refId}`));
  options.click?.forEach((c) => texts.push(`click ${c.id} in ${c.refId}`));
  options.screenshot?.forEach((c) => texts.push(`screenshot ${c.pageno} of ${c.refId}`));
  options.finance?.forEach((c) => texts.push(`finance ${c.ticker} ${c.type} ${c.market ?? ""}`));
  options.weather?.forEach((c) => texts.push(`weather ${c.location}`));
  options.sports?.forEach((c) => texts.push(`sports ${c.fn} ${c.league}`));
  options.time?.forEach((c) => texts.push(`time ${c.utc_offset}`));

  const prompt = texts.filter(Boolean).join("\n");
  return [
    {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: prompt }],
    },
  ];
}

function inferSearchCalls(options: StandaloneCommandsOptions): CodexSearchCall[] {
  const calls: CodexSearchCall[] = [];
  options.searchQuery?.forEach((q) =>
    calls.push({ status: "completed", query: q.q, actionType: "search_query" }),
  );
  options.imageQuery?.forEach((q) =>
    calls.push({ status: "completed", query: q.q, actionType: "image_query" }),
  );
  options.open?.forEach((c) =>
    calls.push({ status: "completed", refId: c.refId, actionType: "open_page" }),
  );
  options.find?.forEach((c) =>
    calls.push({ status: "completed", refId: c.refId, actionType: "find_in_page" }),
  );
  options.click?.forEach((c) =>
    calls.push({ status: "completed", refId: c.refId, actionType: "click" }),
  );
  options.screenshot?.forEach((c) =>
    calls.push({ status: "completed", refId: c.refId, actionType: "screenshot" }),
  );
  options.finance?.forEach((c) =>
    calls.push({ status: "completed", query: `${c.ticker}`, actionType: "finance" }),
  );
  options.weather?.forEach((c) =>
    calls.push({ status: "completed", query: c.location, actionType: "weather" }),
  );
  options.sports?.forEach((c) =>
    calls.push({ status: "completed", query: `${c.fn} ${c.league}`, actionType: "sports" }),
  );
  options.time?.forEach((c) =>
    calls.push({ status: "completed", query: c.utc_offset, actionType: "time" }),
  );
  return calls;
}

const REF_ID_PATTERN = /\b(turn\d+(?:search|fetch|view)\d+)\b/g;

function extractRefIds(text: string): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const match of text.matchAll(REF_ID_PATTERN)) {
    const refId = match[1];
    if (refId) refs[refId] = refId;
  }
  return refs;
}

function extractMarkdownCitations(text: string): CodexCitation[] {
  const citations = new Map<string, CodexCitation>();
  const markdownLinkPattern = /\[([^\]\n]{1,200})\]\((https?:\/\/[^)\s]+)\)/g;
  for (const match of text.matchAll(markdownLinkPattern)) {
    const title = match[1]?.trim();
    const url = match[2]?.trim();
    if (!url || citations.has(url)) continue;
    citations.set(url, { title: title || url, url, startIndex: match.index });
  }
  return [...citations.values()];
}
