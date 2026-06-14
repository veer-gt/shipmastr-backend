import type { PartnerLeadConsentStatus } from "@prisma/client";

import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import {
  cleanString,
  isDuplicateKeyError,
  toStoredJson
} from "./growth-network-maturity.shared.js";
import type { PartnerMarketplaceDb } from "./partner-marketplace.service.js";
import {
  serializePartnerLeadConsent,
  serializePartnerLeadConsentList,
  serializePartnerLeadRoutingIntent,
  serializePartnerLeadRoutingIntentList,
  serializePartnerLeadRoutingReadiness,
  type PartnerLeadConsentRecord,
  type PartnerLeadRoutingIntentRecord
} from "./partner-routing.serializer.js";
import type {
  CreatePartnerLeadConsentInput,
  CreatePartnerLeadRoutingIntentInput,
  ListPartnerLeadConsentsQueryInput,
  ListPartnerLeadRoutingIntentsQueryInput,
  SimulatePartnerLeadRoutingInput,
  UpdatePartnerLeadConsentStatusInput
} from "./partner-routing.validation.js";

export type PartnerRoutingDb = {
  growthPartner?: PartnerMarketplaceDb["growthPartner"];
  growthPartnerLead?: PartnerMarketplaceDb["growthPartnerLead"];
  partnerLeadConsent: {
    create(input: { data: Record<string, unknown> }): Promise<PartnerLeadConsentRecord>;
    findMany(input?: Record<string, unknown>): Promise<PartnerLeadConsentRecord[]>;
    findUnique(input: { where: Record<string, unknown> }): Promise<PartnerLeadConsentRecord | null>;
    update(input: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<PartnerLeadConsentRecord>;
    count(input?: Record<string, unknown>): Promise<number>;
  };
  partnerLeadRoutingIntent: {
    create(input: { data: Record<string, unknown> }): Promise<PartnerLeadRoutingIntentRecord>;
    findMany(input?: Record<string, unknown>): Promise<PartnerLeadRoutingIntentRecord[]>;
    findUnique(input: { where: Record<string, unknown> }): Promise<PartnerLeadRoutingIntentRecord | null>;
    update(input: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<PartnerLeadRoutingIntentRecord>;
    count(input?: Record<string, unknown>): Promise<number>;
  };
};

const defaultClient = prisma as unknown as PartnerRoutingDb;

async function ensurePartnerIfProvided(partnerId: string | null, client: PartnerRoutingDb) {
  if (!partnerId || !client.growthPartner) return null;
  const partner = await client.growthPartner.findUnique({ where: { id: partnerId } });
  if (!partner) throw new HttpError(404, "GROWTH_PARTNER_NOT_FOUND");
  return partner;
}

async function ensureLeadIfProvided(leadId: string | null, client: PartnerRoutingDb) {
  if (!leadId || !client.growthPartnerLead) return null;
  const lead = await client.growthPartnerLead.findUnique({ where: { id: leadId } });
  if (!lead) throw new HttpError(404, "GROWTH_PARTNER_LEAD_NOT_FOUND");
  return lead;
}

async function ensureConsent(consentId: string, client: PartnerRoutingDb) {
  const consent = await client.partnerLeadConsent.findUnique({ where: { id: consentId } });
  if (!consent) throw new HttpError(404, "PARTNER_LEAD_CONSENT_NOT_FOUND");
  return consent;
}

async function ensureIntent(intentId: string, client: PartnerRoutingDb) {
  const intent = await client.partnerLeadRoutingIntent.findUnique({ where: { id: intentId } });
  if (!intent) throw new HttpError(404, "PARTNER_LEAD_ROUTING_INTENT_NOT_FOUND");
  return intent;
}

function consentIsUsable(consent: PartnerLeadConsentRecord | null, now = new Date()) {
  if (!consent) return false;
  if (consent.consentStatus !== "GRANTED") return false;
  if (consent.revokedAt) return false;
  if (consent.expiresAt && new Date(consent.expiresAt).getTime() <= now.getTime()) return false;
  return true;
}

function consentDataForStatus(status: PartnerLeadConsentStatus, input: UpdatePartnerLeadConsentStatusInput) {
  const now = new Date();
  const data: Record<string, unknown> = {
    consentStatus: status,
    ...(input.consentText !== undefined ? { consentText: cleanString(input.consentText) } : {}),
    ...(input.consentScope !== undefined ? { consentScope: toStoredJson(input.consentScope) } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt ?? null } : {}),
    ...(input.metadata !== undefined ? { metadata: toStoredJson(input.metadata) } : {})
  };
  if (status === "GRANTED") {
    data.grantedAt = input.grantedAt ?? now;
    data.revokedAt = null;
  }
  if (status === "REVOKED") {
    data.revokedAt = input.revokedAt ?? now;
  }
  if (status === "EXPIRED") {
    data.expiresAt = input.expiresAt ?? now;
  }
  return data;
}

async function findConsentForIntent(intent: PartnerLeadRoutingIntentRecord, client: PartnerRoutingDb) {
  if (intent.consentId) return client.partnerLeadConsent.findUnique({ where: { id: intent.consentId } });
  if (!intent.merchantId) return null;

  const consents = await client.partnerLeadConsent.findMany({
    where: {
      merchantId: intent.merchantId,
      consentStatus: "GRANTED",
      ...(intent.partnerId ? { partnerId: intent.partnerId } : {}),
      ...(intent.sellerId ? { sellerId: intent.sellerId } : {})
    },
    orderBy: { createdAt: "desc" }
  });

  return consents.find((consent) => consentIsUsable(consent)) ?? null;
}

function routingStatusForConsent(consent: PartnerLeadConsentRecord | null) {
  if (!consent) return "CONSENT_REQUIRED";
  return consentIsUsable(consent) ? "READY_SIMULATED" : "BLOCKED";
}

export async function createPartnerLeadConsent(
  input: CreatePartnerLeadConsentInput,
  client: PartnerRoutingDb = defaultClient
) {
  const partnerId = cleanString(input.partnerId);
  await ensurePartnerIfProvided(partnerId, client);
  const now = new Date();
  const consent = await client.partnerLeadConsent.create({
    data: {
      partnerId,
      merchantId: input.merchantId,
      sellerId: cleanString(input.sellerId),
      consentStatus: input.consentStatus,
      consentScope: toStoredJson(input.consentScope),
      consentText: input.consentText,
      grantedAt: input.consentStatus === "GRANTED" ? input.grantedAt ?? now : input.grantedAt ?? null,
      revokedAt: input.consentStatus === "REVOKED" ? input.revokedAt ?? now : input.revokedAt ?? null,
      expiresAt: input.expiresAt ?? null,
      metadata: toStoredJson(input.metadata)
    }
  });
  return serializePartnerLeadConsent(consent);
}

export async function listPartnerLeadConsents(
  query: ListPartnerLeadConsentsQueryInput,
  client: PartnerRoutingDb = defaultClient
) {
  const where = {
    ...(cleanString(query.partnerId) ? { partnerId: cleanString(query.partnerId) } : {}),
    ...(cleanString(query.merchantId) ? { merchantId: cleanString(query.merchantId) } : {}),
    ...(cleanString(query.sellerId) ? { sellerId: cleanString(query.sellerId) } : {}),
    ...(query.consentStatus ? { consentStatus: query.consentStatus } : {})
  };
  const [consents, total] = await Promise.all([
    client.partnerLeadConsent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.perPage,
      take: query.perPage
    }),
    client.partnerLeadConsent.count({ where })
  ]);

  return serializePartnerLeadConsentList({
    consents,
    total,
    page: query.page,
    perPage: query.perPage
  });
}

