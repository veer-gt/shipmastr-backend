import { DomainProvider, DomainProvisioningStatus, DomainStatus, Prisma } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";

export type StorefrontStatus = "ACTIVE" | "PENDING_DOMAIN" | "SUSPENDED";

export type StorefrontProduct = {
  // SF5 Layer 3: stable client-generated catalog key, used to upsert the matching
  // StorefrontProduct DB row (see syncThemeJsonProductsToCatalog) that the storefront's
  // server-authoritative checkout quote endpoint resolves price from.
  id?: string | undefined;
  name: string;
  price?: string | undefined;
  description?: string | undefined;
  // SF1: imageAssetId is what the client sends; imageUrl is server-resolved from the
  // ready StorefrontAsset at save time (never client-supplied, never base64).
  imageAssetId?: string | undefined;
  imageUrl?: string | undefined;
};

export type StorefrontThemeJson = {
  primaryColor: string;
  backgroundColor: string;
  textColor: string;
  fontFamily: string;
  heroTitle: string;
  heroSubtitle: string;
  ctaLabel: string;
  logoAssetId?: string | undefined;
  logoUrl?: string | undefined;
  heroImageAssetId?: string | undefined;
  heroImageUrl?: string | undefined;
  templateStyle?: string | undefined;
  // SF5 Layer 1: closed enum, no URL field alongside it. This is the only purchase
  // action a storefront theme can ever express — there is deliberately nowhere in this
  // schema for a merchant to point checkout at an external URL.
  ctaAction?: "shipmastr_checkout" | undefined;
  // SF4: which of the 2 real hero layout archetypes (extracted from the 75 preset
  // landing pages — see storefront-presets.ts) this theme renders with.
  heroLayout?: "hero-center" | "hero-split" | undefined;
  // SF4: lineage back to the preset this theme started from (see storefront-presets.ts
  // resolveStorefrontPresetTheme). Informational — not required, not re-validated
  // against the registry on every save, so a merchant's own edits always win.
  presetId?: string | undefined;
  presetVersion?: number | undefined;
  products?: StorefrontProduct[] | undefined;
};

export type StorefrontSettings = {
  tenantId: string;
  merchantId: string;
  domain: string;
  storeName: string;
  status: StorefrontStatus;
  themeJson: StorefrontThemeJson;
};

const DOMAIN_PATTERN = /^[a-z0-9.-]+$/;
const REQUIRED_THEME_FIELDS = [
  "primaryColor",
  "backgroundColor",
  "textColor",
  "fontFamily",
  "heroTitle",
  "heroSubtitle",
  "ctaLabel"
] as const;
const ADMIN_DOMAIN_STATUS_VALUES = [
  DomainStatus.REQUESTED,
  DomainStatus.REGISTERING,
  DomainStatus.REGISTERED,
  DomainStatus.CLOUDFLARE_PENDING,
  DomainStatus.SSL_PENDING,
  DomainStatus.ACTIVE,
  DomainStatus.FAILED,
  DomainStatus.SUSPENDED
] as const;
const PLATFORM_STOREFRONT_DOMAINS = new Set(["shipmastr.com"]);
const SENSITIVE_EVENT_PAYLOAD_KEY_PATTERN = /(api.?key|token|authorization|password|secret|bearer)/i;

export type StorefrontLookupClient = {
  storefrontDomain: {
    findUnique(input: {
      where: { domain: string };
      include: { storefront: { include: { settings: true } } };
    }): Promise<{
      domain: string;
      status: string;
      storefront: {
        id: string;
        merchantId: string;
        name: string;
        settings: { themeJson: unknown } | null;
      };
    } | null>;
  };
};

export type AdminStorefrontThemeJson = StorefrontThemeJson;

export type CreateAdminStorefrontInput = {
  merchantId: string;
  name: string;
  themeJson: AdminStorefrontThemeJson;
  client?: DbClient;
  actorLabel?: string;
};

export type UpdateAdminStorefrontSettingsInput = {
  id: string;
  themeJson: AdminStorefrontThemeJson;
  client?: DbClient;
  actorLabel?: string;
};

export type AddAdminStorefrontDomainInput = {
  id: string;
  domain: string;
  isPrimary?: boolean | undefined;
  client?: DbClient;
};

export type UpdateAdminStorefrontDomainStatusInput = {
  id: string;
  domainId: string;
  status: AdminStorefrontDomainStatus;
  failureReason?: string | undefined;
  client?: DbClient;
};

export type AdminStorefrontDomainLifecycleInput = {
  id: string;
  client?: DbClient;
};

export type AdminStorefrontDomainEventsInput = {
  id: string;
  domainId: string;
  client?: DbClient;
};

type DbClient = Prisma.TransactionClient | typeof prisma;
export type AdminStorefrontDomainStatus = (typeof ADMIN_DOMAIN_STATUS_VALUES)[number];

