# Catalog

## Input

`GET {base_url}/models` returns `{ "data": [ModelDocument, ...] }`. Each entry
is an OpenRouter provider Model Document, schema 2.4. The `fixtures/` payloads
are the reference shape. Reasoning comes from the text output's
`supported_parameters` (see below); the top-level `reasoning` block, which
follows OpenRouter's `ModelReasoning`, is a temporary extension that will be
removed.

The endpoint needs no API key.

## Request

`GET {base_url}/models` goes out with `Accept: application/json` and a
`User-Agent` that names the library, its version and the platform it runs on:

```
vultr-model-catalog/0.0.3 (python; CPython 3.12.14; linux x86_64)
vultr-model-catalog/0.0.3 (typescript; Node.js 24.21.0; linux x64)
```

The comment holds the library (`python` or `typescript`), the runtime and
its version (`CPython`, `PyPy`, `Node.js`, `Bun`), then the operating system
and architecture as the runtime names them: `sys.platform` and
`platform.machine()` in Python, `process.platform` and `process.arch` in
TypeScript. The two libraries can spell the same machine differently.

Python reads its version from the installed package metadata and sends
`unknown` when the package is not installed. TypeScript compiles it in
(`src/version.ts`, tested against `package.json`), because the harness
plugins bundle the library and its `package.json` is not at hand there.

`user_agent` / `userAgent` is the caller's own product token, sent first:
`example-app/1.2 vultr-model-catalog/0.0.3 (...)`. `headers` is merged over
the defaults with names compared case-insensitively, so a `User-Agent` there
replaces the whole value, caller token included. `api_key` / `apiKey` is
sent as `Authorization: Bearer <key>` and wins over an `Authorization` in
`headers`.

## Field mapping

Canonical names are shown. TypeScript uses the camelCase form of each.

