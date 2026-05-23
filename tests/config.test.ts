import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  CONFIG_FILE_NAME,
  DEFAULT_ENABLED,
  DEFAULT_FRESHNESS,
  DEFAULT_SEARCH_CONTEXT_SIZE,
  DEFAULT_TOOL_NAME,
  deleteConfig,
  getConfigPath,
  loadConfig,
  saveConfig,
} from "../src/config.ts";

const ENV_KEYS = [
  "PI_CODEX_WEB_SEARCH_ENABLED",
  "PI_CODEX_WEB_SEARCH_TOOL_NAME",
  "PI_CODEX_WEB_SEARCH_MODEL",
  "PI_CODEX_WEB_SEARCH_BASE_URL",
  "PI_CODEX_WEB_SEARCH_CLIENT_VERSION",
  "PI_CODEX_WEB_SEARCH_CONTEXT_SIZE",
  "PI_CODEX_WEB_SEARCH_FRESHNESS",
] as const;

describe("config loader", () => {
  let cwd: string;
  let home: string;
  let savedEnv: Map<string, string | undefined>;
  let savedHome: string | undefined;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "pi-codex-cwd-"));
    home = await mkdtemp(join(tmpdir(), "pi-codex-home-"));
    savedHome = process.env.HOME;
    process.env.HOME = home;
    savedEnv = new Map();
    for (const key of ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    for (const key of ENV_KEYS) {
      const saved = savedEnv.get(key);
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it("returns defaults when no files or env are present", async () => {
    const resolved = await loadConfig(cwd);
    assert.equal(resolved.enabled, DEFAULT_ENABLED);
    assert.equal(resolved.toolName, DEFAULT_TOOL_NAME);
    assert.equal(resolved.defaultFreshness, DEFAULT_FRESHNESS);
    assert.equal(resolved.defaultSearchContextSize, DEFAULT_SEARCH_CONTEXT_SIZE);
    assert.equal(resolved.model, undefined);
    assert.deepEqual(resolved.sources, {});
  });

  it("reads enabled=false from the project file", async () => {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", CONFIG_FILE_NAME),
      JSON.stringify({ enabled: false }),
      "utf-8",
    );
    const resolved = await loadConfig(cwd);
    assert.equal(resolved.enabled, false);
  });

  it("env overrides enabled with case-insensitive true/false", async () => {
    await mkdir(join(home, ".pi"), { recursive: true });
    await writeFile(
      join(home, ".pi", CONFIG_FILE_NAME),
      JSON.stringify({ enabled: false }),
      "utf-8",
    );

    process.env.PI_CODEX_WEB_SEARCH_ENABLED = "TRUE";
    let resolved = await loadConfig(cwd);
    assert.equal(resolved.enabled, true);

    process.env.PI_CODEX_WEB_SEARCH_ENABLED = "False";
    resolved = await loadConfig(cwd);
    assert.equal(resolved.enabled, false);
  });

  it("rejects a non-boolean enabled in the file", async () => {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", CONFIG_FILE_NAME),
      JSON.stringify({ enabled: "yes" }),
      "utf-8",
    );
    await assert.rejects(loadConfig(cwd), /Invalid enabled/);
  });

  it("rejects an unparseable enabled env value", async () => {
    process.env.PI_CODEX_WEB_SEARCH_ENABLED = "maybe";
    await assert.rejects(loadConfig(cwd), /PI_CODEX_WEB_SEARCH_ENABLED/);
  });

  it("reads the home config when only the home file exists", async () => {
    await mkdir(join(home, ".pi"), { recursive: true });
    await writeFile(
      join(home, ".pi", CONFIG_FILE_NAME),
      JSON.stringify({ toolName: "home_search", freshness: "cached" }),
      "utf-8",
    );

    const resolved = await loadConfig(cwd);
    assert.equal(resolved.toolName, "home_search");
    assert.equal(resolved.defaultFreshness, "cached");
    assert.ok(resolved.sources.home);
    assert.equal(resolved.sources.project, undefined);
  });

  it("lets the project file override the home file", async () => {
    await mkdir(join(home, ".pi"), { recursive: true });
    await writeFile(
      join(home, ".pi", CONFIG_FILE_NAME),
      JSON.stringify({ toolName: "home_search", model: "home_model" }),
      "utf-8",
    );
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", CONFIG_FILE_NAME),
      JSON.stringify({ toolName: "project_search" }),
      "utf-8",
    );

    const resolved = await loadConfig(cwd);
    assert.equal(resolved.toolName, "project_search");
    // Home-only fields fall through.
    assert.equal(resolved.model, "home_model");
    assert.ok(resolved.sources.home);
    assert.ok(resolved.sources.project);
  });

  it("lets env override files", async () => {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", CONFIG_FILE_NAME),
      JSON.stringify({ toolName: "project_search", freshness: "cached" }),
      "utf-8",
    );
    process.env.PI_CODEX_WEB_SEARCH_TOOL_NAME = "env_search";
    process.env.PI_CODEX_WEB_SEARCH_FRESHNESS = "live";

    const resolved = await loadConfig(cwd);
    assert.equal(resolved.toolName, "env_search");
    assert.equal(resolved.defaultFreshness, "live");
    assert.ok(resolved.sources.env);
  });

  it("throws with the file path when JSON is invalid", async () => {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    const filePath = join(cwd, ".pi", CONFIG_FILE_NAME);
    await writeFile(filePath, "{not json", "utf-8");

    await assert.rejects(loadConfig(cwd), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Invalid JSON/);
      assert.ok(error.message.includes(filePath));
      return true;
    });
  });

  it("rejects an invalid toolName", async () => {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", CONFIG_FILE_NAME),
      JSON.stringify({ toolName: "9bad-name" }),
      "utf-8",
    );

    await assert.rejects(loadConfig(cwd), /Invalid toolName/);
  });

  it("rejects an invalid freshness value", async () => {
    process.env.PI_CODEX_WEB_SEARCH_FRESHNESS = "stale";
    await assert.rejects(loadConfig(cwd), /Invalid freshness/);
  });

  it("rejects an invalid searchContextSize value", async () => {
    await mkdir(join(home, ".pi"), { recursive: true });
    await writeFile(
      join(home, ".pi", CONFIG_FILE_NAME),
      JSON.stringify({ searchContextSize: "huge" }),
      "utf-8",
    );
    await assert.rejects(loadConfig(cwd), /Invalid searchContextSize/);
  });

  it("saveConfig writes a file at the right path and roundtrips through loadConfig", async () => {
    const filePath = await saveConfig("project", cwd, {
      toolName: "saved_search",
      freshness: "cached",
    });
    assert.equal(filePath, join(cwd, ".pi", CONFIG_FILE_NAME));
    assert.equal(filePath, getConfigPath("project", cwd));

    const resolved = await loadConfig(cwd);
    assert.equal(resolved.toolName, "saved_search");
    assert.equal(resolved.defaultFreshness, "cached");
  });

  it("deleteConfig removes the file and reports whether it existed", async () => {
    await saveConfig("project", cwd, { toolName: "tmp" });
    const first = await deleteConfig("project", cwd);
    const second = await deleteConfig("project", cwd);
    assert.equal(first, true);
    assert.equal(second, false);
  });
});
