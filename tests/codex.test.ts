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
import { formatQueryPreviewLines } from "../index.ts";

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
    assert.equal(headers.get("openai-beta"), "responses=experimental");
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
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          encrypted_output: "ciphertext",
          output: "Search result from [OpenAI](https://openai.com).",
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
      searchContextSize: "low",
    });

    assert.equal(requestedUrl, "https://example.test/backend/codex/alpha/search");
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
        search_context_size: "low",
        allowed_callers: ["direct"],
        external_web_access: "indexed",
      },
      max_output_tokens: 8000,
    });
    assert.equal(result.text, "Search result from [OpenAI](https://openai.com).");
    assert.equal(result.encryptedOutput, "ciphertext");
    assert.deepEqual(result.citations, [
      { title: "OpenAI", url: "https://openai.com", startIndex: 19 },
    ]);
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

  it("formats query preview lines without result snippets", () => {
    assert.deepEqual(formatQueryPreviewLines(["first query", "second query"]), [
      "  ⌕ 1. first query",
      "  ⌕ 2. second query",
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

  it("sends index_gated_web_access=true only for indexed /codex/responses", async () => {
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
      indexGatedWebAccess: true,
    });

    assert.equal(requestedBody.tools?.[0]?.index_gated_web_access, true);
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
