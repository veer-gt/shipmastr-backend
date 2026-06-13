import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import {
  cleanString,
  toStoredJson
} from "./growth-network-maturity.shared.js";
import type { MerchantCampaignDb } from "./merchant-campaign.service.js";
import type { PartnerMarketplaceDb } from "./partner-marketplace.service.js";
import {
  serializeBillingReadinessCheck,
  serializeBillingReadinessProfile,
  serializeBillingReadinessProfileList,
  serializeBillingSimulationEvent,
  serializeBillingSimulationEventList,
  type GrowthBillingReadinessProfileRecord,
  type GrowthBillingSimulationEventRecord
} from "./billing-readiness.serializer.js";
import type {
  CreateBillingSimulationEventInput,
  ListBillingReadinessProfilesQueryInput,
  ListBillingSimulationEventsQueryInput,
  UpdateBillingReadinessProfileStatusInput,
  UpsertBillingReadinessProfileInput
} from "./billing-readiness.validation.js";

export type BillingReadinessDb = {
  merchantCampaign?: MerchantCampaignDb["merchantCampaign"];
  growthPartner?: PartnerMarketplaceDb["growthPartner"];
  growthPartnerLead?: PartnerMarketplaceDb["growthPartnerLead"];
  growthBillingReadinessProfile: {
    create(input: { data: Record<string, unknown> }): Promise<GrowthBillingReadinessProfileRecord>;
    findMany(input?: Record<string, unknown>): Promise<GrowthBillingReadinessProfileRecord[]>;
    findUnique(input: { where: Record<string, unknown> }): Promise<GrowthBillingReadinessProfileRecord | null>;
    update(input: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<GrowthBillingReadinessProfileRecord>;
    count(input?: Record<string, unknown>): Promise<number>;
  };
  growthBillingSimulationEvent: {
    create(input: { data: Record<string, unknown> }): Promise<GrowthBillingSimulationEventRecord>;
    findMany(input?: Record<string, unknown>): Promise<GrowthBillingSimulationEventRecord[]>;
    count(input?: Record<string, unknown>): Promise<number>;
  };
};

const defaultClient = prisma as unknown as BillingReadinessDb;

function profileWhere(merchantId: string | null, partnerId: string | null) {
  return {
    ...(merchantId ? { merchantId } : {}),
    ...(partnerId ? { partnerId } : {})
  };
}

function readinessBlockReason(input: {
  readinessStatus: string;
  legalReviewRef?: string | null | undefined;
  financeReviewRef?: string | null | undefined;
}) {
  if (input.readinessStatus !== "READY_SIMULATED") return null;
  if (!cleanString(input.legalReviewRef)) return "LEGAL_REVIEW_REF_REQUIRED";
  if (!cleanString(input.financeReviewRef)) return "FINANCE_REVIEW_REF_REQUIRED";
  return null;
}

function ensureProfileReady(profile: GrowthBillingReadinessProfileRecord | null) {
  if (!profile) throw new HttpError(409, "GROWTH_BILLING_READINESS_PROFILE_REQUIRED");
  if (profile.readinessStatus !== "READY_SIMULATED") {
    throw new HttpError(409, "GROWTH_BILLING_PROFILE_NOT_READY");
  }
}

async function ensurePartnerIfProvided(partnerId: string | null, client: BillingReadinessDb) {
  if (!partnerId || !client.growthPartner) return;
  const partner = await client.growthPartner.findUnique({ where: { id: partnerId } });
  if (!partner) throw new HttpError(404, "GROWTH_PARTNER_NOT_FOUND");
}

async function ensureCampaignIfProvided(campaignId: string | null, client: BillingReadinessDb) {
  if (!campaignId || !client.merchantCampaign) return null;
  const campaign = await client.merchantCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new HttpError(404, "MERCHANT_CAMPAIGN_NOT_FOUND");
  return campaign;
}

async function ensureLeadIfProvided(leadId: string | null, client: BillingReadinessDb) {
  if (!leadId || !client.growthPartnerLead) return null;
  const lead = await client.growthPartnerLead.findUnique({ where: { id: leadId } });
  if (!lead) throw new HttpError(404, "GROWTH_PARTNER_LEAD_NOT_FOUND");
  return lead;
}

async function findProfile(
  merchantId: string | null,
  partnerId: string | null,
  client: BillingReadinessDb
) {
  const profiles = await client.growthBillingReadinessProfile.findMany({
    where: profileWhere(merchantId, partnerId),
    orderBy: { createdAt: "desc" },
    take: 1
  });
  return profiles[0] ?? null;
}

function profileData(input: UpsertBillingReadinessProfileInput | UpdateBillingReadinessProfileStatusInput) {
  return {
    readinessStatus: input.readinessStatus,
    legalReviewRef: cleanString(input.legalReviewRef),
    financeReviewRef: cleanString(input.financeReviewRef),
    notes: cleanString(input.notes),
    metadata: toStoredJson(input.metadata)
  };
}

export async function upsertBillingReadinessProfile(
  input: UpsertBillingReadinessProfileInput,
  client: BillingReadinessDb = defaultClient
) {
  const merchantId = cleanString(input.merchantId);
  const partnerId = cleanString(input.partnerId);
  await ensurePartnerIfProvided(partnerId, client);

  const reason = readinessBlockReason(input);
  if (reason) throw new HttpError(409, reason);

  const existing = await findProfile(merchantId, partnerId, client);
  if (existing) {
    const updated = await client.growthBillingReadinessProfile.update({
      where: { id: existing.id },
      data: profileData(input)
    });
    return serializeBillingReadinessProfile(updated);
  }

  const profile = await client.growthBillingReadinessProfile.create({
    data: {
      merchantId,
      partnerId,
      ...profileData(input)
    }
  });
  return serializeBillingReadinessProfile(profile);
}

export async function listBillingReadinessProfiles(
  query: ListBillingReadinessProfilesQueryInput,
  client: BillingReadinessDb = defaultClient
) {
  const where = {
    ...(cleanString(query.merchantId) ? { merchantId: cleanString(query.merchantId) } : {}),
    ...(cleanString(query.partnerId) ? { partnerId: cleanString(query.partnerId) } : {}),
    ...(query.readinessStatus ? { readinessStatus: query.readinessStatus } : {})
  };
  const [profiles, total] = await Promise.all([
    client.growthBillingReadinessProfile.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.perPage,
      take: query.perPage
    }),
    client.growthBillingReadinessProfile.count({ where })
  ]);

  return serializeBillingReadinessProfileList({
    profiles,
    total,
    page: query.page,
    perPage: query.perPage
  });
}

