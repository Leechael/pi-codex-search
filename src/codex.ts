export type SearchContextSize = "low" | "medium" | "high";

export type CodexErrorKind = "auth" | "rate_limit" | "transport" | "timeout" | "schema" | "unknown";

export class CodexError extends Error {
  readonly kind: CodexErrorKind;
  readonly status?: number;

  constructor(kind: CodexErrorKind, message: string, status?: number) {
    super(message);
    this.name = "CodexError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

export function classifyError(error: unknown): CodexErrorKind {
  if (error instanceof CodexError) return error.kind;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return "timeout";
  }
  return "unknown";
}

function classifyHttpStatus(status: number): CodexErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  return "transport";
}

function classifyEventErrorMessage(message: string): CodexErrorKind {
  const lower = message.toLowerCase();
  if (/rate[- ]?limit|too many requests|quota|429/.test(lower)) return "rate_limit";
  if (/auth|unauthori[sz]ed|forbidden|401|403/.test(lower)) return "auth";
  if (/timeout|timed out/.test(lower)) return "timeout";
  if (/network|connection|disconnect|transport|fetch failed/.test(lower)) return "transport";
  return "unknown";
}

export interface CodexModel {
  id: string;
  name?: string;
  isDefault?: boolean;
}

export interface CodexWebSearchOptions {
  query: string;
  token: string;
  accountId: string;
  model: string;
  baseUrl?: string;
  externalWebAccess?: boolean;
  searchContextSize?: SearchContextSize;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  fetchImpl?: typeof fetch;
}

export interface CodexCitation {
  title?: string;
  url: string;
  startIndex?: number;
  endIndex?: number;
}

export interface CodexSearchCall {
  id?: string;
  status?: string;
  query?: string;
  url?: string;
  actionType?: string;
}