export function normalizeStorefrontDomain(domain: string) {
  const normalized = String(domain || "")
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");

  if (
    !normalized ||
    !DOMAIN_PATTERN.test(normalized) ||
    normalized.startsWith(".") ||
    normalized.endsWith(".") ||
    normalized.includes("..")
  ) {
    throw new HttpError(400, "VALIDATION_ERROR");
  }

  return normalized;
}

function normalizeStorefrontLookupCandidates(domain: string) {
  const raw = String(domain || "").trim().toLowerCase();
  const normalized = normalizeStorefrontDomain(domain);
  const candidates = [normalized];

  if (
    raw &&
    raw !== normalized &&
    DOMAIN_PATTERN.test(raw) &&
    !raw.startsWith(".") &&
    !raw.endsWith(".") &&
    !raw.includes("..")
  ) {
    candidates.unshift(raw);
  }

  if (!normalized.startsWith("www.")) {
    candidates.push(`www.${normalized}`);
  }

  return Array.from(new Set(candidates));
}

export function normalizeAdminStorefrontDomain(domain: string) {
  const normalized = normalizeStorefrontDomain(domain);

  if (PLATFORM_STOREFRONT_DOMAINS.has(normalized)) {
    throw new HttpError(400, "DOMAIN_RESERVED_FOR_SHIPMASTR");
  }

  return normalized;
}

export const storefrontTestFixtures = [
  {
    tenantId: "tenant_celvya",
    merchantId: "merchant_celvya",
    domain: "celvyawellness.in",
    storeName: "Celvya Wellness",
    domainStatus: "ACTIVE",
    themeJson: {
      primaryColor: "#2dd4bf",
      backgroundColor: "#080b10",
      textColor: "#f8fafc",
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      heroTitle: "Clean wellness essentials for everyday rituals",
      heroSubtitle: "Thoughtfully made care products, shipped with Shipmastr checkout and delivery confidence.",
      ctaLabel: "Explore the store"
    }
  },
  {
    tenantId: "tenant_pending",
    merchantId: "merchant_pending",
    domain: "pending.shipmastr.store",
    storeName: "Pending Storefront",
    domainStatus: "SSL_PENDING",
    themeJson: {
      primaryColor: "#38bdf8",
      backgroundColor: "#0a0f1a",
      textColor: "#eef6ff",
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      heroTitle: "Your storefront is almost ready",
      heroSubtitle: "DNS and SSL setup may still be in progress.",
      ctaLabel: "Setup in progress"
    }
  },
  {
    tenantId: "tenant_suspended",
    merchantId: "merchant_suspended",
    domain: "suspended.shipmastr.store",
    storeName: "Unavailable Storefront",
    domainStatus: "SUSPENDED",
    themeJson: {
      primaryColor: "#f59e0b",
      backgroundColor: "#0d0d0c",
      textColor: "#fff7ed",
      fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
      heroTitle: "Storefront unavailable",
      heroSubtitle: "This storefront is temporarily unavailable.",
      ctaLabel: "Unavailable"
    }
  }
] as const;

export function mapDomainStatusToRendererStatus(status: string): StorefrontStatus {
  if (status === "ACTIVE") {
    return "ACTIVE";
  }

  if (status === "SUSPENDED" || status === "FAILED") {
    return "SUSPENDED";
  }

  return "PENDING_DOMAIN";
}

const MAX_STOREFRONT_PRODUCTS = 5;

