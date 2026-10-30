import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { CatalogError, DEFAULT_BASE_URL, getJson, type CatalogSource, type FetchOptions } from "./catalog.ts";

// The per-surface catalogs Vultr Inference publishes beside /v1/models, read into one record per
// model. Each record is the surface's own entry, as served: these shapes are Vultr's and carry
// what the provider document's closed schema cannot (size tables, modes, rules, voices).

export const MEDIA_SOURCES = ["public", "image", "video", "music"] as const;
export type MediaSourceName = (typeof MEDIA_SOURCES)[number] | `voices:${string}`;

// GET /v1/images/models: one entry per image model
export interface ImageModelRecord {
  id: string;
  supported_parameters: Record<string, Record<string, unknown>>;
  prompt_max_length?: number | null;
  inputs?: Record<string, unknown> | null;
  modes?: Record<string, unknown>[];
  rules?: Record<string, unknown>[];
  [key: string]: unknown;
}

// GET /v1/videos/models: one entry per video model
export interface VideoModelRecord {
  id: string;
  supported_durations: number[];
  supported_resolutions: string[];
  supported_aspect_ratios: string[];
  supported_sizes: string[];
  [key: string]: unknown;
}

// GET /v1/music/models: one entry per music model
export interface MusicModelRecord {
  id: string;
  [key: string]: unknown;
}

export interface Voice {
  id: string;
  name?: string;
  mode?: string;
  description?: string;
  native_language?: string;
  [key: string]: unknown;
}

// GET /v1/audio/voices?model=: a speech model's voices and the languages its card names
export interface SpeechRecord {
  voices: Voice[];
  languages: string[];
}

// The public shape's entry for a model whose output is an alignment (POST /v1/audio/alignments)
export interface AlignmentRecord {
  languages: string[];
}

export interface RateLimit {
  requests_per_minute?: number;
  concurrent_requests?: number;
  active_jobs?: number;
  [key: string]: unknown;
}

export interface InputLimit {
  max_items?: number;
  max_bytes?: number;
  [key: string]: unknown;
}

export interface ModelMedia {
  id: string;
  image: ImageModelRecord | null;
  video: VideoModelRecord | null;
  music: MusicModelRecord | null;
  speech: SpeechRecord | null;
  // By output modality, from the public shape (GET /v1/models?format=openrouter)
  qualityTiers: Record<string, Record<string, unknown>[]>;
  priceOptions: Record<string, Record<string, unknown>[]>;
  rateLimits: Record<string, RateLimit>;
  // By input modality (image, video, audio), from the public shape: what one chat request may carry
  inputLimits: Record<string, InputLimit>;
  alignment: AlignmentRecord | null;
}

export interface MediaIssue {
  source: MediaSourceName;
  message: string;
}

export interface MediaCatalog {
  models: ModelMedia[];
  issues: MediaIssue[];
  source: CatalogSource;
  // Epoch milliseconds of the network fetch that produced these payloads.
  fetchedAt: number;
}

// The raw payloads one load reads; also the cache file's `payloads`.
export interface MediaPayloads {
  public?: unknown;
  image?: unknown;
  video?: unknown;
  music?: unknown;
  voices?: Record<string, unknown>;
}

export interface MediaLoadOptions extends FetchOptions {
  // Last complete set of payloads, served when a source fails. A different file from loadCatalog's.
  cachePath?: string;
  // A cache younger than this is served without touching the network. Default 0: always fetch.
  maxAgeMs?: number;
  now?: () => number;
}

interface MediaCacheFile {
  base_url: string;
  fetched_at: number;
  payloads: MediaPayloads;
}

const PATHS: Record<(typeof MEDIA_SOURCES)[number], string> = {
  public: "/models?format=openrouter&output_modalities=all",
  image: "/images/models",
  video: "/videos/models",
  music: "/music/models",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The entries of a {data: [...]} list with a string id, by id; the rest are issues
function listed(payload: unknown, source: MediaSourceName, issues: MediaIssue[]): Map<string, Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  if (payload === undefined) return byId;
  const data = isRecord(payload) ? payload["data"] : undefined;
  if (!Array.isArray(data)) {
    issues.push({ source, message: "payload has no data list" });
    return byId;
  }
  data.forEach((entry: unknown, index: number) => {
    if (!isRecord(entry) || typeof entry["id"] !== "string" || entry["id"] === "") {
      issues.push({ source, message: `entry ${index} has no id` });
      return;
    }
    byId.set(entry["id"], entry);
  });
  return byId;
}

