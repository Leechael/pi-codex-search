import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface RefStore {
  resolveRefId(url: string): string | undefined;
  remember(url: string, refId: string): Promise<void>;
  load(sessionDir: string): Promise<void>;
}

interface StoredRefs {
  urlToRefId: Record<string, string>;
}

const STORE_FILE = "pi-codex-search-refs.json";
const PERSIST_QUEUES = new Map<string, Promise<void>>();

export function createRefStore(): RefStore {
  const urlToRefId = new Map<string, string>();
  let sessionDir: string | undefined;

  return {
    resolveRefId(url: string): string | undefined {
      return urlToRefId.get(url) ?? undefined;
    },

    async remember(url: string, refId: string): Promise<void> {
      urlToRefId.set(url, refId);
      if (sessionDir) {
        await enqueuePersist(sessionDir, urlToRefId);
      }
    },

    async load(dir: string): Promise<void> {
      sessionDir = dir;
      const stored = await loadStored(dir);
      for (const [url, refId] of Object.entries(stored.urlToRefId)) {
        urlToRefId.set(url, refId);
      }
    },
  };
}

async function loadStored(dir: string): Promise<StoredRefs> {
  try {
    const raw = await readFile(join(dir, STORE_FILE), "utf-8");
    const parsed = JSON.parse(raw) as StoredRefs;
    return { urlToRefId: parsed.urlToRefId ?? {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { urlToRefId: {} };
    throw error;
  }
}

async function enqueuePersist(dir: string, map: Map<string, string>): Promise<void> {
  const previous = PERSIST_QUEUES.get(dir) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => persistMerged(dir, map));
  PERSIST_QUEUES.set(dir, next);
  try {
    await next;
  } finally {
    if (PERSIST_QUEUES.get(dir) === next) PERSIST_QUEUES.delete(dir);
  }
}

async function persistMerged(dir: string, map: Map<string, string>): Promise<void> {
  const current = await loadStored(dir);
  const stored: StoredRefs = {
    urlToRefId: {
      ...current.urlToRefId,
      ...Object.fromEntries(map),
    },
  };
  await writeFile(join(dir, STORE_FILE), JSON.stringify(stored, null, 2), "utf-8");
}
