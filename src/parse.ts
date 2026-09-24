import { SCHEMA_VERSION, type ModelDocument } from "./document.ts";

export interface CatalogIssue {
  index: number;
  id: string | null;
  message: string;
}

export interface ParsedCatalog {
  documents: ModelDocument[];
  issues: CatalogIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModalityList(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => isRecord(item) && typeof item["type"] === "string");
}

// Accepts the /v1/models envelope ({ data: [...] }) or a bare array. A bad entry is
// skipped and reported; it never fails the whole catalog.
export function parseCatalog(payload: unknown): ParsedCatalog {
  const entries = Array.isArray(payload) ? payload : isRecord(payload) ? payload["data"] : undefined;
  if (!Array.isArray(entries)) {
    throw new TypeError("catalog payload must be an array or an object with a data array");
  }

  const documents: ModelDocument[] = [];
  const issues: CatalogIssue[] = [];
  entries.forEach((entry: unknown, index: number) => {
    if (!isRecord(entry)) {
      issues.push({ index, id: null, message: "entry is not an object" });
      return;
    }
    const id = typeof entry["id"] === "string" && entry["id"] !== "" ? entry["id"] : null;
    if (id === null) {
      issues.push({ index, id, message: "entry has no id" });
      return;
    }
    if (!isModalityList(entry["input_modalities"]) || !isModalityList(entry["output_modalities"])) {
      issues.push({ index, id, message: "entry has no usable input_modalities/output_modalities" });
      return;
    }
    if (entry["schema_version"] !== SCHEMA_VERSION) {
      issues.push({
        index,
        id,
        message: `schema_version is ${JSON.stringify(entry["schema_version"])}, expected "${SCHEMA_VERSION}"; parsed anyway`,
      });
    }
    documents.push(entry as ModelDocument);
  });
  return { documents, issues };
}
