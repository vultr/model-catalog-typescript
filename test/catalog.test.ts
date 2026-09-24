import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CatalogError, fetchCatalog, loadCatalog, modelsUrl } from "../src/index.ts";

const payload = JSON.parse(readFileSync(new URL("../fixtures/vultr-catalog.json", import.meta.url), "utf8")) as {
  data: unknown[];
};

interface Call {
  url: string;
  headers: Record<string, string>;
}

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) } });
    return respond();
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const ok = () => Response.json(payload);
const down = () => {
  throw new TypeError("fetch failed");
};
const cachePath = () => join(mkdtempSync(join(tmpdir(), "model-catalog-")), "nested", "catalog.json");

test("modelsUrl tolerates trailing slashes", () => {
  assert.equal(modelsUrl(), "https://api.vultrinference.com/v1/models");
  assert.equal(modelsUrl("http://localhost:8080/v1//"), "http://localhost:8080/v1/models");
});

test("fetchCatalog sends no credentials unless given a key", async () => {
  const anonymous = fakeFetch(ok);
  await fetchCatalog({ fetch: anonymous.fetch });
  assert.equal(anonymous.calls[0]?.url, "https://api.vultrinference.com/v1/models");
  assert.equal(anonymous.calls[0]?.headers["authorization"], undefined);

  const keyed = fakeFetch(ok);
  await fetchCatalog({ fetch: keyed.fetch, apiKey: "secret", baseUrl: "https://example.test/v1/" });
  assert.equal(keyed.calls[0]?.url, "https://example.test/v1/models");
  assert.equal(keyed.calls[0]?.headers["authorization"], "Bearer secret");
});

test("fetchCatalog turns HTTP and transport failures into CatalogError", async () => {
  await assert.rejects(
    fetchCatalog({ fetch: fakeFetch(() => new Response("nope", { status: 503 })).fetch }),
    (error: unknown) => error instanceof CatalogError && /HTTP 503/.test(error.message),
  );
  await assert.rejects(
    fetchCatalog({ fetch: fakeFetch(down).fetch }),
    (error: unknown) => error instanceof CatalogError && /fetch failed/.test(error.message),
  );
});

test("loadCatalog normalizes a network payload and writes the cache", async () => {
  const path = cachePath();
  const catalog = await loadCatalog({ fetch: fakeFetch(ok).fetch, cachePath: path, now: () => 1_000 });
  assert.equal(catalog.source, "network");
  assert.equal(catalog.fetchedAt, 1_000);
  assert.equal(catalog.models.length, payload.data.length);
  assert.deepEqual(catalog.issues, []);

  const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  assert.equal(written["base_url"], "https://api.vultrinference.com/v1");
  assert.equal(written["fetched_at"], 1_000);
});

test("loadCatalog serves a fresh cache without touching the network", async () => {
  const path = cachePath();
  await loadCatalog({ fetch: fakeFetch(ok).fetch, cachePath: path, now: () => 1_000 });

  const second = fakeFetch(ok);
  const catalog = await loadCatalog({ fetch: second.fetch, cachePath: path, maxAgeMs: 500, now: () => 1_400 });
  assert.equal(catalog.source, "cache");
  assert.equal(catalog.fetchedAt, 1_000);
  assert.equal(second.calls.length, 0);

  const expired = fakeFetch(ok);
  const refreshed = await loadCatalog({ fetch: expired.fetch, cachePath: path, maxAgeMs: 500, now: () => 1_500 });
  assert.equal(refreshed.source, "network");
  assert.equal(expired.calls.length, 1);
});

test("loadCatalog falls back to the last good payload when the network fails", async () => {
  const path = cachePath();
  await loadCatalog({ fetch: fakeFetch(ok).fetch, cachePath: path, now: () => 1_000 });

  const catalog = await loadCatalog({ fetch: fakeFetch(down).fetch, cachePath: path, now: () => 9_000 });
  assert.equal(catalog.source, "stale-cache");
  assert.equal(catalog.fetchedAt, 1_000);
  assert.equal(catalog.models.length, payload.data.length);

  const garbage = await loadCatalog({
    fetch: fakeFetch(() => Response.json({ unexpected: true })).fetch,
    cachePath: path,
  });
  assert.equal(garbage.source, "stale-cache");
});

test("loadCatalog throws CatalogError when there is no cache to fall back to", async () => {
  await assert.rejects(loadCatalog({ fetch: fakeFetch(down).fetch, cachePath: cachePath() }), CatalogError);
  await assert.rejects(loadCatalog({ fetch: fakeFetch(down).fetch }), CatalogError);
});

test("loadCatalog ignores a cache for another endpoint, a corrupt cache, and an empty payload", async () => {
  const path = cachePath();
  await loadCatalog({ fetch: fakeFetch(ok).fetch, cachePath: path });
  await assert.rejects(
    loadCatalog({ fetch: fakeFetch(down).fetch, cachePath: path, baseUrl: "https://other.test/v1" }),
    CatalogError,
  );

  writeFileSync(path, "{ not json");
  await assert.rejects(loadCatalog({ fetch: fakeFetch(down).fetch, cachePath: path }), CatalogError);

  const empty = cachePath();
  await loadCatalog({ fetch: fakeFetch(() => Response.json({ data: [] })).fetch, cachePath: empty });
  await assert.rejects(loadCatalog({ fetch: fakeFetch(down).fetch, cachePath: empty }), CatalogError);
});
