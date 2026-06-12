import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  CourierPartnerStatus,
  PaymentMode,
  PartnerType,
  SellerCourierPartnerStatus,
  ShipmentSegment,
  ShipmentStatus,
  ShippingPaymentMode
} from "@prisma/client";
import { env } from "../../config/env.js";
import type { InternalCourierProviderAdapter } from "../courierPartners/providers/provider-adapter.types.js";
import { HttpError } from "../../lib/httpError.js";
import { cancelShipment } from "./shipping-cancel.service.js";
import { manifestShipment } from "./shipping-manifest.service.js";
import { createShippingPickupLocation, listShippingPickupLocations } from "./shipping-pickup-location.service.js";
import { fetchShipmentRates } from "./shipping-rates.service.js";
import {
  getLiveCourierRatesReadiness,
  serializeLiveCourierRatesReadiness
} from "./shipping-live-rates-gate.service.js";
import {
  getLiveAwbLabelReadiness,
  serializeLiveAwbLabelReadiness
} from "./shipping-live-ship-gate.service.js";
import { shipNowShipment } from "./shipping-ship-now.service.js";
import { createShipmentDraft } from "./shipping-shipments.service.js";
import { selectShippingTiers } from "./shipping-tier-decision.service.js";
import { fetchShipmentTracking } from "./shipping-tracking.service.js";
import { listShippingShipments } from "./shipping-list.service.js";
import { createShipmentFromOrder } from "./shipping-order-bridge.service.js";
import { getPublicTrackingByToken } from "./shipping-public-tracking.service.js";
import { getAutopilotPreferences, upsertAutopilotPreferences } from "./shipping-autopilot-preferences.service.js";
import { buildAutopilotRecommendation, recommendAutopilotForShipment } from "./shipping-autopilot.service.js";
import { bulkFetchRates, bulkShipNow } from "./shipping-bulk.service.js";
import {
  createOrUpdateNdrCaseFromShipment,
  getNdrCase,
  listNdrCases,
  recordNdrAction
} from "./shipping-ndr.service.js";
import {
  calculateEstimatedRtoLoss,
  createOrUpdateRtoCaseFromShipment,
  listRtoCases,
  updateRtoStatus
} from "./shipping-rto.service.js";
import {
  createExpectedCodEntryForCodShipment,
  getCodLedgerSummary,
  listCodLedger,
  recordCodCollected,
  recordCodRemittanceDue,
  recordCodRemitted
} from "./shipping-cod-ledger.service.js";
import {
  closeWeightDispute,
  detectWeightDiscrepancy,
  listWeightDiscrepancyCases,
  markWeightDisputeSubmitted,
  updateWeightDisputeEvidence
} from "./shipping-weight-dispute.service.js";
import {
  calculateReliabilityScore,
  getReliabilityScoreForRate,
  recalculateCourierSlaStats,
  recordSlaEvent
} from "./shipping-sla-learning.service.js";
import {
  calculateAttentionReasons,
  calculateShipmentQueue,
  serializeShipmentListItem
} from "./shipping-public-serializers.js";
import { isSafeTrackingToken } from "./shipping-tracking-token.js";
import { buildTrackingTimeline, publicStatusForShipmentStatus } from "./shipping-tracking-timeline.js";

const now = new Date("2026-06-06T10:00:00.000Z");

function createFakeAdapter(): InternalCourierProviderAdapter & { calls: Record<string, number> } {
  const calls = {
    login: 0,
    ensureToken: 0,
    createPickupLocation: 0,
    createDraftOrder: 0,
    getRates: 0,
    manifestOrder: 0,
    getLabel: 0,
    trackOrder: 0,
    cancelOrder: 0
  };

  return {
    code: "bigship",
    calls,
    login: async () => {
      calls.login += 1;
      return { token: "internal_test_token", expiresAt: new Date("2026-06-06T11:00:00.000Z") };
    },
    ensureToken: async () => {
      calls.ensureToken += 1;
      return { token: "internal_test_token", expiresAt: new Date("2026-06-06T11:00:00.000Z") };
    },
    createPickupLocation: async () => {
      calls.createPickupLocation += 1;
      return {
        providerPickupId: "internal_pickup_001",
        status: "active",
        message: "saved",
        providerMetadata: { saved: true }
      };
    },
    createDraftOrder: async () => {
      calls.createDraftOrder += 1;
      return {
        providerOrderId: "internal_order_001",
        providerReferenceNumber: "internal_ref_001",
        status: "draft",
        message: "created",
        providerMetadata: { created: true }
      };
    },
    getRates: async () => {
      calls.getRates += 1;
      return [{
        rateId: "internal_rate_smart",
        serviceLevel: "Shipmastr Smart",
        courierNetwork: "Shipmastr Courier Network",
        totalCharge: 62,
        currency: "INR",
        tatDays: 2,
        chargedWeightKg: 1,
        providerCourierId: "internal_courier_smart",
        providerMetadata: { score: 92 }
      }, {
        rateId: "internal_rate_economy",
        serviceLevel: "Shipmastr Economy",
        courierNetwork: "Shipmastr Courier Network",
        totalCharge: 48,
        currency: "INR",
        tatDays: 4,
        chargedWeightKg: 1,
        providerCourierId: "internal_courier_economy",
        providerMetadata: { score: 80 }
      }, {
        rateId: "internal_rate_express",
        serviceLevel: "Shipmastr Express",
        courierNetwork: "Shipmastr Courier Network",
        totalCharge: 94,
        currency: "INR",
        tatDays: 1,
        chargedWeightKg: 1,
        providerCourierId: "internal_courier_express",
        providerMetadata: { score: 85 }
      }];
    },
    manifestOrder: async () => {
      calls.manifestOrder += 1;
      return {
        awb: "mock_awb_001",
        trackingNumber: "mock_awb_001",
        status: "manifested",
        providerReferenceNumber: "internal_manifest_001",
        providerAwb: "mock_awb_001",
        message: "manifested",
        providerMetadata: { manifested: true }
      };
    },
    getLabel: async ({ shipmentId, awb }) => {
      calls.getLabel += 1;
      return {
        labelUrl: `https://labels.shipmastr.local/mock/${shipmentId}.pdf`,
        trackingUrl: `https://track.shipmastr.local/${awb ?? "mock_awb_001"}`,
        status: "manifested",
        message: "label generated",
        providerMetadata: { label: true }
      };
    },
    trackOrder: async () => {
      calls.trackOrder += 1;
      return {
        awb: "mock_awb_001",
        trackingNumber: "mock_awb_001",
        status: "in_transit",
        publicStatus: "In transit",
        latestEvent: "Shipment is moving.",
        events: [{
          status: "manifested",
          publicStatus: "Ready to ship",
          message: "Shipment manifested.",
          location: "Origin",
          checkpointTime: new Date("2026-06-06T10:30:00.000Z")
        }, {
          status: "in_transit",
          publicStatus: "In transit",
          message: "Shipment is moving.",
          location: "Transit hub",
          checkpointTime: new Date("2026-06-06T12:00:00.000Z")
        }],
        providerMetadata: { eventCount: 2 }
      };
    },
    cancelOrder: async () => {
      calls.cancelOrder += 1;
      return {
        cancelled: true,
        status: "cancelled",
        message: "cancelled",
        providerMetadata: { cancelled: true }
      };
    }
  };
}

function createFakeShiprocketAdapter(options: { providerCourierId?: string | null } = {}): InternalCourierProviderAdapter & { calls: Record<string, number> } {
  const base = createFakeAdapter();
  const providerCourierId = options.providerCourierId === undefined ? "12345" : options.providerCourierId;
  const rate = (
    rateId: string,
    serviceLevel: "Shipmastr Smart" | "Shipmastr Economy" | "Shipmastr Express",
    totalCharge: number,
    tatDays: number,
    providerRateId: string
  ) => ({
    rateId,
    serviceLevel,
    courierNetwork: "Shipmastr Courier Network" as const,
    totalCharge,
    currency: "INR" as const,
    tatDays,
    chargedWeightKg: 1,
    ...(providerCourierId ? { providerCourierId } : {}),
    providerMetadata: {
      providerCourierId,
      providerServiceId: `svc_${providerRateId}`,
      providerRateId,
      rawProviderResponseStored: false
    }
  });
  return {
    ...base,
    code: "shiprocket",
    getRates: async () => {
      base.calls.getRates = (base.calls.getRates ?? 0) + 1;
      return [
        rate("shiprocket_rate_smart", "Shipmastr Smart", 72, 2, "rate_smart"),
        rate("shiprocket_rate_economy", "Shipmastr Economy", 58, 4, "rate_economy"),
        rate("shiprocket_rate_express", "Shipmastr Express", 96, 1, "rate_express")
      ];
    },
    createDraftOrder: async () => {
      base.calls.createDraftOrder = (base.calls.createDraftOrder ?? 0) + 1;
      return {
        providerOrderId: "987654321",
        providerReferenceNumber: "SR-ORDER-001",
        status: "draft",
        message: "created",
        providerMetadata: { raw_response_stored: false }
      };
    },
    manifestOrder: async () => {
      base.calls.manifestOrder = (base.calls.manifestOrder ?? 0) + 1;
      return {
        awb: "190123456789",
        trackingNumber: "190123456789",
        status: "manifested",
        providerReferenceNumber: "987654321",
        providerAwb: "190123456789",
        message: "manifested",
        providerMetadata: { raw_response_stored: false }
      };
    },
    getLabel: async () => {
      base.calls.getLabel = (base.calls.getLabel ?? 0) + 1;
      return {
        labelUrl: "https://labels.shipmastr.local/live/sm-safe-label.pdf",
        trackingUrl: "https://track.shipmastr.local/190123456789",
        status: "manifested",
        message: "label generated",
        providerMetadata: { raw_response_stored: false }
      };
    }
  };
}

