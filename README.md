# pi-codex-search

[![npm](https://img.shields.io/npm/v/pi-codex-search)](https://www.npmjs.com/package/pi-codex-search)
[![license](https://img.shields.io/npm/l/pi-codex-search)](./LICENSE)

**Give Pi a `codex_search` tool through your Codex subscription.**

Pi is the harness. Codex already has a ChatGPT-backed search path. This package connects the two: it adds a normal Pi tool that searches the web through the `openai-codex` account you already use in Pi.

No `ACCESS_TOKEN` env var. No separate login flow. If Pi can use your Codex subscription, this extension can use the same auth.

## Why this exists

Pi keeps the core small on purpose. Search does not have to be baked into the harness; it can be a tool.

This extension is for the cases where your Pi workflow needs fresh or source-backed information:

- **Current docs and release notes.** Ask the model to look up something that changed after its training cutoff.
- **Source-backed answers.** The tool returns citations alongside the text.
- **Codex account reuse.** It uses Pi's existing `openai-codex` OAuth credential instead of asking you to paste tokens.
- **Custom Pi workflows.** Any model in Pi can see the tool once the Codex auth is available at session start.

## What this package adds

- **A `codex_search` tool** — query the web from inside Pi.
- **Codex auth reuse** — reads the same `openai-codex` credential that Pi stores after `/login openai-codex`.
- **No manual token handling** — the extension does not read `ACCESS_TOKEN` during normal Pi usage.
- **Model selection that follows Pi** — use an explicit env override, the active Codex model, or the default model from Codex's model list.
- **Streaming updates** — partial answer text is sent back while the search response streams.
- **Structured details** — the final tool result includes citations, search calls, response id, model, and usage.

## Install

From npm:

```bash
pi install npm:pi-codex-search
```

Or load a local checkout without installing:

```bash
pi -e /path/to/pi-codex-search
```

### Install from GitHub Release tarball

If you prefer not to use npm, download the tarball from the [latest release](https://github.com/Leechael/pi-codex-search/releases/latest), extract it, and install from the local path:

```bash
curl -L https://github.com/Leechael/pi-codex-search/releases/latest/download/pi-codex-search.tar.gz | tar -xz -C /tmp
pi install /tmp/pi-codex-search
```

## Sign in

Inside Pi, run:

```text
/login openai-codex
```

Choose `ChatGPT Plus/Pro (Codex Subscription)` if Pi asks which provider to use. Pi stores and refreshes the credential.

The extension always registers `codex_search`. If Pi has no `openai-codex` token, or if the ChatGPT account id cannot be recovered from the stored OAuth credential or decoded access token, the tool fails on first call with an `auth`-kind error pointing the user at `/login openai-codex`.

## Tool

The extension registers one tool:

```json
{
  "name": "codex_search",
  "arguments": {
    "queries": ["latest OpenAI Codex release notes"],
    "search_context_size": "medium",
    "freshness": "live"
  }
}
```

Arguments:

- `queries` — required array of 1–5 search questions. Each query is dispatched in parallel; results are returned grouped by query.
- `search_context_size` — optional, one of `low`, `medium`, `high`; defaults to `medium`.
- `freshness` — optional, `live` or `cached`; `live` enables external web access, `cached` skips it. Defaults to `live`.

The tool returns text plus a `Sources:` section when citations are available. The structured `details` object includes:

- `model`
- `freshness` / `searchContextSize`
- `queryCount` / `failedQueryCount`
- `successes`: per-query `{ query, text, citations, searchCalls, responseId?, usage? }`
- `failures`: per-query `{ query, kind, message }` with `kind` one of `auth`, `rate_limit`, `transport`, `timeout`, `schema`, `unknown`

## Model used for search

The search request needs a Codex model id. The extension chooses it in this order:

1. `model` from env / project / home configuration, if set.
2. The active Pi model, if it comes from the `openai-codex` provider.
3. The default model from Codex's `/codex/models` response.

Most users do not need to set anything.

## Configuration

Settings are merged from three layers, highest precedence first:

1. Environment variables (table below).
2. Project file: `<cwd>/.pi/pi-codex-search.json`.
3. Home file: `~/.pi/pi-codex-search.json`.

Each layer is optional. Missing files are skipped silently; malformed JSON or invalid values throw on load.

Full schema (all fields optional):

```json
{
  "toolName": "codex_search",
  "model": "gpt-5-codex",
  "baseUrl": "https://chatgpt.com/backend-api",
  "clientVersion": "1.0.0",
  "searchContextSize": "medium",
  "freshness": "live"
}
```

Environment variable equivalents:

| Field               | Env var                              |
| ------------------- | ------------------------------------ |
| `toolName`          | `PI_CODEX_WEB_SEARCH_TOOL_NAME`      |
| `model`             | `PI_CODEX_WEB_SEARCH_MODEL`          |
| `baseUrl`           | `PI_CODEX_WEB_SEARCH_BASE_URL`       |
| `clientVersion`     | `PI_CODEX_WEB_SEARCH_CLIENT_VERSION` |
| `searchContextSize` | `PI_CODEX_WEB_SEARCH_CONTEXT_SIZE`   |
| `freshness`         | `PI_CODEX_WEB_SEARCH_FRESHNESS`      |

### Slash command

`/codex-search-settings` opens an interactive settings dialog (in interactive mode). Subcommands:

- `/codex-search-settings` — open the main dialog (project / home config editors, reset menu).
- `/codex-search-settings status` — print the merged configuration and which layers contributed.
- `/codex-search-settings reset` — open the reset menu (delete project or home config file).

Each edit writes the matching scope file immediately. On dialog close, the extension calls `ctx.reload()` so the new `toolName` and defaults apply without restarting pi.

### Renaming the tool

The most common reason to use configuration is to avoid colliding with another extension that registers `codex_search` (or whatever default you picked). Set `toolName` in either config file or via env to expose this extension under a different name. Tool names must match `[a-zA-Z_][a-zA-Z0-9_]{0,63}`.

## Notes

### Codex search vs model search

This does not add browsing to the model provider itself. It adds a Pi tool. The model decides when to call `codex_search`, just like any other tool.

### Account id

Codex requests need both the access token and the ChatGPT account id. The extension first checks Pi's stored OAuth credential. If that does not include an account id, it tries to extract one from the access token.

### Headers

The extension builds the Codex request headers itself, including `Authorization`, `chatgpt-account-id`, `originator: pi`, `OpenAI-Beta: responses=experimental`, `accept`, and `content-type`.

## Troubleshooting

### `codex_search` fails with an `auth`-kind error

The tool is always registered, but the first call fails when Pi has no `openai-codex` token or the ChatGPT account id cannot be recovered. Run:

```text
/login openai-codex
```

If Pi asks for a provider, choose `ChatGPT Plus/Pro (Codex Subscription)`. The extension picks up the refreshed credential on the next call.

### `codex_search` says the account id was not found

The stored OAuth credential did not include an account id, and the extension could not decode one from the access token. Re-run `/login openai-codex` so Pi refreshes the credential.

### Search uses the wrong model

Set `model` in your config file (or `PI_CODEX_WEB_SEARCH_MODEL`) to the Codex model id you want. If unset, the extension uses the active Codex model when possible, then falls back to the default model from `/codex/models`.

### A different extension already registers `codex_search`

Use `/codex-search-settings` to rename this extension's tool (or set `toolName` in `~/.pi/pi-codex-search.json`). Reload pi to apply.

## Development

```bash
npm install
npm run check
npm test
npm run lint
npm run format:check
```

## Release

This repository follows the same release shape as `pi-provider-kimi-code`:

- `release-naming.env` defines `PKG_NAME=pi-codex-search` and `TAG_PREFIX=v`.
- `scripts/next-version.sh` computes the next semantic version from tags.
- `.github/workflows/release-command.yml` creates release commits and tags.
- `.github/workflows/release-on-tag.yml` publishes to npm with provenance and attaches `pi-codex-search.tar.gz` to the GitHub release.

## References

- Pi: [earendil-works/pi](https://github.com/earendil-works/pi)

## License

MIT
