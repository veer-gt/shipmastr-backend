import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  decideActionsAfterOtpSuccess,
  decideAutonomousActions,
  decideNdrAutonomousActions,
  filterAutoExecutableActionPlans,
  sellerSafeAutomationSummary
} from "./autonomous-action.service.js";
import { scoreAddressConfidence } from "./address-intelligence.service.js";
import { calculateCodDecisionForSignals } from "./cod-decision.service.js";
import {
  buildOrderIntelligenceDataSnapshot,
  calculateConsigneeScore,
  categorizeConsignee,
  getDecisionForConsigneeTier,
  hashPhone,
  normalizePhone
} from "./consignee-intelligence.service.js";
import { eventTypeFromCarrier, rankCourierOptions } from "./courier-performance.service.js";
import { calculateMerchantTrustTier } from "./merchant-trust.service.js";
import { calculateMerchantMetricSnapshot } from "./metrics.service.js";
import { buildEnrichedSnapshot, buildOrderDataSignalsInput, shipmentPatchFromWebhook } from "./order-intelligence.service.js";
import { actualOutcomeFromCarrier, evaluatePredictionFlags } from "./prediction-outcome.service.js";
import { buildCommunicationQueueWhere, recordBuyerCommunication, updateBuyerCommunicationStatus } from "./buyer-communication.service.js";
import { buildSellerSafeOrderDecision, buildSellerSafeOrderDecisionFromRecords } from "./seller-safe-decision.service.js";

function orderFixture(overrides: Record<string, unknown>) {
  return {
    source: "manual",
    importBatchId: null,
    buyerEmail: null,
    buyerAltPhone: null,
    landmark: null,
    country: "IN",
    declaredValue: Number(overrides.orderValue ?? 0),
    packageLengthMm: null,
    packageWidthMm: null,
    packageHeightMm: null,
    volumetricWeightGrams: null,
    productDescription: null,
    hsnCode: null,
    itemCount: 1,
    tags: null,
    codRiskScore: null,
    codRiskLevel: null,
    rtoRiskScore: null,
    rtoRiskLevel: null,
    courierOverride: null,
    addressQualityScore: null,
    addressQualityFlags: null,
    needsAttentionReasons: null,
    sellerNotes: null,
    pickupLocationId: null,
    ...overrides
  } as any;
}

function makeCommunicationClient(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-05-05T00:00:00.000Z");
  const state = {
    events: [] as any[],
    actions: [
      { id: "action_otp", orderId: "order_cb", merchantId: "merchant_1", actionType: "SEND_COD_OTP", status: "EXECUTED", reason: "OTP", inputSnapshot: null },
      { id: "action_address", orderId: "order_cb", merchantId: "merchant_1", actionType: "SEND_ADDRESS_CORRECTION_LINK", status: "EXECUTED", reason: "Address", inputSnapshot: null },
      { id: "action_prepaid", orderId: "order_cb", merchantId: "merchant_1", actionType: "SEND_PREPAID_LINK", status: "EXECUTED", reason: "Prepaid", inputSnapshot: null },
      { id: "action_ndr", orderId: "order_cb", merchantId: "merchant_1", actionType: "SEND_NDR_RECOVERY_MESSAGE", status: "EXECUTED", reason: "NDR", inputSnapshot: null }
    ] as any[],
    outcomes: [
      { id: "outcome_otp", orderId: "order_cb", merchantId: "merchant_1", actionType: "SEND_COD_OTP", expectedOutcome: "OTP_VERIFIED", actualOutcome: null, worked: null },
      { id: "outcome_address", orderId: "order_cb", merchantId: "merchant_1", actionType: "SEND_ADDRESS_CORRECTION_LINK", expectedOutcome: "ADDRESS_CONFIRMED", actualOutcome: null, worked: null },
      { id: "outcome_prepaid", orderId: "order_cb", merchantId: "merchant_1", actionType: "SEND_PREPAID_LINK", expectedOutcome: "PREPAID_CONVERTED", actualOutcome: null, worked: null },
      { id: "outcome_ndr", orderId: "order_cb", merchantId: "merchant_1", actionType: "SEND_NDR_RECOVERY_MESSAGE", expectedOutcome: "BUYER_CONFIRMED_REATTEMPT", actualOutcome: null, worked: null }
    ] as any[],
    order: {
      id: "order_cb",
      merchantId: "merchant_1",
      externalOrderId: "SM-CB",
      buyerName: "Buyer",
      buyerPhone: "9721193456",
      addressLine1: "Short",
      addressLine2: null,
      city: "Bengaluru",
      state: "Karnataka",
      pincode: "560001",
      orderValue: 1200,
      codAmount: 1200,
      paymentMode: "COD",
      weightGrams: 500,
      status: "RISK_SCORED",
      createdAt: now,
      updatedAt: now
    } as any,
    signals: { orderId: "order_cb", otpVerified: false, whatsappConfirmed: false } as any,
    intelligence: {
      orderId: "order_cb",
      consigneeTier: "BRONZE",
      shipmentDecision: "VERIFY_BEFORE_SHIP",
      overallRiskScore: 45,
      addressConfidenceScore: 52
    } as any,
    policy: {
      merchantId: "merchant_1",
      autoCodControlEnabled: true,
      autoOtpForBronzeEnabled: true,
      autoPrepaidOnlyForIronEnabled: true,
      autoAddressCorrectionEnabled: true,
      autoCourierSelectionEnabled: true,
      autoNdrRecoveryEnabled: true,
      autoRtoHoldEnabled: false,
      autoCancelAfterFailedVerificationEnabled: false,
      maxAutoHoldOrderValue: null,
      maxAutoCourierCostIncrease: null,
      maxAutoCodAmount: null,
      allowPrepaidConversionMessage: true,
      allowBuyerWhatsappMessages: true,
      allowBuyerSmsMessages: true,
      ...overrides.policy as object
    } as any,
    shipment: { shipmentStatus: "HELD", ndrStatus: "OPEN", addressHash: "old_address_hash" } as any
  };

  function matchesStatus(value: string, rule: any) {
    if (!rule) return true;
    if (typeof rule === "string") return value === rule;
    if (Array.isArray(rule.in)) return rule.in.includes(value);
    if (Array.isArray(rule.notIn)) return !rule.notIn.includes(value);
    return true;
  }

  function applyPatch(target: any, data: Record<string, any>) {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && "decrement" in value) {
        target[key] = Math.max(0, (target[key] ?? 0) - Number(value.decrement));
      } else {
        target[key] = value;
      }
    }
    return target;
  }

  const client: any = {
    buyerCommunicationEvent: {
      create: async ({ data }: any) => {
        const event = { id: `event_${state.events.length + 1}`, createdAt: now, updatedAt: now, ...data };
        state.events.push(event);
        return event;
      },
      findMany: async ({ where }: any = {}) => state.events.filter((event) => !where?.status || matchesStatus(event.status, where.status)),
      update: async ({ where, data }: any) => applyPatch(state.events.find((event) => event.id === where.id), data),
      findUniqueOrThrow: async ({ where }: any) => state.events.find((event) => event.id === where.id)
    },
    autonomousAction: {
      findFirst: async ({ where }: any) => state.actions.find((action) => (!where.orderId || action.orderId === where.orderId)
        && (!where.actionType || (typeof where.actionType === "string" ? action.actionType === where.actionType : where.actionType.in.includes(action.actionType)))
        && matchesStatus(action.status, where.status)),
      create: async ({ data }: any) => {
        const action = { id: `action_${state.actions.length + 1}`, status: data.status ?? "PENDING", ...data };
        state.actions.push(action);
        return action;
      },
      update: async ({ where, data }: any) => applyPatch(state.actions.find((action) => action.id === where.id), data)
    },
    actionOutcome: {
      findFirst: async ({ where }: any) => state.outcomes.find((outcome) => outcome.orderId === where.orderId && outcome.actionType === where.actionType),
      create: async ({ data }: any) => {
        const outcome = { id: `outcome_${state.outcomes.length + 1}`, ...data };
        state.outcomes.push(outcome);
        return outcome;
      },
      update: async ({ where, data }: any) => applyPatch(state.outcomes.find((outcome) => outcome.id === where.id), data)
    },
    order: {
      findUnique: async () => state.order,
      findUniqueOrThrow: async () => state.order,
      update: async ({ data }: any) => applyPatch(state.order, data)
    },
    orderDataSignals: {
      findUnique: async () => state.signals,
      updateMany: async ({ data }: any) => applyPatch(state.signals, data)
    },
    orderIntelligence: {
      findUnique: async () => state.intelligence,
      updateMany: async ({ data }: any) => applyPatch(state.intelligence, data)
    },
    merchantAutomationPolicy: {
      upsert: async () => state.policy
    },
    shipmentDetails: {
      updateMany: async ({ data }: any) => applyPatch(state.shipment, data)
    }
  };

  return { client, state };
}

