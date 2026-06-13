import type { BillingReadinessDb } from "../billing-readiness.service.js";
import type { CampaignAnalyticsDb } from "../campaign-analytics.service.js";
import type { CampaignReviewDb } from "../campaign-review.service.js";
import type { MerchantCampaignDb } from "../merchant-campaign.service.js";
import type { PartnerRoutingDb } from "../partner-routing.service.js";

const baseNow = new Date("2026-06-14T00:00:00.000Z");

function matchesDate(value: Date | string | null | undefined, condition: any) {
  if (condition === null) return value == null;
  if (condition?.lte) return value == null || new Date(value).getTime() <= new Date(condition.lte).getTime();
  if (condition?.gte) return value == null || new Date(value).getTime() >= new Date(condition.gte).getTime();
  return true;
}

function matchesWhere(record: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => {
    if (key === "AND") return (condition as any[]).every((child) => matchesWhere(record, child));
    if (key === "OR") return (condition as any[]).some((child) => matchesWhere(record, child));
    if (key === "startsAt" || key === "endsAt") return matchesDate(record[key], condition);
    if (condition && typeof condition === "object" && "in" in (condition as Record<string, unknown>)) {
      return ((condition as any).in as unknown[]).includes(record[key]);
    }
    return record[key] === condition;
  });
}

function sortRecords(records: any[], orderBy: any) {
  const rules = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  return [...records].sort((left, right) => {
    for (const rule of rules) {
      const [field, direction] = Object.entries(rule)[0] as [string, string];
      const leftValue = field === "createdAt" || field === "updatedAt" ? new Date(left[field]).getTime() : left[field];
      const rightValue = field === "createdAt" || field === "updatedAt" ? new Date(right[field]).getTime() : right[field];
      if (leftValue === rightValue) continue;
      if (direction === "asc") return leftValue < rightValue ? -1 : 1;
      return leftValue > rightValue ? -1 : 1;
    }
    return 0;
  });
}

function paginate(records: any[], input: any = {}) {
  let rows = sortRecords(records, input.orderBy);
  if (typeof input.skip === "number") rows = rows.slice(input.skip);
  if (typeof input.take === "number") rows = rows.slice(0, input.take);
  return rows;
}