function createFakeClient() {
  const state = {
    courierPartners: [{
      id: "courier_internal_1",
      name: "Internal Partner",
      code: "internal_partner",
      active: true,
      status: CourierPartnerStatus.active,
      isSystemManaged: true,
      defaultForNewSellers: true,
      credentialsRequiredFromSeller: false,
      country: "IN",
      supportedSegments: [ShipmentSegment.domestic_b2c],
      priority: 50,
      createdAt: now
    }],
    sellerCourierPartners: [] as any[],
    pickupLocations: [] as any[],
    pickupMappings: [] as any[],
    shipments: [] as any[],
    providerRefs: [] as any[],
    rates: [] as any[],
    trackingEvents: [] as any[],
    orders: [] as any[],
    merchants: [{
      id: "seller_1",
      name: "Skymax Direct",
      email: "owner@example.test",
      phone: "+919876543210"
    }],
    automationPreferences: [{
      merchantId: "seller_1",
      metadata: {
        sellerSettingsProfile: {
          trackingBranding: {
            logoText: "Skymax",
            supportEmail: "help@skymax.example",
            supportPhone: "+919876543210"
          }
        }
      }
    }],
    autopilotPreferences: [] as any[],
    autopilotDecisions: [] as any[],
    slaEvents: [] as any[],
    slaStats: [] as any[],
    bulkBatches: [] as any[],
    bulkItems: [] as any[],
    ndrCases: [] as any[],
    ndrActionAttempts: [] as any[],
    rtoCases: [] as any[],
    codLedgerEntries: [] as any[],
    weightDiscrepancyCases: [] as any[],
    livePilotMerchants: [] as any[],
    livePilotCapabilities: [] as any[],
    courierProviderCredentials: [] as any[]
  };

  const id = (prefix: string, count: number) => `${prefix}_${count + 1}`;
  const byId = <T extends { id: string }>(rows: T[], rowId: string) => rows.find((row) => row.id === rowId);
  const statusMatches = (rowStatus: string, whereStatus: any) => {
    if (whereStatus === undefined) return true;
    if (typeof whereStatus === "string") return rowStatus === whereStatus;
    if (Array.isArray(whereStatus.in)) return whereStatus.in.includes(rowStatus);
    return true;
  };
  const pageRows = <T>(rows: T[], args: any = {}) => {
    const sorted = args.orderBy?.createdAt === "desc"
      ? [...rows].sort((left: any, right: any) => right.createdAt.getTime() - left.createdAt.getTime())
      : rows;
    return sorted.slice(args.skip ?? 0, (args.skip ?? 0) + (args.take ?? sorted.length));
  };
  const matchesOperationalWhere = (row: any, where: any = {}) => {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (where.merchantId !== undefined && row.merchantId !== where.merchantId) return false;
    if (where.shipmentId !== undefined && row.shipmentId !== where.shipmentId) return false;
    if (where.ndrCaseId !== undefined && row.ndrCaseId !== where.ndrCaseId) return false;
    if (!statusMatches(row.status, where.status)) return false;
    if (where.entryType !== undefined && row.entryType !== where.entryType) return false;
    return true;
  };

  const matchesShipmentWhere = (row: any, where: any) => {
    if (where.sellerId && row.sellerId !== where.sellerId) return false;
    if (where.id && row.id !== where.id) return false;
    if (where.status && row.status !== where.status) return false;
    if (where.OR?.length) {
      return where.OR.some((clause: any) => {
        if (clause.orderId !== undefined) return row.orderId === clause.orderId;
        if (clause.externalOrderId !== undefined) return row.externalOrderId === clause.externalOrderId;
        if (clause.id !== undefined) return row.id === clause.id;
        return false;
      });
    }
    return true;
  };

  const client = {
    order: {
      findFirst: async ({ where }: any) => state.orders.find((row) => {
        if (where.merchantId && row.merchantId !== where.merchantId) return false;
        if (where.OR?.length) {
          return where.OR.some((clause: any) => {
            if (clause.id !== undefined) return row.id === clause.id;
            if (clause.externalOrderId !== undefined) return row.externalOrderId === clause.externalOrderId;
            return false;
          });
        }
        return true;
      }) ?? null
    },
    merchant: {
      findUnique: async ({ where }: any) => state.merchants.find((row) => row.id === where.id) ?? null
    },
    livePilotMerchant: {
      findUnique: async ({ where }: any) => state.livePilotMerchants.find((row) => row.merchantId === where.merchantId) ?? null
    },
    livePilotCapability: {
      findMany: async ({ where }: any) => state.livePilotCapabilities.filter((row) => (
        where?.merchantId === undefined || row.merchantId === where.merchantId
      ))
    },
    courierProviderCredential: {
      findMany: async ({ where, orderBy, take }: any = {}) => {
        let rows = state.courierProviderCredentials.filter((row) => {
          if (where?.merchantId !== undefined && row.merchantId !== where.merchantId) return false;
          if (where?.providerKey !== undefined && row.providerKey !== where.providerKey) return false;
          if (where?.mode !== undefined && row.mode !== where.mode) return false;
          if (where?.status !== undefined && row.status !== where.status) return false;
          if (where?.credentialRef?.not === null && row.credentialRef === null) return false;
          if (where?.lastTestStatus !== undefined && row.lastTestStatus !== where.lastTestStatus) return false;
          if (where?.lastTestedAt?.not === null && row.lastTestedAt === null) return false;
          if (where?.OR?.length) {
            return where.OR.some((clause: any) => clause.merchantId === row.merchantId);
          }
          return true;
        });
        if (orderBy?.lastTestedAt === "desc") rows = [...rows].sort((left, right) => (right.lastTestedAt?.getTime() ?? 0) - (left.lastTestedAt?.getTime() ?? 0));
        if (orderBy?.updatedAt === "desc") rows = [...rows].sort((left, right) => (right.updatedAt?.getTime() ?? 0) - (left.updatedAt?.getTime() ?? 0));
        return take ? rows.slice(0, take) : rows;
      }
    },
    automationPreference: {
      findUnique: async ({ where }: any) => state.automationPreferences.find((row) => row.merchantId === where.merchantId) ?? null
    },
    autopilotPreference: {
      findUnique: async ({ where }: any) => state.autopilotPreferences.find((row) => row.merchantId === where.merchantId) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const existing = state.autopilotPreferences.find((row) => row.merchantId === where.merchantId);
        if (existing) {
          Object.assign(existing, update, { updatedAt: now });
          return existing;
        }
        const row = { id: id("autopilot_pref", state.autopilotPreferences.length), createdAt: now, updatedAt: now, ...create };
        state.autopilotPreferences.push(row);
        return row;
      }
    },
    autopilotDecision: {
      create: async ({ data }: any) => {
        const row = { id: id("autopilot_decision", state.autopilotDecisions.length), createdAt: now, ...data };
        state.autopilotDecisions.push(row);
        return row;
      }
    },
    courierSlaEvent: {
      create: async ({ data }: any) => {
        const row = { id: id("sla_event", state.slaEvents.length), createdAt: now, ...data };
        state.slaEvents.push(row);
        return row;
      },
      findMany: async ({ where }: any = {}) => state.slaEvents.filter((row) => {
        if (where?.provider !== undefined && row.provider !== where.provider) return false;
        if (where?.courierCode !== undefined && row.courierCode !== where.courierCode) return false;
        if (where?.deliveryPincode !== undefined && row.deliveryPincode !== where.deliveryPincode) return false;
        if (where?.selectedTier !== undefined && row.selectedTier !== where.selectedTier) return false;
        return true;
      })
    },
    courierSlaStat: {
      findFirst: async ({ where }: any = {}) => {
        const rows = state.slaStats.filter((row) => {
          if (where?.provider !== undefined && row.provider !== where.provider) return false;
          if (where?.courierCode !== undefined && row.courierCode !== where.courierCode) return false;
          if (where?.serviceType !== undefined && row.serviceType !== where.serviceType) return false;
          if (where?.selectedTier !== undefined && row.selectedTier !== where.selectedTier) return false;
          if (where?.pickupPincode !== undefined && row.pickupPincode !== where.pickupPincode) return false;
          if (where?.deliveryPincode !== undefined && row.deliveryPincode !== where.deliveryPincode) return false;
          return true;
        });
        return [...rows].sort((left, right) => (right.totalShipments ?? 0) - (left.totalShipments ?? 0))[0] ?? null;
      },
      create: async ({ data }: any) => {
        const row = { id: id("sla_stat", state.slaStats.length), createdAt: now, updatedAt: now, ...data };
        state.slaStats.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = byId(state.slaStats, where.id);
        assert.ok(row);
        Object.assign(row, data, { updatedAt: now });
        return row;
      },
      findMany: async ({ where }: any = {}) => state.slaStats.filter((row) => {
        if (where?.provider !== undefined && row.provider !== where.provider) return false;
        if (where?.courierCode !== undefined && row.courierCode !== where.courierCode) return false;
        if (where?.deliveryPincode !== undefined && row.deliveryPincode !== where.deliveryPincode) return false;
        if (where?.selectedTier !== undefined && row.selectedTier !== where.selectedTier) return false;
        return true;
      }).sort((left, right) => (right.totalShipments ?? 0) - (left.totalShipments ?? 0))
    },
    courierPartner: {
      findFirst: async () => state.courierPartners[0]
    },
    sellerCourierPartner: {
      findUnique: async ({ where }: any) => {
        const unique = where.sellerId_courierPartnerId;
        return state.sellerCourierPartners.find((row) =>
          row.sellerId === unique.sellerId && row.courierPartnerId === unique.courierPartnerId
        ) ?? null;
      },
      create: async ({ data }: any) => {
        const row = { id: id("scp", state.sellerCourierPartners.length), createdAt: now, updatedAt: now, ...data };
        state.sellerCourierPartners.push(row);
        return row;
      }
    },
    pickupLocation: {
      create: async ({ data }: any) => {
        const row = { id: id("pickup", state.pickupLocations.length), createdAt: now, updatedAt: now, ...data };
        state.pickupLocations.push(row);
        return row;
      },
      findMany: async ({ where }: any) => state.pickupLocations.filter((row) => (
        row.sellerId === where.sellerId
        && (!where.status || row.status === where.status)
      )),
      findFirst: async ({ where }: any) => state.pickupLocations.find((row) =>
        row.id === where.id && (!where.sellerId || row.sellerId === where.sellerId)
      ) ?? null
    },
    pickupLocationProviderMapping: {
      findUnique: async ({ where }: any) => {
        const unique = where.pickupLocationId_courierPartnerId;
        return state.pickupMappings.find((row) =>
          row.pickupLocationId === unique.pickupLocationId && row.courierPartnerId === unique.courierPartnerId
        ) ?? null;
      },
      upsert: async ({ where, create, update }: any) => {
        const unique = where.pickupLocationId_courierPartnerId;
        const existing = state.pickupMappings.find((row) =>
          row.pickupLocationId === unique.pickupLocationId && row.courierPartnerId === unique.courierPartnerId
        );
        if (existing) {
          Object.assign(existing, update, { updatedAt: now });
          return existing;
        }
        const row = { id: id("pickup_mapping", state.pickupMappings.length), createdAt: now, updatedAt: now, ...create };
        state.pickupMappings.push(row);
        return row;
      }
    },
    shipment: {
      create: async ({ data }: any) => {
        const row = {
          id: id("shipment", state.shipments.length),
          createdAt: now,
          updatedAt: now,
          awbNumber: null,
          trackingUrl: null,
          trackingToken: null,
          trackingPublicUrl: null,
          trackingStatus: null,
          trackingLastSyncedAt: null,
          serviceLevel: null,
          ...data
        };
        state.shipments.push(row);
        return row;
      },
      findUnique: async ({ where }: any) => state.shipments.find((row) => {
        if (where.id !== undefined) return row.id === where.id;
        if (where.trackingToken !== undefined) return row.trackingToken === where.trackingToken;
        return false;
      }) ?? null,
      findFirst: async ({ where }: any) => state.shipments.find((row) => matchesShipmentWhere(row, where)) ?? null,
      findMany: async ({ where, orderBy }: any) => {
        const rows = state.shipments.filter((row) => matchesShipmentWhere(row, where ?? {}));
        if (orderBy?.createdAt === "desc") {
          return [...rows].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
        }
        return rows;
      },
      update: async ({ where, data }: any) => {
        const row = byId(state.shipments, where.id);
        assert.ok(row);
        Object.assign(row, data, { updatedAt: now });
        return row;
      }
    },
    shipmentProviderRef: {
      findFirst: async ({ where }: any) => state.providerRefs.find((row) =>
        row.shipmentId === where.shipmentId &&
        (where.courierPartnerId === undefined || row.courierPartnerId === where.courierPartnerId)
      ) ?? null,
      create: async ({ data }: any) => {
        const row = { id: id("provider_ref", state.providerRefs.length), createdAt: now, updatedAt: now, ...data };
        state.providerRefs.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = byId(state.providerRefs, where.id);
        assert.ok(row);
        Object.assign(row, data, { updatedAt: now });
        return row;
      }
    },
    shipmentRate: {
      create: async ({ data }: any) => {
        const row = { id: id("rate", state.rates.length), createdAt: now, updatedAt: now, ...data };
        state.rates.push(row);
        return row;
      },
      findMany: async ({ where, orderBy }: any) => {
        const rows = state.rates.filter((row) =>
          (where.shipmentId === undefined || row.shipmentId === where.shipmentId) &&
          (where.sellerId === undefined || row.sellerId === where.sellerId)
        );
        if (orderBy?.createdAt === "desc") {
          return [...rows].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
        }
        return rows;
      },
      findFirst: async ({ where }: any) => state.rates.find((row) =>
        row.id === where.id && row.shipmentId === where.shipmentId && row.sellerId === where.sellerId
      ) ?? null
    },
    shipmentTrackingEvent: {
      create: async ({ data }: any) => {
        const row = { id: id("event", state.trackingEvents.length), createdAt: now, ...data };
        state.trackingEvents.push(row);
        return row;
      },
      findMany: async ({ where }: any) => state.trackingEvents
        .filter((row) => row.shipmentId === where.shipmentId)
        .sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime())
    },
    bulkShippingBatch: {
      create: async ({ data }: any) => {
        const row = { id: id("bulk_batch", state.bulkBatches.length), createdAt: now, updatedAt: now, ...data };
        state.bulkBatches.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = byId(state.bulkBatches, where.id);
        assert.ok(row);
        Object.assign(row, data, { updatedAt: now });
        return row;
      }
    },
    bulkShippingItem: {
      create: async ({ data }: any) => {
        const row = { id: id("bulk_item", state.bulkItems.length), createdAt: now, ...data };
        state.bulkItems.push(row);
        return row;
      }
    },
    ndrCase: {
      create: async ({ data }: any) => {
        const row = { id: id("ndr", state.ndrCases.length), createdAt: now, updatedAt: now, ...data };
        state.ndrCases.push(row);
        return row;
      },
      findFirst: async ({ where }: any) => state.ndrCases.find((row) => matchesOperationalWhere(row, where)) ?? null,
      findMany: async (args: any = {}) => pageRows(
        state.ndrCases.filter((row) => matchesOperationalWhere(row, args.where)),
        args
      ),
      count: async ({ where }: any = {}) => state.ndrCases.filter((row) => matchesOperationalWhere(row, where)).length,
      update: async ({ where, data }: any) => {
        const row = byId(state.ndrCases, where.id);
        assert.ok(row);
        Object.assign(row, data, { updatedAt: now });
        return row;
      }
    },
    ndrActionAttempt: {
      create: async ({ data }: any) => {
        const row = { id: id("ndr_action", state.ndrActionAttempts.length), createdAt: now, ...data };
        state.ndrActionAttempts.push(row);
        return row;
      },
      findMany: async (args: any = {}) => pageRows(
        state.ndrActionAttempts.filter((row) => matchesOperationalWhere(row, args.where)),
        args
      )
    },
    rtoCase: {
      create: async ({ data }: any) => {
        const row = { id: id("rto", state.rtoCases.length), createdAt: now, updatedAt: now, ...data };
        state.rtoCases.push(row);
        return row;
      },
      findFirst: async ({ where }: any) => state.rtoCases.find((row) => matchesOperationalWhere(row, where)) ?? null,
      findMany: async (args: any = {}) => pageRows(
        state.rtoCases.filter((row) => matchesOperationalWhere(row, args.where)),
        args
      ),
      count: async ({ where }: any = {}) => state.rtoCases.filter((row) => matchesOperationalWhere(row, where)).length,
      update: async ({ where, data }: any) => {
        const row = byId(state.rtoCases, where.id);
        assert.ok(row);
        Object.assign(row, data, { updatedAt: now });
        return row;
      }
    },
    codLedgerEntry: {
      create: async ({ data }: any) => {
        const row = { id: id("cod_ledger", state.codLedgerEntries.length), createdAt: now, updatedAt: now, ...data };
        state.codLedgerEntries.push(row);
        return row;
      },
      findFirst: async ({ where }: any) => state.codLedgerEntries.find((row) => matchesOperationalWhere(row, where)) ?? null,
      findMany: async (args: any = {}) => pageRows(
        state.codLedgerEntries.filter((row) => matchesOperationalWhere(row, args.where)),
        args
      ),
      count: async ({ where }: any = {}) => state.codLedgerEntries.filter((row) => matchesOperationalWhere(row, where)).length
    },
    weightDiscrepancyCase: {
      create: async ({ data }: any) => {
        const row = { id: id("weight_dispute", state.weightDiscrepancyCases.length), createdAt: now, updatedAt: now, detectedAt: now, ...data };
        state.weightDiscrepancyCases.push(row);
        return row;
      },
      findFirst: async ({ where }: any) => state.weightDiscrepancyCases.find((row) => matchesOperationalWhere(row, where)) ?? null,
      findMany: async (args: any = {}) => pageRows(
        state.weightDiscrepancyCases.filter((row) => matchesOperationalWhere(row, args.where)),
        args
      ),
      count: async ({ where }: any = {}) => state.weightDiscrepancyCases.filter((row) => matchesOperationalWhere(row, where)).length,
      update: async ({ where, data }: any) => {
        const row = byId(state.weightDiscrepancyCases, where.id);
        assert.ok(row);
        Object.assign(row, data, { updatedAt: now });
        return row;
      }
    }
  };

  return { client: client as any, state };
}

