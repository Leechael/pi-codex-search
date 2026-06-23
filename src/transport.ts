/**
 * Codex-faithful HTTP transport.
 *
 * Builds the same headers and cookie behavior used by the codex Rust client:
 * - originator: codex_cli_rs
 * - User-Agent: codex_cli_rs/{ver} (os ver; arch) terminal
 * - Authorization: Bearer {token}
 * - ChatGPT-Account-ID: {account_id}
 * - ChatGPT Cloudflare cookie store on all outbound/inbound requests
 */

import { getCodexOriginator, buildCodexUserAgent } from "./ua.ts";
import { wrapFetchWithCookies, type FetchLike } from "./cookies.ts";

export interface TransportOptions {
  token: string;
  accountId: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
export const DEFAULT_CLIENT_VERSION = "1.0.0";

export interface CodexTransport {
  fetch: FetchLike;
  baseUrl: string;
  token: string;
  accountId: string;
  buildHeaders(accept: string): Headers;
  resolveEndpoint(path: "models" | "responses"): string;
  resolveSearchEndpoint(): string;
}

export function normalizeCodexBaseUrl(baseUrl: string | undefined): string {
  const raw = baseUrl?.trim() ? baseUrl : DEFAULT_BASE_URL;
  let normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) {
    normalized = normalized.slice(0, -"/codex/responses".length);
  }
  if (normalized.endsWith("/codex")) {
    normalized = normalized.slice(0, -"/codex".length);
  }
  return normalized;
}

function isOpenAiRootBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.hostname === "api.openai.com" && (url.pathname === "" || url.pathname === "/");
  } catch {
    return false;
  }
}

export function resolveCodexEndpoint(
  baseUrl: string | undefined,
  path: "models" | "responses",
): string {
  return `${normalizeCodexBaseUrl(baseUrl)}/codex/${path}`;
}

export function resolveCodexSearchEndpoint(baseUrl: string | undefined): string {
  const raw = baseUrl?.trim() ? baseUrl : DEFAULT_BASE_URL;
  let normalized = raw.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) {
    normalized = normalized.slice(0, -"/responses".length);
  }
  if (normalized.endsWith("/codex/models")) {
    normalized = normalized.slice(0, -"/models".length);
  }
  if (normalized.endsWith("/codex/alpha/search") || normalized.endsWith("/alpha/search")) {
    return normalized;
  }
  if (normalized.endsWith("/codex")) return `${normalized}/alpha/search`;
  if (normalized.endsWith("/v1")) return `${normalized}/alpha/search`;
  if (isOpenAiRootBaseUrl(normalized)) return `${normalized}/v1/alpha/search`;
  return `${normalized}/codex/alpha/search`;
}

export function createTransport(options: TransportOptions): CodexTransport {
  const baseUrl = normalizeCodexBaseUrl(options.baseUrl);
  const rawFetch: FetchLike = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const fetch = wrapFetchWithCookies(rawFetch);

  return {
    fetch,
    baseUrl,
    token: options.token,
    accountId: options.accountId,
    buildHeaders(accept: string): Headers {
      const headers = new Headers();
      headers.set("Authorization", `Bearer ${options.token}`);
      headers.set("chatgpt-account-id", options.accountId);
      headers.set("originator", getCodexOriginator());
      headers.set("OpenAI-Beta", "responses=experimental");
      headers.set("accept", accept);
      if (accept === "text/event-stream") {
        headers.set("content-type", "application/json");
      }
      headers.set("User-Agent", buildCodexUserAgent());
      return headers;
    },
    resolveEndpoint(path) {
      return resolveCodexEndpoint(baseUrl, path);
    },
    resolveSearchEndpoint() {
      return resolveCodexSearchEndpoint(baseUrl);
    },
  };
}
