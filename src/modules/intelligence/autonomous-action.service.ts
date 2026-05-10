import type {
  AutonomousAction,
  AutonomousActionType,
  AutomationLevel,
  CommunicationChannel,
  MerchantAutomationPolicy,
  Order,
  OrderIntelligence,
  Prisma
} from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { getOrCreateMerchantAutomationPolicy } from "./action-policy.service.js";
import { recordBuyerCommunication } from "./buyer-communication.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

type OrderForAutomation = Pick<Order, "id" | "merchantId" | "orderValue" | "codAmount" | "paymentMode">;
type IntelligenceForAutomation = Pick<
  OrderIntelligence,
  | "orderId"
  | "merchantId"
  | "buyerPhoneHash"
  | "addressHash"
  | "consigneeTier"
  | "codDecision"
  | "shipmentDecision"
  | "addressConfidenceScore"
  | "overallRiskScore"
  | "rtoRiskScore"
  | "courierId"
  | "courierScore"
> & {
  riskReasons: readonly string[];
};

export type AutonomousActionPlan = {
  actionType: AutonomousActionType;
  automationLevel: AutomationLevel;
  reason: string;
  inputSnapshot?: Prisma.InputJsonObject;
  expectedOutcome?: string;
  expiresAt?: Date;
};

export type AutomationDecisionContext = {
  courierCostIncrease?: number | null;
  ndrReason?: string | null;
  buyerConfirmed?: boolean;
};

const autoLevels: AutomationLevel[] = ["AUTO_EXECUTE", "AUTO_EXECUTE_NOTIFY"];
const communicationActions: AutonomousActionType[] = [
  "SEND_COD_OTP",
  "SEND_ADDRESS_CORRECTION_LINK",
  "SEND_PREPAID_LINK",
  "SEND_NDR_RECOVERY_MESSAGE"
];