function validateThemeJson(themeJson: unknown, context: { domain?: string; storefrontId?: string }) {
  if (!themeJson || typeof themeJson !== "object" || Array.isArray(themeJson)) {
    logger.error(context, "Storefront theme config is missing or invalid");
    throw new HttpError(500, "CONFIG_ERROR");
  }

  for (const field of REQUIRED_THEME_FIELDS) {
    if (typeof (themeJson as Record<string, unknown>)[field] !== "string") {
      logger.error({ ...context, missingField: field }, "Storefront theme config is missing a required field");
      throw new HttpError(500, "CONFIG_ERROR");
    }
  }

  const record = themeJson as Record<string, unknown>;

  for (const field of ["logoAssetId", "logoUrl", "heroImageAssetId", "heroImageUrl", "templateStyle"] as const) {
    const value = record[field];
    if (value !== undefined && typeof value !== "string") {
      logger.error({ ...context, invalidField: field }, "Storefront theme config has an invalid optional field");
      throw new HttpError(500, "CONFIG_ERROR");
    }
  }

  // SF5 Layer 1: ctaAction, if present at all, must be exactly the closed enum value —
  // there is no other value to set and definitely no URL field alongside it.
  if (record.ctaAction !== undefined && record.ctaAction !== "shipmastr_checkout") {
    logger.error({ ...context, invalidField: "ctaAction" }, "Storefront theme config has an invalid ctaAction");
    throw new HttpError(500, "CONFIG_ERROR");
  }

  // SF4: heroLayout, if present, must be one of the 2 real archetypes.
  if (record.heroLayout !== undefined && record.heroLayout !== "hero-center" && record.heroLayout !== "hero-split") {
    logger.error({ ...context, invalidField: "heroLayout" }, "Storefront theme config has an invalid heroLayout");
    throw new HttpError(500, "CONFIG_ERROR");
  }

  if (record.presetId !== undefined && typeof record.presetId !== "string") {
    logger.error({ ...context, invalidField: "presetId" }, "Storefront theme config has an invalid presetId");
    throw new HttpError(500, "CONFIG_ERROR");
  }

  if (record.presetVersion !== undefined && typeof record.presetVersion !== "number") {
    logger.error({ ...context, invalidField: "presetVersion" }, "Storefront theme config has an invalid presetVersion");
    throw new HttpError(500, "CONFIG_ERROR");
  }

  const products = record.products;
  if (products !== undefined) {
    if (!Array.isArray(products) || products.length > MAX_STOREFRONT_PRODUCTS) {
      logger.error({ ...context, invalidField: "products" }, "Storefront theme config has an invalid products list");
      throw new HttpError(500, "CONFIG_ERROR");
    }
    for (const product of products) {
      if (!product || typeof product !== "object" || Array.isArray(product)) {
        logger.error({ ...context, invalidField: "products" }, "Storefront theme config has an invalid product entry");
        throw new HttpError(500, "CONFIG_ERROR");
      }
      const p = product as Record<string, unknown>;
      if (typeof p.name !== "string" || !p.name.trim()) {
        logger.error({ ...context, invalidField: "products.name" }, "Storefront product is missing a name");
        throw new HttpError(500, "CONFIG_ERROR");
      }
      for (const optionalField of ["id", "price", "description", "imageAssetId", "imageUrl"] as const) {
        if (p[optionalField] !== undefined && typeof p[optionalField] !== "string") {
          logger.error({ ...context, invalidField: `products.${optionalField}` }, "Storefront product has an invalid field");
          throw new HttpError(500, "CONFIG_ERROR");
        }
      }
    }
  }

  return themeJson as StorefrontThemeJson;
}

export function validateStorefrontThemeJson(themeJson: unknown) {
  return validateThemeJson(themeJson, {});
}

// SF2: application-level guard independent of the body-parser limit — even if the parser
// limit regresses upward again, a themeJson blob can never silently grow back into an
// image-bytes container. This is a *save-time-only* check (existing, pre-migration rows
// may still legitimately exceed this until the SF1c migration runs — see storefront
// migration script — so it is intentionally not applied on read).
export const MAX_THEME_JSON_SERIALIZED_BYTES = 200 * 1024;

// SF1 + SF5 defense in depth: no inline image bytes anywhere in themeJson, ever, even in a
// field nobody thought to scope this to (e.g. a merchant pasting a data: URL into a text field).
const DATA_IMAGE_PATTERN = /data:image\//i;

export function assertThemeJsonSaveSafety(themeJson: unknown, context: { storefrontId?: string; merchantId?: string } = {}) {
  const serialized = JSON.stringify(themeJson);

  if (Buffer.byteLength(serialized, "utf8") > MAX_THEME_JSON_SERIALIZED_BYTES) {
    logger.warn({ ...context, bytes: Buffer.byteLength(serialized, "utf8") }, "Rejected oversized themeJson save");
    throw new HttpError(400, "THEME_TOO_LARGE");
  }

  if (DATA_IMAGE_PATTERN.test(serialized)) {
    logger.warn(context, "Rejected themeJson save containing an inline data:image blob");
    throw new HttpError(400, "THEME_CONTAINS_INLINE_IMAGE");
  }

  return themeJson;
}

// SF5 Layer 1 (schema): the storefront schema has no href/URL field anywhere on a
// purchase/CTA action — the only purchase action is the closed `shipmastr_checkout`
// enum (see themeJsonSchema.ctaAction in storefronts.routes.ts), so there is nothing
// for a merchant to point at an external checkout/payment URL even if they wanted to.
// Defense in depth: free-text fields (headings, subheadings, CTA label, product name /
// description) are still plain strings a merchant could type a link into, so we reject
// any save where those fields contain a recognizable external checkout/payment/
// messaging link — wa.me-style "buy on WhatsApp" links, UPI deep links, and payment-
// collection-link services are the common ways sellers route customers off-platform.
// This list is deliberately not exhaustive; extend it as new services are identified.
const EXTERNAL_CHECKOUT_LINK_PATTERNS: RegExp[] = [
  /wa\.me\//i,
  /api\.whatsapp\.com/i,
  /whatsapp:\/\//i,
  /upi:\/\//i,
  /razorpay\.me\//i,
  /rzp\.io\//i,
  /paytm\.me\//i,
  /phonepe\.me\//i,
  /paypal\.me\//i,
  /cashfree\.com\/pg\//i,
  /instamojo\.com\//i,
  /buy\.stripe\.com\//i,
  /payu\.in\//i,
  /pages\.razorpay\.com\//i
];

