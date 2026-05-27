import { DomainProvider, DomainProvisioningStatus, DomainStatus, Prisma } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";

export type StorefrontStatus = "ACTIVE" | "PENDING_DOMAIN" | "SUSPENDED";

export type StorefrontThemeJson = {
  primaryColor: string;
  backgroundColor: string;
  textColor: string;
  fontFamily: string;
  heroTitle: string;
  heroSubtitle: string;
  ctaLabel: string;
  logoUrl?: string | undefined;
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
};

export type UpdateAdminStorefrontSettingsInput = {
  id: string;
  themeJson: AdminStorefrontThemeJson;
  client?: DbClient;
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

  const logoUrl = (themeJson as Record<string, unknown>).logoUrl;
  if (logoUrl !== undefined && typeof logoUrl !== "string") {
    logger.error({ ...context, invalidField: "logoUrl" }, "Storefront theme config has an invalid optional field");
    throw new HttpError(500, "CONFIG_ERROR");
  }

  return themeJson as StorefrontThemeJson;
}

export function validateStorefrontThemeJson(themeJson: unknown) {
  return validateThemeJson(themeJson, {});
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

  return withStorefrontTransaction(input.client, async (client) => {
    const merchant = await client.merchant.findUnique({
      where: { id: input.merchantId },
      select: { id: true }
    });
    if (!merchant) throw new HttpError(404, "MERCHANT_NOT_FOUND");

    const storefront = await client.storefront.create({
      data: {
        merchantId: input.merchantId,
        name: input.name,
        settings: {
          create: {
            themeJson: input.themeJson
          }
        }
      },
      include: {
        settings: true,
        domains: true
      }
    });

    await writeStorefrontProvisioningEvent({
      client,
      merchantId: input.merchantId,
      storefrontId: storefront.id,
      eventType: "STOREFRONT_CREATED",
      payload: {
        name: input.name
      },
      safeMessage: "Storefront created by Shipmastr admin"
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

  return withStorefrontTransaction(input.client, async (client) => {
    const storefront = await client.storefront.findUnique({
      where: { id: input.id },
      select: {
        id: true,
        merchantId: true
      }
    });
    if (!storefront) throw new HttpError(404, "STOREFRONT_NOT_FOUND");

    await client.storefrontSettings.upsert({
      where: { storefrontId: input.id },
      update: {
        themeJson: input.themeJson
      },
      create: {
        storefrontId: input.id,
        themeJson: input.themeJson
      }
    });

    await writeStorefrontProvisioningEvent({
      client,
      merchantId: storefront.merchantId,
      storefrontId: storefront.id,
      eventType: "STOREFRONT_SETTINGS_UPDATED",
      payload: {
        updatedFields: REQUIRED_THEME_FIELDS
      },
      safeMessage: "Storefront settings updated by Shipmastr admin"
    });

    return getAdminStorefront({ id: input.id, client });
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

