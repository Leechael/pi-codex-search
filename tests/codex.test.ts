import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyError,
  CodexError,
  extractAccountIdFromToken,
  fetchCodexModels,
  fetchCodexWebSearch,
  normalizeCodexBaseUrl,
  resolveCodexEndpoint,
  selectDefaultModel,
} from "../src/codex.ts";

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
