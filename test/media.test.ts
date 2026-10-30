import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  CatalogError,
  buildMediaCatalog,
  inputOf,
  loadMediaCatalog,
  normalizeModel,
  outputOf,
  parseCatalog,
  speechModelIds,
  toCanonicalMedia,
  type MediaPayloads,
} from "../src/index.ts";

const fixture = (name: string) => new URL(`../fixtures/${name}`, import.meta.url);
const load = (name: string) => JSON.parse(readFileSync(fixture(name), "utf8")) as unknown;

// The public catalogs as captured, keyed the way fetchMediaPayloads keys them
const SPEECH = ["auk", "chatterbox", "qwen3-tts-12hz-1.7b"];
const payloads = (): MediaPayloads => ({
  public: load("media/public-models.json"),
  image: load("media/image-models.json"),
  video: load("media/video-models.json"),
  music: load("media/music-models.json"),
  voices: Object.fromEntries(SPEECH.map((id) => [id, load(`media/voices-${id}.json`)])),
});

// UPDATE_FIXTURES=1 npm test rewrites the pinned output. Copy it to the Python project too.
test("media catalogs match the pinned canonical output", () => {
  const actual = buildMediaCatalog(payloads(), "network", 0).models.map(toCanonicalMedia);
  if (process.env["UPDATE_FIXTURES"]) {
    writeFileSync(fixture("media.normalized.json"), `${JSON.stringify(actual, null, 2)}\n`);
  }
  assert.deepEqual(actual, load("media.normalized.json"));
});

test("one record per model, with each surface's entry", () => {
  const { models, issues } = buildMediaCatalog(payloads(), "network", 0);
  assert.deepEqual(issues, []);
  const byId = new Map(models.map((model) => [model.id, model]));

  // minimax-h3 makes video and stills: both records, both outputs' tiers and limits
  const h3 = byId.get("minimax-h3");
  assert.ok(h3?.image && h3.video);
  assert.deepEqual(Object.keys(h3.qualityTiers).sort(), ["image", "video"]);
  assert.equal(h3.rateLimits["video"]?.active_jobs, 2);
  assert.deepEqual(
    h3.image.modes?.map((mode) => [mode["mode"], mode["also"]]),
    [["ref", { steps: [8] }], ["generate", { steps: [4] }]],
  );

  const speech = byId.get("qwen3-tts-12hz-1.7b")?.speech;
  assert.equal(speech?.voices.length, 11);
  assert.ok(speech?.languages.includes("Japanese"));
  assert.ok(byId.get("minimax-music3")?.music);
  // A chat model has limits but no media record
  assert.equal(byId.get("glm-5.3")?.image ?? null, null);
  assert.ok(byId.get("glm-5.3")?.rateLimits["text"]);
  // ... and what one request may carry of each media input, with a count where its engine sets one
  assert.deepEqual(byId.get("nemotron-3-nano-omni-30b-a3b-reasoning")?.inputLimits, {
    image: { max_items: 1, max_bytes: 20971520 },
    audio: { max_items: 1, max_bytes: 52428800 },
    video: { max_items: 1, max_bytes: 52428800 },
  });
  assert.deepEqual(byId.get("glm-5.3")?.inputLimits["image"], { max_bytes: 20971520 });
});

test("the speech models are the public shape's entries with voices", () => {
  assert.deepEqual(speechModelIds(load("media/public-models.json")), SPEECH);
});

test("an alignment model is named only by the public shape, with its languages", () => {
  const aligner = {
    id: "aligner-1",
    architecture: { input_modalities: ["audio", "text"], output_modalities: ["alignment"] },
    supported_languages: ["en", "ja", 3],
  };
  const chat = { id: "chat", architecture: { output_modalities: ["text"] }, supported_languages: ["en"] };
  const { models } = buildMediaCatalog({ public: { data: [aligner, chat] } }, "network", 0);
  assert.deepEqual(models.map((model) => [model.id, model.alignment]), [["aligner-1", { languages: ["en", "ja"] }]]);
});

test("a malformed payload or entry is an issue, never a failure", () => {
  const { models, issues } = buildMediaCatalog(
    { image: { data: [{ id: "ok", supported_parameters: {} }, { name: "no id" }] }, video: { nope: true }, voices: { x: [] } },
    "network",
    0,
  );
  assert.deepEqual(models.map((model) => model.id), ["ok"]);
  assert.deepEqual(issues, [
    { source: "image", message: "entry 1 has no id" },
    { source: "video", message: "payload has no data list" },
    { source: "voices:x", message: "payload has no data list" },
  ]);
});