export async function getBillingReadinessProfile(
  profileId: string,
  client: BillingReadinessDb = defaultClient
) {
  const profile = await client.growthBillingReadinessProfile.findUnique({ where: { id: profileId } });
  if (!profile) throw new HttpError(404, "GROWTH_BILLING_READINESS_PROFILE_NOT_FOUND");
  return serializeBillingReadinessProfile(profile);
}

export async function updateBillingReadinessProfileStatus(
  profileId: string,
  input: UpdateBillingReadinessProfileStatusInput,
  client: BillingReadinessDb = defaultClient
) {
  const existing = await client.growthBillingReadinessProfile.findUnique({ where: { id: profileId } });
  if (!existing) throw new HttpError(404, "GROWTH_BILLING_READINESS_PROFILE_NOT_FOUND");
  const merged = {
    readinessStatus: input.readinessStatus,
    legalReviewRef: cleanString(input.legalReviewRef) ?? existing.legalReviewRef,
    financeReviewRef: cleanString(input.financeReviewRef) ?? existing.financeReviewRef
  };
  const reason = readinessBlockReason(merged);
  if (reason) throw new HttpError(409, reason);

  const updated = await client.growthBillingReadinessProfile.update({
    where: { id: profileId },
    data: profileData({
      ...input,
      legalReviewRef: merged.legalReviewRef,
      financeReviewRef: merged.financeReviewRef
    })
  });
  return serializeBillingReadinessProfile(updated);
}

export async function checkBillingReadiness(
  query: { merchantId?: string | null | undefined; partnerId?: string | null | undefined },
  client: BillingReadinessDb = defaultClient
) {
  const profile = await findProfile(cleanString(query.merchantId), cleanString(query.partnerId), client);
  const reason = profile?.readinessStatus === "READY_SIMULATED"
    ? null
    : profile
      ? "PROFILE_NOT_READY"
      : "PROFILE_NOT_FOUND";
  return serializeBillingReadinessCheck({
    profile,
    ready: profile?.readinessStatus === "READY_SIMULATED",
    reason
  });
}

export async function createBillingSimulationEvent(
  input: CreateBillingSimulationEventInput,
  client: BillingReadinessDb = defaultClient
) {
  const campaignId = cleanString(input.campaignId);
  const leadId = cleanString(input.leadId);
  const campaign = await ensureCampaignIfProvided(campaignId, client);
  const lead = await ensureLeadIfProvided(leadId, client);
  const merchantId = cleanString(input.merchantId) ?? campaign?.merchantId ?? lead?.merchantId ?? null;
  const partnerId = cleanString(input.partnerId) ?? lead?.partnerId ?? null;
  await ensurePartnerIfProvided(partnerId, client);

  const profile = await findProfile(merchantId, partnerId, client);
  if (input.eventType !== "READINESS_CHECK") {
    ensureProfileReady(profile);
  }

  const event = await client.growthBillingSimulationEvent.create({
    data: {
      merchantId,
      partnerId,
      campaignId,
      leadId,
      eventType: input.eventType,
      amountPaise: input.amountPaise ?? null,
      currency: input.currency,
      simulationSnapshot: toStoredJson({
        ...(input.simulationSnapshot ?? {}),
        billingMode: "simulation_only",
        payableCreated: false,
        externalPaymentGateway: false,
        realInvoiceCreated: false
      })
    }
  });

  return serializeBillingSimulationEvent(event);
}

export async function listBillingSimulationEvents(
  query: ListBillingSimulationEventsQueryInput,
  client: BillingReadinessDb = defaultClient
) {
  const where = {
    ...(cleanString(query.merchantId) ? { merchantId: cleanString(query.merchantId) } : {}),
    ...(cleanString(query.partnerId) ? { partnerId: cleanString(query.partnerId) } : {}),
    ...(cleanString(query.campaignId) ? { campaignId: cleanString(query.campaignId) } : {}),
    ...(cleanString(query.leadId) ? { leadId: cleanString(query.leadId) } : {}),
    ...(query.eventType ? { eventType: query.eventType } : {})
  };
  const [events, total] = await Promise.all([
    client.growthBillingSimulationEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (query.page - 1) * query.perPage,
      take: query.perPage
    }),
    client.growthBillingSimulationEvent.count({ where })
  ]);

  return serializeBillingSimulationEventList({
    events,
    total,
    page: query.page,
    perPage: query.perPage
  });
}