function keyedLists(value: unknown): Record<string, Record<string, unknown>[]> {
  const out: Record<string, Record<string, unknown>[]> = {};
  if (!isRecord(value)) return out;
  for (const [type, list] of Object.entries(value)) {
    if (Array.isArray(list)) out[type] = list.filter(isRecord);
  }
  return out;
}

function speechRecord(payload: unknown, source: MediaSourceName, issues: MediaIssue[]): SpeechRecord | null {
  if (payload === undefined) return null;
  if (!isRecord(payload) || !Array.isArray(payload["data"])) {
    issues.push({ source, message: "payload has no data list" });
    return null;
  }
  const voices = payload["data"].filter(
    (voice): voice is Voice => isRecord(voice) && typeof voice["id"] === "string",
  );
  const languages = Array.isArray(payload["languages"])
    ? payload["languages"].filter((language): language is string => typeof language === "string")
    : [];
  return { voices, languages };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function alignmentRecord(entry: Record<string, unknown> | undefined): AlignmentRecord | null {
  const architecture = entry?.["architecture"];
  if (!isRecord(architecture) || !strings(architecture["output_modalities"]).includes("alignment")) return null;
  return { languages: strings(entry?.["supported_languages"]) };
}

// The speech models the public shape names: those with a voice list
export function speechModelIds(publicPayload: unknown): string[] {
  const ids: string[] = [];
  const data = isRecord(publicPayload) ? publicPayload["data"] : undefined;
  for (const entry of Array.isArray(data) ? data : []) {
    if (isRecord(entry) && typeof entry["id"] === "string" && Array.isArray(entry["supported_voices"])) {
      ids.push(entry["id"]);
    }
  }
  return ids.sort();
}

// One record per model any payload names, sorted by id. A payload that is missing gives nothing;
// one that is malformed is an issue, and the others still answer.
export function buildMediaCatalog(payloads: MediaPayloads, source: CatalogSource, fetchedAt: number): MediaCatalog {
  const issues: MediaIssue[] = [];
  const publicEntries = listed(payloads.public, "public", issues);
  const images = listed(payloads.image, "image", issues);
  const videos = listed(payloads.video, "video", issues);
  const music = listed(payloads.music, "music", issues);
  const speech = new Map<string, SpeechRecord>();
  for (const [id, payload] of Object.entries(payloads.voices ?? {})) {
    const record = speechRecord(payload, `voices:${id}`, issues);
    if (record !== null) speech.set(id, record);
  }

  const ids = new Set([...images.keys(), ...videos.keys(), ...music.keys(), ...speech.keys()]);
  const hasEntries = (value: unknown) => isRecord(value) && Object.keys(value).length > 0;
  for (const [id, entry] of publicEntries) {
    if (["quality_tiers", "price_options", "rate_limits", "input_limits"].some((key) => hasEntries(entry[key]))) ids.add(id);
    if (alignmentRecord(entry) !== null) ids.add(id);
  }

  const models = [...ids].sort().map((id): ModelMedia => {
    const entry = publicEntries.get(id);
    const rateLimits: Record<string, RateLimit> = {};
    if (isRecord(entry?.["rate_limits"])) {
      for (const [type, limits] of Object.entries(entry["rate_limits"])) {
        if (isRecord(limits)) rateLimits[type] = limits;
      }
    }
    const inputLimits: Record<string, InputLimit> = {};
    if (isRecord(entry?.["input_limits"])) {
      for (const [type, limits] of Object.entries(entry["input_limits"])) {
        if (isRecord(limits)) inputLimits[type] = limits;
      }
    }
    return {
      id,
      image: (images.get(id) as ImageModelRecord | undefined) ?? null,
      video: (videos.get(id) as VideoModelRecord | undefined) ?? null,
      music: (music.get(id) as MusicModelRecord | undefined) ?? null,
      speech: speech.get(id) ?? null,
      qualityTiers: keyedLists(entry?.["quality_tiers"]),
      priceOptions: keyedLists(entry?.["price_options"]),
      rateLimits,
      inputLimits,
      alignment: alignmentRecord(entry),
    };
  });
  return { models, issues, source, fetchedAt };
}

// Reads every source. Throws CatalogError only when every source failed; otherwise the failures
// are in the returned issues, as `failed` keyed by source.
export async function fetchMediaPayloads(
  options: FetchOptions = {},
): Promise<{ payloads: MediaPayloads; failed: MediaIssue[] }> {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const payloads: MediaPayloads = {};
  const failed: MediaIssue[] = [];
  const read = async (source: MediaSourceName, path: string): Promise<unknown> => {
    try {
      return await getJson(`${baseUrl}${path}`, options);
    } catch (error) {
      failed.push({ source, message: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  };

  const [publicPayload, image, video, music] = await Promise.all(
    MEDIA_SOURCES.map((source) => read(source, PATHS[source])),
  );
  Object.assign(payloads, { public: publicPayload, image, video, music });
  const speechIds = publicPayload === undefined ? [] : speechModelIds(publicPayload);
  const voices = await Promise.all(
    speechIds.map((id) => read(`voices:${id}`, `/audio/voices?model=${encodeURIComponent(id)}`)),
  );
  payloads.voices = {};
  speechIds.forEach((id, index) => {
    if (voices[index] !== undefined) payloads.voices![id] = voices[index];
  });

  if (failed.length === MEDIA_SOURCES.length + speechIds.length) {
    throw new CatalogError(`every media catalog failed: ${failed.map((issue) => issue.message).join("; ")}`);
  }
  return { payloads, failed };
}

async function readMediaCache(path: string, baseUrl: string): Promise<MediaCacheFile | null> {
  try {
    const cached = JSON.parse(await readFile(path, "utf8")) as Partial<MediaCacheFile>;
    if (cached.base_url !== baseUrl || typeof cached.fetched_at !== "number" || !isRecord(cached.payloads)) {
      return null;
    }
    return cached as MediaCacheFile;
  } catch {
    return null;
  }
}

async function writeMediaCache(path: string, cache: MediaCacheFile): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(cache));
    await rename(temporary, path);
  } catch {
    // A read-only or missing cache directory must not fail a good fetch.
  }
}

// Fetch every surface catalog and the speech models' voices. A load where every source answered
// is the one cached; a load where some failed is served from the cache when there is one (stale),
// else as it is, with each failure in `issues`.
export async function loadMediaCatalog(options: MediaLoadOptions = {}): Promise<MediaCatalog> {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const now = options.now ?? Date.now;
  const cached = options.cachePath ? await readMediaCache(options.cachePath, baseUrl) : null;

  if (cached && now() - cached.fetched_at < (options.maxAgeMs ?? 0)) {
    return buildMediaCatalog(cached.payloads, "cache", cached.fetched_at);
  }

  let fetched: { payloads: MediaPayloads; failed: MediaIssue[] };
  try {
    fetched = await fetchMediaPayloads({ ...options, baseUrl });
  } catch (error) {
    if (cached) return buildMediaCatalog(cached.payloads, "stale-cache", cached.fetched_at);
    throw error instanceof CatalogError ? error : new CatalogError(String(error), { cause: error });
  }

  if (fetched.failed.length > 0 && cached) {
    const stale = buildMediaCatalog(cached.payloads, "stale-cache", cached.fetched_at);
    return { ...stale, issues: [...fetched.failed, ...stale.issues] };
  }

  const catalog = buildMediaCatalog(fetched.payloads, "network", now());
  if (fetched.failed.length === 0 && options.cachePath) {
    await writeMediaCache(options.cachePath, { base_url: baseUrl, fetched_at: catalog.fetchedAt, payloads: fetched.payloads });
  }
  return { ...catalog, issues: [...fetched.failed, ...catalog.issues] };
}

// Language-neutral snake_case form; the Python library's to_dict() emits the same.
export function toCanonicalMedia(model: ModelMedia): Record<string, unknown> {
  return {
    id: model.id,
    image: model.image,
    video: model.video,
    music: model.music,
    speech: model.speech,
    quality_tiers: model.qualityTiers,
    price_options: model.priceOptions,
    rate_limits: model.rateLimits,
    input_limits: model.inputLimits,
    alignment: model.alignment,
  };
}
