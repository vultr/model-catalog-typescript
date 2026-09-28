import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import {
  acceptsInput,
  isAgentModel,
  isChatModel,
  normalizeModel,
  parseCatalog,
  pricePerMillion,
  toCanonical,
  usdPerMillion,
} from "../src/index.ts";

const fixture = (name: string) => new URL(`../fixtures/${name}`, import.meta.url);
const load = (name: string) => JSON.parse(readFileSync(fixture(name), "utf8")) as unknown;
const models = (name: string) => parseCatalog(load(name)).documents.map(normalizeModel);

// UPDATE_FIXTURES=1 npm test rewrites the pinned output. Copy it to the Python project too.
for (const name of ["vultr-catalog", "edge-cases"]) {
  test(`${name} matches the pinned canonical output`, () => {
    const actual = models(`${name}.json`).map(toCanonical);
    if (process.env["UPDATE_FIXTURES"]) {
      writeFileSync(fixture(`${name}.normalized.json`), `${JSON.stringify(actual, null, 2)}\n`);
    }
    assert.deepEqual(actual, load(`${name}.normalized.json`));
  });
}

test("live catalog: chat model fields come out of the nested modalities", () => {
  const model = models("vultr-catalog.json").find((entry) => entry.id === "deepseek-v4-flash-0731");
  assert.ok(model);
  assert.equal(model.contextWindow, 1_048_576);
  assert.equal(model.maxOutputTokens, 1_048_576);
  assert.deepEqual(model.inputModalities, ["text", "image"]);
  assert.equal(model.pricing.prompt, "0.0000001");
  assert.equal(model.pricing.completion, "0.00000025");
  assert.deepEqual(pricePerMillion(model), {
    prompt: 0.1,
    cachedPrompt: null,
    cacheWrite: null,
    completion: 0.25,
    internalReasoning: null,
  });
  assert.equal(model.tools, true);
  assert.equal(model.streaming, true);
  assert.equal(model.reasoning?.supportsMaxTokens, false);
  assert.equal(model.reasoning?.supportedEfforts?.[0], "ultra");
  assert.ok(acceptsInput(model, "image"));
  assert.ok(!acceptsInput(model, "video"));
});

test("live catalog: rerankers, embedders, image, transcription and decision models are not chat models", () => {
  const all = models("vultr-catalog.json");
  const skipped = all.filter((model) => !isChatModel(model)).map((model) => model.id);
  for (const id of ["bge-reranker-v2-m3", "qwen3-embedding-4b", "z-image-turbo", "whisper-large-v3-turbo", "mica-v0.1-4b"]) {
    assert.ok(skipped.includes(id), id);
  }
  assert.deepEqual(all.find((model) => model.id === "mica-v0.1-4b")?.outputModalities, ["decision"]);
  assert.ok(all.filter(isChatModel).every((model) => model.contextWindow !== null));
});

test("live catalog: agent models are the chat models that call tools", () => {
  const all = models("vultr-catalog.json");
  const classifier = all.find((model) => model.id === "nemotron-3.5-content-safety");
  assert.ok(classifier);
  assert.ok(isChatModel(classifier));
  assert.equal(classifier.tools, false);
  assert.ok(!isAgentModel(classifier));
  const agents = all.filter(isAgentModel);
  assert.ok(agents.some((model) => model.id === "deepseek-v4-flash-0731"));
  assert.ok(agents.every((model) => isChatModel(model) && model.isReady && model.tools && model.contextWindow !== null));
  assert.equal(agents.length, all.filter(isChatModel).length - 1);
});

test("pricing prefers the entry without a UTC window", () => {
  const model = models("edge-cases.json").find((entry) => entry.id === "windowed-pricing");
  assert.ok(model);
  assert.deepEqual(model.pricing, {
    prompt: "0.000001",
    cachedPrompt: "0.0000001",
    cacheWrite: "0.00000125",
    completion: "0.000003",
    internalReasoning: "0.000004",
    request: "0.001",
  });
  assert.equal(model.maxPromptTokens, 30_000);
  assert.equal(model.structuredOutputs, true);
  assert.equal(model.streaming, false);
  assert.equal(model.isReady, false);
  assert.equal(model.deprecationDate, "2027-01-01");
  assert.deepEqual(model.reasoning, {
    mandatory: true,
    defaultEffort: "medium",
    defaultEnabled: true,
    supportedEfforts: ["high", "medium", "low"],
    supportsMaxTokens: true,
  });
});

test("a document with nothing optional still normalizes", () => {
  const model = models("edge-cases.json").find((entry) => entry.id === "bare-minimum");
  assert.ok(model);
  assert.equal(model.contextWindow, null);
  assert.equal(model.maxOutputTokens, null);
  assert.equal(model.pricing.prompt, null);
  assert.equal(model.reasoning, null);
  assert.equal(model.tools, false);
  assert.equal(model.isReady, true);
  assert.ok(isChatModel(model));
  assert.ok(!isAgentModel(model));
});

test("bad entries are skipped and reported, not fatal", () => {
  const { documents, issues } = parseCatalog(load("edge-cases.json"));
  assert.deepEqual(
    documents.map((document) => document.id),
    ["windowed-pricing", "bare-minimum", "future-schema"],
  );
  assert.deepEqual(
    issues.map((issue) => [issue.index, issue.id]),
    [
      [2, "future-schema"],
      [3, null],
      [4, "no-modalities"],
      [5, null],
    ],
  );
  assert.match(issues[0]?.message ?? "", /parsed anyway/);
});

test("parseCatalog accepts a bare array and rejects anything else", () => {
  assert.equal(parseCatalog([]).documents.length, 0);
  assert.throws(() => parseCatalog({ models: [] }), TypeError);
  assert.throws(() => parseCatalog(null), TypeError);
});

test("usdPerMillion shifts the decimal point exactly", () => {
  assert.equal(usdPerMillion("0.0000001"), 0.1);
  assert.equal(usdPerMillion("0.00000025"), 0.25);
  assert.equal(usdPerMillion("0.00000005"), 0.05);
  assert.equal(usdPerMillion("0.000003"), 3);
  assert.equal(usdPerMillion("0.00000125"), 1.25);
  assert.equal(usdPerMillion("1"), 1_000_000);
  assert.equal(usdPerMillion("0"), 0);
  assert.equal(usdPerMillion(".5"), 500_000);
  assert.equal(usdPerMillion("2.5e-7"), 0.25);
});