| Field | Source |
| --- | --- |
| `context_window` | text input `supported_inputs.max_context_length.value` |
| `max_prompt_tokens` | text input `supported_inputs.max_prompt_length.value` |
| `max_output_tokens` | text output `max_length.value` |
| `input_modalities`, `output_modalities` | the `type` of each modality, in order |
| `pricing.prompt`, `cached_prompt`, `cache_write` | text input `pricing[]` by `type`, `unit: token` |
| `pricing.completion`, `internal_reasoning` | text output `pricing[]` by `type`, `unit: token` |
| `pricing.request` | root `pricing[]`, `type: request` |
| `tools` | text output `supported_parameters.tools` present |
| `structured_outputs` | `response_format` or `structured_outputs` present |
| `streaming` | text output `streaming` |
| `supported_parameters`, `parameters` | text output `supported_parameters` names, descriptors |
| `reasoning` | text output `supported_parameters` `reasoning_effort` and `reasoning`, then root `reasoning`; null when neither names reasoning |
| `is_ready` | root `is_ready`, true when absent |
| `outputs` | every output modality, in order: `type`, `streaming` (null when not a boolean), `max_length` (the limit object, null without a numeric `value`), `parameters` (`supported_parameters`), `passthrough_parameters` (the model's own settings) and `pricing` (the entries as stated) |
| `inputs` | every input modality, in order: `type`, `supported_inputs` (as stated: formats, sources, references, roles, size and length limits with their `unit`) and `pricing` |

`outputs` and `inputs` are where a media model's facts are: an image model's
aspect ratios and resolutions, a video model's durations, a speech model's
voices, a music model's prices per second. `outputOf(model, type)` /
`model.output_of(type)` and `inputOf` / `input_of` pick one by type. The
descriptors and pricing entries are the document's own, so nothing is lost
to normalization; the chat fields above are unchanged by them. A media
model's text input states `max_prompt_length` in characters (`unit:
character`), and `max_prompt_tokens` carries that number as it is.

Prices stay exact decimal strings in USD per token. Convert with
`usd_per_million` / `usdPerMillion`, which shifts the decimal point instead
of multiplying floats. When a price has several entries, the one without a
UTC window (`utc_start`, `utc_end`, `utc_days`) is the base rate.

Reasoning is read from the parameters first, field by field, and the root
`reasoning` object fills what they do not state:

| Field | Source |
| --- | --- |
| `supported_efforts` | `reasoning_effort` as `{type: "enum", values}` (or `{type: "unknown"}`, which is `null`: no allowlist), else `reasoning.properties.effort`, else root |
| `supports_max_tokens` | `reasoning.properties.max_tokens` present (the budget is enforced), else root |
| `mandatory`, `default_effort`, `default_enabled` | root only |

A model whose parameters name neither `reasoning_effort` nor `reasoning` and
that has no root `reasoning` has `reasoning: null`.

`reasoning.supported_efforts` is in descending order. `null` means the model
has no effort allowlist, not that it cannot reason. A model that cannot
reason has `reasoning: null`.

Missing values are `null`. Nothing is guessed.

## Model kinds

The catalog holds every model the endpoint lists, whatever it outputs:
`text`, `embeddings`, `rerank`, `image`, `transcription`, `decisions` (older
documents spell it `decision`; both are known and neither is a chat model).

- A chat model (`isChatModel` / `is_chat`) outputs `text`
- An agent model (`isAgentModel` / `is_agent`) is a chat model a coding
  harness can drive: `is_ready`, `tools`, and a known `context_window`. A
  safety classifier outputs text but calls no tools: a chat model, not an
  agent model

## Media catalog

`load_media_catalog` / `loadMediaCatalog` reads what the provider document's
closed schema cannot hold from the gateway's own public catalogs, and gives
one `ModelMedia` record per model, sorted by id. It is opt-in: `load_catalog`
does not call it. No key is needed.

| Source | Request | Gives |
| --- | --- | --- |
| `public` | `GET /models?format=openrouter&output_modalities=all` | `quality_tiers`, `price_options` and `rate_limits`, each keyed by output modality; which models speak (`supported_voices`) |
| `image` | `GET /images/models` | `image`: the entry, with its size rules and `resolution.sizes` table, `modes`, `rules`, `inputs` and `prompt_max_length` |
| `video` | `GET /videos/models` | `video`: durations, sizes, `defaults`, `modes`, `resolution_rules`, `media`, `quality_tiers` and `pricing_skus` |
| `music` | `GET /music/models` | `music`: tasks, duration, lyrics, controls, outputs and parameters |
| `voices:<id>` | `GET /audio/voices?model=<id>`, for each speech model `public` names | `speech`: `voices` and `languages` |

`image`, `video` and `music` are the surfaces' entries as served, not
reshaped: they are the gateway's own documents, described in its API
reference. A model is in the result when any source names it, so a chat
model appears with only its `rate_limits`. A record is null where its
surface does not list the model.

A malformed payload or entry is an issue (`{source, message}`), never a
failure. A source that cannot be reached is an issue too, and the others
still answer; `CatalogError` is raised only when every source failed and no
cache can be served. `to_dict()` / `toCanonicalMedia()` is the shared
snake_case form, pinned by `fixtures/media.normalized.json` from the captures
in `fixtures/media/`.

## Tolerance

An entry is dropped, with an issue, when it is not an object, has no `id`, or
has no modality lists. An unexpected `schema_version` is reported and parsed
anyway. Unknown fields and unknown modality types pass through.

## Cache

`load_catalog` / `loadCatalog` with a cache path writes the raw payload, not
the normalized models, so a library upgrade renormalizes old caches:

```json
{ "base_url": "https://api.vultrinference.com/v1", "fetched_at": 1789700000000, "payload": { "data": [] } }
```

`fetched_at` is epoch milliseconds. Both libraries read and write this
format, so they can share a file. A cache for a different `base_url`, a
corrupt cache, and an empty catalog are all ignored. A failed write is
ignored too. Order of preference: fresh cache, network, stale cache, error.

The media catalog keeps its own cache file (a different path from the
catalog's), holding the raw payloads of a load in which every source
answered:

```json
{ "base_url": "https://api.vultrinference.com/v1", "fetched_at": 1789700000000,
  "payloads": { "public": {}, "image": {}, "video": {}, "music": {}, "voices": { "<id>": {} } } }
```

A load in which some source failed does not replace it, and is served from
it (`stale-cache`, with the failures in `issues`) when there is one. Both
libraries read and write this format too.
