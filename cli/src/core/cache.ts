// @ts-nocheck

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createJsonCache(namespace: string) {
  let loadedCache: Record<string, any> | null = null;

  function getCacheDir(): string {
    const base = process.env.XDG_CACHE_HOME;
    if (base) {
      return path.join(base, namespace);
    }
    return path.join(os.homedir(), ".cache", namespace);
  }

  function loadCache(): Record<string, any> {
    if (loadedCache !== null) {
      return loadedCache;
    }

    const cachePath = path.join(getCacheDir(), "cache.json");
    let data: Record<string, any> = {};
    try {
      const raw = fs.readFileSync(cachePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        data = parsed;
      }
    } catch {
      data = {};
    }

    if (!data.entries || typeof data.entries !== "object") {
      data = { entries: {} };
    }

    loadedCache = data;
    return data;
  }

  function saveCache(cache: Record<string, any>): void {
    const cacheDir = getCacheDir();
    fs.mkdirSync(cacheDir, { recursive: true });

    const cachePath = path.join(cacheDir, "cache.json");
    const tmpPath = path.join(cacheDir, "cache.json.tmp");
    fs.writeFileSync(tmpPath, `${JSON.stringify(cache, null, 2)}\n`);
    fs.renameSync(tmpPath, cachePath);
  }

  function cacheGet(key: string, maxAgeSeconds: number): string | undefined {
    const cache = loadCache();
    const entries = cache.entries as Record<string, any>;
    const entry = entries?.[key];

    if (!entry || typeof entry !== "object") {
      return undefined;
    }

    const ts = entry.ts;
    if (typeof ts !== "number") {
      return undefined;
    }

    if (Date.now() / 1000 - ts > maxAgeSeconds) {
      return undefined;
    }

    const value = entry.value;
    return typeof value === "string" ? value : undefined;
  }

  function cacheSet(key: string, value: string): void {
    const cache = loadCache();
    if (!cache.entries || typeof cache.entries !== "object") {
      cache.entries = {};
    }
    cache.entries[key] = { value, ts: Math.floor(Date.now() / 1000) };
    saveCache(cache);
  }

  return { getCacheDir, cacheGet, cacheSet };
}
