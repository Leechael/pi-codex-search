/**
 * Process-local Cloudflare cookie store for ChatGPT endpoints.
 *
 * Mirrors the constraints in codex chatgpt_cloudflare_cookies.rs:
 * - HTTPS only
 * - ChatGPT host allowlist
 * - Cloudflare infrastructure cookie name allowlist only
 * - Never store account/session/auth cookies
 */

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
}

const ALLOWED_HOSTS = ["chatgpt.com", "chat.openai.com", "chatgpt-staging.com"];
const HOST_SUFFIXES = [".chatgpt.com", ".chatgpt-staging.com"];

const ALLOWED_COOKIE_NAMES = new Set([
  "__cf_bm",
  "__cflb",
  "__cfruid",
  "__cfseq",
  "__cfwaitingroom",
  "_cfuvid",
  "cf_clearance",
  "cf_ob_info",
  "cf_use_ob",
]);

function isAllowedHost(host: string): boolean {
  if (ALLOWED_HOSTS.includes(host)) return true;
  return HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function isAllowedCookieName(name: string): boolean {
  if (ALLOWED_COOKIE_NAMES.has(name)) return true;
  return name.startsWith("cf_chl_");
}

function parseSetCookieHeader(header: string, url: URL): Cookie | undefined {
  const [firstPart] = header.split(";");
  if (!firstPart) return undefined;
  const eqIndex = firstPart.indexOf("=");
  if (eqIndex <= 0) return undefined;
  const name = firstPart.slice(0, eqIndex).trim();
  const value = firstPart.slice(eqIndex + 1).trim();
  if (!isAllowedCookieName(name)) return undefined;
  return {
    name,
    value,
    domain: url.hostname,
    path: "/",
    secure: true,
  };
}

function cookieKey(cookie: Cookie): string {
  return `${cookie.domain}:${cookie.path}:${cookie.name}`;
}

export class ChatGptCloudflareCookieStore {
  private cookies = new Map<string, Cookie>();

  setCookies(setCookieHeaders: string[], url: URL): void {
    if (url.protocol !== "https:") return;
    if (!isAllowedHost(url.hostname)) return;
    for (const header of setCookieHeaders) {
      const cookie = parseSetCookieHeader(header, url);
      if (cookie) {
        this.cookies.set(cookieKey(cookie), cookie);
      }
    }
  }

  cookiesForUrl(url: URL): string | undefined {
    if (url.protocol !== "https:") return undefined;
    if (!isAllowedHost(url.hostname)) return undefined;
    const parts: string[] = [];
    for (const cookie of this.cookies.values()) {
      if (cookie.domain === url.hostname) {
        parts.push(`${cookie.name}=${cookie.value}`);
      }
    }
    return parts.length > 0 ? parts.join("; ") : undefined;
  }
}

const SHARED_STORE = new ChatGptCloudflareCookieStore();

export function getSharedCookieStore(): ChatGptCloudflareCookieStore {
  return SHARED_STORE;
}

export function wrapFetchWithCookies(fetchImpl: FetchLike): FetchLike {
  return async (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const cookieHeader = SHARED_STORE.cookiesForUrl(url);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    if (cookieHeader) {
      const existing = headers.get("cookie");
      headers.set("cookie", existing ? `${existing}; ${cookieHeader}` : cookieHeader);
    }

    const response = await fetchImpl(input, { ...init, headers });

    const setCookie =
      response.headers.getSetCookie?.() ?? parseSetCookieLegacy(response.headers.get("set-cookie"));
    if (setCookie.length > 0) {
      SHARED_STORE.setCookies(setCookie, url);
    }
    return response;
  };
}

function parseSetCookieLegacy(value: string | null): string[] {
  if (!value) return [];
  // Split on comma, but Set-Cookie values rarely contain bare commas in CF cookies.
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
