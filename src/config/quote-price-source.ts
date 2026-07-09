export const QUOTE_PRICE_SOURCES = ["catalog_strict", "client_allowed"] as const;
export type QuotePriceSource = (typeof QUOTE_PRICE_SOURCES)[number];

export class QuotePriceSourceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotePriceSourceConfigError";
  }
}

type QuotePriceSourceEnv = {
  NODE_ENV?: string | undefined;
  APP_ENV?: string | undefined;
  QUOTE_PRICE_SOURCE?: string | undefined;
};

function isProtectedRuntime(source: QuotePriceSourceEnv) {
  const nodeEnv = String(source.NODE_ENV ?? "development").trim().toLowerCase();
  const appEnv = String(source.APP_ENV ?? (nodeEnv === "production" ? "production" : nodeEnv)).trim().toLowerCase();
  return nodeEnv === "production" || appEnv === "production" || appEnv === "staging";
}

function normalizeQuotePriceSource(value: string | undefined): QuotePriceSource | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return null;
  if (QUOTE_PRICE_SOURCES.includes(normalized as QuotePriceSource)) return normalized as QuotePriceSource;
  throw new QuotePriceSourceConfigError("QUOTE_PRICE_SOURCE must be catalog_strict or client_allowed");
}

export function resolveQuotePriceSource(source: QuotePriceSourceEnv = process.env): QuotePriceSource {
  const explicit = normalizeQuotePriceSource(source.QUOTE_PRICE_SOURCE);
  const resolved = explicit ?? (isProtectedRuntime(source) ? "catalog_strict" : "client_allowed");

  if (resolved === "client_allowed" && isProtectedRuntime(source)) {
    throw new QuotePriceSourceConfigError("QUOTE_PRICE_SOURCE=client_allowed is forbidden in staging/production");
  }

  return resolved;
}

export function quotePriceSourceRequiresCheckoutSession(source: QuotePriceSource) {
  return source === "catalog_strict";
}