function money(value: unknown) {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function requiresApproval(level: AutomationLevel) {
  return level === "REQUIRE_SELLER_APPROVAL" || level === "REQUIRE_INTERNAL_REVIEW";
}

export function isAutoExecutable(level: AutomationLevel) {
  return autoLevels.includes(level);
}

function buyerMessagingAllowed(policy: MerchantAutomationPolicy) {
  return policy.allowBuyerWhatsappMessages || policy.allowBuyerSmsMessages;
}

function preferredBuyerChannel(policy: MerchantAutomationPolicy): CommunicationChannel {
  return policy.allowBuyerWhatsappMessages ? "WHATSAPP" : "SMS";
}

function communicationAutomationLevel(policy: MerchantAutomationPolicy, enabled: boolean, reviewRequired: boolean): AutomationLevel {
  if (reviewRequired) return "REQUIRE_INTERNAL_REVIEW";
  return enabled && buyerMessagingAllowed(policy) ? "AUTO_EXECUTE_NOTIFY" : "REQUIRE_SELLER_APPROVAL";
}

function merchantPolicyAllowsCourier(policy: MerchantAutomationPolicy, context: AutomationDecisionContext) {
  if (!policy.autoCourierSelectionEnabled) return false;
  const max = money(policy.maxAutoCourierCostIncrease);
  const increase = context.courierCostIncrease ?? 0;
  return max === null || increase <= max;
}

function pushUnique(plans: AutonomousActionPlan[], plan: AutonomousActionPlan) {
  if (!plans.some((existing) => existing.actionType === plan.actionType && existing.reason === plan.reason)) {
    plans.push(plan);
  }
}

export function decideActionsAfterOtpSuccess(): AutonomousActionPlan[] {
  return [{
    actionType: "RELEASE_SHIPMENT",
    automationLevel: "AUTO_EXECUTE_NOTIFY",
    reason: "OTP verification succeeded",
    expectedOutcome: "SHIPMENT_RELEASED"
  }];
}

export function decideAutonomousActions(
  order: OrderForAutomation,
  orderIntelligence: IntelligenceForAutomation,
  policy: MerchantAutomationPolicy,
  context: AutomationDecisionContext = {}
) {
  const plans: AutonomousActionPlan[] = [];
  const highRisk = (orderIntelligence.overallRiskScore ?? 0) >= 75;
  const maxAutoHold = money(policy.maxAutoHoldOrderValue);
  const maxAutoCod = money(policy.maxAutoCodAmount);
  const highValueHold = maxAutoHold !== null && order.orderValue > maxAutoHold;
  const highCodAmount = order.paymentMode === "COD" && maxAutoCod !== null && order.codAmount > maxAutoCod;
  const reviewRequired = highRisk || highValueHold || highCodAmount;
  const weakAddress = (orderIntelligence.addressConfidenceScore ?? 100) < 60;

  if (reviewRequired) {
    pushUnique(plans, {
      actionType: "ESCALATE_INTERNAL_REVIEW",
      automationLevel: "REQUIRE_INTERNAL_REVIEW",
      reason: highRisk
        ? "High-risk order needs internal review"
        : highValueHold
          ? "Order value exceeds auto-hold policy"
          : "COD amount exceeds auto-control policy",
      inputSnapshot: {
        overallRiskScore: orderIntelligence.overallRiskScore ?? null,
        orderValue: order.orderValue,
        codAmount: order.codAmount,
        maxAutoHoldOrderValue: maxAutoHold,
        maxAutoCodAmount: maxAutoCod
      },
      expectedOutcome: "INTERNAL_REVIEW_COMPLETED"
    });
  }

  if (weakAddress) {
    pushUnique(plans, {
      actionType: "SEND_ADDRESS_CORRECTION_LINK",
      automationLevel: communicationAutomationLevel(policy, policy.autoAddressCorrectionEnabled, reviewRequired),
      reason: "Low address confidence",
      inputSnapshot: {
        addressHash: orderIntelligence.addressHash,
        addressConfidenceScore: orderIntelligence.addressConfidenceScore,
        channel: preferredBuyerChannel(policy)
      },
      expectedOutcome: "ADDRESS_CONFIRMED"
    });
  }

  if (orderIntelligence.consigneeTier === "GOLD" || orderIntelligence.consigneeTier === "SILVER") {
    pushUnique(plans, {
      actionType: "RELEASE_SHIPMENT",
      automationLevel: reviewRequired ? "REQUIRE_INTERNAL_REVIEW" : "AUTO_EXECUTE_NOTIFY",
      reason: `${orderIntelligence.consigneeTier} buyer can ship by default`,
      expectedOutcome: "SHIPMENT_RELEASED"
    });
  }

  if (orderIntelligence.consigneeTier === "BRONZE") {
    if (policy.autoCodControlEnabled && policy.autoOtpForBronzeEnabled) {
      pushUnique(plans, {
        actionType: "SEND_COD_OTP",
        automationLevel: communicationAutomationLevel(policy, true, reviewRequired),
        reason: "Bronze buyer requires verification before COD/shipping",
        inputSnapshot: {
          phoneHash: orderIntelligence.buyerPhoneHash,
          codAmount: order.codAmount,
          channel: preferredBuyerChannel(policy)
        },
        expectedOutcome: "OTP_VERIFIED"
      });
      pushUnique(plans, {
        actionType: "HOLD_SHIPMENT",
        automationLevel: reviewRequired ? "REQUIRE_INTERNAL_REVIEW" : "AUTO_EXECUTE_NOTIFY",
        reason: "Hold until OTP succeeds",
        expectedOutcome: "OTP_VERIFIED"
      });
    } else {
      pushUnique(plans, {
        actionType: "REQUEST_SELLER_APPROVAL",
        automationLevel: "REQUIRE_SELLER_APPROVAL",
        reason: "Bronze buyer verification is disabled by policy",
        expectedOutcome: "SELLER_DECISION"
      });
    }
  }

  if (orderIntelligence.consigneeTier === "IRON") {
    if (policy.autoCodControlEnabled && policy.autoPrepaidOnlyForIronEnabled) {
      pushUnique(plans, {
        actionType: "HIDE_COD",
        automationLevel: reviewRequired ? "REQUIRE_INTERNAL_REVIEW" : "AUTO_EXECUTE_NOTIFY",
        reason: "Iron buyer: COD not recommended",
        inputSnapshot: {
          phoneHash: orderIntelligence.buyerPhoneHash,
          codAmount: order.codAmount
        },
        expectedOutcome: "COD_HIDDEN"
      });

      if (policy.allowPrepaidConversionMessage) {
        pushUnique(plans, {
          actionType: "SEND_PREPAID_LINK",
          automationLevel: communicationAutomationLevel(policy, true, reviewRequired),
          reason: "Offer prepaid conversion for high-risk COD order",
          inputSnapshot: {
            phoneHash: orderIntelligence.buyerPhoneHash,
            channel: preferredBuyerChannel(policy)
          },
          expectedOutcome: "PREPAID_CONVERTED"
        });
      }
    } else {
      pushUnique(plans, {
        actionType: "REQUEST_SELLER_APPROVAL",
        automationLevel: "REQUIRE_SELLER_APPROVAL",
        reason: "Iron buyer action requires seller policy approval",
        expectedOutcome: "SELLER_DECISION"
      });
    }
  }

  if (orderIntelligence.courierId) {
    const canAutoSelect = !reviewRequired && merchantPolicyAllowsCourier(policy, context);
    pushUnique(plans, {
      actionType: "AUTO_SELECT_COURIER",
      automationLevel: canAutoSelect ? "AUTO_EXECUTE" : reviewRequired ? "REQUIRE_INTERNAL_REVIEW" : "REQUIRE_SELLER_APPROVAL",
      reason: canAutoSelect
        ? "Best courier selected within cost policy"
        : reviewRequired
          ? "Courier selection needs review for high-risk or high-value order"
          : "Courier cost increase exceeds policy",
      inputSnapshot: {
        courierId: orderIntelligence.courierId,
        courierScore: orderIntelligence.courierScore,
        courierCostIncrease: context.courierCostIncrease ?? 0,
        maxAutoCourierCostIncrease: money(policy.maxAutoCourierCostIncrease)
      },
      expectedOutcome: "COURIER_SELECTED"
    });
  }

  return plans;
}

export function decideNdrAutonomousActions(input: {
  orderId: string;
  merchantId: string;
  phoneHash?: string | null;
  reason?: string | null;
  buyerConfirmed?: boolean;
  policy: MerchantAutomationPolicy;
}) {
  const reason = String(input.reason || "").toLowerCase();
  const actions: AutonomousActionPlan[] = [];

  if (!input.policy.autoNdrRecoveryEnabled) {
    return [{
      actionType: "REQUEST_SELLER_APPROVAL",
      automationLevel: "REQUIRE_SELLER_APPROVAL",
      reason: "NDR automation disabled by policy",
      expectedOutcome: "SELLER_NDR_DECISION"
    }] satisfies AutonomousActionPlan[];
  }

  const communicationLevel = communicationAutomationLevel(input.policy, true, false);
  const channel = preferredBuyerChannel(input.policy);

  if (reason.includes("address")) {
    actions.push({
      actionType: "SEND_ADDRESS_CORRECTION_LINK",
      automationLevel: communicationLevel,
      reason: "NDR address issue: request corrected address",
      inputSnapshot: { phoneHash: input.phoneHash ?? null, ndrReason: input.reason ?? null, channel },
      expectedOutcome: "ADDRESS_CONFIRMED"
    });
  } else {
    actions.push({
      actionType: "SEND_NDR_RECOVERY_MESSAGE",
      automationLevel: communicationLevel,
      reason: "NDR customer not reachable: request buyer confirmation",
      inputSnapshot: { phoneHash: input.phoneHash ?? null, ndrReason: input.reason ?? null, channel },
      expectedOutcome: "BUYER_CONFIRMED_REATTEMPT"
    });
  }

  if (input.buyerConfirmed) {
    actions.push({
      actionType: "REQUEST_NDR_REATTEMPT",
      automationLevel: "AUTO_EXECUTE_NOTIFY",
      reason: "Buyer confirmed reattempt",
      expectedOutcome: "REATTEMPT_REQUESTED"
    });
  }

  return actions;
}

export function filterAutoExecutableActionPlans(plans: AutonomousActionPlan[]) {
  return plans.filter((plan) => isAutoExecutable(plan.automationLevel));
}

function actionSnapshot(action: Pick<AutonomousAction, "inputSnapshot">) {
  return (action.inputSnapshot && typeof action.inputSnapshot === "object" && !Array.isArray(action.inputSnapshot))
    ? action.inputSnapshot as Record<string, unknown>
    : {};
}

function actionChannel(actionType: AutonomousActionType, snapshot: Record<string, unknown>) {
  if (snapshot.channel === "WHATSAPP" || snapshot.channel === "SMS" || snapshot.channel === "EMAIL" || snapshot.channel === "CALL") {
    return snapshot.channel;
  }

  if (actionType === "SEND_COD_OTP" || actionType === "SEND_ADDRESS_CORRECTION_LINK" || actionType === "SEND_NDR_RECOVERY_MESSAGE") {
    return "WHATSAPP" as const;
  }
  return "SMS" as const;
}

async function executeActionRecord(action: AutonomousAction, client: Db) {
  if (!isAutoExecutable(action.automationLevel) && action.status !== "APPROVED") return action;

  try {
    if (communicationActions.includes(action.actionType)) {
      const snapshot = actionSnapshot(action);
      await recordBuyerCommunication({
        orderId: action.orderId,
        merchantId: action.merchantId,
        phoneHash: typeof snapshot.phoneHash === "string" ? snapshot.phoneHash : null,
        channel: actionChannel(action.actionType, snapshot),
        template: action.actionType.toLowerCase(),
        status: "QUEUED",
        metadata: { actionId: action.id }
      }, client);
    }

    if (action.actionType === "HOLD_SHIPMENT") {
      await client.shipmentDetails.updateMany({
        where: { orderId: action.orderId },
        data: { shipmentStatus: "HELD" }
      });
    }

    if (action.actionType === "RELEASE_SHIPMENT") {
      await client.shipmentDetails.updateMany({
        where: { orderId: action.orderId },
        data: { shipmentStatus: "READY_TO_SHIP" }
      });
    }

    if (action.actionType === "AUTO_SELECT_COURIER") {
      const snapshot = actionSnapshot(action);
      const courierId = typeof snapshot.courierId === "string" ? snapshot.courierId : null;
      if (courierId) {
        await client.shipmentDetails.updateMany({
          where: { orderId: action.orderId },
          data: { courierId }
        });
      }
    }

    if (action.actionType === "REQUEST_NDR_REATTEMPT") {
      await client.shipmentDetails.updateMany({
        where: { orderId: action.orderId },
        data: { ndrStatus: "REATTEMPT_REQUESTED" }
      });
    }

    const updated = await client.autonomousAction.update({
      where: { id: action.id },
      data: {
        status: "EXECUTED",
        executedAt: new Date(),
        resultSnapshot: {
          executed: true,
          actionType: action.actionType
        }
      }
    });

    if (!communicationActions.includes(action.actionType)) {
      await updateActionOutcome(action.orderId, action.actionType, "EXECUTED", client);
    }
    return updated;
  } catch (err) {
    return client.autonomousAction.update({
      where: { id: action.id },
      data: {
        status: "FAILED",
        failedAt: new Date(),
        resultSnapshot: {
          error: err instanceof Error ? err.message : "ACTION_FAILED"
        }
      }
    });
  }
}

async function createActionFromPlan(orderId: string, merchantId: string, plan: AutonomousActionPlan, client: Db) {
  const action = await client.autonomousAction.create({
    data: {
      orderId,
      merchantId,
      actionType: plan.actionType,
      automationLevel: plan.automationLevel,
      reason: plan.reason,
      requiresApproval: requiresApproval(plan.automationLevel),
      expiresAt: plan.expiresAt ?? null,
      ...(plan.inputSnapshot !== undefined ? { inputSnapshot: plan.inputSnapshot } : {})
    }
  });

  await client.actionOutcome.create({
    data: {
      orderId,
      merchantId,
      actionType: plan.actionType,
      expectedOutcome: plan.expectedOutcome ?? plan.actionType
    }
  });

  if (isAutoExecutable(plan.automationLevel)) {
    return executeActionRecord(action, client);
  }

  return action;
}

async function orderAutomationContext(orderId: string, client: Db): Promise<AutomationDecisionContext> {
  const [signals, recommendation] = await Promise.all([
    client.orderDataSignals.findUnique({ where: { orderId } }),
    client.courierRecommendation.findFirst({
      where: { orderId },
      orderBy: { createdAt: "desc" }
    })
  ]);
  const estimatedCost = money(recommendation?.estimatedCost);
  const baselineCost = money(signals?.shippingChargeToSeller) ?? money(signals?.courierCostToShipmastr);

  if (estimatedCost === null || baselineCost === null) {
    return { courierCostIncrease: 0 };
  }

  return {
    courierCostIncrease: Math.max(0, estimatedCost - baselineCost)
  };
}

export async function executeAutonomousAction(actionId: string, client: Db = prisma) {
  const action = await client.autonomousAction.findUniqueOrThrow({ where: { id: actionId } });
  return executeActionRecord(action, client);
}

export async function updateActionOutcome(orderId: string, actionType: AutonomousActionType, actualOutcome: string, client: Db = prisma) {
  const outcome = await client.actionOutcome.findFirst({
    where: { orderId, actionType },
    orderBy: { createdAt: "desc" }
  });

  if (!outcome) return null;

  return client.actionOutcome.update({
    where: { id: outcome.id },
    data: {
      actualOutcome,
      worked: actualOutcome === outcome.expectedOutcome || actualOutcome === "EXECUTED"
    }
  });
}

export async function handleOrderCreatedAutonomy(orderId: string, client: Db = prisma) {
  const order = await client.order.findUniqueOrThrow({ where: { id: orderId } });
  const orderIntelligence = await client.orderIntelligence.findUniqueOrThrow({ where: { orderId } });
  const policy = await getOrCreateMerchantAutomationPolicy(order.merchantId, client);
  const context = await orderAutomationContext(order.id, client);
  const plans = decideAutonomousActions(order, orderIntelligence, policy, context);
  const actions: AutonomousAction[] = [];

  for (const plan of plans) {
    actions.push(await createActionFromPlan(order.id, order.merchantId, plan, client));
  }

  return sellerSafeAutomationSummary(actions);
}

export async function handleWebhookAutonomy(input: {
  orderId: string;
  merchantId: string;
  eventType: string;
  reason?: string | null;
  phoneHash?: string | null;
  buyerConfirmed?: boolean;
}, client: Db = prisma) {
  const policy = await getOrCreateMerchantAutomationPolicy(input.merchantId, client);
  const eventType = input.eventType.toLowerCase();
  const plans = eventType.includes("ndr")
    ? decideNdrAutonomousActions({
        orderId: input.orderId,
        merchantId: input.merchantId,
        policy,
        ...(input.phoneHash !== undefined ? { phoneHash: input.phoneHash } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.buyerConfirmed !== undefined ? { buyerConfirmed: input.buyerConfirmed } : {})
      })
    : [];
  const actions: AutonomousAction[] = [];

  for (const plan of plans) {
    actions.push(await createActionFromPlan(input.orderId, input.merchantId, plan, client));
  }

  return sellerSafeAutomationSummary(actions);
}

export async function approveAutonomousAction(input: {
  orderId: string;
  merchantId: string;
  actionId: string;
  approvedBy: string;
}, client: Db = prisma) {
  const action = await client.autonomousAction.findFirstOrThrow({
    where: {
      id: input.actionId,
      orderId: input.orderId,
      merchantId: input.merchantId
    }
  });
  const approved = await client.autonomousAction.update({
    where: { id: action.id },
    data: {
      status: "APPROVED",
      approvedBy: input.approvedBy,
      approvedAt: new Date()
    }
  });

  return executeActionRecord(approved, client);
}

export async function rejectAutonomousAction(input: {
  orderId: string;
  merchantId: string;
  actionId: string;
  actorId: string;
}, client: Db = prisma) {
  return client.autonomousAction.updateMany({
    where: {
      id: input.actionId,
      orderId: input.orderId,
      merchantId: input.merchantId
    },
    data: {
      status: "REJECTED",
      resultSnapshot: {
        rejectedBy: input.actorId
      }
    }
  });
}

export function sellerSafeAutomationSummary(actions: Array<Pick<AutonomousAction, "id" | "actionType" | "automationLevel" | "status" | "reason" | "requiresApproval" | "createdAt" | "executedAt">>) {
  return {
    total: actions.length,
    pendingApproval: actions.filter((action) => action.requiresApproval && action.status === "PENDING").length,
    executed: actions.filter((action) => action.status === "EXECUTED").length,
    actions: actions.map((action) => ({
      id: action.id,
      actionType: action.actionType,
      automationLevel: action.automationLevel,
      status: action.status,
      reason: action.reason,
      requiresApproval: action.requiresApproval,
      createdAt: action.createdAt,
      executedAt: action.executedAt
    }))
  };
}