export async function getPartnerLeadConsent(
  consentId: string,
  client: PartnerRoutingDb = defaultClient
) {
  return serializePartnerLeadConsent(await ensureConsent(consentId, client));
}

export async function updatePartnerLeadConsentStatus(
  consentId: string,
  input: UpdatePartnerLeadConsentStatusInput,
  client: PartnerRoutingDb = defaultClient
) {
  await ensureConsent(consentId, client);
  const updated = await client.partnerLeadConsent.update({
    where: { id: consentId },
    data: consentDataForStatus(input.consentStatus, input)
  });
  return serializePartnerLeadConsent(updated);
}

export async function createPartnerLeadRoutingIntent(
  input: CreatePartnerLeadRoutingIntentInput,
  client: PartnerRoutingDb = defaultClient
) {
  const idempotencyKey = cleanString(input.idempotencyKey);
  if (idempotencyKey) {
    const existing = await client.partnerLeadRoutingIntent.findUnique({ where: { idempotencyKey } });
    if (existing) return serializePartnerLeadRoutingIntent(existing, true);
  }

  const leadId = cleanString(input.leadId);
  const lead = await ensureLeadIfProvided(leadId, client);
  const partnerId = cleanString(input.partnerId) ?? lead?.partnerId ?? null;
  await ensurePartnerIfProvided(partnerId, client);

  const consentId = cleanString(input.consentId);
  const providedConsent = consentId ? await ensureConsent(consentId, client) : null;
  const merchantId = cleanString(input.merchantId) ?? lead?.merchantId ?? providedConsent?.merchantId ?? null;
  const sellerId = cleanString(input.sellerId) ?? lead?.sellerId ?? providedConsent?.sellerId ?? null;
  const consent = providedConsent ?? (merchantId
    ? await findConsentForIntent({
      id: "",
      partnerId,
      leadId,
      consentId: null,
      merchantId,
      sellerId,
      routingStatus: "CREATED",
      routingSnapshot: {}
    }, client)
    : null);

  try {
    const intent = await client.partnerLeadRoutingIntent.create({
      data: {
        partnerId,
        leadId,
        consentId: consent?.id ?? consentId,
        merchantId,
        sellerId,
        routingStatus: routingStatusForConsent(consent),
        routingSnapshot: toStoredJson({
          ...(input.routingSnapshot ?? {}),
          routingMode: "simulated_no_external_delivery",
          externalPartnerDelivery: false
        }),
        idempotencyKey
      }
    });
    return serializePartnerLeadRoutingIntent(intent, false);
  } catch (error) {
    if (idempotencyKey && isDuplicateKeyError(error)) {
      const existing = await client.partnerLeadRoutingIntent.findUnique({ where: { idempotencyKey } });
      if (existing) return serializePartnerLeadRoutingIntent(existing, true);
    }
    throw error;
  }
}

