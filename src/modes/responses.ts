import {
  CodexError,
  classifyEventErrorMessage,
  classifyHttpStatus,
  formatHttpErrorBody,
} from "../errors.ts";
import type { CodexTransport } from "../transport.ts";
import type {
  CodexWebSearchResult,
  CodexCitation,
  CodexSearchCall,
  SearchContextSize,
} from "./types.ts";

export interface ResponsesSearchOptions {
  query: string;
  model: string;
  transport: CodexTransport;
  externalWebAccess: boolean;
  indexGatedWebAccess?: true;
  searchContextSize?: SearchContextSize;
  sessionId?: string;
  threadId?: string;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
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

export async function runResponsesSearch(
  options: ResponsesSearchOptions,
): Promise<CodexWebSearchResult> {
  const {
    transport,
    query,
    model,
    externalWebAccess,
    searchContextSize,
    sessionId,
    threadId,
    signal,
    onTextDelta,
  } = options;
  const headers = transport.buildHeaders("text/event-stream");
  if (sessionId) headers.set("session-id", sessionId);
  if (threadId) {
    headers.set("thread-id", threadId);
    headers.set("x-client-request-id", threadId);
  }

  const webSearchTool: Record<string, unknown> = {
    type: "web_search",
    external_web_access: externalWebAccess,
    search_context_size: searchContextSize ?? "medium",
  };

  const response = await transport.fetch(transport.resolveEndpoint("responses"), {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      instructions:
        "You are a concise web search assistant. Use web search, answer the query, and preserve source citations from annotations.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: query }],
        },
      ],
      tools: [webSearchTool],
      tool_choice: "required",
      parallel_tool_calls: true,
      store: false,
      stream: true,
      include: [],
    }),
    signal,
  });

  if (!response.ok) {
    const status = response.status;
    const text = formatHttpErrorBody(await response.text(), "responses");
    throw new CodexError(
      classifyHttpStatus(status),
      `Codex responses request failed: HTTP ${status}: ${text}`,
      status,
    );
  }
  if (!response.body) {
    throw new Error("Codex responses response did not include a body");
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
      onTextDelta?.(delta);
      continue;
    }

    if (event.type === "response.output_item.added" && data.item?.type === "web_search_call") {
      const item = data.item;
      if (item.id) {
        searchCalls.set(item.id, {
          id: item.id,
          status: item.status,
        });
      }
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
    model,
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

async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  let doneReading = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        doneReading = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let separator = findSseSeparator(buffer);
      while (separator) {
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator.length);
        const event = parseSseFrame(frame);
        if (event) yield event;
        separator = findSseSeparator(buffer);
      }
    }
  } finally {
    if (!doneReading) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  buffer += decoder.decode();
  const event = parseSseFrame(buffer);
  if (event) yield event;
}

function findSseSeparator(buffer: string): { index: number; length: number } | undefined {
  const match = /\r?\n\r?\n/.exec(buffer);
  return match?.index === undefined ? undefined : { index: match.index, length: match[0].length };
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
