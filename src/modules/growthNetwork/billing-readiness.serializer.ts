import type {
  GrowthBillingEventType,
  GrowthBillingReadinessStatus
} from "@prisma/client";

import {
  metadataRecord,
  timestamp
} from "./growth-network-maturity.shared.js";

export type GrowthBillingReadinessProfileRecord = {
  id: string;
  merchantId?: string | null;
  partnerId?: string | null;
  readinessStatus: GrowthBillingReadinessStatus | string;
  legalReviewRef?: string | null;
  financeReviewRef?: string | null;
  notes?: string | null;
  metadata?: unknown;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
};

export type GrowthBillingSimulationEventRecord = {
  id: string;
  merchantId?: string | null;
  partnerId?: string | null;
  campaignId?: string | null;
  leadId?: string | null;
  eventType: GrowthBillingEventType | string;
  amountPaise?: number | null;
  currency: string;
  simulationSnapshot: unknown;
  createdAt?: Date | string | null;
};

export function serializeBillingReadinessProfile(record: GrowthBillingReadinessProfileRecord) {
  return {
    profileId: record.id,
    merchantId: record.merchantId ?? null,
    partnerId: record.partnerId ?? null,
    readinessStatus: record.readinessStatus,
    legalReviewRef: record.legalReviewRef ?? null,
    financeReviewRef: record.financeReviewRef ?? null,
    notes: record.notes ?? null,
    readinessMode: "simulation_only",
    billingMode: "none",
    payableMode: "none",
    createdAt: timestamp(record.createdAt),
    updatedAt: timestamp(record.updatedAt)
  };
}

export function serializeBillingReadinessProfileList(input: {
  profiles: GrowthBillingReadinessProfileRecord[];
  total: number;
  page: number;
  perPage: number;
}) {
  return {
    profiles: input.profiles.map(serializeBillingReadinessProfile),
    pagination: {
      page: input.page,
      perPage: input.perPage,
      total: input.total,
      hasMore: input.page * input.perPage < input.total
    }
  };
}

export function serializeBillingSimulationEvent(record: GrowthBillingSimulationEventRecord) {
  return {
    eventId: record.id,
    merchantId: record.merchantId ?? null,
    partnerId: record.partnerId ?? null,
    campaignId: record.campaignId ?? null,
    leadId: record.leadId ?? null,
    eventType: record.eventType,
    amountPaise: record.amountPaise ?? null,
    currency: record.currency,
    simulationSnapshot: metadataRecord(record.simulationSnapshot),
    invoiceMode: "draft_simulation_only",
    billingMode: "none",
    payableMode: "none",
    createdAt: timestamp(record.createdAt)
  };
}

export function serializeBillingSimulationEventList(input: {
  events: GrowthBillingSimulationEventRecord[];
  total: number;
  page: number;
  perPage: number;
}) {
  return {
    events: input.events.map(serializeBillingSimulationEvent),
    pagination: {
      page: input.page,
      perPage: input.perPage,
      total: input.total,
      hasMore: input.page * input.perPage < input.total
    }
  };
}

export function serializeBillingReadinessCheck(input: {
  profile: GrowthBillingReadinessProfileRecord | null;
  ready: boolean;
  reason: string | null;
}) {
  return {
    profile: input.profile ? serializeBillingReadinessProfile(input.profile) : null,
    ready: input.ready,
    reason: input.reason,
    readinessMode: "simulation_only",
    billingMode: "none",
    payableMode: "none"
  };
}