function makeDecisionInput(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-05-05T00:00:00.000Z");
  const order = {
    id: "order_decision",
    merchantId: "merchant_1",
    paymentMode: "COD",
    status: "RISK_SCORED"
  };
  const shipmentDetails = {
    shipmentStatus: "HELD",
    awb: null,
    trackingNumber: null,
    courierId: null
  };
  const orderIntelligence = {
    consigneeTier: "BRONZE",
    codDecision: "REQUIRE_OTP",
    shipmentDecision: "VERIFY_BEFORE_SHIP",
    courierId: null,
    courierReasons: [],
    buyerPhoneHash: "internal_phone_hash",
    addressHash: "internal_address_hash",
    overallRiskScore: 64,
    dataSnapshot: { modelVersion: "rules-v1", fraud: { reason: "internal" } }
  };

  return {
    order: { ...order, ...(overrides.order as object) } as any,
    shipmentDetails: { ...shipmentDetails, ...(overrides.shipmentDetails as object) } as any,
    orderIntelligence: { ...orderIntelligence, ...(overrides.orderIntelligence as object) } as any,
    autonomousActions: (overrides.autonomousActions as any[] | undefined) ?? [
      {
        id: "action_otp",
        actionType: "SEND_COD_OTP",
        automationLevel: "AUTO_EXECUTE_NOTIFY",
        status: "EXECUTED",
        requiresApproval: false,
        createdAt: now,
        executedAt: now,
        approvedAt: null,
        failedAt: null,
        inputSnapshot: { phoneHash: "internal_phone_hash" }
      }
    ],
    buyerCommunicationEvents: (overrides.buyerCommunicationEvents as any[] | undefined) ?? [
      {
        id: "event_otp",
        channel: "WHATSAPP",
        template: "send_cod_otp",
        status: "QUEUED",
        response: null,
        sentAt: null,
        deliveredAt: null,
        readAt: null,
        respondedAt: null,
        createdAt: now,
        phoneHash: "internal_phone_hash",
        providerMessageId: "provider_internal"
      }
    ],
    actionOutcomes: (overrides.actionOutcomes as any[] | undefined) ?? [
      {
        actionType: "SEND_COD_OTP",
        expectedOutcome: "OTP_VERIFIED",
        actualOutcome: null,
        worked: null,
        createdAt: now
      }
    ],
    courierRecommendation: (overrides.courierRecommendation as any | undefined) ?? null
  };
}

