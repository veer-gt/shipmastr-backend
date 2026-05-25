import {
  DomainProvider,
  DomainProvisioningStatus,
  DomainStatus,
  MerchantDomainSource,
  Prisma
} from "@prisma/client";
import { ActorType, actorTypeForAccount } from "../../lib/accountRoles.js";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import {
  fallbackPriceForTld,
  formatDomainSafeMessage,
  merchantDomainStatusLabel,
  normalizeDomain,
  normalizeMerchantDomainRequestDomain,
  type DomainPrice
} from "./domain.utils.js";
import {
  buildAdminDomainDiagnosticsView,
  buildMerchantDomainStatusView
} from "./domain-status.presenter.js";
import { cloudflareDuplicateHostnameSafeMessage } from "./providers/cloudflare.service.js";
import { resellerClubService, type DomainAvailabilityResult } from "./providers/resellerclub.service.js";

type DbClient = Prisma.TransactionClient | typeof prisma;

type AvailabilityProvider = {
  checkAvailability(domain: string): Promise<DomainAvailabilityResult>;
};

type DomainRow = {
  id: string;
  merchantId: string;
  storefrontId: string | null;
  domain: string;
  normalizedDomain: string;
  source: MerchantDomainSource;
  provider: DomainProvider;
  status: DomainStatus;
  isPrimary: boolean;
  sslStatus: string | null;
  validationRecords: Prisma.JsonValue | null;
  expiresAt: Date | null;
  autoRenew: boolean;
  lastCheckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type ProvisioningDomainRow = {
  id: string;
  merchantId: string;
  normalizedDomain: string;
  provider: DomainProvider;
  status: DomainStatus;
  cloudflareCustomHostnameId: string | null;
  sslStatus: string | null;
};

export type MerchantDomainRequestIntent = "CONNECT_EXISTING_DOMAIN" | "BUY_NEW_DOMAIN";

const merchantDomainSelect = {
  id: true,
  merchantId: true,
  storefrontId: true,
  domain: true,
  normalizedDomain: true,
  source: true,
  provider: true,
  status: true,
  isPrimary: true,
  sslStatus: true,
  validationRecords: true,
  expiresAt: true,
  autoRenew: true,
  lastCheckedAt: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.MerchantDomainSelect;

function ensureMerchantScope(merchantId?: string | null) {
  if (!merchantId) throw new HttpError(403, "MERCHANT_SCOPE_REQUIRED");
}

export async function assertMerchantDomainAccess(userId: string, merchantId: string, client: DbClient = prisma) {
  ensureMerchantScope(merchantId);
  const user = await client.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      merchantId: true,
      role: true,
      userType: true,
      merchant: {
        select: {
          id: true,
          name: true,
          onboardingStatus: true
        }
      }
    }
  });

  if (!user || user.merchantId !== merchantId || !user.merchant) {
    throw new HttpError(403, "MERCHANT_DOMAIN_ACCESS_DENIED");
  }

  const actorType = actorTypeForAccount({
    role: user.role,
    userType: user.userType,
    onboardingStatus: user.merchant.onboardingStatus
  });

  if (actorType !== ActorType.MERCHANT) {
    throw new HttpError(403, "MERCHANT_PANEL_REQUIRED");
  }

  return user.merchant;
}