const TEXT_FIELDS_TO_SCAN_FOR_EXTERNAL_LINKS = ["heroTitle", "heroSubtitle", "ctaLabel"] as const;

function findExternalCheckoutLinkMatch(value: string): string | null {
  for (const pattern of EXTERNAL_CHECKOUT_LINK_PATTERNS) {
    if (pattern.test(value)) return pattern.source;
  }
  return null;
}

export function assertNoExternalCheckoutSignals(themeJson: StorefrontThemeJson, context: { storefrontId?: string; merchantId?: string } = {}) {
  for (const field of TEXT_FIELDS_TO_SCAN_FOR_EXTERNAL_LINKS) {
    const value = themeJson[field];
    if (typeof value !== "string") continue;
    const matched = findExternalCheckoutLinkMatch(value);
    if (matched) {
      logger.warn({ ...context, field, pattern: matched, eventType: "STOREFRONT_EXTERNAL_CHECKOUT_LINK_REJECTED" }, "Rejected themeJson save containing an external checkout/payment/messaging link");
      throw new HttpError(400, "THEME_CONTAINS_EXTERNAL_CHECKOUT_LINK");
    }
  }

  for (const product of themeJson.products ?? []) {
    for (const field of ["name", "description"] as const) {
      const value = product[field];
      if (typeof value !== "string") continue;
      const matched = findExternalCheckoutLinkMatch(value);
      if (matched) {
        logger.warn({ ...context, field: `products.${field}`, pattern: matched, eventType: "STOREFRONT_EXTERNAL_CHECKOUT_LINK_REJECTED" }, "Rejected themeJson save containing an external checkout/payment/messaging link in a product field");
        throw new HttpError(400, "THEME_CONTAINS_EXTERNAL_CHECKOUT_LINK");
      }
    }
  }

  return themeJson;
}

// SF1b: resolves imageAssetId / heroImageAssetId / logoAssetId references to their real,
// CDN-served URLs — only for assets that are READY and owned by this merchant. Any
// unconfirmed, deleted, or cross-merchant asset id fails the save outright with a specific
// error rather than silently dropping the image.
export async function resolveThemeJsonAssetReferences(input: {
  themeJson: StorefrontThemeJson;
  merchantId: string;
  client?: DbClient;
}): Promise<StorefrontThemeJson> {
  const { assertReadyStorefrontAssetOwnedByMerchant, storefrontAssetPublicUrl } = await import("./storefront-assets.service.js");
  const theme = { ...input.themeJson };

  async function resolve(assetId: string | undefined) {
    if (!assetId) return undefined;
    const asset = await assertReadyStorefrontAssetOwnedByMerchant({
      merchantId: input.merchantId,
      assetId,
      ...(input.client ? { client: input.client } : {})
    });
    const url = storefrontAssetPublicUrl(asset.gcsPath);
    if (!url) {
      // No CDN host configured yet — fail closed rather than persist a broken/missing url.
      throw new HttpError(503, "STOREFRONT_ASSETS_CDN_NOT_CONFIGURED");
    }
    return url;
  }

  if (theme.logoAssetId) {
    theme.logoUrl = await resolve(theme.logoAssetId);
  }
  if (theme.heroImageAssetId) {
    theme.heroImageUrl = await resolve(theme.heroImageAssetId);
  }
  if (theme.products?.length) {
    theme.products = await Promise.all(
      theme.products.map(async (product) => {
        if (!product.imageAssetId) return product;
        return { ...product, imageUrl: await resolve(product.imageAssetId) };
      })
    );
  }

  return theme;
}

// SF5 Layer 3: deterministic catalog id shared with the storefront-renderer, so a
// product a merchant added in themeJson.products (client-generated `id`) maps to
// exactly one StorefrontProduct row every save, and the renderer can independently
// recompute the same id to ask the server-authoritative checkout quote endpoint for it
// — without either side needing to look anything up first.
export function storefrontProductCatalogId(storefrontId: string, clientProductId: string) {
  return `${storefrontId}::${clientProductId}`;
}

// Parses a merchant's free-text product price ("999", "₹1,299.50", "Rs 499") into
// integer minor units (paise). Returns null if unparseable — callers should skip
// syncing that product to the catalog rather than fail the whole save, since a product
// without a resolvable price simply isn't purchasable yet (still fine to display).
export function parsePriceToMinorUnits(price: string | undefined): number | null {
  if (!price) return null;
  const cleaned = price.replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value) || value < 0) return null;
  const minor = Math.round(value * 100);
  if (!Number.isSafeInteger(minor)) return null;
  return minor;
}