describe("logistics intelligence rules", () => {
  it("calculates merchant RTO rate from order history", () => {
    const orders = [
      { paymentMode: "COD", status: "DELIVERED", codAmount: 1200, orderValue: 1200 },
      { paymentMode: "COD", status: "RTO", codAmount: 900, orderValue: 900 },
      { paymentMode: "PREPAID", status: "NDR", codAmount: 0, orderValue: 500 },
      { paymentMode: "PREPAID", status: "DELIVERED", codAmount: 0, orderValue: 700 }
    ] as const;

    const metrics = calculateMerchantMetricSnapshot([...orders], 0);

    assert.equal(metrics.total, 4);
    assert.equal(metrics.rto, 1);
    assert.equal(metrics.rtoRate, 0.25);
    assert.equal(metrics.codExposure, 2100);
  });

  it("scores address confidence lower for weak address data", () => {
    const strong = scoreAddressConfidence({
      addressLine1: "221 Market Street, Block A, Floor 2",
      addressLine2: "Near Metro Station",
      city: "Bengaluru",
      state: "Karnataka",
      pincode: "560001"
    });
    const weak = scoreAddressConfidence({
      addressLine1: "A",
      addressLine2: null,
      city: "X",
      state: "Y",
      pincode: "123"
    });

    assert.ok(["LOW", "MEDIUM"].includes(strong.riskLevel));
    assert.equal(weak.riskLevel, "HIGH");
    assert.ok(strong.score > weak.score);
  });

  it("returns LOW/MEDIUM/HIGH/CRITICAL COD decisions from explainable signals", () => {
    const low = calculateCodDecisionForSignals({
      isCod: false,
      codAmount: 0,
      addressConfidence: 90
    });
    const medium = calculateCodDecisionForSignals({
      isCod: true,
      codAmount: 1600,
      addressConfidence: 55
    });
    const high = calculateCodDecisionForSignals({
      isCod: true,
      codAmount: 3500,
      addressConfidence: 55
    });
    const critical = calculateCodDecisionForSignals({
      isCod: true,
      codAmount: 5000,
      addressConfidence: 40,
      buyerRtoOrders: 3,
      buyerNdrOrders: 3,
      pincodeRtoRate: 0.25
    });

    assert.equal(low.riskLevel, "LOW");
    assert.equal(low.riskDecision, "ALLOW");
    assert.equal(medium.riskLevel, "MEDIUM");
    assert.equal(medium.decision, "REQUIRE_OTP");
    assert.equal(high.riskLevel, "HIGH");
    assert.equal(high.decision, "PREPAID_ONLY");
    assert.equal(critical.riskLevel, "CRITICAL");
    assert.equal(critical.riskDecision, "BLOCK");
  });

  it("ranks courier recommendation options by performance, cost, and priority", () => {
    const ranked = rankCourierOptions([
      { courierId: "slow", priority: 200, performanceScore: 55, deliveryRate: 0.7, rtoRate: 0.18, estimatedCost: 60 },
      { courierId: "fast", priority: 20, performanceScore: 80, deliveryRate: 0.92, rtoRate: 0.04, estimatedCost: 85 }
    ]);

    const [best, second] = ranked;
    assert.ok(best);
    assert.ok(second);
    assert.equal(best.courierId, "fast");
    assert.ok(best.score > second.score);
  });

  it("updates merchant trust tier from reliability signals", () => {
    const trusted = calculateMerchantTrustTier({
      trustScore: 78,
      totalOrders: 40,
      rtoRate: 0.04,
      ndrRate: 0.08,
      fraudSignalCount: 0
    });
    const risky = calculateMerchantTrustTier({
      trustScore: 48,
      totalOrders: 20,
      rtoRate: 0.42,
      ndrRate: 0.36,
      fraudSignalCount: 3
    });

    assert.equal(trusted.tier, "TRUSTED");
    assert.equal(risky.tier, "SUSPENDED");
  });

  it("classifies webhook NDR/RTO events for intelligence updates", () => {
    assert.equal(eventTypeFromCarrier("shipment.ndr"), "NDR");
    assert.equal(eventTypeFromCarrier("shipment.rto"), "RTO");
    assert.equal(eventTypeFromCarrier("shipment.delivered"), "DELIVERED");
  });

  it("maps consignee tier boundaries to seller decisions", () => {
    assert.equal(categorizeConsignee(100).tier, "GOLD");
    assert.equal(categorizeConsignee(80).tier, "GOLD");
    assert.equal(categorizeConsignee(79).tier, "SILVER");
    assert.equal(categorizeConsignee(60).tier, "SILVER");
    assert.equal(categorizeConsignee(59).tier, "BRONZE");
    assert.equal(categorizeConsignee(40).tier, "BRONZE");
    assert.equal(categorizeConsignee(39).tier, "IRON");

    assert.deepEqual(getDecisionForConsigneeTier("GOLD", 92), {
      codDecision: "ALLOW_COD",
      shipmentDecision: "SHIP"
    });
    assert.deepEqual(getDecisionForConsigneeTier("SILVER", 72), {
      codDecision: "ALLOW_COD",
      shipmentDecision: "SHIP"
    });
    assert.deepEqual(getDecisionForConsigneeTier("BRONZE", 52), {
      codDecision: "REQUIRE_OTP",
      shipmentDecision: "VERIFY_BEFORE_SHIP"
    });
    assert.deepEqual(getDecisionForConsigneeTier("IRON", 30), {
      codDecision: "PREPAID_ONLY",
      shipmentDecision: "HOLD"
    });
    assert.deepEqual(getDecisionForConsigneeTier("IRON", 20), {
      codDecision: "MANUAL_REVIEW",
      shipmentDecision: "DO_NOT_SHIP"
    });
  });

  it("hashes consignee phones without storing raw mobile values", () => {
    const normalized = normalizePhone("+91 97211 93456");
    const hashed = hashPhone("+91 97211 93456");

    assert.equal(normalized, "9721193456");
    assert.match(hashed, /^[a-f0-9]{64}$/);
    assert.ok(!hashed.includes("9721193456"));
  });

  it("keeps raw phone out of order intelligence snapshots", () => {
    const rawPhone = "9721193456";
    const phoneHash = hashPhone(rawPhone);
    const decision = {
      ...calculateConsigneeScore({
        totalOrders: 4,
        deliveredOrders: 4,
        codOrders: 2,
        successfulCodOrders: 2,
        prepaidOrders: 2,
        addressConfidenceScore: 90,
        pincodeDeliveryRate: 0.92,
        pincodeRtoRate: 0.02,
        courierPincodeScore: 84
      }),
      codDecision: "ALLOW_COD" as const,
      shipmentDecision: "SHIP" as const,
      addressConfidenceScore: 90,
      pincodeRiskScore: 2,
      codRiskScore: 10,
      rtoRiskScore: 8,
      fraudRiskScore: 5,
      overallRiskScore: 12,
      courierScore: 84,
      courierReasons: [] as string[]
    };
    const snapshot = buildOrderIntelligenceDataSnapshot({
      order: {
        id: "order_1",
        merchantId: "merchant_1",
        buyerPhone: rawPhone,
        addressLine1: "221 Market Street",
        addressLine2: null,
        city: "Bengaluru",
        state: "Karnataka",
        pincode: "560001",
        orderValue: 1200,
        codAmount: 1200,
        paymentMode: "COD",
        weightGrams: 500,
        status: "CREATED",
        createdAt: new Date("2026-05-03T00:00:00.000Z")
      },
      phoneHash,
      addressHash: "address_hash",
      decision
    });

    const serialized = JSON.stringify(snapshot);
    assert.ok(serialized.includes(phoneHash));
    assert.ok(!serialized.includes(rawPhone));
  });

  it("lets address, pincode, courier, COD and RTO risk move consignee score", () => {
    const strong = calculateConsigneeScore({
      totalOrders: 6,
      deliveredOrders: 6,
      codOrders: 3,
      successfulCodOrders: 3,
      prepaidOrders: 3,
      avgOrderValue: 1600,
      currentOrderValue: 1400,
      currentCodAmount: 900,
      paymentMode: "COD",
      addressConfidenceScore: 92,
      pincodeDeliveryRate: 0.94,
      pincodeRtoRate: 0.03,
      courierPincodeScore: 88
    });
    const weak = calculateConsigneeScore({
      totalOrders: 5,
      deliveredOrders: 1,
      rtoOrders: 3,
      ndrOrders: 1,
      codOrders: 5,
      successfulCodOrders: 1,
      failedCodOrders: 4,
      repeatCodFailures: 3,
      avgOrderValue: 700,
      currentOrderValue: 4200,
      currentCodAmount: 4200,
      paymentMode: "COD",
      addressConfidenceScore: 42,
      addressCount: 4,
      highRiskAddressCount: 2,
      pincodeDeliveryRate: 0.44,
      pincodeRtoRate: 0.32,
      courierPincodeScore: 38
    });

    assert.ok(strong.score > weak.score);
    assert.ok(["GOLD", "SILVER"].includes(strong.tier));
    assert.ok(["BRONZE", "IRON"].includes(weak.tier));
    assert.ok(weak.reasons.includes("PREVIOUS_RTO"));
    assert.ok(weak.reasons.includes("LOW_ADDRESS_CONFIDENCE"));
    assert.ok(weak.reasons.includes("LOW_COURIER_PINCODE_SUCCESS"));
  });

  it("builds enriched order data signals for SKU, campaign, profitability, and time", () => {
    const order = orderFixture({
      id: "order_1",
      merchantId: "merchant_1",
      externalOrderId: "SM-1",
      buyerName: "Buyer",
      buyerPhone: "9721193456",
      addressLine1: "221 Market Street",
      addressLine2: null,
      city: "Bengaluru",
      state: "Karnataka",
      pincode: "560001",
      orderValue: 1800,
      codAmount: 1800,
      paymentMode: "COD",
      weightGrams: 750,
      status: "CREATED",
      createdAt: new Date("2026-05-03T23:30:00.000Z"),
      updatedAt: new Date("2026-05-03T23:30:00.000Z")
    });

    const signals = buildOrderDataSignalsInput(order, {
      skuId: "SKU-123",
      productCategory: "apparel",
      productTitle: "  Premium Cotton T-Shirt !! ",
      salesChannel: "shopify",
      campaignId: "camp_1",
      couponCode: "SAVE10",
      discountAmount: 180,
      shippingChargeToSeller: 75,
      courierCostToShipmastr: 52,
      netMargin: 23
    });

    assert.equal(signals.skuId, "SKU-123");
    assert.equal(signals.campaignId, "camp_1");
    assert.equal(signals.productTitleNormalized, "premium cotton t-shirt");
    assert.equal(signals.isLateNightOrder, true);
    assert.equal(signals.isWeekendOrder, true);
    assert.equal(signals.shippingChargeToSeller, 75);
    assert.equal(signals.netMargin, 23);
  });

  it("keeps raw phone out of enriched order intelligence snapshot", () => {
    const rawPhone = "9721193456";
    const pHash = hashPhone(rawPhone);
    const snapshot = buildEnrichedSnapshot({
      order: orderFixture({
        id: "order_2",
        merchantId: "merchant_1",
        externalOrderId: "SM-2",
        buyerName: "Buyer",
        buyerPhone: rawPhone,
        addressLine1: "221 Market Street",
        addressLine2: null,
        city: "Bengaluru",
        state: "Karnataka",
        pincode: "560001",
        orderValue: 2200,
        codAmount: 2200,
        paymentMode: "COD",
        weightGrams: 500,
        status: "CREATED",
        createdAt: new Date("2026-05-03T10:00:00.000Z"),
        updatedAt: new Date("2026-05-03T10:00:00.000Z")
      }),
      buyerPhoneHash: pHash,
      addressHash: "address_hash",
      consigneeScore: 65,
      consigneeTier: "SILVER",
      consigneeLabel: "Silver Buyer — Normal confidence",
      consigneeReasons: ["GOOD_PREPAID_HISTORY"],
      merchantTrustScore: 70,
      merchantTrustTier: "TRUSTED",
      merchantReasons: [],
      courierId: null,
      courierScore: null,
      courierReasons: [],
      addressConfidenceScore: 88,
      pincodeRiskScore: 12,
      codRiskScore: 20,
      rtoRiskScore: 18,
      fraudRiskScore: 10,
      overallRiskScore: 35,
      codDecision: "ALLOW_COD",
      shipmentDecision: "SHIP",
      riskReasons: ["GOOD_PREPAID_HISTORY"],
      signals: { skuId: "SKU-9", campaignId: "CAMP-9", netMargin: 50 }
    });

    const serialized = JSON.stringify(snapshot);
    assert.ok(serialized.includes(pHash));
    assert.ok(serialized.includes("SKU-9"));
    assert.ok(serialized.includes("CAMP-9"));
    assert.ok(!serialized.includes(rawPhone));
  });

  it("maps carrier webhook outcomes and shipment lifecycle patches", () => {
    const order = orderFixture({
      id: "order_3",
      merchantId: "merchant_1",
      externalOrderId: "SM-3",
      buyerName: "Buyer",
      buyerPhone: "9721193456",
      addressLine1: "221 Market Street",
      addressLine2: null,
      city: "Bengaluru",
      state: "Karnataka",
      pincode: "560001",
      orderValue: 1400,
      codAmount: 0,
      paymentMode: "PREPAID",
      weightGrams: 500,
      status: "SHIPPED",
      createdAt: new Date("2026-05-03T10:00:00.000Z"),
      updatedAt: new Date("2026-05-03T10:00:00.000Z")
    });
    const patch = shipmentPatchFromWebhook({
      order,
      status: "NDR",
      now: new Date("2026-05-04T10:00:00.000Z"),
      payload: {
        awbNumber: "AWB123",
        courierId: "courier_1"
      }
    });

    assert.equal(actualOutcomeFromCarrier("shipment.delivered"), "DELIVERED");
    assert.equal(actualOutcomeFromCarrier("shipment.ndr"), "NDR");
    assert.equal(actualOutcomeFromCarrier("shipment.rto"), "RTO");
    assert.equal(patch.shipmentStatus, "NDR");
    assert.equal(patch.ndrStatus, "OPEN");
    assert.equal(patch.awb, "AWB123");
  });

  it("marks prediction outcomes correct, false positive, and false negative", () => {
    const correctRisk = evaluatePredictionFlags({
      predictedConsigneeTier: "BRONZE",
      predictedCodDecision: "REQUIRE_OTP",
      predictedShipmentDecision: "VERIFY_BEFORE_SHIP",
      predictedRtoRiskScore: 60,
      actualOutcome: "RTO"
    });
    const falsePositive = evaluatePredictionFlags({
      predictedConsigneeTier: "IRON",
      predictedCodDecision: "PREPAID_ONLY",
      predictedShipmentDecision: "HOLD",
      predictedRtoRiskScore: 80,
      actualOutcome: "DELIVERED"
    });
    const falseNegative = evaluatePredictionFlags({
      predictedConsigneeTier: "SILVER",
      predictedCodDecision: "ALLOW_COD",
      predictedShipmentDecision: "SHIP",
      predictedRtoRiskScore: 20,
      actualOutcome: "NDR"
    });

    assert.equal(correctRisk.predictionCorrect, true);
    assert.equal(falsePositive.falsePositive, true);
    assert.equal(falseNegative.falseNegative, true);
    assert.ok(falseNegative.reasonMismatch.includes("PREDICTED_SAFE_BUT_BAD_OUTCOME"));
  });

  it("creates Bronze OTP automation and releases after OTP success", () => {
    const plans = decideAutonomousActions(
      { id: "order_otp", merchantId: "merchant_1", orderValue: 1200, codAmount: 1200, paymentMode: "COD" },
      {
        orderId: "order_otp",
        merchantId: "merchant_1",
        buyerPhoneHash: "phone_hash",
        addressHash: "address_hash",
        consigneeTier: "BRONZE",
        codDecision: "REQUIRE_OTP",
        shipmentDecision: "VERIFY_BEFORE_SHIP",
        addressConfidenceScore: 82,
        overallRiskScore: 48,
        rtoRiskScore: 42,
        courierId: null,
        courierScore: null,
        riskReasons: ["BRONZE_BUYER"]
      },
      {
        autoCodControlEnabled: true,
        autoOtpForBronzeEnabled: true,
        autoPrepaidOnlyForIronEnabled: false,
        autoAddressCorrectionEnabled: true,
        autoCourierSelectionEnabled: true,
        autoNdrRecoveryEnabled: true,
        autoRtoHoldEnabled: false,
        autoCancelAfterFailedVerificationEnabled: false,
        maxAutoHoldOrderValue: null,
        maxAutoCourierCostIncrease: null,
        maxAutoCodAmount: null,
        allowPrepaidConversionMessage: true,
        allowBuyerWhatsappMessages: true,
        allowBuyerSmsMessages: true
      } as never
    );

    assert.ok(plans.some((plan) => plan.actionType === "SEND_COD_OTP" && plan.automationLevel === "AUTO_EXECUTE_NOTIFY"));
    assert.ok(plans.some((plan) => plan.actionType === "HOLD_SHIPMENT"));
    assert.equal(decideActionsAfterOtpSuccess()[0]?.actionType, "RELEASE_SHIPMENT");
  });

  it("only hides COD and sends prepaid link for Iron buyers when policy allows it", () => {
    const baseOrder = { id: "order_iron", merchantId: "merchant_1", orderValue: 2200, codAmount: 2200, paymentMode: "COD" } as const;
    const intel = {
      orderId: "order_iron",
      merchantId: "merchant_1",
      buyerPhoneHash: "phone_hash",
      addressHash: "address_hash",
      consigneeTier: "IRON",
      codDecision: "PREPAID_ONLY",
      shipmentDecision: "HOLD",
      addressConfidenceScore: 72,
      overallRiskScore: 72,
      rtoRiskScore: 70,
      courierId: null,
      courierScore: null,
      riskReasons: ["IRON_BUYER"]
    } as const;
    const disabled = decideAutonomousActions(baseOrder, intel, {
      autoCodControlEnabled: true,
      autoOtpForBronzeEnabled: true,
      autoPrepaidOnlyForIronEnabled: false,
      autoAddressCorrectionEnabled: true,
      autoCourierSelectionEnabled: true,
      autoNdrRecoveryEnabled: true,
      autoRtoHoldEnabled: false,
      autoCancelAfterFailedVerificationEnabled: false,
      maxAutoHoldOrderValue: null,
      maxAutoCourierCostIncrease: null,
      maxAutoCodAmount: null,
      allowPrepaidConversionMessage: true,
      allowBuyerWhatsappMessages: true,
      allowBuyerSmsMessages: true
    } as never);
    const enabled = decideAutonomousActions(baseOrder, intel, {
      autoCodControlEnabled: true,
      autoOtpForBronzeEnabled: true,
      autoPrepaidOnlyForIronEnabled: true,
      autoAddressCorrectionEnabled: true,
      autoCourierSelectionEnabled: true,
      autoNdrRecoveryEnabled: true,
      autoRtoHoldEnabled: false,
      autoCancelAfterFailedVerificationEnabled: false,
      maxAutoHoldOrderValue: null,
      maxAutoCourierCostIncrease: null,
      maxAutoCodAmount: null,
      allowPrepaidConversionMessage: true,
      allowBuyerWhatsappMessages: true,
      allowBuyerSmsMessages: true
    } as never);

    assert.ok(!disabled.some((plan) => plan.actionType === "HIDE_COD"));
    assert.ok(disabled.some((plan) => plan.actionType === "REQUEST_SELLER_APPROVAL"));
    assert.ok(enabled.some((plan) => plan.actionType === "HIDE_COD"));
    assert.ok(enabled.some((plan) => plan.actionType === "SEND_PREPAID_LINK"));
  });

  it("creates address correction and respects courier cost policy", () => {
    const plans = decideAutonomousActions(
      { id: "order_addr", merchantId: "merchant_1", orderValue: 900, codAmount: 0, paymentMode: "PREPAID" },
      {
        orderId: "order_addr",
        merchantId: "merchant_1",
        buyerPhoneHash: "phone_hash",
        addressHash: "address_hash",
        consigneeTier: "SILVER",
        codDecision: "ALLOW_COD",
        shipmentDecision: "SHIP",
        addressConfidenceScore: 44,
        overallRiskScore: 35,
        rtoRiskScore: 25,
        courierId: "courier_fast",
        courierScore: 80,
        riskReasons: ["LOW_ADDRESS_CONFIDENCE"]
      },
      {
        autoCodControlEnabled: true,
        autoOtpForBronzeEnabled: true,
        autoPrepaidOnlyForIronEnabled: false,
        autoAddressCorrectionEnabled: true,
        autoCourierSelectionEnabled: true,
        autoNdrRecoveryEnabled: true,
        autoRtoHoldEnabled: false,
        autoCancelAfterFailedVerificationEnabled: false,
        maxAutoHoldOrderValue: null,
        maxAutoCourierCostIncrease: 25,
        maxAutoCodAmount: null,
        allowPrepaidConversionMessage: true,
        allowBuyerWhatsappMessages: true,
        allowBuyerSmsMessages: true
      } as never,
      { courierCostIncrease: 40 }
    );

    assert.ok(plans.some((plan) => plan.actionType === "SEND_ADDRESS_CORRECTION_LINK" && plan.automationLevel === "AUTO_EXECUTE_NOTIFY"));
    assert.ok(plans.some((plan) => plan.actionType === "AUTO_SELECT_COURIER" && plan.automationLevel === "REQUIRE_SELLER_APPROVAL"));
  });

  it("creates NDR recovery action and avoids unsafe auto-execution", () => {
    const ndrPlans = decideNdrAutonomousActions({
      orderId: "order_ndr",
      merchantId: "merchant_1",
      phoneHash: "phone_hash",
      reason: "customer_not_reachable",
      policy: {
        autoNdrRecoveryEnabled: true
      } as never
    });
    const costlyPlans = decideAutonomousActions(
      { id: "order_costly", merchantId: "merchant_1", orderValue: 9999, codAmount: 9999, paymentMode: "COD" },
      {
        orderId: "order_costly",
        merchantId: "merchant_1",
        buyerPhoneHash: "phone_hash",
        addressHash: "address_hash",
        consigneeTier: "IRON",
        codDecision: "MANUAL_REVIEW",
        shipmentDecision: "DO_NOT_SHIP",
        addressConfidenceScore: 35,
        overallRiskScore: 92,
        rtoRiskScore: 90,
        courierId: null,
        courierScore: null,
        riskReasons: ["HIGH_RISK"]
      },
      {
        autoCodControlEnabled: true,
        autoOtpForBronzeEnabled: true,
        autoPrepaidOnlyForIronEnabled: true,
        autoAddressCorrectionEnabled: true,
        autoCourierSelectionEnabled: true,
        autoNdrRecoveryEnabled: true,
        autoRtoHoldEnabled: false,
        autoCancelAfterFailedVerificationEnabled: false,
        maxAutoHoldOrderValue: 2500,
        maxAutoCourierCostIncrease: null,
        maxAutoCodAmount: null,
        allowPrepaidConversionMessage: true,
        allowBuyerWhatsappMessages: true,
        allowBuyerSmsMessages: true
      } as never
    );

    assert.ok(ndrPlans.some((plan) => plan.actionType === "SEND_NDR_RECOVERY_MESSAGE"));
    assert.ok(costlyPlans.some((plan) => plan.actionType === "ESCALATE_INTERNAL_REVIEW"));
    assert.ok(filterAutoExecutableActionPlans(costlyPlans).every((plan) => plan.automationLevel !== "REQUIRE_INTERNAL_REVIEW"));
  });

  it("returns seller-safe automation logs", () => {
    const summary = sellerSafeAutomationSummary([
      {
        id: "action_1",
        actionType: "SEND_COD_OTP",
        automationLevel: "AUTO_EXECUTE_NOTIFY",
        status: "EXECUTED",
        reason: "Bronze buyer requires verification before COD/shipping",
        requiresApproval: false,
        createdAt: new Date("2026-05-04T00:00:00.000Z"),
        executedAt: new Date("2026-05-04T00:00:01.000Z")
      },
      {
        id: "action_2",
        actionType: "REQUEST_SELLER_APPROVAL",
        automationLevel: "REQUIRE_SELLER_APPROVAL",
        status: "PENDING",
        reason: "Courier cost increase exceeds policy",
        requiresApproval: true,
        createdAt: new Date("2026-05-04T00:00:00.000Z"),
        executedAt: null
      }
    ]);

    assert.equal(summary.total, 2);
    assert.equal(summary.pendingApproval, 1);
    assert.equal(summary.executed, 1);
    assert.ok(!JSON.stringify(summary).includes("inputSnapshot"));
  });

  it("releases an OTP-verified order when no blocking risk remains", async () => {
    const { client, state } = makeCommunicationClient();

    await recordBuyerCommunication({
      orderId: "order_cb",
      merchantId: "merchant_1",
      phoneHash: "phone_hash",
      channel: "WHATSAPP",
      template: "send_cod_otp",
      status: "RESPONDED",
      response: "OTP_VERIFIED",
      actionType: "SEND_COD_OTP"
    }, client);

    assert.equal(state.signals.otpVerified, true);
    assert.equal(state.shipment.shipmentStatus, "READY_TO_SHIP");
    assert.ok(state.actions.some((action) => action.actionType === "RELEASE_SHIPMENT" && action.status === "EXECUTED"));
    assert.equal(state.outcomes.find((outcome) => outcome.actionType === "SEND_COD_OTP")?.worked, true);
  });

  it("keeps shipment held on OTP failure and queues prepaid recovery", async () => {
    const { client, state } = makeCommunicationClient();

    await recordBuyerCommunication({
      orderId: "order_cb",
      merchantId: "merchant_1",
      phoneHash: "phone_hash",
      channel: "WHATSAPP",
      template: "send_cod_otp",
      status: "RESPONDED",
      response: "OTP_FAILED",
      actionType: "SEND_COD_OTP"
    }, client);

    assert.equal(state.shipment.shipmentStatus, "HELD");
    assert.ok(!state.actions.some((action) => action.actionType === "RELEASE_SHIPMENT"));
    assert.ok(state.events.some((event) => event.template === "send_prepaid_link" && event.status === "QUEUED"));
    assert.equal(state.outcomes.find((outcome) => outcome.actionType === "SEND_COD_OTP")?.worked, false);
  });

  it("updates address correction communication, action, outcome and address score", async () => {
    const { client, state } = makeCommunicationClient();
    state.signals.otpVerified = true;

    await recordBuyerCommunication({
      orderId: "order_cb",
      merchantId: "merchant_1",
      phoneHash: "phone_hash",
      channel: "WHATSAPP",
      template: "send_address_correction_link",
      status: "RESPONDED",
      response: "ADDRESS_CORRECTED",
      actionType: "SEND_ADDRESS_CORRECTION_LINK",
      metadata: {
        correctedAddress: {
          addressLine1: "221 Market Street, Block A, Floor 2",
          city: "Bengaluru",
          state: "Karnataka",
          pincode: "560001"
        }
      }
    }, client);

    assert.equal(state.order.addressLine1, "221 Market Street, Block A, Floor 2");
    assert.ok(state.intelligence.addressConfidenceScore >= 80);
    assert.equal(state.outcomes.find((outcome) => outcome.actionType === "SEND_ADDRESS_CORRECTION_LINK")?.worked, true);
  });

  it("releases prepaid-converted orders that have no blocking risk", async () => {
    const { client, state } = makeCommunicationClient();
    state.intelligence.consigneeTier = "IRON";

    await recordBuyerCommunication({
      orderId: "order_cb",
      merchantId: "merchant_1",
      phoneHash: "phone_hash",
      channel: "WHATSAPP",
      template: "send_prepaid_link",
      status: "RESPONDED",
      response: "PREPAID_CONVERTED",
      actionType: "SEND_PREPAID_LINK"
    }, client);

    assert.equal(state.shipment.shipmentStatus, "READY_TO_SHIP");
    assert.equal(state.signals.paymentModeChangedAfterCreation, true);
    assert.equal(state.outcomes.find((outcome) => outcome.actionType === "SEND_PREPAID_LINK")?.worked, true);
  });

  it("updates NDR recovery action with a pending final-delivery outcome", async () => {
    const { client, state } = makeCommunicationClient();
    state.order.status = "NDR";

    await recordBuyerCommunication({
      orderId: "order_cb",
      merchantId: "merchant_1",
      phoneHash: "phone_hash",
      channel: "WHATSAPP",
      template: "send_ndr_recovery_message",
      status: "RESPONDED",
      response: "BUYER_CONFIRMED_REATTEMPT",
      actionType: "SEND_NDR_RECOVERY_MESSAGE"
    }, client);

    const reattempt = state.outcomes.find((outcome) => outcome.actionType === "REQUEST_NDR_REATTEMPT");
    assert.equal(state.shipment.ndrStatus, "REATTEMPT_REQUESTED");
    assert.equal(reattempt?.actualOutcome, "REATTEMPT_REQUESTED");
    assert.equal(reattempt?.worked, null);
  });

  it("builds worker queue filters and updates communication delivery status", async () => {
    const where = buildCommunicationQueueWhere({ channel: "WHATSAPP" });
    assert.deepEqual(where, { status: "QUEUED", channel: "WHATSAPP" });

    const { client, state } = makeCommunicationClient();
    state.events.push({
      id: "event_status",
      orderId: "order_cb",
      merchantId: "merchant_1",
      channel: "WHATSAPP",
      template: "send_cod_otp",
      status: "QUEUED",
      providerMessageId: null,
      metadata: null
    });

    const sent = await updateBuyerCommunicationStatus({
      id: "event_status",
      status: "SENT",
      providerMessageId: "provider_1"
    }, client);
    assert.equal(sent.status, "SENT");
    assert.equal(sent.providerMessageId, "provider_1");

    const delivered = await updateBuyerCommunicationStatus({
      id: "event_status",
      status: "DELIVERED",
      providerMessageId: "provider_1"
    }, client);
    assert.equal(delivered.status, "DELIVERED");

    const failed = await updateBuyerCommunicationStatus({
      id: "event_status",
      status: "FAILED",
      providerMessageId: "provider_1"
    }, client);
    assert.equal(failed.status, "FAILED");
  });

  it("uses ActionOutcome for autonomy v1 and does not add DecisionActionOutcome", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");

    assert.match(schema, /model ActionOutcome/);
    assert.match(schema, /Autonomy v1 uses ActionOutcome/);
    assert.ok(!/model\s+DecisionActionOutcome\b/.test(schema));
  });

  it("builds a seller-safe decision for the seller's own order", async () => {
    const records = makeDecisionInput();
    const client = {
      order: {
        findFirst: async ({ where }: any) => where.merchantId === "merchant_1"
          ? { ...records.order, shipmentDetails: records.shipmentDetails, orderIntelligence: records.orderIntelligence }
          : null
      },
      autonomousAction: { findMany: async () => records.autonomousActions },
      buyerCommunicationEvent: { findMany: async () => records.buyerCommunicationEvents },
      actionOutcome: { findMany: async () => records.actionOutcomes },
      courierRecommendation: { findFirst: async () => records.courierRecommendation }
    } as any;

    const decision = await buildSellerSafeOrderDecision("order_decision", "merchant_1", client);

    assert.equal(decision.buyerTierLabel, "Bronze Buyer — Verify before shipping");
    assert.equal(decision.codDecision, "REQUIRE_OTP");
    assert.equal(decision.shipmentDecision, "VERIFY_BEFORE_SHIP");
    assert.equal(decision.automationStatus, "OTP_SENT");
  });

  it("does not let a seller fetch another merchant's order decision", async () => {
    const client = {
      order: { findFirst: async () => null }
    } as any;

    await assert.rejects(
      () => buildSellerSafeOrderDecision("order_decision", "merchant_2", client),
      (err: unknown) => err instanceof Error && err.message === "ORDER_NOT_FOUND"
    );
  });

  it("hides internal scores, snapshots, hashes and versions from seller decisions", () => {
    const decision = buildSellerSafeOrderDecisionFromRecords(makeDecisionInput());
    const serialized = JSON.stringify(decision);

    assert.ok(!serialized.includes("internal_phone_hash"));
    assert.ok(!serialized.includes("internal_address_hash"));
    assert.ok(!serialized.includes("overallRiskScore"));
    assert.ok(!serialized.includes("dataSnapshot"));
    assert.ok(!serialized.includes("modelVersion"));
    assert.ok(!serialized.includes("provider_internal"));
  });

  it("returns the Bronze OTP pending seller state", () => {
    const decision = buildSellerSafeOrderDecisionFromRecords(makeDecisionInput());

    assert.equal(decision.automationStatus, "OTP_SENT");
    assert.equal(decision.pendingRequiredAction, "BUYER_COD_VERIFICATION");
    assert.equal(decision.sellerMessage, "COD verification has been sent automatically. Shipment will release after buyer verification.");
  });

  it("returns released state after OTP verification", () => {
    const now = new Date("2026-05-05T00:00:00.000Z");
    const decision = buildSellerSafeOrderDecisionFromRecords(makeDecisionInput({
      shipmentDetails: { shipmentStatus: "READY_TO_SHIP" },
      autonomousActions: [
        {
          id: "action_otp",
          actionType: "SEND_COD_OTP",
          automationLevel: "AUTO_EXECUTE_NOTIFY",
          status: "EXECUTED",
          requiresApproval: false,
          createdAt: now,
          executedAt: now,
          approvedAt: null,
          failedAt: null
        },
        {
          id: "action_release",
          actionType: "RELEASE_SHIPMENT",
          automationLevel: "AUTO_EXECUTE_NOTIFY",
          status: "EXECUTED",
          requiresApproval: false,
          createdAt: now,
          executedAt: now,
          approvedAt: null,
          failedAt: null
        }
      ],
      actionOutcomes: [
        {
          actionType: "SEND_COD_OTP",
          expectedOutcome: "OTP_VERIFIED",
          actualOutcome: "OTP_VERIFIED",
          worked: true,
          createdAt: now
        }
      ]
    }));

    assert.equal(decision.automationStatus, "RELEASED");
    assert.equal(decision.pendingRequiredAction, null);
    assert.equal(decision.sellerMessage, "Buyer verification is complete. Order cleared for shipment.");
  });

  it("returns the Iron prepaid-only seller message", () => {
    const now = new Date("2026-05-05T00:00:00.000Z");
    const decision = buildSellerSafeOrderDecisionFromRecords(makeDecisionInput({
      orderIntelligence: {
        consigneeTier: "IRON",
        codDecision: "PREPAID_ONLY",
        shipmentDecision: "HOLD"
      },
      autonomousActions: [
        {
          id: "action_prepaid",
          actionType: "SEND_PREPAID_LINK",
          automationLevel: "AUTO_EXECUTE_NOTIFY",
          status: "EXECUTED",
          requiresApproval: false,
          createdAt: now,
          executedAt: now,
          approvedAt: null,
          failedAt: null
        }
      ],
      buyerCommunicationEvents: [
        {
          id: "event_prepaid",
          channel: "WHATSAPP",
          template: "send_prepaid_link",
          status: "SENT",
          response: null,
          sentAt: now,
          deliveredAt: null,
          readAt: null,
          respondedAt: null,
          createdAt: now
        }
      ]
    }));

    assert.equal(decision.buyerTierLabel, "Iron Buyer — COD not recommended");
    assert.equal(decision.codDecision, "PREPAID_ONLY");
    assert.equal(decision.shipmentDecision, "HOLD");
    assert.equal(decision.automationStatus, "PREPAID_LINK_SENT");
    assert.equal(decision.sellerMessage, "COD is not recommended for this order. A prepaid payment link has been sent if enabled by your policy.");
  });

  it("wires order create and detail routes to seller-safe decisions", () => {
    const source = readFileSync("src/modules/orders/orders.routes.ts", "utf8");

    assert.match(source, /decision:\s*await buildSellerSafeOrderDecision/);
    assert.match(source, /res\.json\(\{order, decision\}\)/);
    assert.doesNotMatch(source, /include:\s*\{[\s\S]*riskScores:true/);
  });
});