function safeDomain(row: DomainRow) {
  const merchantStatus = row.status === DomainStatus.CLOUDFLARE_PENDING ? DomainStatus.DNS_PENDING : row.status;
  const statusView = buildMerchantDomainStatusView({
    domain: row.domain,
    status: row.status,
    validationRecords: row.validationRecords,
    sslStatus: row.sslStatus,
    updatedAt: row.updatedAt,
    lastCheckedAt: row.lastCheckedAt
  });

  return {
    id: row.id,
    domain: row.domain,
    normalizedDomain: row.normalizedDomain,
    source: row.source,
    provider: row.provider === DomainProvider.MANUAL ? "manual" : "shipmastr",
    status: merchantStatus,
    merchantStatus: statusView.status,
    statusLabel: statusView.title || merchantDomainStatusLabel(merchantStatus),
    statusView,
    isPrimary: row.isPrimary,
    storefrontId: row.storefrontId,
    expiresAt: row.expiresAt,
    renewal: row.expiresAt ? { expiresAt: row.expiresAt, autoRenew: row.autoRenew } : null,
    lastCheckedAt: row.lastCheckedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

const DOMAIN_STATUS_RANK: Partial<Record<DomainStatus, number>> = {
  [DomainStatus.SEARCHED]: 0,
  [DomainStatus.AVAILABLE]: 0,
  [DomainStatus.UNAVAILABLE]: 0,
  [DomainStatus.PAYMENT_REQUIRED]: 1,
  [DomainStatus.APPROVAL_REQUIRED]: 1,
  [DomainStatus.REGISTERING]: 2,
  [DomainStatus.REGISTERED]: 3,
  [DomainStatus.DNS_PENDING]: 4,
  [DomainStatus.CLOUDFLARE_PENDING]: 4,
  [DomainStatus.SSL_PENDING]: 5,
  [DomainStatus.ACTIVE]: 6,
  [DomainStatus.SUSPENDED]: 7,
  [DomainStatus.EXPIRED]: 7,
  [DomainStatus.RENEWAL_DUE]: 7
};

function assertForwardDomainStatusTransition(current: DomainStatus, next: DomainStatus) {
  if (current === next || next === DomainStatus.FAILED || current === DomainStatus.FAILED) return;

  const currentRank = DOMAIN_STATUS_RANK[current];
  const nextRank = DOMAIN_STATUS_RANK[next];
  if (currentRank === undefined || nextRank === undefined) return;

  if (nextRank < currentRank) {
    throw new HttpError(409, "DOMAIN_STATUS_REGRESSION_BLOCKED");
  }
}

function hasVerifiedSslSignal(input: {
  eventType: string;
  provider: DomainProvider;
  sslStatus?: string | undefined;
}, domainRow: ProvisioningDomainRow) {
  if (input.provider !== DomainProvider.CLOUDFLARE) return false;
  const sslStatus = (input.sslStatus || domainRow.sslStatus || "").toLowerCase();
  const activeSslStatus = ["active", "issued", "valid", "verified"].some((status) => sslStatus.includes(status));
  const activeEventType = /SSL_ACTIVE|SSL_ISSUED|CLOUDFLARE_ACTIVE|CUSTOM_HOSTNAME_ACTIVE/i.test(input.eventType);
  return activeSslStatus || activeEventType;
}

function assertActiveRequiresCloudflareSsl(input: {
  eventType: string;
  provider: DomainProvider;
  status: DomainStatus;
  cloudflareCustomHostnameId?: string | undefined;
  sslStatus?: string | undefined;
}, domainRow: ProvisioningDomainRow) {
  if (input.status !== DomainStatus.ACTIVE) return;
  const customHostnameId = input.cloudflareCustomHostnameId || domainRow.cloudflareCustomHostnameId;
  if (!customHostnameId || !hasVerifiedSslSignal(input, domainRow)) {
    throw new HttpError(409, "DOMAIN_ACTIVE_REQUIRES_SSL_VERIFICATION");
  }
}

function safeProviderError(error: unknown) {
  if (error instanceof HttpError) throw error;
  throw new HttpError(502, "DOMAIN_PROVIDER_TEMPORARILY_UNAVAILABLE");
}

async function priceForTld(tld: string, client: DbClient): Promise<DomainPrice> {
  const product = await client.domainProduct.findFirst({
    where: {
      tld: tld.toLowerCase(),
      provider: DomainProvider.RESELLERCLUB,
      isActive: true
    },
    select: {
      registrationPricePaise: true,
      renewalPricePaise: true,
      currency: true
    }
  });

  if (!product) return fallbackPriceForTld(tld);
  return {
    registrationPaise: product.registrationPricePaise,
    renewalPaise: product.renewalPricePaise,
    currency: product.currency
  };
}

async function createDomainEvent(input: {
  client: DbClient;
  merchantId?: string | null | undefined;
  merchantDomainId?: string | null | undefined;
  storefrontId?: string | null | undefined;
  provider: DomainProvider;
  eventType: string;
  status: DomainProvisioningStatus;
  requestPayload?: Prisma.InputJsonValue | undefined;
  responsePayload?: Prisma.InputJsonValue | undefined;
  safeMessage?: string | undefined;
  internalError?: string | undefined;
  providerReferenceId?: string | undefined;
  idempotencyKey?: string | undefined;
}) {
  const data: Prisma.DomainProvisioningEventCreateInput = {
    provider: input.provider,
    eventType: input.eventType,
    status: input.status,
    ...(input.merchantId ? { merchant: { connect: { id: input.merchantId } } } : {}),
    ...(input.merchantDomainId ? { merchantDomain: { connect: { id: input.merchantDomainId } } } : {}),
    ...(input.storefrontId ? { storefrontId: input.storefrontId } : {}),
    ...(input.requestPayload !== undefined ? { requestPayload: input.requestPayload } : {}),
    ...(input.responsePayload !== undefined ? { responsePayload: input.responsePayload } : {}),
    ...(input.safeMessage ? { safeMessage: input.safeMessage } : {}),
    ...(input.internalError ? { internalError: input.internalError } : {}),
    ...(input.providerReferenceId ? { providerReferenceId: input.providerReferenceId } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {})
  };

  if (!input.idempotencyKey) {
    return input.client.domainProvisioningEvent.create({ data });
  }

  return input.client.domainProvisioningEvent.upsert({
    where: { idempotencyKey: input.idempotencyKey },
    create: data,
    update: {}
  });
}

export async function searchMerchantDomain(input: {
  userId: string;
  merchantId: string;
  domain: string;
  client?: DbClient;
  provider?: AvailabilityProvider;
}) {
  const client = input.client || prisma;
  await assertMerchantDomainAccess(input.userId, input.merchantId, client);

  const normalized = normalizeDomain(input.domain);
  const price = await priceForTld(normalized.tld, client);
  const provider = input.provider || resellerClubService;

  try {
    const availability = await provider.checkAvailability(normalized.normalizedDomain);
    await createDomainEvent({
      client,
      merchantId: input.merchantId,
      provider: DomainProvider.RESELLERCLUB,
      eventType: "DOMAIN_SEARCH",
      status: DomainProvisioningStatus.SUCCEEDED,
      requestPayload: { domain: normalized.normalizedDomain },
      responsePayload: availability.raw as Prisma.InputJsonValue,
      safeMessage: formatDomainSafeMessage(normalized.normalizedDomain, availability.available)
    });

    return {
      domain: normalized.normalizedDomain,
      available: availability.available,
      price,
      message: formatDomainSafeMessage(normalized.normalizedDomain, availability.available)
    };
  } catch (error) {
    await createDomainEvent({
      client,
      merchantId: input.merchantId,
      provider: DomainProvider.RESELLERCLUB,
      eventType: "DOMAIN_SEARCH",
      status: DomainProvisioningStatus.FAILED,
      requestPayload: { domain: normalized.normalizedDomain },
      safeMessage: "Domain search could not be completed",
      internalError: error instanceof Error ? error.message : String(error)
    });
    safeProviderError(error);
  }
}

async function assertDomainNotOwnedByAnotherMerchant(normalizedDomain: string, merchantId: string, client: DbClient) {
  const existing = await client.merchantDomain.findUnique({
    where: { normalizedDomain },
    select: {
      id: true,
      merchantId: true
    }
  });

  if (existing && existing.merchantId !== merchantId) {
    throw new HttpError(409, "DOMAIN_ALREADY_CONNECTED");
  }

  return existing;
}

async function assertStorefrontBelongsToMerchant(storefrontId: string | null | undefined, merchantId: string, client: DbClient) {
  if (!storefrontId) return null;
  const storefront = await client.storefront.findFirst({
    where: {
      id: storefrontId,
      merchantId
    },
    select: {
      id: true,
      merchantId: true,
      name: true
    }
  });

  if (!storefront) throw new HttpError(404, "STOREFRONT_NOT_FOUND");
  return storefront;
}

async function assertStorefrontDomainNotOwnedByAnotherMerchant(domain: string, merchantId: string, client: DbClient) {
  const existing = await client.storefrontDomain.findUnique({
    where: { domain },
    include: {
      storefront: {
        select: {
          id: true,
          merchantId: true
        }
      }
    }
  });

  if (existing && existing.storefront.merchantId !== merchantId) {
    throw new HttpError(409, "DOMAIN_ALREADY_CONNECTED");
  }

  return existing;
}

export async function requestMerchantDomainActivation(input: {
  userId: string;
  merchantId: string;
  domain: string;
  storefrontId?: string | null | undefined;
  intent: MerchantDomainRequestIntent;
  note?: string | null | undefined;
  client?: DbClient;
  allowApex?: boolean | undefined;
}) {
  const client = input.client || prisma;
  await assertMerchantDomainAccess(input.userId, input.merchantId, client);
  const normalized = normalizeMerchantDomainRequestDomain(
    input.domain,
    input.allowApex === true ? { allowApex: true } : {}
  );
  const storefront = await assertStorefrontBelongsToMerchant(input.storefrontId, input.merchantId, client);
  const existingMerchantDomain = await assertDomainNotOwnedByAnotherMerchant(normalized.normalizedDomain, input.merchantId, client);
  const existingStorefrontDomain = storefront
    ? await assertStorefrontDomainNotOwnedByAnotherMerchant(normalized.normalizedDomain, input.merchantId, client)
    : null;
  const source =
    input.intent === "BUY_NEW_DOMAIN"
      ? MerchantDomainSource.PURCHASED_THROUGH_SHIPMASTR
      : MerchantDomainSource.EXTERNAL_CONNECTED;
  const requestPayload = {
    domain: normalized.normalizedDomain,
    storefrontId: storefront?.id || null,
    intent: input.intent,
    note: String(input.note || "").trim() || null,
    apexSupport: normalized.isApex ? "explicitly_allowed" : "subdomain_or_www"
  } satisfies Prisma.InputJsonValue;

  const work = async (tx: DbClient) => {
    const merchantDomain = existingMerchantDomain
      ? await tx.merchantDomain.update({
          where: { id: existingMerchantDomain.id },
          data: {
            storefrontId: storefront?.id || input.storefrontId || null,
            domain: normalized.domain,
            normalizedDomain: normalized.normalizedDomain,
            source,
            provider: DomainProvider.MANUAL,
            status: DomainStatus.REQUESTED,
            validationRecords: {
              requestStatus: "PENDING_REVIEW",
              intent: input.intent
            },
            lastCheckedAt: new Date()
          },
          select: merchantDomainSelect
        })
      : await tx.merchantDomain.create({
          data: {
            merchantId: input.merchantId,
            storefrontId: storefront?.id || input.storefrontId || null,
            domain: normalized.domain,
            normalizedDomain: normalized.normalizedDomain,
            source,
            provider: DomainProvider.MANUAL,
            status: DomainStatus.REQUESTED,
            validationRecords: {
              requestStatus: "PENDING_REVIEW",
              intent: input.intent
            }
          },
          select: merchantDomainSelect
        });

    let storefrontDomainStatus: DomainStatus | "NOT_LINKED" = "NOT_LINKED";
    if (storefront) {
      const storefrontDomain = existingStorefrontDomain
        ? await tx.storefrontDomain.update({
            where: { id: existingStorefrontDomain.id },
            data: {
              storefrontId: storefront.id,
              status: DomainStatus.REQUESTED,
              isPrimary: false,
              lastCheckedAt: new Date()
            },
            select: { id: true, status: true }
          })
        : await tx.storefrontDomain.create({
            data: {
              storefrontId: storefront.id,
              domain: normalized.normalizedDomain,
              status: DomainStatus.REQUESTED,
              isPrimary: false
            },
            select: { id: true, status: true }
          });
      storefrontDomainStatus = storefrontDomain.status;
    }

    await createDomainEvent({
      client: tx,
      merchantId: input.merchantId,
      merchantDomainId: merchantDomain.id,
      storefrontId: storefront?.id || null,
      provider: DomainProvider.MANUAL,
      eventType: "DOMAIN_ACTIVATION_REQUESTED",
      status: DomainProvisioningStatus.PENDING,
      requestPayload,
      safeMessage: "Merchant requested domain setup review"
    });

    return {
      domain: safeDomain(merchantDomain),
      request: {
        domain: normalized.normalizedDomain,
        intent: input.intent,
        status: DomainStatus.REQUESTED,
        storefrontId: storefront?.id || null,
        storefrontDomainStatus
      },
      message: "Request received. Shipmastr will guide you through connecting this domain."
    };
  };

  if (input.client) return work(client);
  return prisma.$transaction((tx) => work(tx));
}

export async function createDomainPurchaseIntent(input: {
  userId: string;
  merchantId: string;
  domain: string;
  storefrontId?: string | null | undefined;
  client?: DbClient;
}) {
  const client = input.client || prisma;
  await assertMerchantDomainAccess(input.userId, input.merchantId, client);
  const normalized = normalizeDomain(input.domain);
  const existing = await assertDomainNotOwnedByAnotherMerchant(normalized.normalizedDomain, input.merchantId, client);
  const price = await priceForTld(normalized.tld, client);

  const row = existing
    ? await client.merchantDomain.update({
        where: { id: existing.id },
        data: {
          source: MerchantDomainSource.PURCHASED_THROUGH_SHIPMASTR,
          provider: DomainProvider.RESELLERCLUB,
          status: DomainStatus.PAYMENT_REQUIRED,
          storefrontId: input.storefrontId || null,
          autoRenew: true
        },
        select: merchantDomainSelect
      })
    : await client.merchantDomain.create({
        data: {
          merchantId: input.merchantId,
          storefrontId: input.storefrontId || null,
          domain: normalized.domain,
          normalizedDomain: normalized.normalizedDomain,
          source: MerchantDomainSource.PURCHASED_THROUGH_SHIPMASTR,
          provider: DomainProvider.RESELLERCLUB,
          status: DomainStatus.PAYMENT_REQUIRED,
          autoRenew: true
        },
        select: merchantDomainSelect
      });

  await createDomainEvent({
    client,
    merchantId: input.merchantId,
    merchantDomainId: row.id,
    storefrontId: input.storefrontId || null,
    provider: DomainProvider.RESELLERCLUB,
    eventType: "PURCHASE_INTENT_CREATED",
    status: DomainProvisioningStatus.PENDING,
    requestPayload: {
      domain: normalized.normalizedDomain,
      price
    },
    safeMessage: "Domain purchase is waiting for payment confirmation"
  });

  return {
    purchaseIntentId: row.id,
    domain: safeDomain(row),
    price,
    message: "Complete payment to buy this brand domain with Shipmastr"
  };
}

export async function connectExistingDomain(input: {
  userId: string;
  merchantId: string;
  domain: string;
  storefrontId?: string | null | undefined;
  client?: DbClient;
}) {
  const client = input.client || prisma;
  await assertMerchantDomainAccess(input.userId, input.merchantId, client);
  const normalized = normalizeDomain(input.domain);
  const existing = await assertDomainNotOwnedByAnotherMerchant(normalized.normalizedDomain, input.merchantId, client);
  const validationRecords = {
    instructions: "Point your domain to the DNS records shown in Shipmastr. SSL checks continue automatically.",
    records: []
  };

  const row = existing
    ? await client.merchantDomain.update({
        where: { id: existing.id },
        data: {
          source: MerchantDomainSource.EXTERNAL_CONNECTED,
          provider: DomainProvider.CLOUDFLARE,
          status: DomainStatus.DNS_PENDING,
          storefrontId: input.storefrontId || null,
          validationRecords
        },
        select: merchantDomainSelect
      })
    : await client.merchantDomain.create({
        data: {
          merchantId: input.merchantId,
          storefrontId: input.storefrontId || null,
          domain: normalized.domain,
          normalizedDomain: normalized.normalizedDomain,
          source: MerchantDomainSource.EXTERNAL_CONNECTED,
          provider: DomainProvider.CLOUDFLARE,
          status: DomainStatus.DNS_PENDING,
          validationRecords
        },
        select: merchantDomainSelect
      });

  await createDomainEvent({
    client,
    merchantId: input.merchantId,
    merchantDomainId: row.id,
    storefrontId: input.storefrontId || null,
    provider: DomainProvider.CLOUDFLARE,
    eventType: "EXTERNAL_DOMAIN_CONNECTED",
    status: DomainProvisioningStatus.PENDING,
    requestPayload: { domain: normalized.normalizedDomain },
    safeMessage: "DNS connection has started"
  });

  return {
    domain: safeDomain(row),
    message: "Your domain is being connected. DNS and SSL checks can take some time, but your setup will continue automatically."
  };
}

export async function listMerchantDomains(input: {
  userId: string;
  merchantId: string;
  client?: DbClient;
}) {
  const client = input.client || prisma;
  await assertMerchantDomainAccess(input.userId, input.merchantId, client);
  const rows = await client.merchantDomain.findMany({
    where: { merchantId: input.merchantId },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
    select: merchantDomainSelect
  });

  return {
    domains: rows.map(safeDomain),
    count: rows.length
  };
}

export async function getMerchantDomain(input: {
  userId: string;
  merchantId: string;
  id: string;
  client?: DbClient;
}) {
  const client = input.client || prisma;
  await assertMerchantDomainAccess(input.userId, input.merchantId, client);
  const row = await client.merchantDomain.findFirst({
    where: {
      id: input.id,
      merchantId: input.merchantId
    },
    select: merchantDomainSelect
  });

  if (!row) throw new HttpError(404, "DOMAIN_NOT_FOUND");
  return { domain: safeDomain(row) };
}

function provisioningStatusForDomainStatus(status: DomainStatus) {
  if (status === DomainStatus.FAILED) return DomainProvisioningStatus.FAILED;
  if (status === DomainStatus.ACTIVE || status === DomainStatus.REGISTERED) return DomainProvisioningStatus.SUCCEEDED;
  return DomainProvisioningStatus.PROCESSING;
}

export async function recordDomainProvisioningEvent(input: {
  merchantId?: string | null | undefined;
  storefrontId?: string | null | undefined;
  merchantDomainId?: string | null | undefined;
  domain?: string | null | undefined;
  provider: DomainProvider;
  eventType: string;
  status: DomainStatus;
  eventStatus?: DomainProvisioningStatus | undefined;
  safeMessage?: string | undefined;
  internalError?: string | undefined;
  providerReferenceId?: string | undefined;
  resellerClubEntityId?: string | undefined;
  resellerClubOrderId?: string | undefined;
  cloudflareCustomHostnameId?: string | undefined;
  sslStatus?: string | undefined;
  validationRecords?: Prisma.InputJsonValue | undefined;
  expiresAt?: Date | undefined;
  requestPayload?: Prisma.InputJsonValue | undefined;
  responsePayload?: Prisma.InputJsonValue | undefined;
  idempotencyKey?: string | undefined;
  client?: DbClient;
}) {
  const client = input.client || prisma;
  let domainRow: ProvisioningDomainRow | null = null;

  if (input.merchantDomainId) {
    domainRow = await client.merchantDomain.findUnique({
      where: { id: input.merchantDomainId },
      select: {
        id: true,
        merchantId: true,
        normalizedDomain: true,
        provider: true,
        status: true,
        cloudflareCustomHostnameId: true,
        sslStatus: true
      }
    });
  } else if (input.domain) {
    const normalized = normalizeDomain(input.domain);
    domainRow = await client.merchantDomain.findUnique({
      where: { normalizedDomain: normalized.normalizedDomain },
      select: {
        id: true,
        merchantId: true,
        normalizedDomain: true,
        provider: true,
        status: true,
        cloudflareCustomHostnameId: true,
        sslStatus: true
      }
    });
  }

  if (!domainRow) throw new HttpError(404, "DOMAIN_NOT_FOUND");
  if (input.merchantId && input.merchantId !== domainRow.merchantId) {
    throw new HttpError(403, "MERCHANT_DOMAIN_SCOPE_MISMATCH");
  }
  assertForwardDomainStatusTransition(domainRow.status, input.status);
  assertActiveRequiresCloudflareSsl(input, domainRow);

  const event = await createDomainEvent({
    client,
    merchantId: domainRow.merchantId,
    merchantDomainId: domainRow.id,
    storefrontId: input.storefrontId || null,
    provider: input.provider,
    eventType: input.eventType,
    status: input.eventStatus || provisioningStatusForDomainStatus(input.status),
    requestPayload: input.requestPayload,
    responsePayload: input.responsePayload,
    safeMessage: input.safeMessage,
    internalError: input.internalError,
    providerReferenceId: input.providerReferenceId,
    idempotencyKey:
      input.idempotencyKey ||
      `domain-event:${domainRow.id}:${input.provider}:${input.eventType}:${input.status}:${input.providerReferenceId || "none"}`
  });

  const updateData: Prisma.MerchantDomainUpdateInput = {
    status: input.status,
    provider: input.provider,
    lastCheckedAt: new Date(),
    ...(input.storefrontId ? { storefrontId: input.storefrontId } : {}),
    ...(input.resellerClubEntityId ? { resellerClubEntityId: input.resellerClubEntityId } : {}),
    ...(input.resellerClubOrderId ? { resellerClubOrderId: input.resellerClubOrderId } : {}),
    ...(input.cloudflareCustomHostnameId ? { cloudflareCustomHostnameId: input.cloudflareCustomHostnameId } : {}),
    ...(input.sslStatus ? { sslStatus: input.sslStatus } : {}),
    ...(input.validationRecords !== undefined ? { validationRecords: input.validationRecords } : {}),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {})
  };

  const updated = await client.merchantDomain.update({
    where: { id: domainRow.id },
    data: updateData,
    select: merchantDomainSelect
  });

  return {
    eventId: event.id,
    domain: safeDomain(updated),
    status: updated.status
  };
}

export async function startDomainRegistration(input: {
  merchantId: string;
  merchantDomainId: string;
  paymentReferenceId: string;
  paymentVerified: boolean;
  onboardingApproved: boolean;
  client?: DbClient;
}) {
  const client = input.client || prisma;
  const row = await client.merchantDomain.findFirst({
    where: {
      id: input.merchantDomainId,
      merchantId: input.merchantId
    },
    select: {
      id: true,
      merchantId: true,
      status: true,
      normalizedDomain: true
    }
  });

  if (!row) throw new HttpError(404, "DOMAIN_NOT_FOUND");
  if (!input.paymentVerified) throw new HttpError(409, "DOMAIN_PAYMENT_NOT_VERIFIED");
  if (!input.onboardingApproved) throw new HttpError(409, "DOMAIN_ONBOARDING_NOT_APPROVED");
  if (row.status !== DomainStatus.PAYMENT_REQUIRED && row.status !== DomainStatus.FAILED) {
    throw new HttpError(409, "DOMAIN_REGISTRATION_ALREADY_STARTED");
  }

  // This endpoint only moves an already paid and approved purchase into the provider queue.
  // Provider registration must never be triggered by search or purchase intent alone.
  await createDomainEvent({
    client,
    merchantId: row.merchantId,
    merchantDomainId: row.id,
    provider: DomainProvider.RESELLERCLUB,
    eventType: "REGISTRATION_REQUESTED",
    status: DomainProvisioningStatus.PROCESSING,
    requestPayload: {
      domain: row.normalizedDomain,
      paymentReferenceId: input.paymentReferenceId,
      paymentVerified: input.paymentVerified,
      onboardingApproved: input.onboardingApproved
    },
    idempotencyKey: `domain-registration:${row.id}:${input.paymentReferenceId}`,
    safeMessage: "Domain registration has started"
  });

  await client.merchantDomain.update({
    where: { id: row.id },
    data: {
      status: DomainStatus.REGISTERING,
      lastCheckedAt: new Date()
    }
  });

  return {
    merchantDomainId: row.id,
    status: DomainStatus.REGISTERING,
    message: "Domain registration has started"
  };
}

export async function listAdminDomains(input: {
  status?: DomainStatus | undefined;
  provider?: DomainProvider | undefined;
  merchantId?: string | undefined;
  client?: DbClient;
}) {
  const client = input.client || prisma;
  const rows = await client.merchantDomain.findMany({
    where: {
      ...(input.status ? { status: input.status } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.merchantId ? { merchantId: input.merchantId } : {})
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      merchant: {
        select: {
          id: true,
          name: true,
          email: true
        }
      }
    }
  });

  return { domains: rows, count: rows.length };
}

export async function getAdminDomainDiagnostics(input: {
  domain: string;
  client?: DbClient;
}) {
  const client = input.client || prisma;
  const normalized = normalizeDomain(input.domain);
  const row = await client.merchantDomain.findUnique({
    where: { normalizedDomain: normalized.normalizedDomain },
    include: {
      merchant: {
        select: {
          id: true,
          name: true,
          email: true
        }
      },
      events: {
        orderBy: { createdAt: "desc" },
        take: 50
      }
    }
  });

  if (!row) throw new HttpError(404, "DOMAIN_NOT_FOUND");
  const diagnostics = buildAdminDomainDiagnosticsView({
    domain: row.domain,
    status: row.status,
    provider: row.provider,
    source: row.source,
    resellerClubOrderId: row.resellerClubOrderId,
    resellerClubEntityId: row.resellerClubEntityId,
    cloudflareCustomHostnameId: row.cloudflareCustomHostnameId,
    validationRecords: row.validationRecords,
    sslStatus: row.sslStatus,
    updatedAt: row.updatedAt,
    lastCheckedAt: row.lastCheckedAt,
    events: row.events
  });

  return {
    domain: row,
    diagnostics,
    providerWarnings: {
      cloudflareDuplicateHostname: cloudflareDuplicateHostnameSafeMessage()
    }
  };
}