test("the provider document's modalities: outputs and inputs", () => {
  const models = parseCatalog(load("media/provider-models.json")).documents.map(normalizeModel);
  const h3 = models.find((model) => model.id === "minimax-h3");
  assert.ok(h3);
  assert.deepEqual(h3.outputs.map((output) => output.type), ["video", "image"]);
  assert.equal(outputOf(h3, "video")?.pricing[0]?.unit, "second");
  assert.deepEqual(outputOf(h3, "video")?.parameters["duration"]?.["default"], 6);
  assert.deepEqual(inputOf(h3, "image")?.supportedInputs["references"], { type: "integer", min: 1, max: 9 });
  assert.equal(outputOf(h3, "text"), null);
  // A chat model's fields are as they were
  const chat = models.find((model) => model.id === "glm-5.3");
  assert.deepEqual(outputOf(chat!, "text")?.parameters, chat?.parameters);
});

// ---- loading

interface Call {
  url: string;
  headers: Record<string, string>;
}

const PATHS: Record<string, string> = {
  "/models?format=openrouter&output_modalities=all": "media/public-models.json",
  "/images/models": "media/image-models.json",
  "/videos/models": "media/video-models.json",
  "/music/models": "media/music-models.json",
  ...Object.fromEntries(SPEECH.map((id) => [`/audio/voices?model=${id}`, `media/voices-${id}.json`])),
};

function fakeFetch(failing: (path: string) => boolean = () => false) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    const path = url.replace("https://api.vultrinference.com/v1", "");
    if (failing(path)) return new Response("down", { status: 503 });
    const file = PATHS[path];
    return file ? Response.json(load(file)) : new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const cachePath = () => join(mkdtempSync(join(tmpdir(), "model-catalog-media-")), "nested", "media.json");

test("loadMediaCatalog reads every surface without a key, then each speech model's voices", async () => {
  const { fetch, calls } = fakeFetch();
  const catalog = await loadMediaCatalog({ fetch, userAgent: "app/1" });
  assert.equal(catalog.source, "network");
  assert.deepEqual(catalog.issues, []);
  assert.deepEqual(calls.map((call) => call.url.replace("https://api.vultrinference.com/v1", "")).sort(), Object.keys(PATHS).sort());
  for (const call of calls) {
    assert.equal(call.headers["authorization"], undefined);
    assert.match(call.headers["user-agent"] ?? "", /^app\/1 vultr-model-catalog\//);
  }
  assert.deepEqual(catalog.models.map(toCanonicalMedia), load("media.normalized.json"));
});

test("a source that fails is an issue, and the rest answer", async () => {
  const { fetch } = fakeFetch((path) => path === "/videos/models");
  const catalog = await loadMediaCatalog({ fetch });
  assert.equal(catalog.source, "network");
  assert.deepEqual(catalog.issues.map((issue) => issue.source), ["video"]);
  assert.equal(catalog.models.find((model) => model.id === "minimax-h3")?.video, null);
  assert.ok(catalog.models.find((model) => model.id === "minimax-h3")?.image);
});

test("a complete load is cached; a partial one is served from that cache, stale", async () => {
  const path = cachePath();
  const good = await loadMediaCatalog({ fetch: fakeFetch().fetch, cachePath: path, now: () => 1000 });
  assert.equal(good.source, "network");

  const partial = await loadMediaCatalog({ fetch: fakeFetch((p) => p === "/music/models").fetch, cachePath: path, now: () => 2000 });
  assert.equal(partial.source, "stale-cache");
  assert.equal(partial.fetchedAt, 1000);
  assert.deepEqual(partial.issues.map((issue) => issue.source), ["music"]);
  assert.ok(partial.models.find((model) => model.id === "minimax-music3")?.music);

  const fresh = fakeFetch();
  const cached = await loadMediaCatalog({ fetch: fresh.fetch, cachePath: path, maxAgeMs: 5000, now: () => 3000 });
  assert.equal(cached.source, "cache");
  assert.equal(fresh.calls.length, 0);

  // The partial load did not replace the cache
  assert.equal((JSON.parse(readFileSync(path, "utf8")) as { fetched_at: number }).fetched_at, 1000);
});

test("every source down and no cache is a CatalogError", async () => {
  await assert.rejects(loadMediaCatalog({ fetch: fakeFetch(() => true).fetch }), CatalogError);
});
