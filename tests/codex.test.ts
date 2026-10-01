import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildCodexUserAgent,
  classifyError,
  CodexError,
  extractAccountIdFromToken,
  fetchCodexModels,
  createTransport,
  ChatGptCloudflareCookieStore,
  createRefStore,
  wrapFetchWithCookies,
  runStandaloneCommands,
  runResponsesSearch,
  normalizeCodexBaseUrl,
  resolveCodexEndpoint,
  resolveCodexSearchEndpoint,
  selectDefaultModel,
  type StandaloneCommandsOptions,
} from "../src/codex.ts";
import {
  resolveCodexAccountId,
  resolveCodexCredential,
  type StoredCredential,
} from "../src/pi-auth.ts";
import { formatQueryPreviewLines, selectStandalonePageRefId } from "../index.ts";

describe("codex helpers", () => {
  it("normalizes codex base URLs", () => {
    assert.equal(normalizeCodexBaseUrl(undefined), "https://chatgpt.com/backend-api");
    assert.equal(
      normalizeCodexBaseUrl("https://chatgpt.com/backend-api/codex"),
      "https://chatgpt.com/backend-api",
    );
    assert.equal(
      normalizeCodexBaseUrl("https://chatgpt.com/backend-api/codex/responses"),
      "https://chatgpt.com/backend-api",
    );
  });

  it("resolves codex endpoints", () => {
    assert.equal(
      resolveCodexEndpoint("https://chatgpt.com/backend-api/codex", "responses"),
      "https://chatgpt.com/backend-api/codex/responses",
    );
    assert.equal(
      resolveCodexEndpoint("https://example.test/root", "models"),
      "https://example.test/root/codex/models",
    );
    assert.equal(
      resolveCodexSearchEndpoint("https://chatgpt.com/backend-api"),
      "https://chatgpt.com/backend-api/codex/alpha/search",
    );
    assert.equal(
      resolveCodexSearchEndpoint("https://api.openai.com"),
      "https://api.openai.com/v1/alpha/search",
    );
    assert.equal(
      resolveCodexSearchEndpoint("https://api.openai.com/v1"),
      "https://api.openai.com/v1/alpha/search",
    );
    assert.equal(
      resolveCodexSearchEndpoint("https://chatgpt.com/backend-api/codex/responses"),
      "https://chatgpt.com/backend-api/codex/alpha/search",
    );
  });

  it("formats Codex user agent architecture like upstream", () => {
    const expectedArch = process.arch === "x64" ? "x86_64" : process.arch;
    assert.match(
      buildCodexUserAgent(),
      new RegExp(`; ${expectedArch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`),
    );
  });

  it("builds Codex-aligned transport headers", () => {
    const transport = createTransport({ token: "token", accountId: "account" });
    const headers = transport.buildHeaders("application/json");

    assert.equal(headers.get("originator"), "codex_cli_rs");
    assert.equal(headers.get("openai-beta"), null);
    assert.equal(headers.get("authorization"), "Bearer token");
    assert.equal(headers.get("chatgpt-account-id"), "account");
    assert.match(headers.get("user-agent") ?? "", /^codex_cli_rs\/0\.143\.0 /);
  });

  it("preserves Request headers when wrapping fetch with cookies", async () => {
    let observedHeaders = new Headers();
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
      observedHeaders = new Headers(init?.headers);
      return new Response("ok");
    };
    const wrapped = wrapFetchWithCookies(fetchImpl);
    const request = new Request("https://example.test/", {
      headers: { "x-from-request": "request" },
    });

    await wrapped(request, { headers: { "x-from-init": "init" } });

    assert.equal(observedHeaders.get("x-from-request"), "request");
    assert.equal(observedHeaders.get("x-from-init"), "init");
  });

  it("stores only Cloudflare cookies for ChatGPT hosts", () => {
    const store = new ChatGptCloudflareCookieStore();
    const url = new URL("https://chatgpt.com/backend-api/codex/responses");

    store.setCookies(
      [
        "cf_clearance=clearance; Path=/; Secure; HttpOnly",
        "__Secure-next-auth.session-token=secret; Path=/; Secure; HttpOnly",
      ],
      url,
    );

    assert.equal(store.cookiesForUrl(url), "cf_clearance=clearance");
    assert.equal(
      store.cookiesForUrl(new URL("https://foo.chatgpt.com/backend-api/codex/responses")),
      undefined,
    );
    assert.equal(store.cookiesForUrl(new URL("https://api.openai.com/v1/responses")), undefined);
  });

  it("persists standalone ref ids by URL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-codex-refs-"));
    try {
      const first = createRefStore();
      await first.load(dir);
      await first.remember("https://example.com/docs", "turn0fetch0");

      const second = createRefStore();
      await second.load(dir);
      assert.equal(second.resolveRefId("https://example.com/docs"), "turn0fetch0");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("merges concurrent ref id persistence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-codex-refs-race-"));
    try {
      const first = createRefStore();
      const second = createRefStore();
      await Promise.all([first.load(dir), second.load(dir)]);
      await Promise.all([
        first.remember("https://example.com/a", "turn0fetch0"),
        second.remember("https://example.com/b", "turn0fetch1"),
      ]);

      const reloaded = createRefStore();
      await reloaded.load(dir);
      assert.equal(reloaded.resolveRefId("https://example.com/a"), "turn0fetch0");
      assert.equal(reloaded.resolveRefId("https://example.com/b"), "turn0fetch1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("fails fast on corrupt persisted ref ids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-codex-refs-bad-"));
    try {
      await writeFile(join(dir, "pi-codex-search-refs.json"), "{bad json", "utf-8");
      const store = createRefStore();
      await assert.rejects(store.load(dir), SyntaxError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("extracts account id from an access token JWT", () => {
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct_123",
        },
      }),
    ).toString("base64url");
    const token = `header.${payload}.signature`;

    assert.equal(extractAccountIdFromToken(token), "acct_123");
    assert.equal(extractAccountIdFromToken("not-a-jwt"), undefined);
  });

  it("prefers a stored OAuth account id when the token has no account claim", () => {
    assert.equal(
      resolveCodexAccountId("opaque-token", {}, (provider) => {
        assert.equal(provider, "openai-codex");
        return { type: "oauth", accountId: "acct_stored" };
      }),
      "acct_stored",
    );
  });

  it("trims a stored OAuth account id", () => {
    assert.equal(
      resolveCodexAccountId("opaque-token", {}, () => ({
        type: "oauth",
        accountId: "  acct_stored  ",
      })),
      "acct_stored",
    );
  });

  it("falls back to the token account id when a stored OAuth account id is not a string", () => {
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_token" },
      }),
    ).toString("base64url");

    assert.equal(
      resolveCodexAccountId(`header.${payload}.signature`, {}, () => ({
        type: "oauth",
        accountId: 42,
      })),
      "acct_token",
    );
  });

  it("falls back to the token account id when stored credentials are unusable", () => {
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_token" },
      }),
    ).toString("base64url");

    assert.equal(
      resolveCodexAccountId(`header.${payload}.signature`, {}, () => ({
        type: "oauth",
        accountId: "   ",
      })),
      "acct_token",
    );
  });

  it("returns undefined when neither stored credentials nor the token provide an account id", () => {
    assert.equal(
      resolveCodexAccountId("opaque-token", {}, () => undefined),
      undefined,
    );
  });

  it("uses the legacy credential store when Pi's public reader is unavailable", () => {
    assert.equal(
      resolveCodexAccountId(
        "opaque-token",
        { authStorage: { get: () => ({ type: "oauth", accountId: "acct_legacy" }) } },
        null,
      ),
      "acct_legacy",
    );
  });

  it("prefers the public reader when both credential APIs are present", () => {
    assert.equal(
      resolveCodexAccountId(
        "opaque-token",
        { authStorage: { get: () => ({ type: "oauth", accountId: "acct_legacy" }) } },
        () => ({ type: "oauth", accountId: "acct_public" }),
      ),
      "acct_public",
    );
  });

  it("prefers the openai-codex credential in auto mode", async () => {
    const registry = {
      getApiKeyForProvider: async (provider: string) =>
        provider === "openai-codex" ? "legacy-token" : "chatgpt-token",
    };
    const credential = await resolveCodexCredential(registry, "auto", (provider) =>
      provider === "openai-codex" ? { type: "oauth", accountId: "acct_legacy" } : { type: "oauth" },
    );
    assert.equal(credential?.source, "openai-codex");
    assert.equal(credential?.token, "legacy-token");
    assert.equal(credential?.accountId, "acct_legacy");
  });

  it("falls back to the openai ChatGPT credential when the legacy credential is absent", async () => {
    const registry = {
      getApiKeyForProvider: async (provider: string) =>
        provider === "openai" ? "chatgpt-token" : undefined,
    };
    const credential = await resolveCodexCredential(registry, "auto", () => ({ type: "oauth" }));
    assert.equal(credential?.source, "openai");
    assert.equal(credential?.token, "chatgpt-token");
  });

  it("skips the openai credential when it is not OAuth", async () => {
    const registry = {
      getApiKeyForProvider: async (provider: string) =>
        provider === "openai" ? "sk-platform-key" : undefined,
    };
    const credential = await resolveCodexCredential(registry, "auto", (provider) =>
      provider === "openai" ? { type: "api_key" } : undefined,
    );
    assert.equal(credential, undefined);
  });

  it("skips the openai credential when its token looks like a platform API key", async () => {
    const registry = {
      getApiKeyForProvider: async (provider: string) =>
        provider === "openai" ? "sk-somethingelse" : undefined,
    };
    const credential = await resolveCodexCredential(registry, "auto", (provider) =>
      provider === "openai" ? { type: "oauth" } : undefined,
    );
    assert.equal(credential, undefined);
  });

  it("honors an explicit openai preference even when the legacy credential exists", async () => {
    const registry = {
      getApiKeyForProvider: async (provider: string) =>
        provider === "openai-codex" ? "legacy-token" : "chatgpt-token",
    };
    const credential = await resolveCodexCredential(registry, "openai", (provider) =>
      provider === "openai-codex" ? { type: "oauth", accountId: "acct_legacy" } : { type: "oauth" },
    );
    assert.equal(credential?.source, "openai");
    assert.equal(credential?.token, "chatgpt-token");
  });

  it("returns undefined for an explicit openai-codex preference when no token resolves", async () => {
    const credential = await resolveCodexCredential(
      { getApiKeyForProvider: async () => undefined },
      "openai-codex",
      () => undefined,
    );
    assert.equal(credential, undefined);
  });

  it("resolves the legacy token without a stored credential", async () => {
    const credential = await resolveCodexCredential(
      { getApiKeyForProvider: async () => "legacy-token" },
      "openai-codex",
      () => undefined,
    );
    assert.equal(credential?.source, "openai-codex");
    assert.equal(credential?.token, "legacy-token");
    assert.equal(credential?.accountId, undefined);
  });

  it("decodes the account id from the openai ChatGPT token when none is stored", async () => {
    const payload = Buffer.from(
      JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: "acct_jwt" },
      }),
    ).toString("base64url");
    const credential = await resolveCodexCredential(
      { getApiKeyForProvider: async () => `header.${payload}.signature` },
      "openai",
      () => ({ type: "oauth" }),
    );
    assert.equal(credential?.source, "openai");
    assert.equal(credential?.accountId, "acct_jwt");
  });

  it("allows a missing account id for the openai source", async () => {
    const credential = await resolveCodexCredential(
      { getApiKeyForProvider: async () => "opaque-token" },
      "openai",
      () => ({ type: "oauth" }),
    );
    assert.equal(credential?.source, "openai");
    assert.equal(credential?.accountId, undefined);
  });

  it("uses the legacy authStorage when the public reader is unavailable", async () => {
    const registry = {
      getApiKeyForProvider: async () => "legacy-token",
      authStorage: {
        get: (provider: string): StoredCredential | undefined =>
          provider === "openai-codex"
            ? { type: "oauth", accountId: "acct_legacy_store" }
            : undefined,
      },
    };
    const credential = await resolveCodexCredential(registry, "auto", null);
    assert.equal(credential?.source, "openai-codex");
    assert.equal(credential?.accountId, "acct_legacy_store");
  });

  it("omits the ChatGPT-Account-ID header when no account id is provided", () => {
    const transport = createTransport({ token: "token" });
    const headers = transport.buildHeaders("application/json");
    assert.equal(headers.get("authorization"), "Bearer token");
    assert.equal(headers.get("chatgpt-account-id"), null);
  });

  it("selects default model first", () => {
    assert.equal(selectDefaultModel([{ id: "gpt-a" }, { id: "gpt-b", isDefault: true }]), "gpt-b");
    assert.equal(selectDefaultModel([{ id: "gpt-a" }]), "gpt-a");
    assert.equal(selectDefaultModel([]), undefined);
  });

  it("classifies HTTP 401 from /codex/models as an auth CodexError", async () => {
    const fetchImpl = async () =>
      new Response("unauthorized", { status: 401, statusText: "Unauthorized" });

    await assert.rejects(
      fetchCodexModels({
        token: "t",
        accountId: "a",
        baseUrl: "https://example.test/backend",
        fetchImpl: fetchImpl as typeof fetch,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CodexError, `expected CodexError, got ${error}`);
        assert.equal(error.kind, "auth");
        assert.equal(error.status, 401);
        return true;
      },
    );
  });

  it("posts standalone search requests to /alpha/search", async () => {
    let requestedUrl = "";
    let requestedBody: unknown;
    let requestedHeaders = new Headers();
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedHeaders = new Headers(init?.headers);
      requestedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          encrypted_output: "ciphertext",
          output: "Search result.",
          results: [
            {
              type: "text_result",
              ref_id: "turn0search0",
              title: "OpenAI",
              url: "https://openai.com",
              future_field: { preserved: true },
            },
          ],
        }),
      );
    };

    const transport = createTransport({
      token: "token",
      accountId: "account",
      baseUrl: "https://example.test/backend/codex",
      fetchImpl: fetchImpl as typeof fetch,
    });

    const result = await runStandaloneCommands({
      model: "gpt-test",
      transport,
      sessionId: "pi-codex-search",
      searchQuery: [{ q: "OpenAI news" }],
      freshness: "indexed",
      searchContextSize: "medium",
    });

    assert.equal(requestedUrl, "https://example.test/backend/codex/alpha/search");
    assert.equal(requestedHeaders.get("openai-beta"), "responses=experimental");
    assert.deepEqual(requestedBody, {
      id: "pi-codex-search",
      model: "gpt-test",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "OpenAI news" }],
        },
      ],
      commands: { search_query: [{ q: "OpenAI news" }] },
      settings: {
        search_context_size: "medium",
        allowed_callers: ["direct"],
        external_web_access: "indexed",
      },
      max_output_tokens: 8000,
    });
    assert.equal(result.text, "Search result.");
    assert.equal(result.encryptedOutput, "ciphertext");
    assert.deepEqual(result.results, [
      {
        type: "text_result",
        ref_id: "turn0search0",
        title: "OpenAI",
        url: "https://openai.com",
        future_field: { preserved: true },
      },
    ]);
    assert.deepEqual(result.refIds, { turn0search0: "turn0search0" });
    assert.deepEqual(result.citations, [{ title: "OpenAI", url: "https://openai.com" }]);
  });

  it("treats null standalone structured results as unavailable", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ output: "Lookup result turn0fetch0", results: null }));
    const transport = createTransport({
      token: "token",
      accountId: "account",
      baseUrl: "https://example.test/backend/codex",
      fetchImpl: fetchImpl as typeof fetch,
    });

    const result = await runStandaloneCommands({
      model: "gpt-test",
      transport,
      sessionId: "pi-codex-search",
      open: [{ refId: "https://example.com" }],
      freshness: "live",
    });

    assert.equal(result.results, undefined);
    assert.deepEqual(result.refIds, { turn0fetch0: "turn0fetch0" });
  });

  it("posts standalone web content and lookup commands one action per request", async () => {
    const cases: Array<{
      options: Partial<StandaloneCommandsOptions>;
      expectedCommands: Record<string, unknown>;
      expectedCall?: { actionType?: string; refId?: string; query?: string };
    }> = [
      {
        options: { open: [{ refId: "https://example.com/docs" }] },
        expectedCommands: { open: [{ ref_id: "https://example.com/docs" }] },
        expectedCall: { actionType: "open_page", refId: "https://example.com/docs" },
      },
      {
        options: { find: [{ refId: "https://example.com/docs", pattern: "install" }] },
        expectedCommands: {
          find: [{ ref_id: "https://example.com/docs", pattern: "install" }],
        },
        expectedCall: { actionType: "find_in_page", refId: "https://example.com/docs" },
      },
      {
        options: { click: [{ refId: "https://example.com/docs", id: 7 }] },
        expectedCommands: { click: [{ ref_id: "https://example.com/docs", id: 7 }] },
        expectedCall: { actionType: "click", refId: "https://example.com/docs" },
      },
      {
        options: { screenshot: [{ refId: "https://example.com/docs", pageno: 1 }] },
        expectedCommands: {
          screenshot: [{ ref_id: "https://example.com/docs", pageno: 1 }],
        },
        expectedCall: { actionType: "screenshot", refId: "https://example.com/docs" },
      },
      {
        options: { finance: [{ ticker: "AMD", type: "equity", market: "USA" }] },
        expectedCommands: { finance: [{ ticker: "AMD", type: "equity", market: "USA" }] },
        expectedCall: { actionType: "finance", query: "AMD" },
      },
      {
        options: { weather: [{ location: "San Francisco, CA" }] },
        expectedCommands: { weather: [{ location: "San Francisco, CA" }] },
        expectedCall: { actionType: "weather", query: "San Francisco, CA" },
      },
      {
        options: {
          sports: [
            {
              fn: "schedule",
              league: "nba",
              team: "GSW",
              date_from: "2026-01-01",
              date_to: "2026-01-31",
              num_games: 3,
            },
          ],
        },
        expectedCommands: {
          sports: [
            {
              fn: "schedule",
              league: "nba",
              team: "GSW",
              date_from: "2026-01-01",
              date_to: "2026-01-31",
              num_games: 3,
            },
          ],
        },
        expectedCall: { actionType: "sports", query: "schedule nba" },
      },
      {
        options: { time: [{ utc_offset: "+03:00" }] },
        expectedCommands: { time: [{ utc_offset: "+03:00" }] },
        expectedCall: { actionType: "time", query: "+03:00" },
      },
      {
        options: { imageQuery: [{ q: "waterfalls" }] },
        expectedCommands: { image_query: [{ q: "waterfalls" }] },
        expectedCall: { actionType: "image_query", query: "waterfalls" },
      },
    ];

    for (const testCase of cases) {
      let requestedBody = {} as { commands?: Record<string, unknown> };
      const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
        requestedBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ output: "Lookup result turn0fetch0" }));
      };

      const transport = createTransport({
        token: "token",
        accountId: "account",
        baseUrl: "https://example.test/backend/codex",
        fetchImpl: fetchImpl as typeof fetch,
      });

      const result = await runStandaloneCommands({
        model: "gpt-test",
        transport,
        sessionId: "pi-codex-search",
        freshness: "live",
        ...testCase.options,
      });

      assert.deepEqual(requestedBody.commands, testCase.expectedCommands);
      if (testCase.expectedCall) {
        const call = result.searchCalls[0];
        assert.equal(call?.actionType, testCase.expectedCall.actionType);
        if (testCase.expectedCall.refId !== undefined) {
          assert.equal(call?.refId, testCase.expectedCall.refId);
        }
        if (testCase.expectedCall.query !== undefined) {
          assert.equal(call?.query, testCase.expectedCall.query);
        }
      }
    }
  });

  it("prefers opened page refs for standalone follow-up actions", () => {
    assert.equal(
      selectStandalonePageRefId({ turn0search0: "turn0search0", turn0view0: "turn0view0" }),
      "turn0view0",
    );
    assert.equal(selectStandalonePageRefId({ turn0fetch0: "turn0fetch0" }), "turn0fetch0");
  });

  it("reuses caller-provided standalone session id across follow-up turns", async () => {
    const ids: string[] = [];
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id?: string };
      if (body.id) ids.push(body.id);
      return new Response(JSON.stringify({ output: "Lookup result turn0view0" }));
    };

    const transport = createTransport({
      token: "token",
      accountId: "account",
      baseUrl: "https://example.test/backend/codex",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const sessionId = "pi-codex-session-123";

    await runStandaloneCommands({
      model: "gpt-test",
      transport,
      sessionId,
      open: [{ refId: "https://example.com" }],
      freshness: "live",
      searchContextSize: "medium",
    });
    await runStandaloneCommands({
      model: "gpt-test",
      transport,
      sessionId,
      find: [{ refId: "turn0view0", pattern: "Example" }],
      freshness: "live",
      searchContextSize: "medium",
    });

    assert.deepEqual(ids, [sessionId, sessionId]);
  });

  it("rejects standalone low", async () => {
    const transport = createTransport({
      token: "token",
      accountId: "account",
      baseUrl: "https://example.test/backend/codex",
    });

    await assert.rejects(
      runStandaloneCommands({
        model: "gpt-test",
        transport,
        sessionId: "pi-codex-search",
        searchQuery: [{ q: "OpenAI news" }],
        freshness: "indexed",
        searchContextSize: "low",
      }),
      /standalone\/low is disabled/,
    );
  });

  it("rejects standalone action batching", async () => {
    const transport = createTransport({
      token: "token",
      accountId: "account",
      baseUrl: "https://example.test/backend/codex",
    });

    await assert.rejects(
      runStandaloneCommands({
        model: "gpt-test",
        transport,
        sessionId: "pi-codex-search",
        searchQuery: [{ q: "OpenAI news" }, { q: "Codex release notes" }],
        freshness: "live",
      }),
      /one per request/,
    );
  });

  it("sets response_length for standalone single requests when requested", async () => {
    let requestedBody = {} as { commands?: { response_length?: string } };
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
      requestedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ output: "Result" }));
    };

    const transport = createTransport({
      token: "token",
      accountId: "account",
      baseUrl: "https://example.test/backend/codex",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await runStandaloneCommands({
      model: "gpt-test",
      transport,
      sessionId: "pi-codex-search",
      searchQuery: [{ q: "q1" }],
      freshness: "live",
      responseLength: "medium",
    });

    assert.equal(requestedBody.commands?.response_length, "medium");
  });

  it("rejects empty standalone command batches", async () => {
    const transport = createTransport({
      token: "token",
      accountId: "account",
      baseUrl: "https://example.test/backend/codex",
    });

    await assert.rejects(
      runStandaloneCommands({
        model: "gpt-test",
        transport,
        sessionId: "pi-codex-search",
        searchQuery: [],
        freshness: "live",
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match((error as Error).message, /at least one command/);
        return true;
      },
    );
  });

  it("formats query preview lines as a tree", () => {
    assert.deepEqual(formatQueryPreviewLines(["first query", "second query"]), [
      "  ├ first query",
      "  └ second query",
    ]);
  });

  it("does not send unsupported index_gated_web_access to /codex/responses", async () => {
    let requestedBody = {} as { tools?: Array<Record<string, unknown>> };
    const sse = [
      'event: response.output_item.done\ndata: {"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}}\n\n',
      'event: response.completed\ndata: {"response":{"usage":{"total_tokens":1}}}\n\n',
    ].join("");
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
      requestedBody = JSON.parse(String(init?.body));
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    };

    const transport = createTransport({
      token: "token",
      accountId: "account",
      baseUrl: "https://example.test/backend",
      fetchImpl: fetchImpl as typeof fetch,
    });

    const result = await runResponsesSearch({
      query: "q",
      model: "m",
      transport,
      externalWebAccess: true,
      searchContextSize: "medium",
    });

    assert.equal(result.text, "ok");
    assert.equal(requestedBody.tools?.[0]?.index_gated_web_access, undefined);
  });

  it("sends canonical indexed_web_access to /codex/responses", async () => {
    let requestedBody = {} as { tools?: Array<Record<string, unknown>> };
    const sse =
      'event: response.output_item.done\ndata: {"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}}\n\n';
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
      requestedBody = JSON.parse(String(init?.body));
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    };

    const transport = createTransport({
      token: "token",
      accountId: "account",
      baseUrl: "https://example.test/backend",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await runResponsesSearch({
      query: "q",
      model: "m",
      transport,
      externalWebAccess: true,
      indexedWebAccess: true,
    });

    assert.equal(requestedBody.tools?.[0]?.indexed_web_access, true);
  });

  it("summarizes Cloudflare challenge HTML errors", async () => {
    const fetchImpl = async () =>
      new Response(
        '<html><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script></html>',
        {
          status: 403,
          headers: { "content-type": "text/html" },
        },
      );

    const transport = createTransport({
      token: "token",
      accountId: "account",
      baseUrl: "https://example.test/backend/codex",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await assert.rejects(
      runStandaloneCommands({
        model: "gpt-test",
        transport,
        sessionId: "pi-codex-search",
        searchQuery: [{ q: "q" }],
        freshness: "live",
      }),
      (error: unknown) => {
        assert.ok(error instanceof CodexError);
        assert.equal(error.kind, "auth");
        assert.match(error.message, /Cloudflare challenge blocked/);
        assert.doesNotMatch(error.message, /<html>/);
        return true;
      },
    );
  });

  it("classifies HTTP 429 from /codex/responses as a rate_limit CodexError", async () => {
    const fetchImpl = async () =>
      new Response("too many", { status: 429, statusText: "Too Many Requests" });

    const transport = createTransport({
      token: "token",
      accountId: "account",
      baseUrl: "https://example.test/backend",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await assert.rejects(
      runResponsesSearch({
        query: "q",
        model: "m",
        transport,
        externalWebAccess: true,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CodexError);
        assert.equal(error.kind, "rate_limit");
        assert.equal(error.status, 429);
        return true;
      },
    );
  });

  it("maps response.failed events to a kind based on the error message", async () => {
    const sse =
      'event: response.failed\r\ndata: {"error":{"message":"Rate limit exceeded"}}\r\n\r\n';
    const fetchImpl = async () =>
      new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    const transport = createTransport({
      token: "token",
      accountId: "account",
      baseUrl: "https://example.test/backend",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await assert.rejects(
      runResponsesSearch({
        query: "q",
        model: "m",
        transport,
        externalWebAccess: true,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CodexError);
        assert.equal(error.kind, "rate_limit");
        return true;
      },
    );
  });

  it("classifies generic errors via classifyError", () => {
    assert.equal(classifyError(new CodexError("auth", "x")), "auth");
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    assert.equal(classifyError(abortErr), "timeout");
    assert.equal(classifyError(new Error("boom")), "unknown");
  });

  it("passes client_version to the models endpoint", async () => {
    let requestedUrl = "";
    const fetchImpl = async (input: string | URL | Request) => {
      requestedUrl = String(input);
      return new Response(
        JSON.stringify({
          models: [{ slug: "gpt-default", is_default: true }],
        }),
      );
    };

    const models = await fetchCodexModels({
      token: "token",
      accountId: "account",
      baseUrl: "https://example.test/backend",
      clientVersion: "9.9.9",
      fetchImpl: fetchImpl as typeof fetch,
    });

    assert.equal(models[0]?.id, "gpt-default");
    assert.equal(new URL(requestedUrl).searchParams.get("client_version"), "9.9.9");
  });
});
