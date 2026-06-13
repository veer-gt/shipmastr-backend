import type {
  PartnerLeadConsentStatus,
  PartnerLeadRoutingStatus
} from "@prisma/client";

import {
  metadataRecord,
  timestamp
} from "./growth-network-maturity.shared.js";

export type PartnerLeadConsentRecord = {
  id: string;
  partnerId?: string | null;
  merchantId: string;
  sellerId?: string | null;
  consentStatus: PartnerLeadConsentStatus | string;
  consentScope: unknown;
  consentText: string;
  grantedAt?: Date | string | null;
  revokedAt?: Date | string | null;
  expiresAt?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

export type PartnerLeadRoutingIntentRecord = {
  id: string;
  partnerId?: string | null;
  leadId?: string | null;
  consentId?: string | null;
  merchantId?: string | null;
  sellerId?: string | null;
  routingStatus: PartnerLeadRoutingStatus | string;
  routingSnapshot: unknown;
  idempotencyKey?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

export function serializePartnerLeadConsent(record: PartnerLeadConsentRecord) {
  return {
    consentId: record.id,
    partnerId: record.partnerId ?? null,
    merchantId: record.merchantId,
    sellerId: record.sellerId ?? null,
    consentStatus: record.consentStatus,
    consentScope: metadataRecord(record.consentScope),
    consentText: record.consentText,
    grantedAt: timestamp(record.grantedAt),
    revokedAt: timestamp(record.revokedAt),
    expiresAt: timestamp(record.expiresAt),
    createdAt: timestamp(record.createdAt),
    updatedAt: timestamp(record.updatedAt)
  };
}

export function serializePartnerLeadConsentList(input: {
  consents: PartnerLeadConsentRecord[];
  total: number;
  page: number;
  perPage: number;
}) {
  return {
    consents: input.consents.map(serializePartnerLeadConsent),
    pagination: {
      page: input.page,
      perPage: input.perPage,
      total: input.total,
      hasMore: input.page * input.perPage < input.total
    }
  };
}

export function serializePartnerLeadRoutingIntent(record: PartnerLeadRoutingIntentRecord, duplicate = false) {
  return {
    intentId: record.id,
    partnerId: record.partnerId ?? null,
    leadId: record.leadId ?? null,
    consentId: record.consentId ?? null,
    merchantId: record.merchantId ?? null,
    sellerId: record.sellerId ?? null,
    routingStatus: record.routingStatus,
    routingSnapshot: metadataRecord(record.routingSnapshot),
    routingMode: "simulated_no_external_delivery",
    duplicate,
    createdAt: timestamp(record.createdAt),
    updatedAt: timestamp(record.updatedAt)
  };
}

export function serializePartnerLeadRoutingIntentList(input: {
  intents: PartnerLeadRoutingIntentRecord[];
  total: number;
  page: number;
  perPage: number;
}) {
  return {
    intents: input.intents.map((intent) => serializePartnerLeadRoutingIntent(intent)),
    pagination: {
      page: input.page,
      perPage: input.perPage,
      total: input.total,
      hasMore: input.page * input.perPage < input.total
    }
  };
}

export function serializePartnerLeadRoutingReadiness(input: {
  intent: PartnerLeadRoutingIntentRecord;
  consent: PartnerLeadConsentRecord | null;
  ready: boolean;
  reason: string | null;
}) {
  return {
    intent: serializePartnerLeadRoutingIntent(input.intent),
    consent: input.consent ? serializePartnerLeadConsent(input.consent) : null,
    ready: input.ready,
    reason: input.reason,
    routingMode: "simulated_no_external_delivery"
  };
}