export async function listPartnerLeadRoutingIntents(
  query: ListPartnerLeadRoutingIntentsQueryInput,
  client: PartnerRoutingDb = defaultClient
) {
  const where = {
    ...(cleanString(query.partnerId) ? { partnerId: cleanString(query.partnerId) } : {}),
    ...(cleanString(query.leadId) ? { leadId: cleanString(query.leadId) } : {}),
    ...(cleanString(query.consentId) ? { consentId: cleanString(query.consentId) } : {}),
    ...(cleanString(query.merchantId) ? { merchantId: cleanString(query.merchantId) } : {}),
    ...(cleanString(query.sellerId) ? { sellerId: cleanString(query.sellerId) } : {}),
    ...(query.routingStatus ? { routingStatus: query.routingStatus } : {})
  };
  const [intents, total] = await Promise.all([
    client.partnerLeadRoutingIntent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.perPage,
      take: query.perPage
    }),
    client.partnerLeadRoutingIntent.count({ where })
  ]);

  return serializePartnerLeadRoutingIntentList({
    intents,
    total,
    page: query.page,
    perPage: query.perPage
  });
}

export async function getPartnerLeadRoutingIntent(
  intentId: string,
  client: PartnerRoutingDb = defaultClient
) {
  return serializePartnerLeadRoutingIntent(await ensureIntent(intentId, client));
}

export async function getPartnerLeadRoutingReadiness(
  intentId: string,
  client: PartnerRoutingDb = defaultClient
) {
  const intent = await ensureIntent(intentId, client);
  const consent = await findConsentForIntent(intent, client);
  const ready = consentIsUsable(consent);
  return serializePartnerLeadRoutingReadiness({
    intent,
    consent,
    ready,
    reason: ready ? null : "CONSENT_NOT_GRANTED_OR_EXPIRED"
  });
}

export async function simulatePartnerLeadRouting(
  intentId: string,
  input: SimulatePartnerLeadRoutingInput,
  client: PartnerRoutingDb = defaultClient
) {
  const intent = await ensureIntent(intentId, client);
  const consent = await findConsentForIntent(intent, client);
  if (!consentIsUsable(consent)) {
    throw new HttpError(409, "PARTNER_LEAD_ROUTING_CONSENT_REQUIRED");
  }
  if (intent.routingStatus === "CANCELLED" || intent.routingStatus === "ARCHIVED") {
    throw new HttpError(409, "PARTNER_LEAD_ROUTING_INTENT_NOT_ROUTABLE");
  }

  const updated = await client.partnerLeadRoutingIntent.update({
    where: { id: intentId },
    data: {
      consentId: consent?.id ?? intent.consentId,
      routingStatus: "ROUTED_SIMULATED",
      routingSnapshot: toStoredJson({
        ...((intent.routingSnapshot && typeof intent.routingSnapshot === "object" && !Array.isArray(intent.routingSnapshot))
          ? intent.routingSnapshot as Record<string, unknown>
          : {}),
        ...(input.routingSnapshot ?? {}),
        routedAt: new Date().toISOString(),
        routingMode: "simulated_no_external_delivery",
        externalPartnerDelivery: false
      })
    }
  });

  return serializePartnerLeadRoutingIntent(updated);
}
