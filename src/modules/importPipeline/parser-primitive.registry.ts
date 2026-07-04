export const PARSER_PRIMITIVES = [
  "trim",
  "normalize_whitespace",
  "normalize_header",
  "parse_paise",
  "parse_date",
  "parse_grams",
  "parse_string",
  "parse_enum",
  "map_charge_code",
  "infer_sign",
  "classify_event",
  "require_field",
  "optional_field",
  "row_filter",
  "duplicate_key",
  "total_rule"
] as const;

export type ParserPrimitiveName = typeof PARSER_PRIMITIVES[number];

const PRIMITIVE_SET = new Set<string>(PARSER_PRIMITIVES);

export function isParserPrimitive(value: unknown): value is ParserPrimitiveName {
  return typeof value === "string" && PRIMITIVE_SET.has(value);
}

export function listParserPrimitives() {
  return [...PARSER_PRIMITIVES];
}
