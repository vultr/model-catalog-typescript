import type { Limit, ModelDocument, ParameterDescriptor, PricingEntry } from "./document.ts";
import { usdPerMillion } from "./price.ts";

// Exact decimal strings, USD per token (request: USD per request). null when unpriced.
export interface ModelPricing {
  prompt: string | null;
  cachedPrompt: string | null;
  cacheWrite: string | null;
  completion: string | null;
  internalReasoning: string | null;
  request: string | null;
}

export interface ReasoningSupport {
  mandatory: boolean;
  defaultEffort: string | null;
  defaultEnabled: boolean | null;
  // Descending order. null means the model has no effort allowlist.
  supportedEfforts: string[] | null;
  supportsMaxTokens: boolean;
}

export interface CatalogModel {
  id: string;
  name: string;
  description: string | null;
  created: number | null;
  huggingFaceId: string | null;
  quantization: string | null;
  contextWindow: number | null;
  maxPromptTokens: number | null;
  maxOutputTokens: number | null;
  inputModalities: string[];
  outputModalities: string[];
  pricing: ModelPricing;
  tools: boolean;
  structuredOutputs: boolean;
  streaming: boolean;
  supportedParameters: string[];
  parameters: Record<string, ParameterDescriptor>;
  reasoning: ReasoningSupport | null;
  isReady: boolean;
  deprecationDate: string | null;
}

function limit(value: Limit | undefined): number | null {
  return typeof value?.value === "number" && Number.isFinite(value.value) ? value.value : null;
}

function isWindowed(entry: PricingEntry): boolean {
  return entry.utc_start !== undefined || entry.utc_end !== undefined || entry.utc_days !== undefined;
}

// The base rate is the entry without a UTC window; windowed entries are time-of-day discounts.
function price(entries: PricingEntry[] | undefined, type: string, unit: string): string | null {
  const matches = (entries ?? []).filter(
    (entry) => entry.type === type && entry.unit === unit && typeof entry.cost_usd === "string",
  );
  return (matches.find((entry) => !isWindowed(entry)) ?? matches[0])?.cost_usd ?? null;
}

export function normalizeModel(document: ModelDocument): CatalogModel {
  const textIn = document.input_modalities.find((modality) => modality.type === "text");
  const textOut = document.output_modalities.find((modality) => modality.type === "text");
  const parameters = textOut?.supported_parameters ?? {};
  const reasoning = document.reasoning ?? null;

  return {
    id: document.id,
    name: document.name || document.id,
    description: document.description ?? null,
    created: document.created ?? null,
    huggingFaceId: document.hugging_face_id ?? null,
    quantization: document.quantization ?? null,
    contextWindow: limit(textIn?.supported_inputs?.max_context_length),
    maxPromptTokens: limit(textIn?.supported_inputs?.max_prompt_length),
    maxOutputTokens: limit(textOut?.max_length),
    inputModalities: document.input_modalities.map((modality) => modality.type),
    outputModalities: document.output_modalities.map((modality) => modality.type),
    pricing: {
      prompt: price(textIn?.pricing, "prompt", "token"),
      cachedPrompt: price(textIn?.pricing, "cached_prompt", "token"),
      cacheWrite: price(textIn?.pricing, "cache_write", "token"),
      completion: price(textOut?.pricing, "completion", "token"),
      internalReasoning: price(textOut?.pricing, "internal_reasoning", "token"),
      request: price(document.pricing, "request", "request"),
    },
    tools: "tools" in parameters,
    structuredOutputs: "response_format" in parameters || "structured_outputs" in parameters,
    streaming: textOut?.streaming === true,
    supportedParameters: Object.keys(parameters),
    parameters,
    reasoning: reasoning && {
      mandatory: reasoning.mandatory === true,
      defaultEffort: reasoning.default_effort ?? null,
      defaultEnabled: reasoning.default_enabled ?? null,
      supportedEfforts: reasoning.supported_efforts ?? null,
      supportsMaxTokens: reasoning.supports_max_tokens === true,
    },
    isReady: document.is_ready !== false,
    deprecationDate: document.deprecation_date ?? null,
  };
}

// A chat model produces text. Rerankers, embedders and image generators do not.
export function isChatModel(model: CatalogModel): boolean {
  return model.outputModalities.includes("text");
}

export function acceptsInput(model: CatalogModel, modality: string): boolean {
  return model.inputModalities.includes(modality);
}

// USD per million tokens, the unit every harness model picker wants.
export function pricePerMillion(model: CatalogModel): Record<keyof Omit<ModelPricing, "request">, number | null> {
  const { prompt, cachedPrompt, cacheWrite, completion, internalReasoning } = model.pricing;
  const scale = (value: string | null) => (value === null ? null : usdPerMillion(value));
  return {
    prompt: scale(prompt),
    cachedPrompt: scale(cachedPrompt),
    cacheWrite: scale(cacheWrite),
    completion: scale(completion),
    internalReasoning: scale(internalReasoning),
  };
}

// Language-neutral snake_case form. The Python library emits the same document from
// to_dict(); fixtures/*.normalized.json pins both.
export function toCanonical(model: CatalogModel): Record<string, unknown> {
  return {
    id: model.id,
    name: model.name,
    description: model.description,
    created: model.created,
    hugging_face_id: model.huggingFaceId,
    quantization: model.quantization,
    context_window: model.contextWindow,
    max_prompt_tokens: model.maxPromptTokens,
    max_output_tokens: model.maxOutputTokens,
    input_modalities: model.inputModalities,
    output_modalities: model.outputModalities,
    pricing: {
      prompt: model.pricing.prompt,
      cached_prompt: model.pricing.cachedPrompt,
      cache_write: model.pricing.cacheWrite,
      completion: model.pricing.completion,
      internal_reasoning: model.pricing.internalReasoning,
      request: model.pricing.request,
    },
    tools: model.tools,
    structured_outputs: model.structuredOutputs,
    streaming: model.streaming,
    supported_parameters: model.supportedParameters,
    reasoning: model.reasoning && {
      mandatory: model.reasoning.mandatory,
      default_effort: model.reasoning.defaultEffort,
      default_enabled: model.reasoning.defaultEnabled,
      supported_efforts: model.reasoning.supportedEfforts,
      supports_max_tokens: model.reasoning.supportsMaxTokens,
    },
    is_ready: model.isReady,
    deprecation_date: model.deprecationDate,
  };
}
