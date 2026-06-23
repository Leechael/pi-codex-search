import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyError,
  CodexError,
  extractAccountIdFromToken,
  fetchCodexModels,
  fetchCodexStandaloneSearch,
  fetchCodexStandaloneSearchBatch,
  fetchCodexWebSearch,
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
        assert.ok(error instanceof CodexError);
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

    const result = await fetchCodexStandaloneSearch({
      query: "OpenAI news",
      token: "token",
      accountId: "account",
      model: "gpt-test",
      baseUrl: "https://example.test/backend/codex",
      externalWebAccess: "indexed",
      searchContextSize: "low",
      fetchImpl: fetchImpl as typeof fetch,
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
    });
    assert.equal(result.text, "Search result from [OpenAI](https://openai.com).");
    assert.equal(result.encryptedOutput, "ciphertext");
    assert.deepEqual(result.citations, [
      { title: "OpenAI", url: "https://openai.com", startIndex: 19 },
    ]);
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

    const result = await fetchCodexStandaloneSearchBatch({
      queries: ["OpenAI news", "Codex release notes"],
      token: "token",
      accountId: "account",
      model: "gpt-test",
      baseUrl: "https://example.test/backend/codex",
      fetchImpl: fetchImpl as typeof fetch,
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

    await fetchCodexStandaloneSearchBatch({
      queries: ["q1", "q2", "q3", "q4"],
      token: "token",
      accountId: "account",
      model: "gpt-test",
      fetchImpl: fetchImpl as typeof fetch,
    });

    assert.equal(requestedBody.commands?.response_length, "medium");
  });

  it("rejects empty standalone query batches", async () => {
    await assert.rejects(
      fetchCodexStandaloneSearchBatch({
        queries: [" ", ""],
        token: "token",
        accountId: "account",
        model: "gpt-test",
      }),
      (error: unknown) => {
        assert.ok(error instanceof CodexError);
        assert.equal(error.kind, "schema");
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

  it("returns a concise Cloudflare error for standalone search 403", async () => {
    const fetchImpl = async () =>
      new Response("<html><title>Just a moment...</title><body>Cloudflare</body></html>", {
        status: 403,
        statusText: "Forbidden",
        headers: { "content-type": "text/html", "cf-ray": "test-ray" },
      });

    await assert.rejects(
      fetchCodexStandaloneSearch({
        query: "q",
        token: "t",
        accountId: "a",
        model: "m",
        baseUrl: "https://example.test/backend",
        fetchImpl: fetchImpl as typeof fetch,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CodexError);
        assert.equal(error.kind, "auth");
        assert.equal(error.status, 403);
        assert.match(error.message, /Cloudflare blocked the request/);
        assert.match(error.message, /searchApi=responses/);
        assert.doesNotMatch(error.message, /<html>/);
        return true;
      },
    );
  });

  it("does not return raw HTML bodies to the model", async () => {
    const fetchImpl = async () =>
      new Response(
        "<html><head><title>Forbidden &amp; blocked</title></head><body>secret challenge</body></html>",
        {
          status: 403,
          statusText: "Forbidden",
          headers: { "content-type": "text/html" },
        },
      );

    await assert.rejects(
      fetchCodexStandaloneSearch({
        query: "q",
        token: "t",
        accountId: "a",
        model: "m",
        baseUrl: "https://example.test/backend",
        fetchImpl: fetchImpl as typeof fetch,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CodexError);
        assert.equal(error.kind, "auth");
        assert.equal(error.status, 403);
        assert.match(error.message, /HTTP 403/);
        assert.match(error.message, /HTML page title: Forbidden & blocked/);
        assert.doesNotMatch(error.message, /<html>/);
        assert.doesNotMatch(error.message, /secret challenge/);
        return true;
      },
    );
  });

  it("keeps backend error details when Cloudflare headers wrap a JSON API error", async () => {
    const fetchImpl = async () =>
      new Response('{"error":"backend denied"}', {
        status: 403,
        statusText: "Forbidden",
        headers: { "content-type": "application/json", "cf-ray": "test-ray" },
      });

    await assert.rejects(
      fetchCodexStandaloneSearch({
        query: "q",
        token: "t",
        accountId: "a",
        model: "m",
        baseUrl: "https://example.test/backend",
        fetchImpl: fetchImpl as typeof fetch,
      }),
      (error: unknown) => {
        assert.ok(error instanceof CodexError);
        assert.equal(error.kind, "auth");
        assert.equal(error.status, 403);
        assert.match(error.message, /backend denied/);
        assert.doesNotMatch(error.message, /Cloudflare blocked the request/);
        return true;
      },
    );
  });

  it("classifies HTTP 429 from /codex/responses as a rate_limit CodexError", async () => {
    const fetchImpl = async () =>
      new Response("too many", { status: 429, statusText: "Too Many Requests" });

    await assert.rejects(
      fetchCodexWebSearch({
        query: "q",
        token: "t",
        accountId: "a",
        model: "m",
        baseUrl: "https://example.test/backend",
        fetchImpl: fetchImpl as typeof fetch,
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
    const sse = 'event: response.failed\ndata: {"error":{"message":"Rate limit exceeded"}}\n\n';
    const fetchImpl = async () =>
      new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });

    await assert.rejects(
      fetchCodexWebSearch({
        query: "q",
        token: "t",
        accountId: "a",
        model: "m",
        baseUrl: "https://example.test/backend",
        fetchImpl: fetchImpl as typeof fetch,
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
