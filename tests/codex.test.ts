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

  it("posts standalone web content and lookup commands", async () => {
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
      open: [{ refId: "https://example.com/docs" }],
      find: [{ refId: "https://example.com/docs", pattern: "install" }],
      click: [{ refId: "https://example.com/docs", id: 7 }],
      screenshot: [{ refId: "https://example.com/docs", pageno: 1 }],
      finance: [{ ticker: "AMD", type: "equity", market: "USA" }],
      weather: [{ location: "San Francisco, CA" }],
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
      time: [{ utc_offset: "+03:00" }],
      imageQuery: [{ q: "waterfalls" }],
      freshness: "live",
    });

    assert.deepEqual(requestedBody.commands?.open, [{ ref_id: "https://example.com/docs" }]);
    assert.deepEqual(requestedBody.commands?.find, [
      { ref_id: "https://example.com/docs", pattern: "install" },
    ]);
    assert.deepEqual(requestedBody.commands?.click, [
      { ref_id: "https://example.com/docs", id: 7 },
    ]);
    assert.deepEqual(requestedBody.commands?.screenshot, [
      { ref_id: "https://example.com/docs", pageno: 1 },
    ]);
    assert.deepEqual(requestedBody.commands?.finance, [
      { ticker: "AMD", type: "equity", market: "USA" },
    ]);
    assert.deepEqual(requestedBody.commands?.weather, [{ location: "San Francisco, CA" }]);
    assert.deepEqual(requestedBody.commands?.sports, [
      {
        fn: "schedule",
        league: "nba",
        team: "GSW",
        date_from: "2026-01-01",
        date_to: "2026-01-31",
        num_games: 3,
      },
    ]);
    assert.deepEqual(requestedBody.commands?.time, [{ utc_offset: "+03:00" }]);
    assert.deepEqual(requestedBody.commands?.image_query, [{ q: "waterfalls" }]);
    assert.deepEqual(result.refIds, { turn0fetch0: "turn0fetch0" });
    assert.deepEqual(
      result.searchCalls
        .filter((call) =>
          ["open_page", "find_in_page", "click", "screenshot"].includes(call.actionType ?? ""),
        )
        .map((call) => ({ actionType: call.actionType, refId: call.refId, url: call.url })),
      [
        { actionType: "open_page", refId: "https://example.com/docs", url: undefined },
        { actionType: "find_in_page", refId: "https://example.com/docs", url: undefined },
        { actionType: "click", refId: "https://example.com/docs", url: undefined },
        { actionType: "screenshot", refId: "https://example.com/docs", url: undefined },
      ],
    );
  });

  it("batches standalone queries into one /alpha/search request", async () => {
    let requestedBody: unknown;
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
      requestedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          output: "Batch result",
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
      searchQuery: [{ q: "OpenAI news" }, { q: "Codex release notes" }],
      freshness: "live",
    });

    assert.deepEqual(requestedBody, {
      id: "pi-codex-search",
      model: "gpt-test",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "OpenAI news\nCodex release notes" }],
        },
      ],
      commands: {
        search_query: [{ q: "OpenAI news" }, { q: "Codex release notes" }],
      },
      settings: {
        search_context_size: "medium",
        allowed_callers: ["direct"],
        external_web_access: true,
      },
      max_output_tokens: 8000,
    });
    assert.equal(result.text, "Batch result");
    assert.deepEqual(
      result.searchCalls.map((call) => call.query),
      ["OpenAI news", "Codex release notes"],
    );
  });

  it("sets response_length for standalone batches above three queries", async () => {
    let requestedBody = {} as { commands?: { response_length?: string } };
    const fetchImpl = async (_input: string | URL | Request, init?: RequestInit) => {
      requestedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ output: "Batch result" }));
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
      searchQuery: [{ q: "q1" }, { q: "q2" }, { q: "q3" }, { q: "q4" }],
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
