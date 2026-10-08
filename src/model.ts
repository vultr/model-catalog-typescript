import type { Limit, ModelDocument, ModelReasoning, ParameterDescriptor, PricingEntry } from "./document.ts";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// undefined: the descriptor does not say. null: any effort is accepted. Otherwise the allowlist.
function effortValues(descriptor: unknown): string[] | null | undefined {
  if (!isRecord(descriptor)) return undefined;
  if (descriptor["type"] === "unknown") return null;
  if (descriptor["type"] === "enum" && Array.isArray(descriptor["values"])) {
    return descriptor["values"].filter((value): value is string => typeof value === "string");
  }
  return undefined;
}

// The text output's supported_parameters carry the facts: reasoning_effort (enum, or unknown when
// unrestricted) and reasoning (object whose properties hold effort, and max_tokens only when the
// budget is enforced). The root reasoning object is a temporary extension that will go away, so it
// only answers what the parameters do not: mandatory, the defaults, and any model whose parameters
// name no reasoning at all.
function reasoningSupport(
  parameters: Record<string, ParameterDescriptor>,
  root: ModelReasoning | null | undefined,
): ReasoningSupport | null {
  const effort = parameters["reasoning_effort"];
  const object = parameters["reasoning"];
  if (!isRecord(effort) && !isRecord(object) && !isRecord(root)) return null;

  const properties = isRecord(object) && isRecord(object["properties"]) ? object["properties"] : undefined;
  // null is an answer (unrestricted), so the second source is asked only on undefined
  let efforts = effortValues(effort);
  if (efforts === undefined) efforts = effortValues(properties?.["effort"]);
  const maxTokens = properties === undefined ? undefined : "max_tokens" in properties;
  const fallback = isRecord(root) ? root : undefined;

  return {
    mandatory: fallback?.mandatory === true,
    defaultEffort: fallback?.default_effort ?? null,
    defaultEnabled: fallback?.default_enabled ?? null,
    supportedEfforts: efforts !== undefined ? efforts : (fallback?.supported_efforts ?? null),
    supportsMaxTokens: maxTokens ?? fallback?.supports_max_tokens === true,
  };
}

export function normalizeModel(document: ModelDocument): CatalogModel {
  const textIn = document.input_modalities.find((modality) => modality.type === "text");
  const textOut = document.output_modalities.find((modality) => modality.type === "text");
  const parameters = textOut?.supported_parameters ?? {};

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
    reasoning: reasoningSupport(parameters, document.reasoning),
    isReady: document.is_ready !== false,
    deprecationDate: document.deprecation_date ?? null,
  };
}

// A chat model produces text. Rerankers, embedders and image generators do not.
export function isChatModel(model: CatalogModel): boolean {
  return model.outputModalities.includes("text");
}

// An agent model can drive a coding harness: it chats, is ready, calls tools and states its
// context window. A classifier can produce text without calling tools.
export function isAgentModel(model: CatalogModel): boolean {
  return isChatModel(model) && model.isReady && model.tools && model.contextWindow !== null;
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
