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
 * - "openai": only the "Sign in with ChatGPT" credential of the openai provider.
 *   Kept as an explicit diagnostic opt-in: the Codex backend rejects this token
 *   type (HTTP 401 rejected_by_access_enforcement), so "auto" never selects it.
 * - "auto" (default): only the legacy openai-codex credential.
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
 * The openai-codex OAuth credential is the only one the Codex backend accepts.
 * The openai provider's "Sign in with ChatGPT" credential (pi >= 0.99) only
 * qualifies under an explicit "openai" preference: it must be OAuth (an `sk-`
 * platform key is never sent to the ChatGPT backend), and the backend rejects
 * it with HTTP 401 rejected_by_access_enforcement, so "auto" does not fall
 * back to it.
 *
 * The resolved `accountId` may be undefined; callers decide whether it is required.
 */
export async function resolveCodexCredential(
  registry: ApiKeyProviderRegistry,
  preference: CodexCredentialPreference = "auto",
  readStoredCredential: StoredCredentialReader | null = getPublicCredentialReader() ?? null,
): Promise<ResolvedCodexCredential | undefined> {
  // "auto" resolves the legacy credential only. Falling back to the openai
  // ChatGPT sign-in credential would guarantee a backend 401 — see the
  // preference docs above — so it is opt-in via an explicit "openai" value.
  const candidates: CodexCredentialSource[] =
    preference === "openai" ? [OPENAI_PROVIDER] : [OPENAI_CODEX_PROVIDER];

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
