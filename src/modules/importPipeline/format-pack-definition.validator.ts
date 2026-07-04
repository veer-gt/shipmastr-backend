import { createHash } from "node:crypto";
import { isParserPrimitive } from "./parser-primitive.registry.js";
import type {
  FormatPackDefinition,
  FormatPackValidationIssue,
  FormatPackValidationResult
} from "./types.js";

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "schema_version",
  "source",
  "headers",
  "columns",
  "charge_code_map",
  "event_class_map",
  "row_filters",
  "duplicate_key",
  "total_rule",
  "quirks",
  "metadata"
]);

export const ALLOWED_EVENT_CLASSES = new Set([
  "freight_charged",
  "weight_dispute_debit",
  "weight_dispute_credit",
  "cod_collected",
  "cod_remitted",
  "rto_freight_charged",
  "return_freight_charged",
  "shipment_refund",
  "deduction_unattributed",
  "unknown"
]);

const UNSAFE_STRING_PARTS = [
  ["ev", "al("],
  ["new ", "Function"],
  ["javascript:"],
  ["req", "uire("],
  ["imp", "ort("],
  ["v", "m."],
  ["child", "_process"]
];

const UNSAFE_WORD_PARTS = [
  ["script"],
  ["exec"],
  ["spawn"],
  ["function"]
];

const SQL_FRAGMENT_PATTERN = /\b(select|insert|update|delete)\b/i;
const REGEX_CONFIG_KEYS = new Set(["regex", "regexp", "pattern", "match", "matches"]);
const COLUMN_CONFIG_KEYS = new Set(["from", "transforms"]);

export class FormatPackDefinitionValidationError extends Error {
  readonly code = "FORMAT_PACK_DEFINITION_INVALID";
  readonly issues: FormatPackValidationIssue[];

  constructor(issues: FormatPackValidationIssue[]) {
    super(issues.map((issue) => issue.code).join(", "));
    this.name = "FormatPackDefinitionValidationError";
    this.issues = issues;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pushIssue(issues: FormatPackValidationIssue[], code: string, path: string, message: string) {
  issues.push({ code, path, message });
}

function unsafeStringReason(value: string) {
  const normalized = value.toLowerCase();
  const unsafe = UNSAFE_STRING_PARTS
    .map((parts) => parts.join(""))
    .find((fragment) => normalized.includes(fragment.toLowerCase()));
  if (unsafe) return "EXECUTABLE_STRING";
  const unsafeWord = UNSAFE_WORD_PARTS
    .map((parts) => parts.join(""))
    .find((fragment) => new RegExp(`\\b${fragment.toLowerCase()}\\b`).test(normalized));
  if (unsafeWord) return "EXECUTABLE_STRING";
  if (SQL_FRAGMENT_PATTERN.test(value)) return "SQL_LIKE_STRING";
  return null;
}

function validateJsonValue(value: unknown, path: string, issues: FormatPackValidationIssue[]) {
  if (value === undefined || typeof value === "symbol" || typeof value === "bigint" || typeof value === "function") {
    pushIssue(issues, "NON_JSON_VALUE", path, "Format pack definitions must be JSON data only.");
    return;
  }

  if (typeof value === "string") {
    const reason = unsafeStringReason(value);
    if (reason) {
      pushIssue(issues, reason, path, "Executable-code-like or SQL-like strings are not allowed in format pack definitions.");
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => validateJsonValue(item, `${path}[${index}]`, issues));
    return;
  }

  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (REGEX_CONFIG_KEYS.has(key.toLowerCase())) {
        pushIssue(issues, "ARBITRARY_REGEX_NOT_ALLOWED", `${path}.${key}`, "Arbitrary regex config is blocked in W0B-2.");
      }
      validateJsonValue(item, `${path}.${key}`, issues);
    }
  }
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim());
}

