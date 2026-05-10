import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../lib/httpError.js";
import { getConsigneeDecision } from "./consignee-intelligence.service.js";
import { recommendCourierForOrder } from "./courier-performance.service.js";
import { updateMerchantMetrics } from "./metrics.service.js";
import { updateMerchantTrustProfile } from "./merchant-trust.service.js";

export const intelligenceRouter = Router();
export const intelligenceOpsRouter = Router();

const recommendationQuery = z.object({
  orderId: z.string().min(1)
});

function isAdmin(role: unknown) {
  return String(role || "").toUpperCase() === "ADMIN";
}

const scorePreviewSchema = z.object({
  buyerPhone: z.string().min(6),
  addressLine1: z.string().min(1),
  addressLine2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().min(1),
  pincode: z.string().min(3),
  orderValue: z.number().nonnegative(),
  codAmount: z.number().nonnegative().default(0),
  paymentMode: z.enum(["PREPAID", "COD"]),
  weightGrams: z.number().optional()
});

intelligenceRouter.get("/merchant", async (req, res) => {
  const metrics = await updateMerchantMetrics(req.auth!.merchantId);
  const [recentRiskDecisions, fraudSignals] = await Promise.all([
    prisma.riskDecision.findMany({
      where: { merchantId: req.auth!.merchantId },
      orderBy: { createdAt: "desc" },
      take: 10
    }),
    prisma.fraudSignal.findMany({
      where: { merchantId: req.auth!.merchantId },
      orderBy: { createdAt: "desc" },
      take: 10
    })
  ]);

  res.json({ metrics, recentRiskDecisions, fraudSignals });
});

intelligenceRouter.post("/consignee/score-preview", async (req, res) => {
  const body = scorePreviewSchema.parse(req.body);
  const decision = await getConsigneeDecision({
    id: "preview",
    merchantId: req.auth!.merchantId,
    buyerPhone: body.buyerPhone,
    addressLine1: body.addressLine1,
    addressLine2: body.addressLine2 ?? null,
    city: body.city,
    state: body.state,
    pincode: body.pincode,
    orderValue: body.orderValue,
    codAmount: body.codAmount,
    paymentMode: body.paymentMode,
    weightGrams: body.weightGrams ?? null,
    status: "CREATED",
    createdAt: new Date()
  });

  res.json({
    phoneHash: decision.phoneHash,
    addressHash: decision.addressHash,
    consigneeScore: decision.score,
    consigneeTier: decision.tier,
    sellerLabel: decision.label,
    codDecision: decision.codDecision,
    shipmentDecision: decision.shipmentDecision,
    riskReasons: decision.reasons,
    scores: {
      addressConfidenceScore: decision.addressConfidenceScore,
      pincodeRiskScore: decision.pincodeRiskScore,
      codRiskScore: decision.codRiskScore,
      rtoRiskScore: decision.rtoRiskScore,
      fraudRiskScore: decision.fraudRiskScore,
      overallRiskScore: decision.overallRiskScore
    }
  });
});

intelligenceRouter.get("/consignee/:phoneHash", async (req, res) => {
  const phoneHash = req.params.phoneHash;
  if (!/^[a-f0-9]{64}$/i.test(phoneHash)) throw new HttpError(400, "INVALID_PHONE_HASH");

  const [profile, orderSnapshots] = await Promise.all([
    prisma.consigneeProfile.findUnique({ where: { phoneHash } }),
    prisma.orderIntelligence.findMany({
      where: {
        merchantId: req.auth!.merchantId,
        buyerPhoneHash: phoneHash
      },
      orderBy: { createdAt: "desc" },
      take: 20
    })
  ]);

  if (!profile && orderSnapshots.length === 0) throw new HttpError(404, "CONSIGNEE_NOT_FOUND");

  res.json({ profile, orderSnapshots });
});

intelligenceRouter.get("/predictions/accuracy", async (req, res) => {
  if (!isAdmin(req.auth?.role)) throw new HttpError(403, "ADMIN_ONLY");

  const outcomes = await prisma.predictionOutcome.findMany({
    where: { actualOutcome: { not: "PENDING" } }
  });
  const evaluated = outcomes.length;
  const correct = outcomes.filter((outcome) => outcome.predictionCorrect === true).length;
  const falsePositive = outcomes.filter((outcome) => outcome.falsePositive === true).length;
  const falseNegative = outcomes.filter((outcome) => outcome.falseNegative === true).length;

  res.json({
    evaluated,
    correct,
    falsePositive,
    falseNegative,
    accuracy: evaluated ? Number((correct / evaluated).toFixed(4)) : null
  });
});

intelligenceRouter.get("/pincode/:pincode", async (req, res) => {
  const pincode = req.params.pincode;
  if (!/^\d{6}$/.test(pincode)) throw new HttpError(400, "INVALID_PINCODE");

  const [intelligence, courierPerformance] = await Promise.all([
    prisma.pincodeIntelligence.findUnique({ where: { pincode } }),
    prisma.courierPincodePerformance.findMany({
      where: { pincode },
      orderBy: [{ score: "desc" }, { deliveryRate: "desc" }]
    })
  ]);

  res.json({ pincode, intelligence, courierPerformance });
});

intelligenceRouter.get("/orders/:orderId/full", async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.orderId },
    include: {
      shipmentDetails: true,
      orderIntelligence: true,
      orderDataSignals: true,
      predictionOutcome: true,
      riskScores: true,
      webhookEvents: true
    }
  });

  if (!order) throw new HttpError(404, "ORDER_NOT_FOUND");
  if (!isAdmin(req.auth?.role)) throw new HttpError(403, "ADMIN_ONLY");

  res.json({ order });
});

intelligenceRouter.get("/couriers/recommend", async (req, res) => {
  const query = recommendationQuery.parse(req.query);
  const order = await prisma.order.findFirst({
    where: {
      id: query.orderId,
      merchantId: req.auth!.merchantId
    }
  });

  if (!order) throw new HttpError(404, "ORDER_NOT_FOUND");

  const recommendation = await recommendCourierForOrder(order.id);
  res.json({ recommendation });
});

intelligenceRouter.get("/trust", async (req, res) => {
  const profile = await updateMerchantTrustProfile(req.auth!.merchantId);
  const events = await prisma.merchantTrustEvent.findMany({
    where: { merchantId: req.auth!.merchantId },
    orderBy: { createdAt: "desc" },
    take: 20
  });

  res.json({ profile, events });
});

intelligenceOpsRouter.get("/health", async (_req, res) => {
  const [openSlaBreaches, staleTrackingEvents, webhookFailures] = await Promise.all([
    prisma.slaBreach.count({ where: { status: "open" } }),
    prisma.operationalEvent.count({ where: { status: "tracking_stale" } }),
    prisma.webhookEvent.count({ where: { status: "FAILED" } })
  ]);

  res.json({
    ok: true,
    intelligence: {
      openSlaBreaches,
      staleTrackingEvents,
      webhookFailures
    }
  });
});