function seedActiveLiveCourierProvider(state: ReturnType<typeof createFakeClient>["state"], merchantId = "seller_1") {
  state.courierProviderCredentials.push({
    id: `courier_credential_${state.courierProviderCredentials.length + 1}`,
    merchantId,
    providerKey: "SHIPROCKET",
    mode: "LIVE",
    status: "ACTIVE",
    credentialRef: "env:SHIPROCKET_LIVE_CREDENTIALS",
    requiredFields: ["email", "password"],
    safeMeta: {
      required_fields_present: ["email", "password"]
    },
    lastTestedAt: now,
    lastTestStatus: "PASS",
    lastTestSummary: {
      non_destructive: true,
      raw_response_stored: false
    },
    createdAt: now,
    updatedAt: now
  });
}

function liveShiprocketSource(shipmentId: string, merchantId = "seller_1") {
  return {
    SHIPMASTR_LIVE_AWB_LABEL_ENABLED: "true",
    SHIPMASTR_LIVE_AWB_LABEL_MODE: "LIVE",
    SHIPMASTR_LIVE_AWB_LABEL_PILOT_ONLY: "true",
    SHIPMASTR_ENABLE_LIVE_SHIPROCKET_AWB: "1",
    SHIPMASTR_LIVE_SHIPROCKET_ALLOWED_MERCHANT_ID: merchantId,
    SHIPMASTR_LIVE_SHIPROCKET_ALLOWED_SHIPMENT_ID: shipmentId,
    SHIPMASTR_LIVE_SHIPROCKET_ONE_SHOT_TOKEN: "operator-one-shot",
    SHIPMASTR_LIVE_SHIPROCKET_ONE_SHOT_HEADER: "operator-one-shot",
    SHIPROCKET_LIVE_CREDENTIALS: JSON.stringify({
      email: "pilot@example.test",
      password: "redacted-password"
    })
  };
}

function liveRatesSource() {
  return {
    SHIPMASTR_LIVE_COURIER_RATES_ENABLED: "true",
    SHIPMASTR_LIVE_COURIER_RATES_MODE: "LIVE",
    SHIPMASTR_LIVE_COURIER_RATES_PILOT_ONLY: "true",
    SHIPROCKET_LIVE_CREDENTIALS: JSON.stringify({
      email: "pilot@example.test",
      password: "redacted-password"
    })
  };
}

async function withEnvPatch<T>(patch: Record<string, unknown>, callback: () => Promise<T>) {
  const target = env as unknown as Record<string, unknown>;
  const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, target[key]]));
  Object.assign(target, patch);
  try {
    return await callback();
  } finally {
    for (const key of Object.keys(patch)) {
      if (previous[key] === undefined) {
        delete target[key];
      } else {
        target[key] = previous[key];
      }
    }
  }
}

function seedShipmentRate(
  state: ReturnType<typeof createFakeClient>["state"],
  input: {
    shipmentId: string;
    sellerId?: string;
    internalCourierId: string | null;
    serviceName?: "Shipmastr Smart" | "Shipmastr Economy" | "Shipmastr Express";
  }
) {
  const serviceName = input.serviceName ?? "Shipmastr Smart";
  const serviceCode = serviceName === "Shipmastr Economy"
    ? "shipmastr_economy"
    : serviceName === "Shipmastr Express"
      ? "shipmastr_express"
      : "shipmastr_smart";
  state.rates.push({
    id: `rate_${state.rates.length + 1}`,
    shipmentId: input.shipmentId,
    sellerId: input.sellerId ?? "seller_1",
    sellerCourierPartnerId: "seller_courier_1",
    courierPartnerId: "courier_internal_1",
    publicServiceCode: serviceCode,
    publicServiceName: serviceName,
    segment: ShipmentSegment.domestic_b2c,
    chargeableWeightKg: 1,
    amountPaise: 7200,
    currency: "INR",
    estimatedDeliveryDays: 2,
    rateBreakup: {
      internalRateId: "shiprocket_rate_smart",
      internalCourierId: input.internalCourierId,
      phase6: {
        tier: "smart",
        codSupported: true,
        pickupAvailable: true,
        deliveryAvailable: true,
        reliabilityScore: 0.9,
        livePilotRatesMode: "LIVE",
        livePilotRatesReady: true
      }
    },
    createdAt: now,
    updatedAt: now
  });
}

