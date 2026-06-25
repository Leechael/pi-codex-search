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

export function classifyHttpStatus(status: number): CodexErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  return "transport";
}

export function formatHttpErrorBody(text: string, mode: "responses" | "standalone"): string {
  if (isCloudflareChallenge(text)) {
    const advice =
      mode === "standalone"
        ? "Use codex_search for search, or retry after Codex/ChatGPT has refreshed its Cloudflare clearance."
        : "Retry after Codex/ChatGPT has refreshed its Cloudflare clearance.";
    return `Cloudflare challenge blocked the Codex request. ${advice}`;
  }
  return text;
}

export function isCloudflareChallenge(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("/cdn-cgi/challenge-platform/") ||
    lower.includes("cf_chl_") ||
    lower.includes("enable javascript and cookies to continue")
  );
}

export function classifyEventErrorMessage(message: string): CodexErrorKind {
  const lower = message.toLowerCase();
  if (/rate[- ]?limit|too many requests|quota|429/.test(lower)) return "rate_limit";
  if (/auth|unauthori[sz]ed|forbidden|401|403/.test(lower)) return "auth";
  if (/timeout|timed out/.test(lower)) return "timeout";
  if (/network|connection|disconnect|transport|fetch failed/.test(lower)) return "transport";
  return "unknown";
}
