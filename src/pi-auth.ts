import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import { extractAccountIdFromToken } from "./codex.ts";

const OPENAI_CODEX_PROVIDER = "openai-codex";
const OPENAI_PROVIDER = "openai";

export interface StoredCredential {
  type?: unknown;
  accountId?: unknown;
}

interface LegacyModelRegistry {
  authStorage?: {
    get(provider: string): StoredCredential | undefined;
  };
}

export type StoredCredentialReader = (provider: string) => StoredCredential | undefined;

/** Which stored Pi credential can provide the token codex_search sends to the ChatGPT backend. */
export type CodexCredentialSource = "openai-codex" | "openai";

/**
 * How codex_search picks its credential.
 * - "openai-codex": only the OpenAI Codex (legacy) OAuth credential.
 * - "openai": the openai provider's "Sign in with ChatGPT" credential, used with
 *   the platform Responses API (api.openai.com/v1), not the Codex backend.
 * - "auto" (default): openai-codex first (Codex backend); if missing, openai
 *   (platform web search).
 */
export type CodexCredentialPreference = "auto" | CodexCredentialSource;

export const CREDENTIAL_PREFERENCES: readonly CodexCredentialPreference[] = [
  "auto",
  "openai-codex",
  "openai",
];

export const CREDENTIAL_SOURCES: readonly CodexCredentialSource[] = ["openai-codex", "openai"];

/** Minimal registry surface needed to resolve a provider token. */
export interface ApiKeyProviderRegistry {
  getApiKeyForProvider(provider: string): Promise<string | undefined>;
}

export interface ResolvedCodexCredential {
  token: string;
  accountId?: string;
  source: CodexCredentialSource;
}

function getPublicCredentialReader(): StoredCredentialReader | undefined {
  return (piCodingAgent as { readStoredCredential?: StoredCredentialReader }).readStoredCredential;
}

function readStored(
  registry: object,
  provider: string,
  reader: StoredCredentialReader | null,
): StoredCredential | undefined {
  if (reader) return reader(provider);
  return (registry as LegacyModelRegistry).authStorage?.get(provider);
}

function storedAccountId(credential: StoredCredential | undefined): string | undefined {
  if (credential?.type === "oauth" && typeof credential.accountId === "string") {
    const accountId = credential.accountId.trim();
    if (accountId) return accountId;
  }
  return undefined;
}

export function resolveCodexAccountId(
  token: string,
  modelRegistry: object,
  readStoredCredential: StoredCredentialReader | null = getPublicCredentialReader() ?? null,
): string | undefined {
  const credential = readStored(modelRegistry, OPENAI_CODEX_PROVIDER, readStoredCredential);
  const accountId = storedAccountId(credential);
  if (accountId) return accountId;
  return extractAccountIdFromToken(token);
}

/**
 * Resolve the credential codex_search should use against chatgpt.com/backend-api.
 *
 * openai-codex talks to chatgpt.com/backend-api (the Codex backend).
 * openai (Sign in with ChatGPT) talks to api.openai.com/v1 — the Codex backend
 * rejects that token (HTTP 401 no_matching_rule), but hosted web_search on the
 * platform API accepts it. "auto" prefers openai-codex and falls back to openai
 * so a future Codex-backend sunset still has a working search path.
 * An `sk-` platform key is never selected for the openai source.
 *
 * The resolved `accountId` may be undefined; callers decide whether it is required.
 */
export async function resolveCodexCredential(
  registry: ApiKeyProviderRegistry,
  preference: CodexCredentialPreference = "auto",
  readStoredCredential: StoredCredentialReader | null = getPublicCredentialReader() ?? null,
): Promise<ResolvedCodexCredential | undefined> {
  const candidates: CodexCredentialSource[] =
    preference === "auto" ? [OPENAI_CODEX_PROVIDER, OPENAI_PROVIDER] : [preference];

  for (const provider of candidates) {
    const stored = readStored(registry, provider, readStoredCredential);
    if (provider === OPENAI_PROVIDER && stored?.type !== "oauth") {
      // Without a stored OAuth credential the openai provider resolves to an
      // API key (env or stored), which the ChatGPT backend must never receive.
      continue;
    }
    const token = await registry.getApiKeyForProvider(provider);
    if (!token) continue;
    if (provider === OPENAI_PROVIDER && token.startsWith("sk-")) continue;
    const accountId = storedAccountId(stored) ?? extractAccountIdFromToken(token);
    return { token, accountId, source: provider };
  }

  return undefined;
}