function pickupBody() {
  return {
    name: "Main warehouse",
    contact_person: "Ops Lead",
    phone: "9999999999",
    email: "ops@example.test",
    address: {
      line1: "Warehouse line",
      city: "Bengaluru",
      state: "KA",
      country: "IN",
      pincode: "560001"
    }
  };
}

function shipmentBody(pickupLocationId: string) {
  return {
    seller_order_id: "ORD1001",
    segment: "domestic_b2c" as const,
    pickup_location_id: pickupLocationId,
    payment_mode: "cod" as const,
    invoice: {
      invoice_number: "INV-1001",
      invoice_amount: 1499,
      collectable_amount: 1499
    },
    buyer: {
      name: "Demo Buyer",
      phone: "8888888888",
      address: {
        line1: "Buyer line",
        city: "Mumbai",
        state: "MH",
        country: "IN",
        pincode: "400001"
      }
    },
    boxes: [{
      weight_kg: 0.8,
      dimensions: {
        length_cm: 20,
        breadth_cm: 15,
        height_cm: 10
      },
      products: [{
        name: "Cotton Shirt",
        quantity: 1,
        unit_price: 1499
      }]
    }]
  };
}

function orderBody(overrides: Record<string, unknown> = {}) {
  return {
    id: "order_1",
    merchantId: "seller_1",
    externalOrderId: "ORD1001",
    buyerName: "Rahul Sharma",
    buyerPhone: "9876543210",
    addressLine1: "Buyer line",
    addressLine2: null,
    city: "Delhi",
    state: "Delhi",
    pincode: "110011",
    orderValue: 1299,
    codAmount: 1299,
    paymentMode: PaymentMode.COD,
    weightGrams: 800,
    status: "CREATED",
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe("Shipmastr Shipping Network services", () => {
  it("creates pickup locations with internal mapping while returning only public fields", async () => {
    const { client, state } = createFakeClient();
    const adapter = createFakeAdapter();

    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    state.pickupLocations.push({
      id: "pickup_inactive",
      sellerId: "seller_1",
      label: "Inactive warehouse",
      status: "inactive",
      country: "IN",
      createdAt: now,
      updatedAt: now
    });
    const list = await listShippingPickupLocations("seller_1", client);
    const json = JSON.stringify({ pickup, list });

    assert.equal(adapter.calls.createPickupLocation, 1);
    assert.equal(state.pickupLocations.length, 2);
    assert.equal(state.pickupMappings.length, 1);
    assert.equal(state.pickupMappings[0]?.providerPickupId, "internal_pickup_001");
    assert.equal(pickup.pickup_location_id, "pickup_1");
    assert.equal(pickup.courier_network, "Shipmastr Courier Network");
    assert.equal(list.length, 1);
    assert.equal(list[0]?.pickup_location_id, "pickup_1");
    assert.doesNotMatch(json, /internal_pickup_001|providerPickupId|internal_partner/i);
  });

  it("creates shipment drafts with seller-safe public fields", async () => {
    const { client } = createFakeClient();
    const adapter = createFakeAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });

    const shipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);

    assert.equal(shipment.shipment_id, "shipment_1");
    assert.equal(shipment.seller_order_id, "ORD1001");
    assert.equal(shipment.status, "draft");
    assert.equal(shipment.segment, "domestic_b2c");
    assert.equal(shipment.payment_mode, "cod");
  });

  it("fetches rates, reuses provider drafts, caches rates, and keeps public rates provider-safe", async () => {
    const { client, state } = createFakeClient();
    const adapter = createFakeAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const shipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);

    const first = await fetchShipmentRates("seller_1", shipment.shipment_id, { client, adapter });
    const second = await fetchShipmentRates("seller_1", shipment.shipment_id, { client, adapter });
    const json = JSON.stringify(first);

    assert.equal(adapter.calls.createDraftOrder, 1);
    assert.equal(adapter.calls.getRates, 1);
    assert.equal(state.providerRefs.length, 1);
    assert.equal(state.rates.length, 3);
    assert.equal(first.rates.length, 3);
    assert.equal(second.rates.length, 3);
    assert.equal(first.status, "rates_available");
    assert.equal(first.tiers.smart.label, "Shipmastr Smart");
    assert.equal(first.tiers.economy.label, "Shipmastr Economy");
    assert.equal(first.tiers.express.label, "Shipmastr Express");
    assert.equal(first.rates[0]?.courier_network, "Shipmastr Courier Network");
    assert.doesNotMatch(json, /internal_courier|internal_order|providerOrder|provider_order|bigship/i);
  });

  it("blocks live pilot rate calls when the merchant is not allowlisted", async () => {
    const { client } = createFakeClient();
    const adapter = createFakeAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const shipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);

    await assert.rejects(
      () => fetchShipmentRates("seller_1", shipment.shipment_id, {
        client,
        adapter,
        liveRatesSource: {
          SHIPMASTR_LIVE_COURIER_RATES_ENABLED: "true",
          SHIPMASTR_LIVE_COURIER_RATES_MODE: "LIVE",
          SHIPMASTR_LIVE_COURIER_RATES_PILOT_ONLY: "true"
        }
      }),
      (error) => error instanceof HttpError && error.message === "LIVE_PILOT_MERCHANT_NOT_ALLOWLISTED"
    );
    assert.equal(adapter.calls.createDraftOrder, 0);
    assert.equal(adapter.calls.getRates, 0);
  });

  it("allows live pilot rate calls only for allowlisted merchants with the rates capability", async () => {
    const { client, state } = createFakeClient();
    state.livePilotMerchants.push({ merchantId: "seller_1", status: "ENABLED" });
    state.livePilotCapabilities.push({
      merchantId: "seller_1",
      capability: "LIVE_COURIER_RATES",
      status: "ENABLED"
    });
    seedActiveLiveCourierProvider(state);
    const adapter = createFakeShiprocketAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const shipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);
    adapter.calls.createPickupLocation = 0;
    adapter.calls.createDraftOrder = 0;
    adapter.calls.getRates = 0;

    const result = await fetchShipmentRates("seller_1", shipment.shipment_id, {
      client,
      adapter,
      liveRatesSource: liveRatesSource()
    });

    const json = JSON.stringify(result);
    const storedRateBreakup = state.rates.map((rate) => rate.rateBreakup);
    assert.equal(adapter.calls.getRates, 1);
    assert.equal(adapter.calls.createPickupLocation, 0);
    assert.equal(adapter.calls.createDraftOrder, 0);
    assert.equal(result.rates.length, 3);
    assert.equal(result.tiers.smart.label, "Shipmastr Smart");
    assert.equal(storedRateBreakup.every((metadata) => metadata.phase6.livePilotRatesMode === "LIVE"), true);
    assert.equal(storedRateBreakup.every((metadata) => metadata.phase6.livePilotRatesReady === true), true);
    assert.equal(storedRateBreakup.every((metadata) => /^[0-9]+$/.test(metadata.providerCourierId)), true);
    assert.doesNotMatch(json, /internal_courier|providerCourierId|providerServiceId|providerRateId|providerMetadata|providerResponseJson|bigship|shiprocket|12345|svc_rate|rate_smart/i);
  });

  it("passes runtime env source into the live Shiprocket rates adapter when no explicit source is provided", async () => {
    const { client, state } = createFakeClient();
    state.livePilotMerchants.push({ merchantId: "seller_1", status: "ENABLED" });
    state.livePilotCapabilities.push({
      merchantId: "seller_1",
      capability: "LIVE_COURIER_RATES",
      status: "ENABLED"
    });
    seedActiveLiveCourierProvider(state);
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter: createFakeAdapter() });
    const shipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);
    const adapter = createFakeShiprocketAdapter();
    let adapterSource: Record<string, unknown> | undefined;

    await withEnvPatch(liveRatesSource(), async () => {
      const result = await fetchShipmentRates("seller_1", shipment.shipment_id, {
        client,
        liveRatesAdapterFactory: (input) => {
          adapterSource = input.source;
          return adapter;
        }
      });

      assert.equal(result.tiers.smart.label, "Shipmastr Smart");
    });

    assert.equal(adapter.calls.getRates, 1);
    assert.equal(adapterSource?.SHIPROCKET_LIVE_CREDENTIALS, liveRatesSource().SHIPROCKET_LIVE_CREDENTIALS);
    assert.equal(adapterSource?.SHIPMASTR_LIVE_COURIER_RATES_MODE, "LIVE");
    assert.equal(state.rates.every((rate) => rate.rateBreakup.phase6.livePilotRatesMode === "LIVE"), true);
    assert.equal(state.rates.every((rate) => /^[0-9]+$/.test(rate.rateBreakup.providerCourierId)), true);
  });

  it("returns a safe unresolved credential error before serviceability when live credentials are missing", async () => {
    const { client, state } = createFakeClient();
    state.livePilotMerchants.push({ merchantId: "seller_1", status: "ENABLED" });
    state.livePilotCapabilities.push({
      merchantId: "seller_1",
      capability: "LIVE_COURIER_RATES",
      status: "ENABLED"
    });
    seedActiveLiveCourierProvider(state);
    const adapter = createFakeShiprocketAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const shipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);

    await assert.rejects(
      () => fetchShipmentRates("seller_1", shipment.shipment_id, {
        client,
        adapter,
        liveRatesSource: {
          SHIPMASTR_LIVE_COURIER_RATES_ENABLED: "true",
          SHIPMASTR_LIVE_COURIER_RATES_MODE: "LIVE",
          SHIPMASTR_LIVE_COURIER_RATES_PILOT_ONLY: "true"
        }
      }),
      (error) => error instanceof HttpError && error.message === "LIVE_SHIPROCKET_CREDENTIAL_REF_UNRESOLVED"
    );
    assert.equal(adapter.calls.getRates, 0);
    assert.equal(state.rates.length, 0);
  });

  it("keeps dry-run rates on the mock path without a Shiprocket serviceability call", async () => {
    const { client, state } = createFakeClient();
    const adapter = createFakeShiprocketAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const shipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);

    const result = await fetchShipmentRates("seller_1", shipment.shipment_id, {
      client,
      adapter,
      liveRatesSource: {
        SHIPMASTR_LIVE_COURIER_RATES_ENABLED: "true",
        SHIPMASTR_LIVE_COURIER_RATES_MODE: "DRY_RUN",
        SHIPMASTR_LIVE_COURIER_RATES_PILOT_ONLY: "true"
      }
    });

    assert.equal(adapter.calls.createPickupLocation, 1);
    assert.equal(adapter.calls.createDraftOrder, 1);
    assert.equal(adapter.calls.getRates, 1);
    assert.equal(state.rates.every((rate) => rate.rateBreakup.phase6.livePilotRatesMode === "DRY_RUN"), true);
    assert.equal(state.rates.every((rate) => rate.rateBreakup.phase6.livePilotRatesReady === false), true);
    assert.equal(result.tiers.smart.label, "Shipmastr Smart");
  });

  it("fails live rates safely when serviceability has no numeric provider courier id", async () => {
    const { client, state } = createFakeClient();
    state.livePilotMerchants.push({ merchantId: "seller_1", status: "ENABLED" });
    state.livePilotCapabilities.push({
      merchantId: "seller_1",
      capability: "LIVE_COURIER_RATES",
      status: "ENABLED"
    });
    seedActiveLiveCourierProvider(state);
    const adapter = createFakeShiprocketAdapter({ providerCourierId: null });
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const shipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);

    await assert.rejects(
      () => fetchShipmentRates("seller_1", shipment.shipment_id, {
        client,
        adapter,
        liveRatesSource: liveRatesSource()
      }),
      (error) => error instanceof HttpError && error.message === "SHIPROCKET_LIVE_RATE_PROVIDER_ID_MISSING"
    );
    assert.equal(adapter.calls.getRates, 1);
    assert.equal(state.providerRefs.length, 0);
    assert.equal(state.rates.length, 0);
  });

  it("serializes live rate readiness without provider or credential details", async () => {
    const { client, state } = createFakeClient();
    state.livePilotMerchants.push({ merchantId: "seller_1", status: "ENABLED" });
    const readiness = await getLiveCourierRatesReadiness("seller_1", {
      client,
      source: {
        SHIPMASTR_LIVE_COURIER_RATES_ENABLED: "true",
        SHIPMASTR_LIVE_COURIER_RATES_MODE: "DRY_RUN",
        SHIPMASTR_LIVE_COURIER_RATES_PILOT_ONLY: "true"
      }
    });
    const serialized = serializeLiveCourierRatesReadiness(readiness);
    const json = JSON.stringify(serialized);

    assert.equal(serialized.status, "DRY_RUN");
    assert.equal(serialized.runtime.mode, "DRY_RUN");
    assert.doesNotMatch(json, /Bigship|bigship|Shiprocket|shiprocket|providerCourierId|providerServiceId|providerRateId|Authorization|Bearer|credentialHash|secretHash|rawPayload|rawHeaders|rawResponse|env:SHIPROCKET/i);
  });

  it("manifests a shipment, stores internal AWB, and returns Shipmastr tracking fields", async () => {
    const { client, state } = createFakeClient();
    const adapter = createFakeAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const shipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);
    const rates = await fetchShipmentRates("seller_1", shipment.shipment_id, { client, adapter });

    const manifested = await manifestShipment("seller_1", shipment.shipment_id, rates.rates[0]!.rate_id, {
      client,
      adapter
    });

    assert.equal(adapter.calls.manifestOrder, 1);
    assert.equal(state.providerRefs[0]?.providerAwb, "mock_awb_001");
    assert.match(manifested.awb, /^SM/);
    assert.equal(manifested.tracking_number, manifested.awb);
    assert.equal(manifested.courier_network, "Shipmastr Courier Network");
    assert.equal(manifested.service_level, "Shipmastr Smart");
  });

  it("ship-now fetches rates if missing, uses the requested tier, and stores AWB plus label", async () => {
    const { client, state } = createFakeClient();
    const adapter = createFakeAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const shipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);

    const created = await shipNowShipment("seller_1", shipment.shipment_id, "economy", { client, adapter });
    const second = await shipNowShipment("seller_1", shipment.shipment_id, "economy", { client, adapter });
    const json = JSON.stringify(created);

    assert.equal(adapter.calls.getRates, 1);
    assert.equal(adapter.calls.manifestOrder, 1);
    assert.equal(adapter.calls.getLabel, 1);
    assert.equal(created.status, "label_generated");
    assert.equal(created.tier, "economy");
    assert.equal(created.serviceLevel, "Shipmastr Economy");
    assert.match(created.awbNumber ?? "", /^SM/);
    assert.equal(created.labelUrl, "https://labels.shipmastr.local/mock/shipment_1.pdf");
    assert.equal(second.awbNumber, created.awbNumber);
    assert.equal(created.trackingUrl, state.shipments[0]?.trackingPublicUrl);
    assert.equal(created.trackingPublicUrl, state.shipments[0]?.trackingPublicUrl);
    assert.ok(isSafeTrackingToken(state.shipments[0]?.trackingToken));
    assert.notEqual(state.shipments[0]?.trackingToken, shipment.shipment_id);
    assert.notEqual(state.shipments[0]?.trackingToken, created.awbNumber);
    assert.equal(adapter.calls.manifestOrder, 1);
    assert.equal(adapter.calls.getLabel, 1);
    assert.equal(state.providerRefs[0]?.providerAwb, "mock_awb_001");
    assert.equal(state.shipments[0]?.serviceLevel, "Shipmastr Economy");
    assert.doesNotMatch(json, /internal_courier|internal_order|providerOrder|provider_order|bigship/i);
  });

  it("blocks live pilot Ship Now before AWB or label adapter calls when capability gates are missing", async () => {
    const { client } = createFakeClient();
    const adapter = createFakeAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const shipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);

    await assert.rejects(
      () => shipNowShipment("seller_1", shipment.shipment_id, "smart", {
        client,
        adapter,
        liveAwbLabelSource: {
          SHIPMASTR_LIVE_AWB_LABEL_ENABLED: "true",
          SHIPMASTR_LIVE_AWB_LABEL_MODE: "LIVE",
          SHIPMASTR_LIVE_AWB_LABEL_PILOT_ONLY: "true"
        }
      }),
      (error) => error instanceof HttpError && error.message === "LIVE_PILOT_MERCHANT_NOT_ALLOWLISTED"
    );
    assert.equal(adapter.calls.getRates, 0);
    assert.equal(adapter.calls.manifestOrder, 0);
    assert.equal(adapter.calls.getLabel, 0);
  });

  it("allows live pilot Ship Now only with rates and AWB label capabilities and stays idempotent", async () => {
    const { client, state } = createFakeClient();
    state.livePilotMerchants.push({ merchantId: "seller_1", status: "ENABLED" });
    state.livePilotCapabilities.push(
      { merchantId: "seller_1", capability: "LIVE_COURIER_RATES", status: "ENABLED" },
      { merchantId: "seller_1", capability: "LIVE_AWB_LABEL", status: "ENABLED" }
    );
    seedActiveLiveCourierProvider(state);
    const adapter = createFakeShiprocketAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const shipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);
    seedShipmentRate(state, { shipmentId: shipment.shipment_id, internalCourierId: "12345" });

    const first = await shipNowShipment("seller_1", shipment.shipment_id, "smart", {
      client,
      adapter,
      liveAwbLabelSource: liveShiprocketSource(shipment.shipment_id)
    });
    const second = await shipNowShipment("seller_1", shipment.shipment_id, "smart", {
      client,
      adapter,
      liveAwbLabelSource: liveShiprocketSource(shipment.shipment_id)
    });
    const json = JSON.stringify(first);

    assert.equal(adapter.calls.createDraftOrder, 1);
    assert.equal(adapter.calls.manifestOrder, 1);
    assert.equal(adapter.calls.getLabel, 1);
    assert.equal(first.awbNumber, second.awbNumber);
    assert.match(first.awbNumber ?? "", /^SM/);
    assert.notEqual(first.awbNumber, "190123456789");
    assert.equal(first.courierNetwork, "Shipmastr Courier Network");
    assert.equal(state.providerRefs[0]?.providerOrderId, "987654321");
    assert.equal(state.providerRefs[0]?.providerAwb, "190123456789");
    assert.doesNotMatch(json, /internal_courier|providerMetadata|providerResponseJson|bigship|shiprocket|providerAwb|providerShipmentId|190123456789|987654321/i);
  });

  it("blocks live Ship Now when the selected rate has no Shiprocket courier id", async () => {
    const { client, state } = createFakeClient();
    state.livePilotMerchants.push({ merchantId: "seller_1", status: "ENABLED" });
    state.livePilotCapabilities.push(
      { merchantId: "seller_1", capability: "LIVE_COURIER_RATES", status: "ENABLED" },
      { merchantId: "seller_1", capability: "LIVE_AWB_LABEL", status: "ENABLED" }
    );
    seedActiveLiveCourierProvider(state);
    const adapter = createFakeShiprocketAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const shipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);
    seedShipmentRate(state, { shipmentId: shipment.shipment_id, internalCourierId: "shipmastr_smart" });

    await assert.rejects(
      () => shipNowShipment("seller_1", shipment.shipment_id, "smart", {
        client,
        adapter,
        liveAwbLabelSource: liveShiprocketSource(shipment.shipment_id)
      }),
      (error) => error instanceof HttpError && error.message === "SHIPROCKET_LIVE_RATE_PROVIDER_ID_MISSING"
    );
    assert.equal(adapter.calls.createDraftOrder, 0);
    assert.equal(adapter.calls.manifestOrder, 0);
    assert.equal(adapter.calls.getLabel, 0);
  });

  it("blocks live Ship Now without one-shot approval before provider calls", async () => {
    const { client, state } = createFakeClient();
    state.livePilotMerchants.push({ merchantId: "seller_1", status: "ENABLED" });
    state.livePilotCapabilities.push(
      { merchantId: "seller_1", capability: "LIVE_COURIER_RATES", status: "ENABLED" },
      { merchantId: "seller_1", capability: "LIVE_AWB_LABEL", status: "ENABLED" }
    );
    seedActiveLiveCourierProvider(state);
    const adapter = createFakeShiprocketAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const shipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);

    await assert.rejects(
      () => shipNowShipment("seller_1", shipment.shipment_id, "smart", {
        client,
        adapter,
        liveAwbLabelSource: {
          ...liveShiprocketSource(shipment.shipment_id),
          SHIPMASTR_LIVE_SHIPROCKET_ONE_SHOT_HEADER: ""
        }
      }),
      (error) => error instanceof HttpError && error.message === "LIVE_SHIPROCKET_ONE_SHOT_APPROVAL_REQUIRED"
    );
    assert.equal(adapter.calls.getRates, 0);
    assert.equal(adapter.calls.createDraftOrder, 0);
    assert.equal(adapter.calls.manifestOrder, 0);
    assert.equal(adapter.calls.getLabel, 0);
  });

  it("serializes live Ship Now readiness without provider, raw response, or credential details", async () => {
    const { client, state } = createFakeClient();
    state.livePilotMerchants.push({ merchantId: "seller_1", status: "ENABLED" });
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter: createFakeAdapter() });
    const shipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);
    const readiness = await getLiveAwbLabelReadiness("seller_1", {
      client,
      shipmentId: shipment.shipment_id,
      source: {
        SHIPMASTR_LIVE_AWB_LABEL_ENABLED: "true",
        SHIPMASTR_LIVE_AWB_LABEL_MODE: "DRY_RUN",
        SHIPMASTR_LIVE_AWB_LABEL_PILOT_ONLY: "true"
      }
    });
    const serialized = serializeLiveAwbLabelReadiness(readiness);
    const json = JSON.stringify(serialized);

    assert.equal(serialized.status, "DRY_RUN");
    assert.equal(serialized.runtime.mode, "DRY_RUN");
    assert.equal(serialized.shipment?.ready_for_ship_now, true);
    assert.doesNotMatch(json, /Bigship|bigship|provider|Authorization|Bearer|credentialHash|secretHash|rawPayload|rawHeaders|rawResponse/i);
  });

  it("keeps public tracking tokens stable across repeated Ship Now responses", async () => {
    const { client, state } = createFakeClient();
    const adapter = createFakeAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const shipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);

    const first = await shipNowShipment("seller_1", shipment.shipment_id, "smart", { client, adapter });
    const token = state.shipments[0]?.trackingToken;
    const second = await shipNowShipment("seller_1", shipment.shipment_id, "smart", { client, adapter });

    assert.ok(isSafeTrackingToken(token));
    assert.equal(state.shipments[0]?.trackingToken, token);
    assert.equal(first.trackingPublicUrl, second.trackingPublicUrl);
    assert.match(first.trackingPublicUrl ?? "", /^\/tracking\/trk_/);
  });

  it("returns buyer-safe branded tracking data by public token", async () => {
    const { client, state } = createFakeClient();
    const adapter = createFakeAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const shipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);
    await shipNowShipment("seller_1", shipment.shipment_id, "smart", { client, adapter });

    const token = state.shipments[0]?.trackingToken;
    const tracking = await getPublicTrackingByToken(token, client);
    const missing = await getPublicTrackingByToken("trk_missing_missing_missing", client);
    const json = JSON.stringify(tracking);

    assert.equal(missing, null);
    assert.equal(tracking?.trackingToken, token);
    assert.equal(tracking?.brand.name, "Skymax");
    assert.equal(tracking?.shipment.publicStatus, "Shipment ready");
    assert.equal(tracking?.shipment.awbNumber, state.shipments[0]?.awbNumber);
    assert.equal(tracking?.shipment.trackingUrl, null);
    assert.equal(tracking?.order.externalOrderId, "ORD1001");
    assert.equal(tracking?.delivery.city, "Mumbai");
    assert.equal(tracking?.delivery.pincode, "400001");
    assert.equal(tracking?.support.contactEmail, "help@skymax.example");
    assert.equal(tracking?.support.contactPhoneMasked, "ending 3210");
    assert.ok((tracking?.timeline.length ?? 0) >= 3);
    assert.doesNotMatch(json, /internal_order|internal_courier|providerResponseJson|providerErrorJson|courierOverride|8888888888|Buyer line|bigship/i);
  });

  it("builds public tracking timelines from real available events only", () => {
    const timeline = buildTrackingTimeline({
      order: { status: "CREATED", createdAt: new Date("2026-06-06T09:00:00.000Z") },
      shipment: {
        status: "label_generated",
        awbNumber: "SM0001",
        createdAt: new Date("2026-06-06T09:10:00.000Z"),
        updatedAt: new Date("2026-06-06T09:20:00.000Z"),
        metadata: {
          phase6: {
            awbAssignedAt: "2026-06-06T09:15:00.000Z",
            labelGeneratedAt: "2026-06-06T09:20:00.000Z",
            labelUrl: "https://labels.shipmastr.local/mock/shipment_1.pdf"
          }
        }
      },
      rates: [{ createdAt: new Date("2026-06-06T09:12:00.000Z") }],
      trackingEvents: []
    });
    const statuses = timeline.map((event) => event.status);

    assert.deepEqual(statuses, [
      "order_created",
      "shipment_created",
      "rates_available",
      "awb_assigned",
      "label_generated"
    ]);
    assert.equal(publicStatusForShipmentStatus("provider_failed").publicStatus, "Shipment delayed");
    assert.equal(publicStatusForShipmentStatus("out_for_delivery").publicStatus, "Out for delivery");
  });

  it("ship-now handles provider failure safely without leaking internals", async () => {
    const { client, state } = createFakeClient();
    const adapter = createFakeAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const shipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);
    adapter.manifestOrder = async () => {
      adapter.calls.manifestOrder = (adapter.calls.manifestOrder ?? 0) + 1;
      throw Object.assign(new Error("internal provider exploded"), {
        code: "COURIER_PROVIDER_HTTP_ERROR",
        retryable: true
      });
    };

    await assert.rejects(
      () => shipNowShipment("seller_1", shipment.shipment_id, "smart", { client, adapter }),
      (error) => error instanceof HttpError && error.message === "SHIPMENT_CREATION_FAILED"
    );

    const json = JSON.stringify(state.shipments[0]?.metadata);
    assert.equal(adapter.calls.manifestOrder, 1);
    assert.match(json, /providerErrorJson/);
    assert.doesNotMatch(json, /internal provider exploded|access_key|password|token/i);
  });

  it("stores normalized public tracking history", async () => {
    const { client } = createFakeClient();
    const adapter = createFakeAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const shipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);
    const rates = await fetchShipmentRates("seller_1", shipment.shipment_id, { client, adapter });
    await manifestShipment("seller_1", shipment.shipment_id, rates.rates[0]!.rate_id, { client, adapter });

    const tracking = await fetchShipmentTracking("seller_1", shipment.shipment_id, { client, adapter });

    assert.equal(adapter.calls.trackOrder, 1);
    assert.equal(tracking.status, "in_transit");
    assert.equal(tracking.history.length, 2);
    assert.equal(tracking.history[0]?.label, "Ready to ship");
  });

  it("blocks terminal shipment cancellation and cancels cancellable shipments", async () => {
    const { client, state } = createFakeClient();
    const adapter = createFakeAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const shipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);

    const cancelled = await cancelShipment("seller_1", shipment.shipment_id, "Seller request", { client, adapter });

    assert.equal(cancelled.status, "cancelled");
    assert.equal(adapter.calls.cancelOrder, 0);

    state.shipments[0]!.status = ShipmentStatus.delivered;
    await assert.rejects(
      () => cancelShipment("seller_1", shipment.shipment_id, "Too late", { client, adapter }),
      (error) => error instanceof HttpError && error.message === "SHIPMENT_STATUS_TERMINAL"
    );
  });

  it("lists only authenticated seller shipments and paginates safely", async () => {
    const { client } = createFakeClient();
    const adapter = createFakeAdapter();
    const sellerPickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const otherPickup = await createShippingPickupLocation("seller_2", pickupBody(), { client, adapter });
    const first = await createShipmentDraft("seller_1", shipmentBody(sellerPickup.pickup_location_id), client);
    await createShipmentDraft("seller_1", { ...shipmentBody(sellerPickup.pickup_location_id), seller_order_id: "ORD1002" }, client);
    await createShipmentDraft("seller_2", { ...shipmentBody(otherPickup.pickup_location_id), seller_order_id: "OTHER1001" }, client);

    const pageOne = await listShippingShipments("seller_1", { page: 1, per_page: 1 }, client);
    const pageTwo = await listShippingShipments("seller_1", { page: 2, per_page: 1 }, client);
    const searched = await listShippingShipments("seller_1", { page: 1, per_page: 20, search: first.seller_order_id ?? "" }, client);

    assert.equal(pageOne.shipments.length, 1);
    assert.equal(pageTwo.shipments.length, 1);
    assert.equal(pageOne.pagination.total, 2);
    assert.equal(pageOne.pagination.has_more, true);
    assert.equal(pageTwo.pagination.has_more, false);
    assert.equal(searched.shipments.length, 1);
    assert.equal(searched.shipments[0]?.seller_order_id, "ORD1001");
    assert.equal(pageOne.shipments.some((shipment) => shipment.seller_order_id === "OTHER1001"), false);
  });

  it("filters shipment lists by queue and keeps public rows provider-safe", async () => {
    const { client } = createFakeClient();
    const adapter = createFakeAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const draft = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);
    await fetchShipmentRates("seller_1", draft.shipment_id, { client, adapter });

    const ready = await listShippingShipments("seller_1", { page: 1, per_page: 20, queue: "ready_to_ship" }, client);
    const attention = await listShippingShipments("seller_1", { page: 1, per_page: 20, queue: "needs_attention" }, client);
    const json = JSON.stringify(ready);

    assert.equal(ready.shipments.length, 1);
    assert.equal(ready.shipments[0]?.queue, "ready_to_ship");
    assert.equal(attention.shipments.length, 0);
    assert.doesNotMatch(json, /internal_courier|internal_order|providerOrder|provider_order|bigship/i);
  });

  it("classifies shipment queues and attention reasons safely", () => {
    const completeDraft = {
      id: "shipment_ready",
      status: ShipmentStatus.rates_fetched,
      paymentMode: ShippingPaymentMode.prepaid,
      pickupLocationId: "pickup_1",
      declaredValuePaise: 129900,
      codAmountPaise: 0,
      deadWeightKg: 1,
      lengthCm: 20,
      breadthCm: 15,
      heightCm: 10,
      metadata: {
        buyer: {
          name: "Buyer",
          phone: "9999999999",
          address: { pincode: "110011", city: "Delhi", state: "Delhi" }
        },
        invoice: { invoice_amount: 1299 }
      }
    };
    const incompleteCod = {
      ...completeDraft,
      id: "shipment_attention",
      status: ShipmentStatus.draft,
      paymentMode: ShippingPaymentMode.cod,
      pickupLocationId: null,
      codAmountPaise: 0,
      declaredValuePaise: null,
      deadWeightKg: null,
      lengthCm: null,
      breadthCm: null,
      heightCm: null,
      metadata: {
        buyer: {
          name: "Buyer",
          phone: "",
          address: { pincode: "", city: "Delhi", state: "Delhi" }
        },
        invoice: {}
      }
    };

    const reasonCodes = calculateAttentionReasons(incompleteCod).map((reason) => reason.code);

    assert.equal(calculateShipmentQueue(completeDraft), "ready_to_ship");
    assert.equal(calculateShipmentQueue({ ...completeDraft, status: ShipmentStatus.manifested }), "in_transit");
    assert.equal(calculateShipmentQueue({ ...completeDraft, status: ShipmentStatus.delivered }), "delivered");
    assert.equal(calculateShipmentQueue({ ...completeDraft, status: ShipmentStatus.delivery_failed }), "rto_failed");
    assert.equal(calculateShipmentQueue(incompleteCod), "needs_attention");
    assert.deepEqual(reasonCodes.sort(), [
      "missing_buyer_phone",
      "missing_buyer_pincode",
      "missing_cod_collectable_amount",
      "missing_invoice_amount",
      "missing_package_dimensions",
      "missing_package_weight",
      "missing_pickup_location",
      "no_rates_fetched"
    ].sort());
  });

  it("selects Economy, Express, and Smart tiers deterministically", () => {
    const tiers = selectShippingTiers([
      {
        id: "slow_cheap",
        amountPaise: 4900,
        currency: "INR",
        estimatedDeliveryDays: 5,
        chargeableWeightKg: 1,
        reliabilityScore: 0.7
      },
      {
        id: "balanced",
        amountPaise: 6200,
        currency: "INR",
        estimatedDeliveryDays: 2,
        chargeableWeightKg: 1,
        reliabilityScore: 0.95
      },
      {
        id: "fast_costly",
        amountPaise: 9800,
        currency: "INR",
        estimatedDeliveryDays: 1,
        chargeableWeightKg: 1,
        reliabilityScore: 0.75
      }
    ], "cod");

    assert.equal(tiers.economy.rateId, "slow_cheap");
    assert.equal(tiers.express.rateId, "fast_costly");
    assert.equal(tiers.smart.rateId, "balanced");
    assert.equal(tiers.smart.recommended, true);
  });

  it("manages Autopilot preferences and recommends explainable seller-safe tiers", async () => {
    const { client } = createFakeClient();
    const defaults = await getAutopilotPreferences("seller_1", client);
    const updated = await upsertAutopilotPreferences("seller_1", {
      isEnabled: true,
      defaultMode: "auto_ship_with_limits",
      preferredTier: "economy",
      maxCodAmount: 200000,
      maxOrderAmount: 300000,
      maxWeightGrams: 2000
    }, client);
    const recommendation = buildAutopilotRecommendation({
      shipment: {
        id: "shipment_safe",
        paymentMode: "cod",
        codAmountPaise: 149900,
        declaredValuePaise: 149900,
        deadWeightKg: 1
      },
      preferences: updated
    });
    const blocked = buildAutopilotRecommendation({
      shipment: {
        id: "shipment_blocked",
        paymentMode: "cod",
        codAmountPaise: 500000,
        declaredValuePaise: 500000,
        deadWeightKg: 4,
        metadata: { protection: { codRiskLevel: "HIGH", weightRiskLevel: "HIGH" } }
      },
      preferences: updated
    });

    assert.equal(defaults.isEnabled, false);
    assert.equal(updated.defaultMode, "auto_ship_with_limits");
    assert.equal(recommendation.recommendedTier, "economy");
    assert.equal(recommendation.canAutoShip, true);
    assert.equal(recommendation.decisionLevel, "safe");
    assert.equal(blocked.decisionLevel, "blocked");
    assert.equal(blocked.canAutoShip, false);
    assert.ok(blocked.reasons.some((reason) => reason.includes("manual review")));
  });

  it("scopes Autopilot recommendations by authenticated merchant", async () => {
    const { client } = createFakeClient();
    const adapter = createFakeAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const shipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);

    const recommendation = await recommendAutopilotForShipment("seller_1", shipment.shipment_id, { client });

    assert.equal(recommendation.shipmentId, shipment.shipment_id);
    await assert.rejects(
      () => recommendAutopilotForShipment("seller_2", shipment.shipment_id, { client }),
      (error) => error instanceof HttpError && error.message === "SHIPMENT_NOT_FOUND"
    );
  });

  it("records SLA events, recalculates reliability, and keeps default fallback behavior", async () => {
    const { client, state } = createFakeClient();

    assert.equal(await getReliabilityScoreForRate({ selectedTier: "smart" }, client), 0.75);
    assert.equal(calculateReliabilityScore({ totalShipments: 0, deliveredCount: 0, rtoCount: 0, failedCount: 0 }), 0.75);

    await recordSlaEvent({
      merchantId: "seller_1",
      shipmentId: "shipment_delivered",
      provider: "bigship",
      courierCode: "courier_smart",
      selectedTier: "smart",
      deliveryPincode: "110011",
      eventType: "delivered"
    }, client);
    await recordSlaEvent({
      merchantId: "seller_1",
      shipmentId: "shipment_rto",
      provider: "bigship",
      courierCode: "courier_smart",
      selectedTier: "smart",
      deliveryPincode: "110011",
      eventType: "rto"
    }, client);
    await recordSlaEvent({
      merchantId: "seller_1",
      shipmentId: "shipment_failed",
      provider: "bigship",
      courierCode: "courier_smart",
      selectedTier: "smart",
      deliveryPincode: "110011",
      eventType: "failed"
    }, client);

    const stats = await recalculateCourierSlaStats({ selectedTier: "smart" }, client);
    const score = await getReliabilityScoreForRate({
      provider: "bigship",
      courierCode: "courier_smart",
      deliveryPincode: "110011",
      selectedTier: "smart"
    }, client);

    assert.equal(state.slaEvents.length, 3);
    assert.equal(stats[0]?.totalShipments, 3);
    assert.equal(stats[0]?.deliveredCount, 1);
    assert.equal(stats[0]?.rtoCount, 1);
    assert.equal(stats[0]?.failedCount, 1);
    assert.ok(score < 0.75);
  });

  it("lets Smart tier use SLA reliability while Economy and Express behavior stay unchanged", () => {
    const tiers = selectShippingTiers([
      {
        id: "cheap_slow",
        amountPaise: 5000,
        currency: "INR",
        estimatedDeliveryDays: 5,
        reliabilityScore: 0.5
      },
      {
        id: "fast_costly",
        amountPaise: 9000,
        currency: "INR",
        estimatedDeliveryDays: 1,
        reliabilityScore: 0.5
      },
      {
        id: "reliable_balanced",
        amountPaise: 6500,
        currency: "INR",
        estimatedDeliveryDays: 3,
        reliabilityScore: 1
      }
    ], "prepaid");

    assert.equal(tiers.economy.rateId, "cheap_slow");
    assert.equal(tiers.express.rateId, "fast_costly");
    assert.equal(tiers.smart.rateId, "reliable_balanced");
  });

  it("bulk fetches rates with partial success and persisted item results", async () => {
    const { client, state } = createFakeClient();
    const adapter = createFakeAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const shipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);

    const result = await bulkFetchRates("seller_1", {
      shipmentIds: [shipment.shipment_id, "shipment_missing"],
      refresh: false
    }, { client, adapter });
    const json = JSON.stringify(result);

    assert.equal(result.status, "completed_with_errors");
    assert.equal(result.successCount, 1);
    assert.equal(result.failedCount, 1);
    assert.equal(state.bulkBatches.length, 1);
    assert.equal(state.bulkItems.length, 2);
    assert.equal(result.items[0]?.status, "success");
    assert.equal(result.items[1]?.status, "failed");
    assert.doesNotMatch(json, /internal_courier|internal_order|providerResponseJson|providerErrorJson|bigship/i);
  });

  it("bulk Ship Now is idempotent and skips Autopilot-blocked shipments", async () => {
    const { client, state } = createFakeClient();
    const adapter = createFakeAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const safeShipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);
    const riskyShipment = await createShipmentDraft("seller_1", {
      ...shipmentBody(pickup.pickup_location_id),
      seller_order_id: "ORD1002"
    }, client);
    state.shipments[1]!.metadata = {
      ...state.shipments[1]!.metadata,
      protection: { codRiskLevel: "HIGH" }
    };
    await upsertAutopilotPreferences("seller_1", {
      isEnabled: true,
      defaultMode: "auto_ship_with_limits",
      preferredTier: "smart",
      requireManualReviewHigh: true
    }, client);

    const first = await bulkShipNow("seller_1", {
      shipmentIds: [safeShipment.shipment_id, riskyShipment.shipment_id],
      tier: "smart",
      useAutopilot: true
    }, { client, adapter });
    const second = await bulkShipNow("seller_1", {
      shipmentIds: [safeShipment.shipment_id],
      tier: "smart",
      useAutopilot: false
    }, { client, adapter });
    const json = JSON.stringify(first);

    assert.equal(first.status, "completed_with_errors");
    assert.equal(first.successCount, 1);
    assert.equal(first.skippedCount, 1);
    assert.equal(second.successCount, 1);
    assert.equal(adapter.calls.manifestOrder, 1);
    assert.equal(state.autopilotDecisions.length, 2);
    assert.equal(state.autopilotDecisions.some((decision) => decision.applied === false && decision.blockedReason === "AUTOPILOT_BLOCKED"), true);
    assert.equal(state.bulkBatches.length, 2);
    assert.equal(state.bulkItems.length, 3);
    assert.equal(state.slaEvents.some((event) => event.eventType === "awb_assigned"), true);
    assert.equal(state.slaEvents.some((event) => event.eventType === "label_generated"), true);
    assert.doesNotMatch(json, /internal_courier|internal_order|providerResponseJson|providerErrorJson|bigship/i);
  });

  it("records NDR cases and seller actions with merchant scoping and safe responses", async () => {
    const { client, state } = createFakeClient();
    const adapter = createFakeAdapter();
    const sellerPickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const otherPickup = await createShippingPickupLocation("seller_2", pickupBody(), { client, adapter });
    const shipment = await createShipmentDraft("seller_1", shipmentBody(sellerPickup.pickup_location_id), client);
    const otherShipment = await createShipmentDraft("seller_2", shipmentBody(otherPickup.pickup_location_id), client);

    const ndr = await createOrUpdateNdrCaseFromShipment("seller_1", shipment.shipment_id, {
      reasonCode: "CUSTOMER_NOT_REACHABLE",
      reasonLabel: "Buyer unreachable",
      buyerIssueType: "unreachable"
    }, client);
    await createOrUpdateNdrCaseFromShipment("seller_2", otherShipment.shipment_id, {
      reasonCode: "ADDRESS_ISSUE"
    }, client);
    const action = await recordNdrAction("seller_1", ndr.case_id, {
      action: "update_phone",
      payload: { buyerPhone: "9999999999", note: "call requested" }
    }, client);
    const detail = await getNdrCase("seller_1", ndr.case_id, client);
    const list = await listNdrCases("seller_1", {}, client);
    const json = JSON.stringify({ ndr, action, detail, list });

    assert.equal(state.ndrCases.length, 2);
    assert.equal(state.ndrActionAttempts.length, 1);
    assert.equal(action.case.status, "action_submitted");
    assert.equal(list.cases.length, 1);
    assert.equal(detail.actions.length, 1);
    assert.doesNotMatch(json, /9999999999|providerActionRef|providerStatus|internalNotes|payloadJson|bigship/i);
    await assert.rejects(
      () => getNdrCase("seller_2", ndr.case_id, client),
      (error) => error instanceof HttpError && error.message === "NDR_CASE_NOT_FOUND"
    );
  });

  it("records RTO cases, calculates loss, and keeps RTO lists merchant-scoped", async () => {
    const { client } = createFakeClient();
    const adapter = createFakeAdapter();
    const sellerPickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const otherPickup = await createShippingPickupLocation("seller_2", pickupBody(), { client, adapter });
    const shipment = await createShipmentDraft("seller_1", shipmentBody(sellerPickup.pickup_location_id), client);
    const otherShipment = await createShipmentDraft("seller_2", shipmentBody(otherPickup.pickup_location_id), client);

    const rto = await createOrUpdateRtoCaseFromShipment("seller_1", shipment.shipment_id, {
      reasonCode: "CUSTOMER_REFUSED",
      reasonLabel: "Buyer refused delivery",
      forwardFreightPaise: 6200,
      rtoFreightPaise: 4200,
      codLostPaise: 149900
    }, client);
    await createOrUpdateRtoCaseFromShipment("seller_2", otherShipment.shipment_id, {
      reasonCode: "OTHER"
    }, client);
    const received = await updateRtoStatus("seller_1", rto.case_id, { status: "received" }, client);
    const list = await listRtoCases("seller_1", {}, client);
    const json = JSON.stringify({ rto, received, list });

    assert.equal(calculateEstimatedRtoLoss({
      forwardFreightPaise: 6200,
      rtoFreightPaise: 4200,
      codLostPaise: 149900
    }), 160300);
    assert.equal(rto.loss.estimated_loss_paise, 160300);
    assert.equal(received.status, "received");
    assert.equal(list.cases.length, 1);
    assert.doesNotMatch(json, /providerStatus|metadataJson|internal_order|bigship/i);
  });

  it("maintains COD ledger entries, summaries, duplicate protection, and prepaid safeguards", async () => {
    const { client, state } = createFakeClient();
    const adapter = createFakeAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const codShipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);
    const prepaidShipment = await createShipmentDraft("seller_1", {
      ...shipmentBody(pickup.pickup_location_id),
      seller_order_id: "ORD_PREPAID",
      payment_mode: "prepaid",
      invoice: { invoice_amount: 999 }
    }, client);

    const expected = await createExpectedCodEntryForCodShipment("seller_1", codShipment.shipment_id, {}, client);
    const duplicateExpected = await createExpectedCodEntryForCodShipment("seller_1", codShipment.shipment_id, {}, client);
    await recordCodCollected("seller_1", codShipment.shipment_id, { amountPaise: 149900 }, client);
    await recordCodRemittanceDue("seller_1", codShipment.shipment_id, { amountPaise: 149900 }, client);
    await recordCodRemitted("seller_1", codShipment.shipment_id, { amountPaise: 100000 }, client);
    state.codLedgerEntries.push({
      id: "cod_other",
      merchantId: "seller_2",
      shipmentId: "shipment_other",
      orderId: null,
      entryType: "expected_collection",
      status: "pending",
      amountPaise: 50000,
      currency: "INR",
      createdAt: now,
      updatedAt: now
    });
    const summary = await getCodLedgerSummary("seller_1", {}, client);
    const list = await listCodLedger("seller_1", {}, client);
    const json = JSON.stringify({ expected, summary, list });

    assert.equal(expected.entry_id, duplicateExpected.entry_id);
    assert.equal(state.codLedgerEntries.filter((entry) => entry.merchantId === "seller_1").length, 4);
    assert.equal(summary.expected_collection_paise, 149900);
    assert.equal(summary.collected_paise, 149900);
    assert.equal(summary.remittance_due_paise, 149900);
    assert.equal(summary.remitted_paise, 100000);
    assert.equal(summary.pending_paise, 49900);
    assert.equal(list.entries.length, 4);
    assert.doesNotMatch(json, /providerResponseJson|providerErrorJson|courierOverride|Buyer line|8888888888|bigship/i);
    await assert.rejects(
      () => createExpectedCodEntryForCodShipment("seller_1", prepaidShipment.shipment_id, {}, client),
      (error) => error instanceof HttpError && error.message === "COD_LEDGER_PREPAID_SHIPMENT"
    );
    await assert.rejects(
      () => recordCodCollected("seller_1", codShipment.shipment_id, { amountPaise: -1 }, client),
      (error) => error instanceof HttpError && error.message === "COD_LEDGER_AMOUNT_INVALID"
    );
  });

  it("detects weight discrepancies and supports evidence/submission/close workflow safely", async () => {
    const { client, state } = createFakeClient();
    const adapter = createFakeAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    const shipment = await createShipmentDraft("seller_1", shipmentBody(pickup.pickup_location_id), client);

    const none = await detectWeightDiscrepancy("seller_1", shipment.shipment_id, {
      billedWeightGrams: 700
    }, client);
    const detected = await detectWeightDiscrepancy("seller_1", shipment.shipment_id, {
      billedWeightGrams: 1200,
      expectedChargePaise: 6200,
      billedChargePaise: 8200
    }, client);
    const caseId = detected.case!.case_id;
    const evidence = await updateWeightDisputeEvidence("seller_1", caseId, {
      packagePhotos: ["s3://evidence/package-1.jpg"],
      sellerNote: "Package measured before pickup."
    }, client);
    const submitted = await markWeightDisputeSubmitted("seller_1", caseId, {
      providerRef: "internal_provider_dispute_1",
      note: "Submitted manually in provider portal."
    }, client);
    const closed = await closeWeightDispute("seller_1", caseId, {
      note: "Credit received."
    }, client);
    state.weightDiscrepancyCases.push({
      id: "weight_other",
      merchantId: "seller_2",
      shipmentId: "shipment_other",
      orderId: null,
      status: "detected",
      differenceGrams: 500,
      createdAt: now,
      updatedAt: now,
      detectedAt: now
    });
    const list = await listWeightDiscrepancyCases("seller_1", {}, client);
    const json = JSON.stringify({ detected, evidence, submitted, closed, list });

    assert.equal(none.created, false);
    assert.equal(detected.created, true);
    assert.equal(detected.difference_grams, 400);
    assert.equal(evidence.status, "dispute_ready");
    assert.equal(submitted.status, "submitted");
    assert.equal(closed.status, "closed");
    assert.equal(list.cases.length, 1);
    assert.doesNotMatch(json, /internal_provider_dispute_1|providerRef|providerStatus|internalNotes|Buyer line|8888888888|bigship/i);
  });

  it("creates a shipment draft from an existing seller order without provider calls", async () => {
    const { client, state } = createFakeClient();
    const adapter = createFakeAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    state.orders.push(orderBody());
    adapter.calls.createPickupLocation = 0;

    const result = await createShipmentFromOrder("seller_1", "order_1", {
      pickup_location_id: pickup.pickup_location_id
    }, client);
    const publicRow = serializeShipmentListItem(state.shipments[0]);

    assert.equal(result.existed, false);
    assert.equal(result.shipment.order_id, "order_1");
    assert.equal(result.shipment.seller_order_id, "ORD1001");
    assert.equal(result.shipment.payment_mode, "cod");
    assert.equal(result.shipment.pickup_location_id, pickup.pickup_location_id);
    assert.equal(state.shipments.length, 1);
    assert.equal(state.providerRefs.length, 0);
    assert.equal(state.rates.length, 0);
    assert.equal(adapter.calls.createPickupLocation, 0);
    assert.equal(publicRow.buyer.name, "Rahul Sharma");
    assert.equal(publicRow.buyer.pincode, "110011");
  });

  it("returns an existing order shipment instead of duplicating it", async () => {
    const { client, state } = createFakeClient();
    const adapter = createFakeAdapter();
    const pickup = await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    state.orders.push(orderBody());

    const first = await createShipmentFromOrder("seller_1", "ORD1001", {
      pickup_location_id: pickup.pickup_location_id
    }, client);
    const second = await createShipmentFromOrder("seller_1", "ORD1001", {
      pickup_location_id: pickup.pickup_location_id
    }, client);

    assert.equal(first.existed, false);
    assert.equal(second.existed, true);
    assert.equal(second.shipment.shipment_id, first.shipment.shipment_id);
    assert.equal(state.shipments.length, 1);
  });

  it("requires a pickup location when order bridge pickup selection is ambiguous", async () => {
    const { client, state } = createFakeClient();
    const adapter = createFakeAdapter();
    await createShippingPickupLocation("seller_1", pickupBody(), { client, adapter });
    await createShippingPickupLocation("seller_1", { ...pickupBody(), name: "Second warehouse" }, { client, adapter });
    state.orders.push(orderBody());

    await assert.rejects(
      () => createShipmentFromOrder("seller_1", "ORD1001", {}, client),
      (error) => error instanceof HttpError && error.message === "PICKUP_LOCATION_REQUIRED"
    );
    assert.equal(state.shipments.length, 0);
  });

  it("preserves the existing manual /shipments route and mounts /shipping additively", () => {
    const routes = readFileSync("src/routes/index.ts", "utf8");
    const shippingRoutes = readFileSync("src/modules/shippingNetwork/shipping-network.routes.ts", "utf8");
    const legacyShipments = readFileSync("src/modules/shipments/shipments.routes.ts", "utf8");

    assert.match(routes, /apiRouter\.use\("\/shipping", requireJwtAuth, shippingNetworkRouter\);/);
    assert.match(routes, /apiRouter\.use\("\/shipments", requireJwtAuth, shipmentsRouter\);/);
    assert.match(shippingRoutes, /shippingNetworkRouter\.get\("\/shipments"/);
    assert.match(shippingRoutes, /shippingNetworkRouter\.post\("\/orders\/:orderId\/create-shipment"/);
    assert.match(shippingRoutes, /shippingNetworkRouter\.post\("\/shipments\/:shipmentId\/ship-now"/);
    assert.match(shippingRoutes, /shippingNetworkRouter\.get\("\/autopilot\/preferences"/);
    assert.match(shippingRoutes, /shippingNetworkRouter\.post\("\/bulk\/rates"/);
    assert.match(shippingRoutes, /shippingNetworkRouter\.post\("\/bulk\/ship-now"/);
    assert.match(shippingRoutes, /shippingNetworkRouter\.get\("\/sla\/stats"/);
    assert.match(shippingRoutes, /shippingNetworkRouter\.get\("\/ndr"/);
    assert.match(shippingRoutes, /shippingNetworkRouter\.post\("\/shipments\/:shipmentId\/ndr"/);
    assert.match(shippingRoutes, /shippingNetworkRouter\.get\("\/rto"/);
    assert.match(shippingRoutes, /shippingNetworkRouter\.post\("\/shipments\/:shipmentId\/rto"/);
    assert.match(shippingRoutes, /shippingNetworkRouter\.get\("\/cod-ledger\/summary"/);
    assert.match(shippingRoutes, /shippingNetworkRouter\.post\("\/shipments\/:shipmentId\/cod\/expected"/);
    assert.match(shippingRoutes, /shippingNetworkRouter\.get\("\/weight-disputes"/);
    assert.match(shippingRoutes, /shippingNetworkRouter\.post\("\/shipments\/:shipmentId\/weight-discrepancy"/);
    assert.match(legacyShipments, /shipmentsRouter\.get\("\/",/);
    assert.match(legacyShipments, /shipmentsRouter\.post\("\/",/);
  });
});