export interface CodexWebSearchResult {
  responseId?: string;
  model: string;
  text: string;
  searchCalls: CodexSearchCall[];
  citations: CodexCitation[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

interface SseEvent {
  type: string;
  data?: unknown;
  raw?: string;
}

interface ResponseOutputText {
  type?: string;
  text?: string;
  annotations?: Array<{
    type?: string;
    title?: string;
    url?: string;
    start_index?: number;
    end_index?: number;
  }>;
}

interface ResponseOutputItem {
  id?: string;
  type?: string;
  status?: string;
  role?: string;
  action?: {
    type?: string;
    query?: string;
    queries?: string[];
    url?: string;
  };
  content?: ResponseOutputText[];
}

interface ResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface ResponseEnvelope {
  id?: string;
  usage?: ResponseUsage;
}

interface ResponseEventData {
  response?: ResponseEnvelope;
  item?: ResponseOutputItem;
  delta?: string;
  error?: {
    message?: string;
    code?: string;
  };
}

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_CLIENT_VERSION = "1.0.0";
const ACCOUNT_ID_CLAIM = "https://api.openai.com/auth";

export function normalizeCodexBaseUrl(baseUrl: string | undefined): string {
  const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_BASE_URL;
  const normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses"))
    return normalized.slice(0, -"/codex/responses".length);
  if (normalized.endsWith("/codex")) return normalized.slice(0, -"/codex".length);
  return normalized;
}

export function resolveCodexEndpoint(
  baseUrl: string | undefined,
  path: "models" | "responses",
): string {
  return `${normalizeCodexBaseUrl(baseUrl)}/codex/${path}`;
}

export function extractAccountIdFromToken(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;

  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as {
      [ACCOUNT_ID_CLAIM]?: { chatgpt_account_id?: unknown };
    };
    const accountId = payload[ACCOUNT_ID_CLAIM]?.chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchCodexModels(options: {
  token: string;
  accountId: string;
  baseUrl?: string;
  clientVersion?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<CodexModel[]> {
  const fetcher = options.fetchImpl ?? fetch;
  const endpoint = new URL(resolveCodexEndpoint(options.baseUrl, "models"));
  endpoint.searchParams.set(
    "client_version",
    options.clientVersion ??
      process.env.PI_CODEX_WEB_SEARCH_CLIENT_VERSION ??
      DEFAULT_CLIENT_VERSION,
  );

  const response = await fetcher(endpoint.toString(), {
    headers: buildCodexHeaders(options.token, options.accountId, "application/json"),
    signal: options.signal,
  });
  if (!response.ok) {
    const status = response.status;
    throw new CodexError(
      classifyHttpStatus(status),
      `Codex models request failed: HTTP ${status} ${await response.text()}`,
      status,
    );
  }

  const data = (await response.json()) as {
    models?: Array<{
      slug?: string;
      id?: string;
      model?: string;
      display_name?: string;
      is_default?: boolean;
    }>;
  };
  return (data.models ?? [])
    .map((model) => ({
      id: model.slug ?? model.id ?? model.model ?? "",
      name: model.display_name,
      isDefault: model.is_default,
    }))
    .filter((model) => model.id.length > 0);
}

export function selectDefaultModel(models: CodexModel[]): string | undefined {
  return (models.find((model) => model.isDefault) ?? models[0])?.id;
}

export async function fetchCodexWebSearch(
  options: CodexWebSearchOptions,
): Promise<CodexWebSearchResult> {
  const fetcher = options.fetchImpl ?? fetch;
  const response = await fetcher(resolveCodexEndpoint(options.baseUrl, "responses"), {
    method: "POST",
    headers: buildCodexHeaders(options.token, options.accountId, "text/event-stream"),
    body: JSON.stringify(buildWebSearchRequestBody(options)),
    signal: options.signal,
  });

  if (!response.ok) {
    const status = response.status;
    throw new CodexError(
      classifyHttpStatus(status),
      `Codex web search request failed: HTTP ${status} ${await response.text()}`,
      status,
    );
  }
  if (!response.body) {
    throw new CodexError("transport", "Codex web search response did not include a body");
  }

  let responseId: string | undefined;
  let usage: ResponseUsage | undefined;
  let streamedText = "";
  const messageTextParts: string[] = [];
  const searchCalls = new Map<string, CodexSearchCall>();
  const citations = new Map<string, CodexCitation>();

  for await (const event of parseSse(response.body)) {
    const data = event.data as ResponseEventData | undefined;
    if (!data) continue;

    if (event.type === "response.created") {
      responseId = data.response?.id;
      continue;
    }

    if (event.type === "response.output_text.delta") {
      const delta = data.delta ?? "";
      streamedText += delta;
      options.onTextDelta?.(delta);
      continue;
    }

    if (event.type === "response.output_item.added" && data.item?.type === "web_search_call") {
      const item = data.item;
      searchCalls.set(item.id ?? `search-${searchCalls.size + 1}`, {
        id: item.id,
        status: item.status,
      });
      continue;
    }

    if (event.type === "response.output_item.done") {
      collectOutputItem(data.item, searchCalls, messageTextParts, citations);
      continue;
    }

    if (event.type === "response.completed") {
      usage = data.response?.usage;
      continue;
    }

    if (event.type === "response.failed") {
      const message = data.error?.message ?? data.error?.code ?? "Codex web search failed";
      throw new CodexError(classifyEventErrorMessage(message), message);
    }
  }

  return {
    responseId,
    model: options.model,
    text: messageTextParts.join("") || streamedText,
    searchCalls: [...searchCalls.values()],
    citations: [...citations.values()],
    usage: usage
      ? {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          totalTokens: usage.total_tokens,
        }
      : undefined,
  };
}

function buildCodexHeaders(token: string, accountId: string, accept: string): Headers {
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("chatgpt-account-id", accountId);
  headers.set("originator", "pi");
  headers.set("OpenAI-Beta", "responses=experimental");
  headers.set("accept", accept);
  if (accept === "text/event-stream") {
    headers.set("content-type", "application/json");
  }
  headers.set("User-Agent", "pi-codex-search");
  return headers;
}

function buildWebSearchRequestBody(options: CodexWebSearchOptions) {
  return {
    model: options.model,
    instructions:
      "You are a concise web search assistant. Use web search, answer the query, and preserve source citations from annotations.",
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: options.query }],
      },
    ],
    tools: [
      {
        type: "web_search",
        external_web_access: options.externalWebAccess ?? true,
        search_context_size: options.searchContextSize ?? "medium",
      },
    ],
    tool_choice: "required",
    parallel_tool_calls: true,
    store: false,
    stream: true,
    include: [],
  };
}

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex !== -1) {
      const frame = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const event = parseSseFrame(frame);
      if (event) yield event;
      separatorIndex = buffer.indexOf("\n\n");
    }
  }

  buffer += decoder.decode();
  const event = parseSseFrame(buffer);
  if (event) yield event;
}

function parseSseFrame(frame: string): SseEvent | undefined {
  const lines = frame.split(/\r?\n/);
  let type = "";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      type = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) return undefined;
  const raw = dataLines.join("\n");
  if (raw === "[DONE]") return undefined;

  try {
    return { type, data: JSON.parse(raw) };
  } catch {
    return { type, raw };
  }
}

function collectOutputItem(
  item: ResponseOutputItem | undefined,
  searchCalls: Map<string, CodexSearchCall>,
  messageTextParts: string[],
  citations: Map<string, CodexCitation>,
): void {
  if (!item) return;

  if (item.type === "web_search_call") {
    const key = item.id ?? `search-${searchCalls.size + 1}`;
    const query = item.action?.query ?? item.action?.queries?.join(", ");
    searchCalls.set(key, {
      id: item.id,
      status: item.status,
      query,
      url: item.action?.url,
      actionType: item.action?.type,
    });
    return;
  }

  if (item.type !== "message" || item.role !== "assistant") return;

  for (const part of item.content ?? []) {
    if (part.type !== "output_text") continue;
    messageTextParts.push(part.text ?? "");
    for (const annotation of part.annotations ?? []) {
      if (annotation.type !== "url_citation" || !annotation.url) continue;
      citations.set(annotation.url, {
        title: annotation.title,
        url: annotation.url,
        startIndex: annotation.start_index,
        endIndex: annotation.end_index,
      });
    }
  }
}
