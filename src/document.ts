// Wire types for a Model Document 2.4 entry, as served by GET /v1/models.
// Shape reference: the payloads in fixtures/
// Only the fields this library reads are typed; everything else passes through.

export const SCHEMA_VERSION = "2.4";

export type InputModalityType = "text" | "image" | "video" | "audio" | "file";

export type OutputModalityType =
  | "text"
  | "image"
  | "video"
  | "speech"
  | "transcription"
  | "embeddings"
  | "rerank"
  | "audio";

export type PricingUnit = "token" | "image" | "megapixel" | "second" | "character" | "request" | "search";

export interface PricingEntry {
  type: string;
  unit: PricingUnit | (string & {});
  cost_usd: string;
  utc_start?: number;
  utc_end?: number;
  utc_days?: string[];
  [key: string]: unknown;
}

export interface Limit {
  value: number;
  unit?: string;
}

export interface ParameterDescriptor {
  type: "range" | "integer" | "boolean" | "enum" | "array" | "object" | "unknown" | (string & {});
  min?: number;
  max?: number;
  default?: unknown;
  values?: unknown[];
  unit?: string;
  max_items?: number;
  [key: string]: unknown;
}

export interface InputModality {
  type: InputModalityType | (string & {});
  supported_inputs?: {
    max_context_length?: Limit;
    max_prompt_length?: Limit;
    [key: string]: unknown;
  };
  pricing?: PricingEntry[];
  [key: string]: unknown;
}

export interface OutputModality {
  type: OutputModalityType | (string & {});
  max_length?: Limit;
  streaming?: boolean;
  supported_parameters?: Record<string, ParameterDescriptor>;
  pricing?: PricingEntry[];
  [key: string]: unknown;
}

export interface ModelReasoning {
  mandatory: boolean;
  default_effort?: string | null;
  default_enabled?: boolean | null;
  // Descending order. null means the model has no effort allowlist.
  supported_efforts?: string[] | null;
  supports_max_tokens?: boolean | null;
}

export interface ModelDocument {
  schema_version: string;
  id: string;
  name: string;
  created?: number;
  description?: string;
  hugging_face_id?: string | null;
  quantization?: string | null;
  input_modalities: InputModality[];
  output_modalities: OutputModality[];
  pricing?: PricingEntry[];
  reasoning?: ModelReasoning | null;
  is_ready?: boolean;
  deprecation_date?: string | null;
  [key: string]: unknown;
}