// SF5 Layer 3: keeps StorefrontProduct (the DB table the server-authoritative checkout
// quote endpoint reads price from) in sync with themeJson.products whenever a merchant
// saves their storefront. Products without both a client `id` and a parseable price are
// skipped (still fine to display — just not yet purchasable via the storefront's own
// checkout quote endpoint until the merchant sets a price).
export async function syncThemeJsonProductsToCatalog(input: {
  themeJson: StorefrontThemeJson;
  storefrontId: string;
  merchantId: string;
  client?: DbClient;
}) {
  const client = input.client || prisma;
  const products = input.themeJson.products ?? [];
  const syncableIds = new Set<string>();

  for (const product of products) {
    if (!product.id) continue;
    const priceMinor = parsePriceToMinorUnits(product.price);
    if (priceMinor === null) continue;

    const catalogId = storefrontProductCatalogId(input.storefrontId, product.id);
    syncableIds.add(catalogId);

    await client.storefrontProduct.upsert({
      where: { id: catalogId },
      update: {
        name: product.name,
        priceMinor,
        description: product.description ?? null,
        imageAssetId: product.imageAssetId ?? null,
        isActive: true
      },
      create: {
        id: catalogId,
        storefrontId: input.storefrontId,
        merchantId: input.merchantId,
        name: product.name,
        priceMinor,
        description: product.description ?? null,
        imageAssetId: product.imageAssetId ?? null
      }
    });
  }

  // Deactivate (never delete — preserves order history references) any previously
  // synced catalog rows for this storefront that are no longer present in themeJson,
  // so a removed product can't still be bought via a stale productId.
  await client.storefrontProduct.updateMany({
    where: {
      storefrontId: input.storefrontId,
      isActive: true,
      id: { notIn: Array.from(syncableIds) }
    },
    data: { isActive: false }
  });
}

