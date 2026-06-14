import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addGrowthPartnerPlacement,
  captureGrowthPartnerLead,
  createGrowthPartner,
  getGrowthPartnerPerformanceSummary,
  listGrowthPartners,
  recordGrowthPartnerAttributionEvent,
  resolvePublicGrowthPartnerSuggestions,
  updateGrowthPartnerStatus,
  type PartnerMarketplaceDb
} from "../partner-marketplace.service.js";

const now = new Date("2026-06-13T09:00:00.000Z");

function makePartnerMarketplaceClient() {
  const state = {
    offers: [{
      id: "offer_1",
      title: "Demo offer",
      type: "PARTNER_SPONSORED",
      status: "ACTIVE",
      isSponsored: false,
      ctaLabel: "View",
      createdAt: now,
      updatedAt: now
    }],
    partners: [] as any[],
    placements: [] as any[],
    leads: [] as any[],
    events: [] as any[],
    nextPartner: 1,
    nextPlacement: 1,
    nextLead: 1,
    nextEvent: 1,
    tick: 0
  };

  function nextDate() {
    state.tick += 1;
    return new Date(now.getTime() + state.tick * 1000);
  }

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
        const leftValue = field === "createdAt" ? new Date(left[field]).getTime() : left[field];
        const rightValue = field === "createdAt" ? new Date(right[field]).getTime() : right[field];
        if (leftValue === rightValue) continue;
        if (direction === "asc") return leftValue < rightValue ? -1 : 1;
        return leftValue > rightValue ? -1 : 1;
      }
      return 0;
    });
  }

  const client: PartnerMarketplaceDb = {
    growthOffer: {
      create: async () => {
        throw new Error("UNUSED");
      },
      findMany: async () => [],
      findUnique: async ({ where }) => (state.offers.find((offer) => offer.id === where.id) ?? null) as any,
      update: async () => {
        throw new Error("UNUSED");
      },
      count: async () => state.offers.length
    },
    growthPartner: {
      create: async ({ data }) => {
        const createdAt = nextDate();
        const partner = {
          id: `partner_${state.nextPartner++}`,
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
        return partner as any;
      },
      findMany: async (input: any = {}) => {
        let records = state.partners.filter((partner) => matchesWhere(partner, input.where));
        records = sortRecords(records, input.orderBy);
        if (typeof input.skip === "number") records = records.slice(input.skip);
        if (typeof input.take === "number") records = records.slice(0, input.take);
        return records;
      },
      findUnique: async ({ where }) => state.partners.find((partner) => (
        (where.id && partner.id === where.id) || (where.name && partner.name === where.name)
      )) ?? null,
      update: async ({ where, data }) => {
        const partner = state.partners.find((record) => record.id === where.id);
        if (!partner) throw new Error("PARTNER_NOT_FOUND");
        Object.assign(partner, data, { updatedAt: nextDate() });
        return partner;
      },
      count: async (input: any = {}) => state.partners.filter((partner) => matchesWhere(partner, input.where)).length
    },
    growthPartnerPlacement: {
      create: async ({ data }) => {
        const createdAt = nextDate();
        const placement = {
          id: `placement_${state.nextPlacement++}`,
          offerId: null,
          rulesJson: null,
          startsAt: null,
          endsAt: null,
          createdAt,
          updatedAt: createdAt,
          ...data
        };
        state.placements.push(placement);
        return placement as any;
      },
      findMany: async (input: any = {}) => sortRecords(
        state.placements.filter((placement) => matchesWhere(placement, input.where)),
        input.orderBy
      )
    },
    growthPartnerLead: {
      create: async ({ data }) => {
        if (data.idempotencyKey && state.leads.some((lead) => lead.idempotencyKey === data.idempotencyKey)) {
          throw { code: "P2002" };
        }
        const createdAt = nextDate();
        const lead = {
          id: `lead_${state.nextLead++}`,
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
        return lead as any;
      },
      findUnique: async ({ where }) => state.leads.find((lead) => (
        (where.id && lead.id === where.id) || (where.idempotencyKey && lead.idempotencyKey === where.idempotencyKey)
      )) ?? null,
      count: async (input: any = {}) => state.leads.filter((lead) => matchesWhere(lead, input.where)).length
    },
    growthPartnerAttributionEvent: {
      create: async ({ data }) => {
        if (data.idempotencyKey && state.events.some((event) => event.idempotencyKey === data.idempotencyKey)) {
          throw { code: "P2002" };
        }
        const event = {
          id: `event_${state.nextEvent++}`,
          partnerId: null,
          offerId: null,
          leadId: null,
          merchantId: null,
          sellerId: null,
          attributionRef: null,
          sessionRef: null,
          idempotencyKey: null,
          metadata: null,
          createdAt: nextDate(),
          ...data
        };
        state.events.push(event);
        return event as any;
      },
      findUnique: async ({ where }) => state.events.find((event) => (
        (where.id && event.id === where.id) || (where.idempotencyKey && event.idempotencyKey === where.idempotencyKey)
      )) ?? null,
      findMany: async (input: any = {}) => state.events.filter((event) => matchesWhere(event, input.where)),
      count: async (input: any = {}) => state.events.filter((event) => matchesWhere(event, input.where)).length
    }
  };

  return { client, state };
}

async function createActivePartner(
  client: PartnerMarketplaceDb,
  input: Partial<Parameters<typeof createGrowthPartner>[0]> = {},
  placement: Partial<Parameters<typeof addGrowthPartnerPlacement>[1]> = {}
) {
  const partner = await createGrowthPartner({
    name: input.name ?? `demo_partner_${Math.random().toString(36).slice(2, 8)}`,
    displayName: input.displayName ?? "Demo Partner",
    category: input.category ?? "PACKAGING",
    status: input.status ?? "ACTIVE",
    description: input.description,
    websiteUrl: input.websiteUrl,
    isSponsored: input.isSponsored ?? false,
    metadata: input.metadata
  }, client);

  await addGrowthPartnerPlacement(partner.partnerId, {
    offerId: placement.offerId,
    surface: placement.surface ?? "TRACKING_PAGE",
    priority: placement.priority ?? 100,
    rulesJson: placement.rulesJson,
    startsAt: placement.startsAt,
    endsAt: placement.endsAt
  }, client);

  return partner;
}

describe("partner marketplace service", () => {
  it("creates, lists, transitions status, and creates placements without exposing raw data", async () => {
    const { client } = makePartnerMarketplaceClient();
    const partner = await createGrowthPartner({
      name: "demo_packaging_partner",
      displayName: "Demo Packaging Partner",
      category: "PACKAGING",
      status: "DRAFT",
      description: "Packaging support",
      websiteUrl: "https://example.invalid/demo",
      isSponsored: true,
      metadata: {
        buyerEmail: "buyer@example.com",
        courierName: "Bigship",
        publicTitle: "Safer packaging"
      }
    }, client);

    assert.equal(partner.partnerId, "partner_1");
    assert.equal(partner.status, "DRAFT");
    assert.equal("metadata" in partner, false);

    const list = await listGrowthPartners({ page: 1, perPage: 50 }, client);
    assert.equal(list.pagination.total, 1);
    assert.equal(list.partners[0]?.partnerId, partner.partnerId);

    const active = await updateGrowthPartnerStatus(partner.partnerId, { status: "ACTIVE" }, client);
    assert.equal(active.status, "ACTIVE");

    const placement = await addGrowthPartnerPlacement(partner.partnerId, {
      offerId: "offer_1",
      surface: "TRACKING_PAGE",
      priority: 20,
      rulesJson: { providerName: "Shiprocket" }
    }, client);
    assert.equal(placement.offerId, "offer_1");
    assert.equal("rulesJson" in placement, false);
  });

  it("resolves only active live partner suggestions with bounded public-safe fields", async () => {
    const { client } = makePartnerMarketplaceClient();
    await createActivePartner(client, {
      name: "older_partner",
      displayName: "Older Partner",
      category: "ANALYTICS"
    }, { priority: 10 });
    await createActivePartner(client, {
      name: "newer_partner",
      displayName: "Shiprocket Demo Growth Tool",
      category: "STORE_GROWTH_TOOL",
      metadata: {
        publicTitle: "Shiprocket setup helper",
        publicDescription: "Works without exposing courier data",
        ctaLabel: "Open tool",
        ctaUrl: "/seller/growth/partners/newer"
      }
    }, { priority: 10 });
    await createActivePartner(client, {
      name: "sponsored_partner",
      displayName: "Demo Sponsored Partner",
      category: "PACKAGING",
      isSponsored: true
    }, { priority: 30, rulesJson: { courierName: "Bigship" } });
    await createActivePartner(client, { name: "paused_partner", status: "PAUSED" }, { priority: 1 });
    await createActivePartner(client, { name: "expired_partner" }, {
      priority: 1,
      endsAt: new Date("2026-06-12T00:00:00.000Z")
    });
    await createActivePartner(client, { name: "future_partner" }, {
      priority: 1,
      startsAt: new Date("2026-06-14T00:00:00.000Z")
    });
    await createActivePartner(client, { name: "checkout_partner" }, {
      surface: "CHECKOUT",
      priority: 1
    });

    const resolved = await resolvePublicGrowthPartnerSuggestions("TRACKING_PAGE", { max: 3 }, client, now);

    assert.deepEqual(resolved.suggestions.map((suggestion) => suggestion.displayName), [
      "Shipmastr logistics network Demo Growth Tool",
      "Older Partner",
      "Demo Sponsored Partner"
    ]);
    assert.deepEqual(resolved.suggestions.map((suggestion) => suggestion.label), [
      "Recommended",
      "Recommended",
      "Sponsored Partner"
    ]);
    assert.equal(resolved.suggestions[0]?.ctaUrl, "/seller/growth/partners/newer");

    const json = JSON.stringify(resolved);
    assert.equal(json.includes("metadata"), false);
    assert.equal(json.includes("rulesJson"), false);
    assert.equal(json.includes("Bigship"), false);
    assert.equal(json.includes("Shiprocket"), false);
  });

  it("captures simulated leads, records idempotent attribution, and summarizes ROAS-style metrics safely", async () => {
    const { client, state } = makePartnerMarketplaceClient();
    const partner = await createActivePartner(client, {
      name: "roas_partner",
      displayName: "Demo ROAS Partner",
      category: "ANALYTICS"
    }, { priority: 1 });

    const lead = await captureGrowthPartnerLead({
      partnerId: partner.partnerId,
      merchantId: "merchant_1",
      sellerId: "seller_1",
      offerId: "offer_1",
      shipmentId: "shipment_1",
      orderId: "order_1",
      status: "CAPTURED",
      sourceSurface: "TRACKING_PAGE",
      attributionRef: "attr_1",
      idempotencyKey: "lead-key-1",
      metadata: {
        buyerEmail: "buyer@example.com",
        safeNote: "kept internally"
      }
    }, client);
    const duplicateLead = await captureGrowthPartnerLead({
      partnerId: partner.partnerId,
      status: "CAPTURED",
      sourceSurface: "TRACKING_PAGE",
      idempotencyKey: "lead-key-1"
    }, client);
    assert.equal(lead.leadId, duplicateLead.leadId);
    assert.equal(duplicateLead.duplicate, true);
    assert.equal(state.leads.length, 1);
    assert.equal("metadata" in lead, false);

    await recordGrowthPartnerAttributionEvent({
      partnerId: partner.partnerId,
      eventType: "IMPRESSION",
      surface: "TRACKING_PAGE",
      attributionRef: "attr_1"
    }, client);
    const click = await recordGrowthPartnerAttributionEvent({
      partnerId: partner.partnerId,
      eventType: "CLICK",
      surface: "TRACKING_PAGE",
      attributionRef: "attr_1",
      idempotencyKey: "click-key-1"
    }, client);
    const duplicateClick = await recordGrowthPartnerAttributionEvent({
      partnerId: partner.partnerId,
      eventType: "CLICK",
      surface: "TRACKING_PAGE",
      idempotencyKey: "click-key-1"
    }, client);
    await recordGrowthPartnerAttributionEvent({
      leadId: lead.leadId,
      eventType: "CONVERSION_SIMULATED",
      surface: "TRACKING_PAGE",
      metadata: {
        simulatedRevenuePaise: 120000,
        actualRevenuePaise: 999999
      }
    }, client);

    assert.equal(click.eventId, duplicateClick.eventId);
    assert.equal(duplicateClick.duplicate, true);

    const summary = await getGrowthPartnerPerformanceSummary(partner.partnerId, client);
    assert.equal(summary.impressions, 1);
    assert.equal(summary.clicks, 1);
    assert.equal(summary.leadsCaptured, 1);
    assert.equal(summary.simulatedConversions, 1);
    assert.equal(summary.ctr, 1);
    assert.equal(summary.leadConversionRate, 1);
    assert.equal(summary.simulatedConversionRate, 1);
    assert.equal(summary.simulatedRevenuePaise, 120000);
    assert.equal(summary.adSpendPaise, null);
    assert.equal(summary.roas, null);
    assert.equal(summary.billingMode, "none");
  });
});
