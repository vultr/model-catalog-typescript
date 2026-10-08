# Catalog

## Input

`GET {base_url}/models` returns `{ "data": [ModelDocument, ...] }`. Each entry
is an OpenRouter provider Model Document, schema 2.4. The `fixtures/` payloads
are the reference shape. Reasoning comes from the text output's
`supported_parameters` (see below); the top-level `reasoning` block, which
follows OpenRouter's `ModelReasoning`, is a temporary extension that will be
removed.

The endpoint needs no API key.

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