function safeStorefrontDomain(row: {
  id: string;
  domain: string;
  status: DomainStatus | string;
  isPrimary: boolean;
  verificationStatus?: string | null;
  dnsTarget?: string | null;
  sslStatus?: string | null;
  failureReason?: string | null;
  lastCheckedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}) {
  return {
    id: row.id,
    domain: row.domain,
    status: row.status,
    rendererStatus: mapDomainStatusToRendererStatus(row.status),
    isPrimary: row.isPrimary,
    verificationStatus: row.verificationStatus || null,
    dnsTarget: row.dnsTarget || null,
    sslStatus: row.sslStatus || null,
    failureReason: row.failureReason || null,
    lastCheckedAt: row.lastCheckedAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function safeStorefrontLifecycleDomain(row: {
  id: string;
  domain: string;
  status: DomainStatus | string;
  isPrimary: boolean;
  verificationStatus?: string | null;
  dnsTarget?: string | null;
  sslStatus?: string | null;
  failureReason?: string | null;
  lastCheckedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}) {
  return {
    id: row.id,
    domain: row.domain,
    status: row.status,
    isPrimary: row.isPrimary,
    verificationStatus: row.verificationStatus || null,
    dnsTarget: row.dnsTarget || null,
    sslStatus: row.sslStatus || null,
    failureReason: row.failureReason || null,
    lastCheckedAt: row.lastCheckedAt || null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export function redactStorefrontEventPayload(payload: unknown): unknown {
  if (Array.isArray(payload)) {
    return payload.map((item) => redactStorefrontEventPayload(item));
  }

  if (!payload || typeof payload !== "object") {
    return payload;
  }

  return Object.fromEntries(
    Object.entries(payload as Record<string, unknown>).map(([key, value]) => [
      key,
      SENSITIVE_EVENT_PAYLOAD_KEY_PATTERN.test(key) ? "[redacted]" : redactStorefrontEventPayload(value)
    ])
  );
}

function safeProvisioningEvent(row: {
  id: string;
  eventType: string;
  status: DomainProvisioningStatus | string;
  provider: DomainProvider | string;
  safeMessage?: string | null;
  storefrontDomainId?: string | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    eventType: row.eventType,
    status: row.status,
    provider: row.provider,
    safeMessage: row.safeMessage || null,
    storefrontDomainId: row.storefrontDomainId || null,
    createdAt: row.createdAt
  };
}

function safeAdminStorefrontDetail(row: any) {
  return {
    id: row.id,
    merchantId: row.merchantId,
    name: row.name,
    settings: row.settings
      ? {
          id: row.settings.id,
          themeJson: validateThemeJson(row.settings.themeJson, { storefrontId: row.id }),
          updatedAt: row.settings.updatedAt
        }
      : null,
    domains: (row.domains || []).map(safeStorefrontDomain),
    events: (row.events || []).map(safeProvisioningEvent),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

async function withStorefrontTransaction<T>(client: DbClient | undefined, fn: (tx: DbClient) => Promise<T>) {
  if (client) return fn(client);
  return prisma.$transaction((tx) => fn(tx));
}

async function writeStorefrontProvisioningEvent(input: {
  client: DbClient;
  merchantId: string;
  storefrontId: string;
  storefrontDomainId?: string | null | undefined;
  eventType: string;
  payload?: Prisma.InputJsonValue | undefined;
  safeMessage: string;
}) {
  const data: Prisma.DomainProvisioningEventUncheckedCreateInput = {
    merchantId: input.merchantId,
    storefrontId: input.storefrontId,
    provider: DomainProvider.MANUAL,
    eventType: input.eventType,
    status: DomainProvisioningStatus.SUCCEEDED,
    safeMessage: input.safeMessage
  };

  if (input.storefrontDomainId) {
    data.storefrontDomainId = input.storefrontDomainId;
  }

  if (input.payload !== undefined) {
    data.payload = input.payload;
  }

  return input.client.domainProvisioningEvent.create({ data });
}

export function assertAdminStorefrontDomainStatus(status: string): AdminStorefrontDomainStatus {
  if (ADMIN_DOMAIN_STATUS_VALUES.includes(status as AdminStorefrontDomainStatus)) {
    return status as AdminStorefrontDomainStatus;
  }

  throw new HttpError(400, "INVALID_STOREFRONT_DOMAIN_STATUS");
}

function isPrismaUniqueConstraint(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function createAdminStorefront(input: CreateAdminStorefrontInput) {
  validateStorefrontThemeJson(input.themeJson);
  assertThemeJsonSaveSafety(input.themeJson, { merchantId: input.merchantId });
  assertNoExternalCheckoutSignals(input.themeJson, { merchantId: input.merchantId });
  const actorLabel = input.actorLabel || "Shipmastr admin";

  return withStorefrontTransaction(input.client, async (client) => {
    const merchant = await client.merchant.findUnique({
      where: { id: input.merchantId },
      select: { id: true }
    });
    if (!merchant) throw new HttpError(404, "MERCHANT_NOT_FOUND");

    const resolvedThemeJson = await resolveThemeJsonAssetReferences({
      themeJson: input.themeJson,
      merchantId: input.merchantId,
      client
    });

    const storefront = await client.storefront.create({
      data: {
        merchantId: input.merchantId,
        name: input.name,
        settings: {
          create: {
            themeJson: resolvedThemeJson
          }
        }
      },
      include: {
        settings: true,
        domains: true
      }
    });

    await syncThemeJsonProductsToCatalog({
      themeJson: resolvedThemeJson,
      storefrontId: storefront.id,
      merchantId: input.merchantId,
      client
    });

    await writeStorefrontProvisioningEvent({
      client,
      merchantId: input.merchantId,
      storefrontId: storefront.id,
      eventType: "STOREFRONT_CREATED",
      payload: {
        name: input.name
      },
      safeMessage: `Storefront created by ${actorLabel}`
    });

    return getAdminStorefront({ id: storefront.id, client });
  });
}

export async function getAdminStorefront(input: { id: string; client?: DbClient }) {
  const client = input.client || prisma;
  const storefront = await client.storefront.findUnique({
    where: { id: input.id },
    include: {
      settings: true,
      domains: {
        orderBy: [
          { isPrimary: "desc" },
          { createdAt: "asc" }
        ]
      }
    }
  });

  if (!storefront) throw new HttpError(404, "STOREFRONT_NOT_FOUND");
  const events = await client.domainProvisioningEvent.findMany({
    where: { storefrontId: input.id },
    orderBy: { createdAt: "desc" },
    take: 50
  });

  return safeAdminStorefrontDetail({ ...storefront, events });
}

export async function listAdminStorefrontDomains(input: AdminStorefrontDomainLifecycleInput) {
  const client = input.client || prisma;
  const storefront = await client.storefront.findUnique({
    where: { id: input.id },
    select: { id: true }
  });
  if (!storefront) throw new HttpError(404, "STOREFRONT_NOT_FOUND");

  const domains = await client.storefrontDomain.findMany({
    where: { storefrontId: input.id },
    orderBy: [
      { isPrimary: "desc" },
      { createdAt: "asc" }
    ]
  });

  return {
    storefrontId: input.id,
    domains: domains.map(safeStorefrontLifecycleDomain)
  };
}

export async function listAdminStorefrontDomainEvents(input: AdminStorefrontDomainEventsInput) {
  const client = input.client || prisma;
  const storefront = await client.storefront.findUnique({
    where: { id: input.id },
    select: { id: true }
  });
  if (!storefront) throw new HttpError(404, "STOREFRONT_NOT_FOUND");

  const domain = await client.storefrontDomain.findUnique({
    where: { id: input.domainId },
    select: {
      id: true,
      storefrontId: true
    }
  });
  if (!domain || domain.storefrontId !== input.id) throw new HttpError(404, "STOREFRONT_DOMAIN_NOT_FOUND");

  const events = await client.domainProvisioningEvent.findMany({
    where: {
      storefrontId: input.id,
      storefrontDomainId: input.domainId
    },
    orderBy: { createdAt: "desc" }
  });

  return {
    storefrontId: input.id,
    storefrontDomainId: input.domainId,
    events: events.map((event) => ({
      id: event.id,
      eventType: event.eventType,
      payload: redactStorefrontEventPayload(event.payload),
      createdAt: event.createdAt
    }))
  };
}

export async function updateAdminStorefrontSettings(input: UpdateAdminStorefrontSettingsInput) {
  validateStorefrontThemeJson(input.themeJson);
  assertThemeJsonSaveSafety(input.themeJson, { storefrontId: input.id });
  assertNoExternalCheckoutSignals(input.themeJson, { storefrontId: input.id });
  const actorLabel = input.actorLabel || "Shipmastr admin";

  return withStorefrontTransaction(input.client, async (client) => {
    const storefront = await client.storefront.findUnique({
      where: { id: input.id },
      select: {
        id: true,
        merchantId: true
      }
    });
    if (!storefront) throw new HttpError(404, "STOREFRONT_NOT_FOUND");

    const resolvedThemeJson = await resolveThemeJsonAssetReferences({
      themeJson: input.themeJson,
      merchantId: storefront.merchantId,
      client
    });

    await client.storefrontSettings.upsert({
      where: { storefrontId: input.id },
      update: {
        themeJson: resolvedThemeJson
      },
      create: {
        storefrontId: input.id,
        themeJson: resolvedThemeJson
      }
    });

    await syncThemeJsonProductsToCatalog({
      themeJson: resolvedThemeJson,
      storefrontId: storefront.id,
      merchantId: storefront.merchantId,
      client
    });

    await writeStorefrontProvisioningEvent({
      client,
      merchantId: storefront.merchantId,
      storefrontId: storefront.id,
      eventType: "STOREFRONT_SETTINGS_UPDATED",
      payload: {
        updatedFields: REQUIRED_THEME_FIELDS
      },
      safeMessage: `Storefront settings updated by ${actorLabel}`
    });

    return getAdminStorefront({ id: input.id, client });
  });
}

// ---------------------------------------------------------------------------
// Merchant self-service wrappers. merchantId always comes from the caller's
// authenticated session (req.auth.merchantId in the route layer) — these
// functions never accept an arbitrary merchantId to act on someone else's
// storefront. A merchant is assumed to own at most one storefront for now
// (the most recently created one if more than one ever exists in the data).
// ---------------------------------------------------------------------------

export async function getMerchantStorefront(input: { merchantId: string; client?: DbClient }) {
  const client = input.client || prisma;
  const storefront = await client.storefront.findFirst({
    where: { merchantId: input.merchantId },
    orderBy: { createdAt: "desc" },
    select: { id: true }
  });
  if (!storefront) throw new HttpError(404, "STOREFRONT_NOT_FOUND");
  return getAdminStorefront({ id: storefront.id, client });
}

export async function findOrCreateMerchantStorefront(input: {
  merchantId: string;
  name: string;
  themeJson: AdminStorefrontThemeJson;
  client?: DbClient;
}) {
  const client = input.client || prisma;
  const existing = await client.storefront.findFirst({
    where: { merchantId: input.merchantId },
    orderBy: { createdAt: "desc" },
    select: { id: true }
  });

  if (existing) {
    return updateMerchantStorefrontSettings({
      merchantId: input.merchantId,
      themeJson: input.themeJson,
      client
    });
  }

  return createAdminStorefront({
    merchantId: input.merchantId,
    name: input.name,
    themeJson: input.themeJson,
    client,
    actorLabel: "merchant self-service"
  });
}

export async function updateMerchantStorefrontSettings(input: {
  merchantId: string;
  themeJson: AdminStorefrontThemeJson;
  client?: DbClient;
}) {
  const client = input.client || prisma;
  const storefront = await client.storefront.findFirst({
    where: { merchantId: input.merchantId },
    orderBy: { createdAt: "desc" },
    select: { id: true }
  });
  if (!storefront) throw new HttpError(404, "STOREFRONT_NOT_FOUND");

  return updateAdminStorefrontSettings({
    id: storefront.id,
    themeJson: input.themeJson,
    client,
    actorLabel: "merchant self-service"
  });
}

export async function addAdminStorefrontDomain(input: AddAdminStorefrontDomainInput) {
  const normalizedDomain = normalizeAdminStorefrontDomain(input.domain);

  return withStorefrontTransaction(input.client, async (client) => {
    const storefront = await client.storefront.findUnique({
      where: { id: input.id },
      select: {
        id: true,
        merchantId: true
      }
    });
    if (!storefront) throw new HttpError(404, "STOREFRONT_NOT_FOUND");

    const existingDomain = await client.storefrontDomain.findUnique({
      where: { domain: normalizedDomain },
      select: { id: true }
    });
    if (existingDomain) throw new HttpError(409, "DOMAIN_ALREADY_ATTACHED");

    if (input.isPrimary) {
      await client.storefrontDomain.updateMany({
        where: { storefrontId: input.id },
        data: { isPrimary: false }
      });
    }

    try {
      const domain = await client.storefrontDomain.create({
        data: {
          storefrontId: input.id,
          domain: normalizedDomain,
          status: DomainStatus.REQUESTED,
          isPrimary: Boolean(input.isPrimary)
        }
      });

      await writeStorefrontProvisioningEvent({
        client,
        merchantId: storefront.merchantId,
        storefrontId: storefront.id,
        storefrontDomainId: domain.id,
        eventType: "STOREFRONT_DOMAIN_ADDED",
        payload: {
          domain: normalizedDomain,
          isPrimary: Boolean(input.isPrimary)
        },
        safeMessage: "Storefront domain added by Shipmastr admin"
      });

      return getAdminStorefront({ id: input.id, client });
    } catch (error) {
      if (isPrismaUniqueConstraint(error)) {
        throw new HttpError(409, "DOMAIN_ALREADY_ATTACHED");
      }
      throw error;
    }
  });
}

export async function updateAdminStorefrontDomainStatus(input: UpdateAdminStorefrontDomainStatusInput) {
  const status = assertAdminStorefrontDomainStatus(input.status);

  return withStorefrontTransaction(input.client, async (client) => {
    const storefront = await client.storefront.findUnique({
      where: { id: input.id },
      select: {
        id: true,
        merchantId: true
      }
    });
    if (!storefront) throw new HttpError(404, "STOREFRONT_NOT_FOUND");

    const domain = await client.storefrontDomain.findUnique({
      where: { id: input.domainId },
      select: {
        id: true,
        storefrontId: true,
        domain: true,
        status: true
      }
    });
    if (!domain || domain.storefrontId !== input.id) throw new HttpError(404, "STOREFRONT_DOMAIN_NOT_FOUND");

    await client.storefrontDomain.update({
      where: { id: input.domainId },
      data: {
        status,
        failureReason: input.failureReason || null,
        lastCheckedAt: new Date()
      }
    });

    await writeStorefrontProvisioningEvent({
      client,
      merchantId: storefront.merchantId,
      storefrontId: storefront.id,
      storefrontDomainId: domain.id,
      eventType: "STOREFRONT_DOMAIN_STATUS_UPDATED",
      payload: {
        domain: domain.domain,
        previousStatus: domain.status,
        status,
        failureReason: input.failureReason || null
      },
      safeMessage: "Storefront domain status updated by Shipmastr admin"
    });

    return getAdminStorefront({ id: input.id, client });
  });
}

export async function getStorefrontByDomain(
  domain: string,
  client: StorefrontLookupClient = prisma
): Promise<StorefrontSettings | null> {
  const lookupCandidates = normalizeStorefrontLookupCandidates(domain);
  let storefrontDomain: Awaited<ReturnType<StorefrontLookupClient["storefrontDomain"]["findUnique"]>> = null;

  for (const lookupDomain of lookupCandidates) {
    storefrontDomain = await client.storefrontDomain.findUnique({
      where: {
        domain: lookupDomain
      },
      include: {
        storefront: {
          include: {
            settings: true
          }
        }
      }
    });

    if (storefrontDomain) {
      break;
    }
  }

  if (!storefrontDomain) {
    return null;
  }

  const storefront = storefrontDomain.storefront;
  if (!storefront.settings) {
    logger.error(
      {
        domain: storefrontDomain.domain,
        storefrontId: storefront.id
      },
      "Storefront settings are missing"
    );
    throw new HttpError(500, "CONFIG_ERROR");
  }

  return {
    tenantId: storefront.id,
    merchantId: storefront.merchantId,
    domain: storefrontDomain.domain,
    storeName: storefront.name,
    status: mapDomainStatusToRendererStatus(storefrontDomain.status),
    themeJson: validateThemeJson(storefront.settings.themeJson, {
      domain: storefrontDomain.domain,
      storefrontId: storefront.id
    })
  };
}

export async function listAdminStorefronts(input?: { client?: DbClient }) {
  const client = input?.client || prisma;
  const storefronts = await client.storefront.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      settings: true,
      domains: {
        orderBy: [
          { isPrimary: "desc" },
          { createdAt: "asc" }
        ]
      }
    }
  });

  return storefronts.map((sf) => ({
    id: sf.id,
    merchantId: sf.merchantId,
    name: sf.name,
    settings: sf.settings
      ? {
          id: sf.settings.id,
          themeJson: validateThemeJson(sf.settings.themeJson, { storefrontId: sf.id }),
          updatedAt: sf.settings.updatedAt
        }
      : null,
    domains: (sf.domains || []).map(safeStorefrontDomain),
    createdAt: sf.createdAt,
    updatedAt: sf.updatedAt
  }));
}

