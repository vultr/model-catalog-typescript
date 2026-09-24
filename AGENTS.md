# AGENTS.md - vultr/model-catalog-typescript

`@vultr/model-catalog`: fetches `GET /v1/models` from Vultr Inference and turns
each Model Document 2.4 entry into a flat `CatalogModel`. The harness
integrations for Pi, OpenClaw and OpenCode build on this; none of their code
lives here.

Human overview: `README.md`. Field mapping, tolerance and cache format:
`docs/catalog.md`.

## What holds the design up

- **The twin.** `vultr/model-catalog-python` is the same library for Python
  (Hermes). Same input, same output. `fixtures/*.normalized.json` is the
  contract: this repo generates it, the Python tests must match it. A change
  to normalization is a change to both repos, in the same turn
- **The schema is not ours.** The input is OpenRouter's provider Model
  Document, schema 2.4; the `reasoning` block follows OpenRouter's
  `ModelReasoning`. The `fixtures/` payloads are the reference shape. Read
  those, not web summaries, before changing `src/document.ts`
- **Harness-neutral.** No Pi, OpenClaw or OpenCode types, names or units in
  this repo. A harness wants a different shape: that is a mapper in the
  harness package
- **No runtime dependencies.** `dependencies` stays empty. Node 20+ and Bun
  both load this; `node:fs` and global `fetch` are the whole platform surface
- **Nothing is guessed.** A value the document does not carry is `null`.
  No default context window, no assumed price
- **One bad entry never fails the catalog.** `parseCatalog` skips it and
  reports an issue. `loadCatalog` throws `CatalogError` only when there is
  neither a network payload nor a cache to serve
- **Prices are strings.** `cost_usd` stays an exact decimal string. Convert
  with `usdPerMillion`, which shifts the decimal point. Do not multiply
  floats: `0.0000001 * 1e6` is `0.09999999999999999`

## Working here

- `npm run typecheck`, `npm test` and `npm run build` must pass
- The harness plugins install this repo as a git dependency. `prepare` builds
  `dist/` on install, so `dist/` stays out of git and `npm run build` must
  work from a clean clone with only `devDependencies`
- Tests run the `.ts` sources on Node's type stripping, so source stays
  erasable: no enums, namespaces or parameter properties, and relative
  imports carry the `.ts` extension (`tsc` rewrites them on build)
- After changing normalization: `UPDATE_FIXTURES=1 npm test`, read the diff
  in `fixtures/*.normalized.json`, then copy `fixtures/*.json` to
  `model-catalog-python/fixtures/` and run its tests
- `fixtures/vultr-catalog.json` is a capture of the live endpoint. Refresh it
  on purpose, not as a side effect; hand-written cases go in
  `fixtures/edge-cases.json`
- The cache file format is shared with the Python library. Changing it is a
  change to both
- `src/index.ts` is the public contract. A new export is deliberate; add it
  to the README surface list
- Put lasting explanation in `docs/`, not in the source. If a comment is
  needed, make it short. Docs describe current behavior, not history
- Write commit messages to the Conventional Commits spec
- No em dashes or en dashes anywhere: prose, comments, commit messages and
  docs use plain hyphens, `·`, or `:`
- No AI trailers on commits (`Co-Authored-By`, `Generated with`, ...)
- Never force-push; never rewrite pushed history
