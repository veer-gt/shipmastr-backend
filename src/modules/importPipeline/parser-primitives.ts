import { ALLOWED_EVENT_CLASSES } from "./format-pack-definition.validator.js";
import { ImportPipelineRowError } from "./import-pipeline.errors.js";
import { isParserPrimitive, type ParserPrimitiveName } from "./parser-primitive.registry.js";
import type { FormatPackDefinition } from "./types.js";

type PrimitiveConfig = string | Record<string, unknown>;

type PrimitiveContext = {
  definition: FormatPackDefinition;
  fieldKey: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeHeader(value: unknown) {
  return String(value ?? "")
    .trim()
    .replace(/^\uFEFF/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function primitiveName(config: PrimitiveConfig): ParserPrimitiveName {
  if (typeof config === "string") {
    if (!isParserPrimitive(config)) throw new ImportPipelineRowError("UNSUPPORTED_PRIMITIVE", { primitive: config });
    return config;
  }
  const keys = Object.keys(config);
  const key = keys.length === 1 ? keys[0] : null;
  if (!key || !isParserPrimitive(key)) throw new ImportPipelineRowError("UNSUPPORTED_PRIMITIVE", { primitive: key });
  return key;
}

function primitiveArgs(config: PrimitiveConfig) {
  if (typeof config === "string") return undefined;
  const key = Object.keys(config)[0];
  return key ? config[key] : undefined;
}

export function parseMinorUnits(input: unknown): bigint {
  let value = String(input ?? "").trim();
  if (!value) throw new ImportPipelineRowError("BAD_MONEY", { value: input });

  let negative = false;
  if (value.startsWith("(") && value.endsWith(")")) {
    negative = true;
    value = value.slice(1, -1).trim();
  }
  if (value.startsWith("-")) {
    negative = true;
    value = value.slice(1).trim();
  }

  value = value
    .replace(/,/g, "")
    .replace(/^₹\s*/iu, "")
    .replace(/^rs\.?\s*/iu, "")
    .replace(/^inr\s*/iu, "")
    .trim();
  if (/^(nan|[-+]?infinity)$/iu.test(value)) throw new ImportPipelineRowError("BAD_MONEY", { value: input });
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new ImportPipelineRowError("BAD_MONEY", { value: input });

  const rupees = BigInt(match[1] ?? "0");
  const paiseText = (match[2] ?? "").padEnd(2, "0");
  const paise = BigInt(paiseText || "0");
  const minor = rupees * 100n + paise;
  return negative ? -minor : minor;
}

function parseDecimalScaled(value: string, scale: bigint, errorCode: string) {
  const cleaned = value.trim().toLowerCase().replace(/\s+/g, "");
  const match = /^(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!match) throw new ImportPipelineRowError(errorCode, { value });
  const whole = BigInt(match[1] ?? "0") * scale;
  const decimals = match[2] ?? "";
  const padded = decimals.padEnd(String(scale).length - 1, "0").slice(0, String(scale).length - 1);
  if (decimals.length > String(scale).length - 1 && /[1-9]/.test(decimals.slice(String(scale).length - 1))) {
    throw new ImportPipelineRowError(errorCode, { value });
  }
  return whole + BigInt(padded || "0");
}

export function parseGrams(input: unknown): number {
  const raw = String(input ?? "").trim();
  if (!raw) throw new ImportPipelineRowError("BAD_WEIGHT", { value: input });
  const normalized = raw.toLowerCase().replace(/\s+/g, "");
  if (normalized.endsWith("kg")) {
    const grams = parseDecimalScaled(normalized.slice(0, -2), 1000n, "BAD_WEIGHT");
    return +grams.toString();
  }
  if (normalized.endsWith("g")) {
    const grams = parseDecimalScaled(normalized.slice(0, -1), 1n, "BAD_WEIGHT");
    return +grams.toString();
  }
  const grams = parseDecimalScaled(normalized, 1n, "BAD_WEIGHT");
  return +grams.toString();
}

function parseDateParts(raw: string, format: string) {
  if (format === "DD/MM/YYYY") {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
    return match ? { day: match[1]!, month: match[2]!, year: match[3]! } : null;
  }
  if (format === "YYYY-MM-DD") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    return match ? { day: match[3]!, month: match[2]!, year: match[1]! } : null;
  }
  if (format === "DD-MM-YYYY") {
    const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(raw);
    return match ? { day: match[1]!, month: match[2]!, year: match[3]! } : null;
  }
  return null;
}

function toInt(text: string) {
  return /^\d+$/.test(text) ? +text : NaN;
}

export function parseDateValue(input: unknown, formats: unknown): string {
  const raw = String(input ?? "").trim();
  const declaredFormats = Array.isArray(formats) ? formats.filter((format): format is string => typeof format === "string") : [];
  for (const format of declaredFormats) {
    const parts = parseDateParts(raw, format);
    if (!parts) continue;
    const iso = `${parts.year}-${parts.month}-${parts.day}`;
    const date = new Date(`${iso}T00:00:00.000Z`);
    const year = toInt(parts.year);
    const month = toInt(parts.month);
    const day = toInt(parts.day);
    if (
      date.getUTCFullYear() === year
      && date.getUTCMonth() + 1 === month
      && date.getUTCDate() === day
    ) {
      return iso;
    }
  }
  throw new ImportPipelineRowError("BAD_DATE", { value: input, formats: declaredFormats });
}

function chargeCodeMap(definition: FormatPackDefinition) {
  return isObject(definition.charge_code_map) ? definition.charge_code_map : {};
}

export function classifyChargeCode(value: unknown, definition: FormatPackDefinition) {
  const code = String(value ?? "").trim();
  const mapped = chargeCodeMap(definition)[code];
  if (typeof mapped !== "string" || !ALLOWED_EVENT_CLASSES.has(mapped)) {
    throw new ImportPipelineRowError("UNKNOWN_CHARGE_CODE", { chargeCode: code });
  }
  return mapped;
}

export function applyPrimitive(value: unknown, config: PrimitiveConfig, context: PrimitiveContext): unknown {
  const name = primitiveName(config);
  const args = primitiveArgs(config);

  if (name === "trim") return String(value ?? "").trim();
  if (name === "normalize_whitespace") return String(value ?? "").replace(/\s+/g, " ").trim();
  if (name === "normalize_header") return normalizeHeader(value);
  if (name === "parse_paise") return parseMinorUnits(value);
  if (name === "parse_date") return parseDateValue(value, args);
  if (name === "parse_grams") return parseGrams(value);
  if (name === "parse_string") return String(value ?? "");
  if (name === "parse_enum") {
    const allowed = isObject(args) && Array.isArray(args.values) ? args.values : Array.isArray(args) ? args : [];
    const text = String(value ?? "").trim();
    if (allowed.length && !allowed.includes(text)) throw new ImportPipelineRowError("INVALID_ENUM", { field: context.fieldKey, value: text });
    return text;
  }
  if (name === "map_charge_code" || name === "classify_event") return classifyChargeCode(value, context.definition);
  if (name === "infer_sign") return value;
  if (name === "require_field") {
    if (String(value ?? "").trim() === "") throw new ImportPipelineRowError("REQUIRED_FIELD_MISSING", { field: context.fieldKey });
    return value;
  }
  if (name === "optional_field") return value;
  if (name === "row_filter" || name === "duplicate_key" || name === "total_rule") return value;

  throw new ImportPipelineRowError("UNSUPPORTED_PRIMITIVE", { primitive: name });
}

export function serializeParsedValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => serializeParsedValue(item));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializeParsedValue(item)]));
  }
  return value;
}