function validateHeaders(headers: unknown, issues: FormatPackValidationIssue[]) {
  if (!isObject(headers)) {
    pushIssue(issues, "HEADERS_INVALID", "headers", "headers must be an object when present.");
    return;
  }

  if (!stringArray(headers.fingerprint)) {
    pushIssue(issues, "HEADERS_FINGERPRINT_REQUIRED", "headers.fingerprint", "headers.fingerprint must be a non-empty string array.");
  }

  if ("aliases" in headers) {
    if (!isObject(headers.aliases)) {
      pushIssue(issues, "HEADERS_ALIASES_INVALID", "headers.aliases", "headers.aliases must be an object when present.");
      return;
    }
    for (const [alias, values] of Object.entries(headers.aliases)) {
      if (!stringArray(values)) {
        pushIssue(issues, "HEADERS_ALIAS_VALUES_INVALID", `headers.aliases.${alias}`, "header aliases must be non-empty string arrays.");
      }
    }
  }
}

function primitiveNameFromTransform(transform: unknown): string | null {
  if (typeof transform === "string") return transform;
  if (isObject(transform)) {
    const keys = Object.keys(transform);
    return keys.length === 1 ? keys[0] ?? null : null;
  }
  return null;
}

function validateTransform(transform: unknown, path: string, issues: FormatPackValidationIssue[]) {
  const primitiveName = primitiveNameFromTransform(transform);

  if (!primitiveName) {
    pushIssue(issues, "TRANSFORM_INVALID", path, "transforms must be primitive names or single-key primitive config objects.");
    return;
  }

  if (!isParserPrimitive(primitiveName)) {
    pushIssue(issues, "UNKNOWN_PRIMITIVE", path, `Unknown parser primitive: ${primitiveName}`);
  }

  if (isObject(transform) && Object.keys(transform).length !== 1) {
    pushIssue(issues, "TRANSFORM_CONFIG_INVALID", path, "primitive config objects must contain exactly one primitive key.");
  }
}

function columnTransforms(columnConfig: unknown) {
  if (!isObject(columnConfig) || !Array.isArray(columnConfig.transforms)) return [];
  return columnConfig.transforms
    .map((transform) => primitiveNameFromTransform(transform))
    .filter((primitive): primitive is string => Boolean(primitive));
}

function validateColumns(columns: unknown, issues: FormatPackValidationIssue[]) {
  if (!isObject(columns)) {
    pushIssue(issues, "COLUMNS_INVALID", "columns", "columns must be an object when present.");
    return;
  }

  for (const [columnKey, config] of Object.entries(columns)) {
    const path = `columns.${columnKey}`;
    if (!isObject(config)) {
      pushIssue(issues, "COLUMN_CONFIG_INVALID", path, "column config must be an object.");
      continue;
    }

    for (const key of Object.keys(config)) {
      if (!COLUMN_CONFIG_KEYS.has(key)) {
        pushIssue(issues, "COLUMN_CONFIG_KEY_UNKNOWN", `${path}.${key}`, `Unknown column config key: ${key}`);
      }
    }

    if (typeof config.from !== "string" || !config.from.trim()) {
      pushIssue(issues, "COLUMN_FROM_REQUIRED", `${path}.from`, "column config requires a source column name.");
    }

    if ("transforms" in config) {
      if (!Array.isArray(config.transforms)) {
        pushIssue(issues, "COLUMN_TRANSFORMS_INVALID", `${path}.transforms`, "column transforms must be an array.");
      } else {
        config.transforms.forEach((transform, index) => validateTransform(transform, `${path}.transforms[${index}]`, issues));
      }
    }
  }
}

function validateEventClassMap(value: unknown, path: string, issues: FormatPackValidationIssue[]) {
  if (!isObject(value)) {
    pushIssue(issues, "EVENT_CLASS_MAP_INVALID", path, `${path} must be an object.`);
    return;
  }

  for (const [key, eventClass] of Object.entries(value)) {
    if (typeof eventClass !== "string" || !ALLOWED_EVENT_CLASSES.has(eventClass)) {
      pushIssue(issues, "EVENT_CLASS_INVALID", `${path}.${key}`, `Unsupported event class: ${String(eventClass)}`);
    }
  }
}

