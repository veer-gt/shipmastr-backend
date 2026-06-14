import { Router } from "express";

import { successEnvelope } from "../shippingNetwork/shipping-public-serializers.js";
import {
  createRtoNdrRecoveryIntent,
  createRtoNdrRecoveryPolicy,
  getRtoNdrRecoveryIntent,
  listRtoNdrRecoveryPolicies,
  resolveRtoNdrRecoveryOffer,
  updateRtoNdrRecoveryPolicyStatus,
  type RtoNdrRecoveryDb
} from "./rto-ndr-recovery.service.js";
import {
  createRtoNdrRecoveryIntentSchema,
  createRtoNdrRecoveryPolicySchema,
  listRtoNdrRecoveryPoliciesQuerySchema,
  resolveRtoNdrRecoverySchema,
  rtoNdrRecoveryIntentIdParamsSchema,
  rtoNdrRecoveryPolicyIdParamsSchema,
  updateRtoNdrRecoveryPolicyStatusSchema
} from "./rto-ndr-recovery.validation.js";

type RtoNdrRecoveryRouterDeps = {
  client?: RtoNdrRecoveryDb;
};

function withAliases(input: Record<string, unknown>) {
  return {
    ...input,
    merchantId: input.merchantId ?? input.merchant_id,
    sellerId: input.sellerId ?? input.seller_id,
    orderId: input.orderId ?? input.order_id,
    shipmentId: input.shipmentId ?? input.shipment_id,
    orderStatus: input.orderStatus ?? input.order_status,
    shipmentStatus: input.shipmentStatus ?? input.shipment_status,
    ndrStatus: input.ndrStatus ?? input.ndr_status,
    rtoStatus: input.rtoStatus ?? input.rto_status,
    failureReason: input.failureReason ?? input.failure_reason,
    orderAmountPaise: input.orderAmountPaise ?? input.order_amount_paise,
    actionType: input.actionType ?? input.action_type,
    incentiveAmountPaise: input.incentiveAmountPaise ?? input.incentive_amount_paise,
    maxIncentiveAmountPaise: input.maxIncentiveAmountPaise ?? input.max_incentive_amount_paise,
    minOrderAmountPaise: input.minOrderAmountPaise ?? input.min_order_amount_paise,
    maxOrderAmountPaise: input.maxOrderAmountPaise ?? input.max_order_amount_paise,
    allowedFailureReasons: input.allowedFailureReasons ?? input.allowed_failure_reasons,
    startsAt: input.startsAt ?? input.starts_at,
    endsAt: input.endsAt ?? input.ends_at,
    policyId: input.policyId ?? input.policy_id,
    growthOfferId: input.growthOfferId ?? input.growth_offer_id,
    idempotencyKey: input.idempotencyKey ?? input.idempotency_key,
    expiresAt: input.expiresAt ?? input.expires_at,
    anonymousBuyerRef: input.anonymousBuyerRef ?? input.anonymous_buyer_ref,
    sessionRef: input.sessionRef ?? input.session_ref,
    perPage: input.perPage ?? input.per_page
  };
}

export function createRtoNdrRecoveryRouter(deps: RtoNdrRecoveryRouterDeps = {}) {
  const router = Router();
  const client = deps.client;

  router.post("/policies", async (req, res) => {
    const body = createRtoNdrRecoveryPolicySchema.parse(withAliases(req.body));
    const data = await createRtoNdrRecoveryPolicy(body, client);
    return res.status(201).json(successEnvelope("RTO/NDR recovery policy created.", data));
  });

  router.get("/policies", async (req, res) => {
    const query = listRtoNdrRecoveryPoliciesQuerySchema.parse(withAliases(req.query));
    const data = await listRtoNdrRecoveryPolicies(query, client);
    return res.json(successEnvelope("RTO/NDR recovery policies fetched.", data));
  });

  router.patch("/policies/:policyId/status", async (req, res) => {
    const { policyId } = rtoNdrRecoveryPolicyIdParamsSchema.parse(req.params);
    const body = updateRtoNdrRecoveryPolicyStatusSchema.parse(req.body);
    const data = await updateRtoNdrRecoveryPolicyStatus(policyId, body, client);
    return res.json(successEnvelope("RTO/NDR recovery policy status updated.", data));
  });

  router.post("/resolve", async (req, res) => {
    const body = resolveRtoNdrRecoverySchema.parse(withAliases(req.body));
    const data = await resolveRtoNdrRecoveryOffer(body, client);
    return res.json(successEnvelope("RTO/NDR recovery offer resolved.", data));
  });

  router.post("/intents", async (req, res) => {
    const body = createRtoNdrRecoveryIntentSchema.parse(withAliases(req.body));
    const data = await createRtoNdrRecoveryIntent(body, client);
    return res.status(201).json(successEnvelope("RTO/NDR recovery intent created.", data));
  });

  router.get("/intents/:intentId", async (req, res) => {
    const { intentId } = rtoNdrRecoveryIntentIdParamsSchema.parse(req.params);
    const data = await getRtoNdrRecoveryIntent(intentId, client);
    return res.json(successEnvelope("RTO/NDR recovery intent fetched.", data));
  });

  return router;
}