export function makeGrowthNetworkMaturityClient() {
  const state = {
    offers: [] as any[],
    offerPlacements: [] as any[],
    partners: [{
      id: "partner_1",
      name: "partner_one",
      displayName: "Partner One",
      category: "PACKAGING",
      status: "ACTIVE",
      description: "Packaging help",
      websiteUrl: null,
      isSponsored: false,
      metadata: null,
      createdAt: baseNow,
      updatedAt: baseNow
    }],
    leads: [{
      id: "lead_1",
      partnerId: "partner_1",
      merchantId: "merchant_1",
      sellerId: "seller_1",
      offerId: null,
      shipmentId: null,
      orderId: null,
      status: "CAPTURED",
      sourceSurface: "TRACKING_PAGE",
      attributionRef: null,
      idempotencyKey: null,
      metadata: null,
      createdAt: baseNow,
      updatedAt: baseNow
    }],
    campaigns: [] as any[],
    campaignEvents: [] as any[],
    campaignReviews: [] as any[],
    consents: [] as any[],
    routingIntents: [] as any[],
    billingProfiles: [] as any[],
    billingEvents: [] as any[],
    nextOffer: 1,
    nextOfferPlacement: 1,
    nextCampaign: 1,
    nextCampaignEvent: 1,
    nextCampaignReview: 1,
    nextConsent: 1,
    nextRoutingIntent: 1,
    nextBillingProfile: 1,
    nextBillingEvent: 1,
    tick: 0
  };

  function nextDate() {
    state.tick += 1;
    return new Date(baseNow.getTime() + state.tick * 1000);
  }

  function findUnique(records: any[], where: any) {
    return records.find((record) => Object.entries(where).some(([key, value]) => Boolean(value) && record[key] === value)) ?? null;
  }

  const client = {
    growthOffer: {
      create: async ({ data }: any) => {
        const createdAt = nextDate();
        const offer = {
          id: `offer_${state.nextOffer++}`,
          merchantId: null,
          subtitle: null,
          sponsorName: null,
          ctaUrl: null,
          metadata: null,
          startsAt: null,
          endsAt: null,
          createdAt,
          updatedAt: createdAt,
          ...data
        };
        state.offers.push(offer);
        return offer;
      },
      findMany: async (input: any = {}) => paginate(state.offers.filter((record) => matchesWhere(record, input.where)), input),
      findUnique: async ({ where }: any) => findUnique(state.offers, where),
      update: async ({ where, data }: any) => {
        const offer = findUnique(state.offers, where);
        if (!offer) throw new Error("OFFER_NOT_FOUND");
        Object.assign(offer, data, { updatedAt: nextDate() });
        return offer;
      },
      count: async (input: any = {}) => state.offers.filter((record) => matchesWhere(record, input.where)).length
    },
    growthOfferPlacement: {
      create: async ({ data }: any) => {
        const createdAt = nextDate();
        const placement = {
          id: `offer_placement_${state.nextOfferPlacement++}`,
          rulesJson: null,
          startsAt: null,
          endsAt: null,
          createdAt,
          updatedAt: createdAt,
          ...data
        };
        state.offerPlacements.push(placement);
        return placement;
      },
      findMany: async (input: any = {}) => paginate(state.offerPlacements.filter((record) => matchesWhere(record, input.where)), input)
    },
    merchantCampaign: {
      create: async ({ data }: any) => {
        const createdAt = nextDate();
        const campaign = {
          id: `campaign_${state.nextCampaign++}`,
          description: null,
          status: "DRAFT",
          reviewStatus: "NOT_REQUIRED",
          rejectionReason: null,
          growthOfferId: null,
          startsAt: null,
          endsAt: null,
          ctaUrl: null,
          rulesJson: null,
          metadata: null,
          createdAt,
          updatedAt: createdAt,
          ...data
        };
        state.campaigns.push(campaign);
        return campaign;
      },
      findMany: async (input: any = {}) => paginate(state.campaigns.filter((record) => matchesWhere(record, input.where)), input),
      findUnique: async ({ where }: any) => findUnique(state.campaigns, where),
      update: async ({ where, data }: any) => {
        const campaign = findUnique(state.campaigns, where);
        if (!campaign) throw new Error("CAMPAIGN_NOT_FOUND");
        Object.assign(campaign, data, { updatedAt: nextDate() });
        return campaign;
      },
      count: async (input: any = {}) => state.campaigns.filter((record) => matchesWhere(record, input.where)).length
    },
    merchantCampaignEvent: {
      create: async ({ data }: any) => {
        const event = {
          id: `campaign_event_${state.nextCampaignEvent++}`,
          merchantId: null,
          sellerId: null,
          surface: null,
          growthOfferEventId: null,
          metadata: null,
          createdAt: nextDate(),
          ...data
        };
        state.campaignEvents.push(event);
        return event;
      },
      findMany: async (input: any = {}) => paginate(state.campaignEvents.filter((record) => matchesWhere(record, input.where)), input),
      count: async (input: any = {}) => state.campaignEvents.filter((record) => matchesWhere(record, input.where)).length
    },
    merchantCampaignReview: {
      create: async ({ data }: any) => {
        const createdAt = nextDate();
        const review = {
          id: `campaign_review_${state.nextCampaignReview++}`,
          reviewerRef: null,
          decisionReason: null,
          policyChecklist: null,
          createdAt,
          updatedAt: createdAt,
          ...data
        };
        state.campaignReviews.push(review);
        return review;
      },
      findMany: async (input: any = {}) => paginate(state.campaignReviews.filter((record) => matchesWhere(record, input.where)), input)
    },
    growthPartner: {
      create: async ({ data }: any) => {
        const createdAt = nextDate();
        const partner = {
          id: `partner_${state.partners.length + 1}`,
          status: "DRAFT",
          description: null,
          websiteUrl: null,
          isSponsored: false,
          metadata: null,
          createdAt,
          updatedAt: createdAt,
          ...data
        };
        state.partners.push(partner);
        return partner;
      },
      findMany: async (input: any = {}) => paginate(state.partners.filter((record) => matchesWhere(record, input.where)), input),
      findUnique: async ({ where }: any) => findUnique(state.partners, where),
      update: async ({ where, data }: any) => {
        const partner = findUnique(state.partners, where);
        if (!partner) throw new Error("PARTNER_NOT_FOUND");
        Object.assign(partner, data, { updatedAt: nextDate() });
        return partner;
      },
      count: async (input: any = {}) => state.partners.filter((record) => matchesWhere(record, input.where)).length
    },
    growthPartnerLead: {
      create: async ({ data }: any) => {
        const createdAt = nextDate();
        const lead = {
          id: `lead_${state.leads.length + 1}`,
          partnerId: null,
          merchantId: null,
          sellerId: null,
          offerId: null,
          shipmentId: null,
          orderId: null,
          status: "CAPTURED",
          attributionRef: null,
          idempotencyKey: null,
          metadata: null,
          createdAt,
          updatedAt: createdAt,
          ...data
        };
        state.leads.push(lead);
        return lead;
      },
      findUnique: async ({ where }: any) => findUnique(state.leads, where),
      count: async (input: any = {}) => state.leads.filter((record) => matchesWhere(record, input.where)).length
    },
    partnerLeadConsent: {
      create: async ({ data }: any) => {
        const createdAt = nextDate();
        const consent = {
          id: `consent_${state.nextConsent++}`,
          partnerId: null,
          sellerId: null,
          grantedAt: null,
          revokedAt: null,
          expiresAt: null,
          metadata: null,
          createdAt,
          updatedAt: createdAt,
          ...data
        };
        state.consents.push(consent);
        return consent;
      },
      findMany: async (input: any = {}) => paginate(state.consents.filter((record) => matchesWhere(record, input.where)), input),
      findUnique: async ({ where }: any) => findUnique(state.consents, where),
      update: async ({ where, data }: any) => {
        const consent = findUnique(state.consents, where);
        if (!consent) throw new Error("CONSENT_NOT_FOUND");
        Object.assign(consent, data, { updatedAt: nextDate() });
        return consent;
      },
      count: async (input: any = {}) => state.consents.filter((record) => matchesWhere(record, input.where)).length
    },
    partnerLeadRoutingIntent: {
      create: async ({ data }: any) => {
        if (data.idempotencyKey && state.routingIntents.some((intent) => intent.idempotencyKey === data.idempotencyKey)) {
          throw { code: "P2002" };
        }
        const createdAt = nextDate();
        const intent = {
          id: `intent_${state.nextRoutingIntent++}`,
          partnerId: null,
          leadId: null,
          consentId: null,
          merchantId: null,
          sellerId: null,
          routingSnapshot: {},
          idempotencyKey: null,
          createdAt,
          updatedAt: createdAt,
          ...data
        };
        state.routingIntents.push(intent);
        return intent;
      },
      findMany: async (input: any = {}) => paginate(state.routingIntents.filter((record) => matchesWhere(record, input.where)), input),
      findUnique: async ({ where }: any) => findUnique(state.routingIntents, where),
      update: async ({ where, data }: any) => {
        const intent = findUnique(state.routingIntents, where);
        if (!intent) throw new Error("INTENT_NOT_FOUND");
        Object.assign(intent, data, { updatedAt: nextDate() });
        return intent;
      },
      count: async (input: any = {}) => state.routingIntents.filter((record) => matchesWhere(record, input.where)).length
    },
    growthBillingReadinessProfile: {
      create: async ({ data }: any) => {
        const createdAt = nextDate();
        const profile = {
          id: `billing_profile_${state.nextBillingProfile++}`,
          merchantId: null,
          partnerId: null,
          legalReviewRef: null,
          financeReviewRef: null,
          notes: null,
          metadata: null,
          createdAt,
          updatedAt: createdAt,
          ...data
        };
        state.billingProfiles.push(profile);
        return profile;
      },
      findMany: async (input: any = {}) => paginate(state.billingProfiles.filter((record) => matchesWhere(record, input.where)), input),
      findUnique: async ({ where }: any) => findUnique(state.billingProfiles, where),
      update: async ({ where, data }: any) => {
        const profile = findUnique(state.billingProfiles, where);
        if (!profile) throw new Error("PROFILE_NOT_FOUND");
        Object.assign(profile, data, { updatedAt: nextDate() });
        return profile;
      },
      count: async (input: any = {}) => state.billingProfiles.filter((record) => matchesWhere(record, input.where)).length
    },
    growthBillingSimulationEvent: {
      create: async ({ data }: any) => {
        const event = {
          id: `billing_event_${state.nextBillingEvent++}`,
          merchantId: null,
          partnerId: null,
          campaignId: null,
          leadId: null,
          amountPaise: null,
          currency: "INR",
          simulationSnapshot: {},
          createdAt: nextDate(),
          ...data
        };
        state.billingEvents.push(event);
        return event;
      },
      findMany: async (input: any = {}) => paginate(state.billingEvents.filter((record) => matchesWhere(record, input.where)), input),
      count: async (input: any = {}) => state.billingEvents.filter((record) => matchesWhere(record, input.where)).length
    }
  } as unknown as MerchantCampaignDb & CampaignReviewDb & CampaignAnalyticsDb & PartnerRoutingDb & BillingReadinessDb;

  return { client, state };
}
