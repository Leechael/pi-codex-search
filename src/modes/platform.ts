import { CodexError, classifyHttpStatus, formatHttpErrorBody } from "../errors.ts";
import { consumeResponsesStream } from "./responses.ts";
import type { CodexWebSearchResult, SearchContextSize } from "./types.ts";

export const DEFAULT_PLATFORM_MODEL = "gpt-5.5";
export const DEFAULT_PLATFORM_RESPONSES_URL = "https://api.openai.com/v1/responses";

export interface PlatformSearchOptions {
  query: string;
  model: string;
  token: string;
  searchContextSize?: SearchContextSize;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

/**
 * Hosted Responses API web search on api.openai.com/v1.
 *
 * This is the migration path when the Codex backend (chatgpt.com/backend-api)
 * is unavailable: the openai provider's Sign in with ChatGPT token is rejected
 * there, but it is accepted here with models such as gpt-5.5 / gpt-6-sol.
 */
export async function runPlatformSearch(
  options: PlatformSearchOptions,
): Promise<CodexWebSearchResult> {
  const { query, model, token, searchContextSize, signal, onTextDelta, fetchImpl, baseUrl } =
    options;
  const fetchFn: typeof fetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const endpoint = baseUrl?.trim() ? baseUrl.replace(/\/+$/, "") : DEFAULT_PLATFORM_RESPONSES_URL;

  const headers = new Headers();
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("content-type", "application/json");
  headers.set("accept", "text/event-stream");

  const response = await fetchFn(endpoint, {
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
      tools: [{ type: "web_search", search_context_size: searchContextSize ?? "medium" }],
      tool_choice: "required",
      stream: true,
      store: false,
    }),
    signal,
  });

  if (!response.ok) {
    const status = response.status;
    const text = formatHttpErrorBody(await response.text(), "responses");
    throw new CodexError(
      classifyHttpStatus(status),
      `OpenAI platform responses request failed: HTTP ${status}: ${text}`,
      status,
    );
  }
  if (!response.body) {
    throw new Error("OpenAI platform responses response did not include a body");
  }

  return consumeResponsesStream(response.body, model, onTextDelta);
}
