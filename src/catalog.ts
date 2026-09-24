import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { normalizeModel, type CatalogModel } from "./model.ts";
import { parseCatalog, type CatalogIssue } from "./parse.ts";

export const DEFAULT_BASE_URL = "https://api.vultrinference.com/v1";
export const DEFAULT_TIMEOUT_MS = 8_000;

export class CatalogError extends Error {
  override name = "CatalogError";
}

export interface FetchOptions {
  baseUrl?: string;
  // The Vultr catalog is public. Sent as a Bearer token when given.
  apiKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
}

export interface LoadOptions extends FetchOptions {
  // Last good payload is kept here and served when the network fails.
  cachePath?: string;
  // A cache younger than this is served without touching the network. Default 0: always fetch.
  maxAgeMs?: number;
  now?: () => number;
}

export type CatalogSource = "network" | "cache" | "stale-cache";

export interface Catalog {
  models: CatalogModel[];
  issues: CatalogIssue[];
  source: CatalogSource;
  // Epoch milliseconds of the network fetch that produced this payload.
  fetchedAt: number;
}

interface CacheFile {
  base_url: string;
  fetched_at: number;
  payload: unknown;
}

export function modelsUrl(baseUrl: string = DEFAULT_BASE_URL): string {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

// Returns the raw JSON payload. Throws CatalogError on any transport or HTTP failure.
export async function fetchCatalog(options: FetchOptions = {}): Promise<unknown> {
  const url = modelsUrl(options.baseUrl);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const headers: Record<string, string> = { accept: "application/json", ...options.headers };
  if (options.apiKey) {
    headers["authorization"] = `Bearer ${options.apiKey}`;
  }

  try {
    const response = await (options.fetch ?? globalThis.fetch)(url, { headers, signal });
    if (!response.ok) {
      throw new CatalogError(`GET ${url} returned HTTP ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    if (error instanceof CatalogError) {
      throw error;
    }
    throw new CatalogError(`GET ${url} failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
}

export function buildCatalog(payload: unknown, source: CatalogSource, fetchedAt: number): Catalog {
  const { documents, issues } = parseCatalog(payload);
  return { models: documents.map(normalizeModel), issues, source, fetchedAt };
}

async function readCache(path: string, baseUrl: string): Promise<CacheFile | null> {
  try {
    const cached = JSON.parse(await readFile(path, "utf8")) as Partial<CacheFile>;
    if (cached.base_url !== baseUrl || typeof cached.fetched_at !== "number") {
      return null;
    }
    parseCatalog(cached.payload);
    return cached as CacheFile;
  } catch {
    return null;
  }
}

async function writeCache(path: string, cache: CacheFile): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(cache));
    await rename(temporary, path);
  } catch {
    // A read-only or missing cache directory must not fail a good fetch.
  }
}

// Fetch, normalize, and fall back to the last good payload when the network fails.
export async function loadCatalog(options: LoadOptions = {}): Promise<Catalog> {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const now = options.now ?? Date.now;
  const cached = options.cachePath ? await readCache(options.cachePath, baseUrl) : null;

  if (cached && now() - cached.fetched_at < (options.maxAgeMs ?? 0)) {
    return buildCatalog(cached.payload, "cache", cached.fetched_at);
  }

  try {
    const payload = await fetchCatalog({ ...options, baseUrl });
    const catalog = buildCatalog(payload, "network", now());
    if (options.cachePath && catalog.models.length > 0) {
      await writeCache(options.cachePath, { base_url: baseUrl, fetched_at: catalog.fetchedAt, payload });
    }
    return catalog;
  } catch (error) {
    if (cached) {
      return buildCatalog(cached.payload, "stale-cache", cached.fetched_at);
    }
    throw error instanceof CatalogError ? error : new CatalogError(String(error), { cause: error });
  }
}
