import { Router } from "express";

import { successEnvelope } from "../shippingNetwork/shipping-public-serializers.js";
import {
  createPrepaidConversionIntent,
  createPrepaidIncentivePolicy,
  getPrepaidConversionIntent,
  listPrepaidIncentivePolicies,
  resolvePrepaidIncentiveOffer,
  updatePrepaidIncentivePolicyStatus,
  type CodPrepaidIncentiveDb
} from "./cod-prepaid-incentive.service.js";
import {
  createPrepaidConversionIntentSchema,
  createPrepaidIncentivePolicySchema,
  listPrepaidIncentivePoliciesQuerySchema,
  prepaidIntentIdParamsSchema,
  prepaidPolicyIdParamsSchema,
  resolvePrepaidIncentiveSchema,
  updatePrepaidIncentivePolicyStatusSchema
} from "./cod-prepaid-incentive.validation.js";

type CodPrepaidRouterDeps = {
  client?: CodPrepaidIncentiveDb;
};

function withAliases(input: Record<string, unknown>) {
  return {
    ...input,
    merchantId: input.merchantId ?? input.merchant_id,
    sellerId: input.sellerId ?? input.seller_id,
    orderId: input.orderId ?? input.order_id,
    shipmentId: input.shipmentId ?? input.shipment_id,
    paymentMode: input.paymentMode ?? input.payment_mode,
    paymentStatus: input.paymentStatus ?? input.payment_status,
    isPaid: input.isPaid ?? input.is_paid,
    codAmountPaise: input.codAmountPaise ?? input.cod_amount_paise,
    orderAmountPaise: input.orderAmountPaise ?? input.order_amount_paise,
    orderStatus: input.orderStatus ?? input.order_status,
    shipmentStatus: input.shipmentStatus ?? input.shipment_status,
    anonymousBuyerRef: input.anonymousBuyerRef ?? input.anonymous_buyer_ref,
    sessionRef: input.sessionRef ?? input.session_ref,
    incentiveType: input.incentiveType ?? input.incentive_type,
    discountAmountPaise: input.discountAmountPaise ?? input.discount_amount_paise,
    discountPercent: input.discountPercent ?? input.discount_percent,
    maxDiscountAmountPaise: input.maxDiscountAmountPaise ?? input.max_discount_amount_paise,
    minOrderAmountPaise: input.minOrderAmountPaise ?? input.min_order_amount_paise,
    maxOrderAmountPaise: input.maxOrderAmountPaise ?? input.max_order_amount_paise,
    startsAt: input.startsAt ?? input.starts_at,
    endsAt: input.endsAt ?? input.ends_at,
    policyId: input.policyId ?? input.policy_id,
    growthOfferId: input.growthOfferId ?? input.growth_offer_id,
    originalPaymentMode: input.originalPaymentMode ?? input.original_payment_mode,
    idempotencyKey: input.idempotencyKey ?? input.idempotency_key,
    expiresAt: input.expiresAt ?? input.expires_at,
    perPage: input.perPage ?? input.per_page
  };
}

export function createCodPrepaidIncentiveRouter(deps: CodPrepaidRouterDeps = {}) {
  const router = Router();
  const client = deps.client;

  router.post("/policies", async (req, res) => {
    const body = createPrepaidIncentivePolicySchema.parse(withAliases(req.body));
    const data = await createPrepaidIncentivePolicy(body, client);
    return res.status(201).json(successEnvelope("Prepaid incentive policy created.", data));
  });

  router.get("/policies", async (req, res) => {
    const query = listPrepaidIncentivePoliciesQuerySchema.parse(withAliases(req.query));
    const data = await listPrepaidIncentivePolicies(query, client);
    return res.json(successEnvelope("Prepaid incentive policies fetched.", data));
  });

  router.patch("/policies/:policyId/status", async (req, res) => {
    const { policyId } = prepaidPolicyIdParamsSchema.parse(req.params);
    const body = updatePrepaidIncentivePolicyStatusSchema.parse(req.body);
    const data = await updatePrepaidIncentivePolicyStatus(policyId, body, client);
    return res.json(successEnvelope("Prepaid incentive policy status updated.", data));
  });

  router.post("/resolve", async (req, res) => {
    const body = resolvePrepaidIncentiveSchema.parse(withAliases(req.body));
    const data = await resolvePrepaidIncentiveOffer(body, client);
    return res.json(successEnvelope("Prepaid incentive offer resolved.", data));
  });

  router.post("/intents", async (req, res) => {
    const body = createPrepaidConversionIntentSchema.parse(withAliases(req.body));
    const data = await createPrepaidConversionIntent(body, client);
    return res.status(201).json(successEnvelope("Prepaid conversion intent created.", data));
  });

  router.get("/intents/:intentId", async (req, res) => {
    const { intentId } = prepaidIntentIdParamsSchema.parse(req.params);
    const data = await getPrepaidConversionIntent(intentId, client);
    return res.json(successEnvelope("Prepaid conversion intent fetched.", data));
  });

  return router;
}
