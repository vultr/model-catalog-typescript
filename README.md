# @vultr/model-catalog

Fetch `GET /v1/models` from Vultr Inference and turn each Model Document 2.4
entry into a flat `CatalogModel`. This is the base the TypeScript harness
integrations (Pi, OpenClaw, OpenCode) build on. The Python twin is
`model-catalog-python`; both produce the same output for the same input.

## Install

```bash
npm install @vultr/model-catalog
```

No runtime dependencies. Node 20+ or Bun.

```ts
import { isChatModel, loadCatalog, pricePerMillion } from "@vultr/model-catalog";

const catalog = await loadCatalog({ cachePath: "/home/me/.cache/vultr/catalog.json", maxAgeMs: 300_000 });
for (const model of catalog.models.filter(isChatModel)) {
  console.log(model.id, model.contextWindow, pricePerMillion(model).prompt);
}
```

## Surface

- `loadCatalog(options)`: fetch, normalize, fall back to the last good
  payload when the network fails. `catalog.source` is `network`, `cache` or
  `stale-cache`. Throws `CatalogError` only when there is nothing to serve
- `fetchCatalog(options)`: the raw JSON payload. The catalog is public;
  `apiKey` is optional
- `parseCatalog(payload)`: documents plus `issues`. A bad entry is skipped
  and reported, it never fails the catalog
- `normalizeModel(document)`: one `CatalogModel`
- `isChatModel`, `isAgentModel`, `acceptsInput`, `pricePerMillion`, `usdPerMillion`
- `toCanonical(model)`: the snake_case form shared with the Python library

`CatalogModel` carries `contextWindow`, `maxOutputTokens`, `inputModalities`,
`outputModalities`, `pricing` (exact USD per token strings), `tools`,
`structuredOutputs`, `streaming`, `supportedParameters`, `parameters`,
`reasoning`, `isReady`, `deprecationDate`. Rerankers, embedders, image
generators, transcription and decision models are in the catalog too;
`isChatModel` keeps the ones that output text. `isAgentModel` keeps the chat
models a coding harness can drive: ready, with tool calling and a known context
window. A safety classifier outputs text but calls no tools, so it is a chat
model and not an agent model.

See `docs/catalog.md` for the field mapping and the cache format.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

Tests run the `.ts` sources directly on Node's type stripping. `fixtures/` is
shared with the Python project: after changing normalization, run
`UPDATE_FIXTURES=1 npm test` and copy `fixtures/*.json` to
`model-catalog-python/fixtures/`.