function validateDuplicateKey(value: unknown, columns: unknown, issues: FormatPackValidationIssue[]) {
  if (!stringArray(value)) {
    pushIssue(issues, "DUPLICATE_KEY_INVALID", "duplicate_key", "duplicate_key must be a non-empty array of column keys.");
    return;
  }

  if (!isObject(columns)) return;
  for (const key of value) {
    if (!(key in columns)) {
      pushIssue(issues, "DUPLICATE_KEY_UNKNOWN_COLUMN", "duplicate_key", `duplicate_key references unknown column: ${key}`);
    }
  }
}

function validatesAsNumericColumn(field: string, columns: unknown) {
  if (field.endsWith("_minor")) return true;
  if (!isObject(columns)) return false;
  const transforms = columnTransforms(columns[field]);
  return transforms.includes("parse_paise") || transforms.includes("parse_grams");
}

function validateTotalRule(value: unknown, columns: unknown, issues: FormatPackValidationIssue[]) {
  if (!isObject(value)) {
    pushIssue(issues, "TOTAL_RULE_INVALID", "total_rule", "total_rule must be an object.");
    return;
  }

  if (typeof value.field !== "string" || !value.field.trim()) {
    pushIssue(issues, "TOTAL_RULE_FIELD_REQUIRED", "total_rule.field", "total_rule.field must reference a parsed numeric field.");
    return;
  }

  if (isObject(columns) && !(value.field in columns)) {
    pushIssue(issues, "TOTAL_RULE_UNKNOWN_FIELD", "total_rule.field", "total_rule.field references an unknown parsed column.");
  }

  if (!validatesAsNumericColumn(value.field, columns)) {
    pushIssue(issues, "TOTAL_RULE_FIELD_NOT_NUMERIC", "total_rule.field", "total_rule.field must reference a minor-unit or numeric parsed field.");
  }

  if (value.must_equal !== "stated_total_minor") {
    pushIssue(issues, "TOTAL_RULE_TARGET_INVALID", "total_rule.must_equal", "total_rule.must_equal must be stated_total_minor in W0B-2.");
  }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

export function definitionHash(definition: FormatPackDefinition) {
  return createHash("sha256").update(canonicalJson(definition)).digest("hex");
}

export class FormatPackDefinitionValidator {
  validate(definition: FormatPackDefinition): FormatPackValidationResult {
    const issues: FormatPackValidationIssue[] = [];

    if (!isObject(definition)) {
      throw new FormatPackDefinitionValidationError([{
        code: "DEFINITION_INVALID",
        path: "$",
        message: "Format pack definition must be an object."
      }]);
    }

    validateJsonValue(definition, "$", issues);

    for (const key of Object.keys(definition)) {
      if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
        pushIssue(issues, "TOP_LEVEL_KEY_UNKNOWN", key, `Unknown top-level key: ${key}`);
      }
    }

    if ("headers" in definition) validateHeaders(definition.headers, issues);
    if ("columns" in definition) validateColumns(definition.columns, issues);
    if ("charge_code_map" in definition) validateEventClassMap(definition.charge_code_map, "charge_code_map", issues);
    if ("event_class_map" in definition) validateEventClassMap(definition.event_class_map, "event_class_map", issues);
    if ("duplicate_key" in definition) validateDuplicateKey(definition.duplicate_key, definition.columns, issues);
    if ("total_rule" in definition) validateTotalRule(definition.total_rule, definition.columns, issues);

    if (issues.length) {
      throw new FormatPackDefinitionValidationError(issues);
    }

    const serialized = canonicalJson(definition);
    return {
      ok: true,
      canonicalJson: serialized,
      definitionHash: createHash("sha256").update(serialized).digest("hex")
    };
  }
}

export const formatPackDefinitionValidator = new FormatPackDefinitionValidator();
