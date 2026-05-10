import type {
  ActionOutcome,
  AutonomousAction,
  AutonomousActionType,
  BuyerCommunicationEvent,
  CodDecision,
  CommunicationStatus,
  ConsigneeTier,
  CourierRecommendation,
  Order,
  OrderIntelligence,
  Prisma,
  ShipmentDecision,
  ShipmentDetails
} from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { CONSIGNEE_TIER_LABELS } from "./consignee-intelligence.service.js";

type Db = Prisma.TransactionClient | typeof prisma;

type DecisionOrder = Pick<Order, "id" | "merchantId" | "paymentMode" | "status">;
type DecisionShipment = Pick<ShipmentDetails, "shipmentStatus" | "awb" | "trackingNumber" | "courierId"> | null;
type DecisionIntelligence = Pick<
  OrderIntelligence,
  "consigneeTier" | "codDecision" | "shipmentDecision" | "courierId" | "courierReasons"
> | null;
type DecisionAction = Pick<
  AutonomousAction,
  "id" | "actionType" | "automationLevel" | "status" | "requiresApproval" | "createdAt" | "executedAt" | "approvedAt" | "failedAt"
>;
type DecisionCommunication = Pick<
  BuyerCommunicationEvent,
  "id" | "channel" | "template" | "status" | "response" | "sentAt" | "deliveredAt" | "readAt" | "respondedAt" | "createdAt"
>;
type DecisionOutcome = Pick<ActionOutcome, "actionType" | "expectedOutcome" | "actualOutcome" | "worked" | "createdAt">;
type DecisionCourier = Pick<CourierRecommendation, "courierId" | "estimatedCost" | "estimatedEtaDays" | "metadata" | "createdAt"> | null;

export type SellerSafeAutomationStatus =
  | "PENDING"
  | "HELD"
  | "OTP_SENT"
  | "OTP_VERIFIED"
  | "PREPAID_LINK_SENT"
  | "PREPAID_CONVERTED"
  | "ADDRESS_CORRECTION_SENT"
  | "NDR_REATTEMPT_REQUESTED"
  | "SELLER_APPROVAL_REQUIRED"
  | "INTERNAL_REVIEW"
  | "RELEASED";

const actionLabels: Record<AutonomousActionType, string> = {
  SEND_COD_OTP: "COD verification sent",
  SEND_ADDRESS_CORRECTION_LINK: "Address confirmation sent",
  HIDE_COD: "COD option hidden",
  SEND_PREPAID_LINK: "Prepaid payment link sent",
  AUTO_SELECT_COURIER: "Courier selected",
  HOLD_SHIPMENT: "Shipment held",
  RELEASE_SHIPMENT: "Shipment released",
  REQUEST_NDR_REATTEMPT: "Delivery reattempt requested",
  SEND_NDR_RECOVERY_MESSAGE: "NDR recovery message sent",
  ESCALATE_INTERNAL_REVIEW: "Internal review requested",
  REQUEST_SELLER_APPROVAL: "Seller approval requested"
};

function dateValue(value: Date | null | undefined) {
  return value ? value.getTime() : 0;
}

function latest<T extends { createdAt: Date }>(items: T[]) {
  return [...items].sort((left, right) => dateValue(right.createdAt) - dateValue(left.createdAt))[0] ?? null;
}

function hasAction(actions: DecisionAction[], actionType: AutonomousActionType, statuses?: string[]) {
  return actions.some((action) => action.actionType === actionType && (!statuses || statuses.includes(action.status)));
}

function latestOutcome(outcomes: DecisionOutcome[], actionType: AutonomousActionType) {
  return latest(outcomes.filter((outcome) => outcome.actionType === actionType));
}

function hasCommunicationTemplate(communications: DecisionCommunication[], needle: string, statuses?: CommunicationStatus[]) {
  return communications.some((event) => {
    const template = event.template.toLowerCase();
    return template.includes(needle) && (!statuses || statuses.includes(event.status));
  });
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function templateLabel(template: string) {
  const normalized = template.toLowerCase();
  if (normalized.includes("otp")) return "COD verification";
  if (normalized.includes("address")) return "Address confirmation";
  if (normalized.includes("prepaid")) return "Prepaid payment link";
  if (normalized.includes("ndr")) return "NDR recovery message";
  return "Buyer message";
}

function shipmentDecisionFromOrder(order: DecisionOrder): ShipmentDecision {
  if (order.status === "HELD" || order.status === "NDR") return "HOLD";
  if (order.status === "CANCELLED" || order.status === "RTO") return "DO_NOT_SHIP";
  return "SHIP";
}

function isReleased(input: {
  shipment: DecisionShipment;
  actions: DecisionAction[];
  order: DecisionOrder;
}) {
  return hasAction(input.actions, "RELEASE_SHIPMENT", ["EXECUTED"])
    || ["READY_TO_SHIP", "SHIPPED", "DELIVERED"].includes(input.shipment?.shipmentStatus ?? "")
    || ["READY_TO_SHIP", "SHIPPED", "DELIVERED"].includes(input.order.status);
}

function automationStatus(input: {
  order: DecisionOrder;
  shipment: DecisionShipment;
  intelligence: DecisionIntelligence;
  actions: DecisionAction[];
  communications: DecisionCommunication[];
  outcomes: DecisionOutcome[];
}): SellerSafeAutomationStatus {
  const pendingSeller = input.actions.some((action) => action.actionType === "REQUEST_SELLER_APPROVAL" && action.status === "PENDING");
  if (pendingSeller) return "SELLER_APPROVAL_REQUIRED";

  const pendingInternal = input.actions.some((action) => action.actionType === "ESCALATE_INTERNAL_REVIEW" && action.status === "PENDING");
  if (pendingInternal) return "INTERNAL_REVIEW";

  if (isReleased(input)) return "RELEASED";

  if (hasAction(input.actions, "REQUEST_NDR_REATTEMPT", ["EXECUTED"])) return "NDR_REATTEMPT_REQUESTED";

  if (latestOutcome(input.outcomes, "SEND_PREPAID_LINK")?.worked === true) return "PREPAID_CONVERTED";
  if (hasAction(input.actions, "SEND_PREPAID_LINK", ["EXECUTED", "PENDING", "APPROVED"])
    || hasCommunicationTemplate(input.communications, "prepaid", ["QUEUED", "SENT", "DELIVERED", "READ", "RESPONDED"])) {
    return "PREPAID_LINK_SENT";
  }

  if (latestOutcome(input.outcomes, "SEND_COD_OTP")?.worked === true) return "OTP_VERIFIED";
  if (hasAction(input.actions, "SEND_COD_OTP", ["EXECUTED", "PENDING", "APPROVED"])
    || hasCommunicationTemplate(input.communications, "otp", ["QUEUED", "SENT", "DELIVERED", "READ"])) {
    return "OTP_SENT";
  }

  if (hasAction(input.actions, "SEND_ADDRESS_CORRECTION_LINK", ["EXECUTED", "PENDING", "APPROVED"])
    || hasCommunicationTemplate(input.communications, "address", ["QUEUED", "SENT", "DELIVERED", "READ"])) {
    return "ADDRESS_CORRECTION_SENT";
  }

  if (hasAction(input.actions, "HOLD_SHIPMENT", ["EXECUTED"]) || input.shipment?.shipmentStatus === "HELD") return "HELD";

  if (input.intelligence?.shipmentDecision === "SHIP") return "RELEASED";
  return "PENDING";
}

function pendingRequiredAction(status: SellerSafeAutomationStatus) {
  if (status === "SELLER_APPROVAL_REQUIRED") return "SELLER_APPROVAL_REQUIRED";
  if (status === "INTERNAL_REVIEW") return "INTERNAL_REVIEW";
  if (status === "OTP_SENT") return "BUYER_COD_VERIFICATION";
  if (status === "ADDRESS_CORRECTION_SENT") return "BUYER_ADDRESS_CONFIRMATION";
  if (status === "PREPAID_LINK_SENT") return "BUYER_PREPAID_PAYMENT";
  return null;
}

function shortReasons(input: {
  tier: ConsigneeTier;
  status: SellerSafeAutomationStatus;
  actions: DecisionAction[];
  courierRecommendation: DecisionCourier;
}) {
  const reasons: string[] = [];
  if (input.tier === "GOLD" || input.tier === "SILVER") reasons.push("Buyer history supports automatic shipment");
  if (input.tier === "BRONZE") reasons.push(input.status === "RELEASED" ? "Buyer verification completed" : "Buyer verification is in progress");
  if (input.tier === "IRON") reasons.push("COD is not recommended for this order");
  if (input.status === "ADDRESS_CORRECTION_SENT") reasons.push("Address confirmation is in progress");
  if (input.status === "PREPAID_LINK_SENT") reasons.push("Prepaid conversion link has been sent");
  if (input.status === "SELLER_APPROVAL_REQUIRED") reasons.push("Seller approval is required before proceeding");
  if (input.courierRecommendation) reasons.push("Courier recommendation is available");
  if (hasAction(input.actions, "AUTO_SELECT_COURIER", ["EXECUTED"])) reasons.push("Courier selection was handled automatically");

  return [...new Set(reasons)].slice(0, 3);
}

function sellerMessage(input: {
  tier: ConsigneeTier;
  status: SellerSafeAutomationStatus;
  codDecision: CodDecision;
  shipmentDecision: ShipmentDecision;
}) {
  if (input.status === "OTP_SENT") {
    return "COD verification has been sent automatically. Shipment will release after buyer verification.";
  }

  if (input.status === "PREPAID_LINK_SENT" || input.codDecision === "PREPAID_ONLY") {
    return "COD is not recommended for this order. A prepaid payment link has been sent if enabled by your policy.";
  }

  if (input.status === "ADDRESS_CORRECTION_SENT") {
    return "Address confirmation has been sent automatically. Shipment will continue after buyer confirmation.";
  }

  if (input.status === "SELLER_APPROVAL_REQUIRED") {
    return "This order needs your approval before shipment moves ahead.";
  }

  if (input.status === "INTERNAL_REVIEW") {
    return "Shipmastr is reviewing this order and will surface only required seller actions.";
  }

  if (input.status === "NDR_REATTEMPT_REQUESTED") {
    return "Buyer confirmation was received and a delivery reattempt has been requested.";
  }

  if (input.status === "RELEASED" || (input.shipmentDecision === "SHIP" && input.codDecision === "ALLOW_COD")) {
    return input.tier === "BRONZE"
      ? "Buyer verification is complete. Order cleared for shipment."
      : "Order cleared for shipment.";
  }

  return "Automation is monitoring this order and will ask you only if seller action is needed.";
}

function safeCourierRecommendation(recommendation: DecisionCourier, shipment: DecisionShipment) {
  if (!recommendation && !shipment?.courierId) return null;

  const metadata = jsonObject(recommendation?.metadata);
  return {
    courierId: recommendation?.courierId ?? shipment?.courierId ?? null,
    courierName: typeof metadata.courierName === "string" ? metadata.courierName : null,
    courierCode: typeof metadata.courierCode === "string" ? metadata.courierCode : null,
    estimatedCost: recommendation?.estimatedCost === null || recommendation?.estimatedCost === undefined
      ? null
      : Number(recommendation.estimatedCost),
    estimatedEtaDays: recommendation?.estimatedEtaDays ?? null,
    selectedCourierId: shipment?.courierId ?? null
  };
}

export function buildSellerSafeOrderDecisionFromRecords(input: {
  order: DecisionOrder;
  shipmentDetails: DecisionShipment;
  orderIntelligence: DecisionIntelligence;
  autonomousActions: DecisionAction[];
  buyerCommunicationEvents: DecisionCommunication[];
  actionOutcomes: DecisionOutcome[];
  courierRecommendation: DecisionCourier;
}) {
  const tier = input.orderIntelligence?.consigneeTier ?? "SILVER";
  const codDecision = input.orderIntelligence?.codDecision ?? "ALLOW_COD";
  const shipmentDecision = input.orderIntelligence?.shipmentDecision ?? shipmentDecisionFromOrder(input.order);
  const status = automationStatus({
    order: input.order,
    shipment: input.shipmentDetails,
    intelligence: input.orderIntelligence,
    actions: input.autonomousActions,
    communications: input.buyerCommunicationEvents,
    outcomes: input.actionOutcomes
  });
  const courierRecommendation = safeCourierRecommendation(input.courierRecommendation, input.shipmentDetails);
  const actionTimeline = [...input.autonomousActions]
    .sort((left, right) => dateValue(left.createdAt) - dateValue(right.createdAt))
    .map((action) => ({
      id: action.id,
      actionType: action.actionType,
      label: actionLabels[action.actionType],
      automationLevel: action.automationLevel,
      status: action.status,
      requiresApproval: action.requiresApproval,
      createdAt: action.createdAt,
      approvedAt: action.approvedAt,
      executedAt: action.executedAt,
      failedAt: action.failedAt
    }));
  const communicationTimeline = [...input.buyerCommunicationEvents]
    .sort((left, right) => dateValue(left.createdAt) - dateValue(right.createdAt))
    .map((event) => ({
      id: event.id,
      channel: event.channel,
      label: templateLabel(event.template),
      status: event.status,
      response: event.response,
      sentAt: event.sentAt,
      deliveredAt: event.deliveredAt,
      readAt: event.readAt,
      respondedAt: event.respondedAt,
      createdAt: event.createdAt
    }));

  return {
    shipmentStatus: input.shipmentDetails?.shipmentStatus ?? input.order.status,
    awb: input.shipmentDetails?.awb ?? null,
    trackingNumber: input.shipmentDetails?.trackingNumber ?? null,
    buyerTierLabel: CONSIGNEE_TIER_LABELS[tier],
    codDecision,
    shipmentDecision,
    automationStatus: status,
    pendingRequiredAction: pendingRequiredAction(status),
    courierRecommendation,
    shortReasons: shortReasons({
      tier,
      status,
      actions: input.autonomousActions,
      courierRecommendation: input.courierRecommendation
    }),
    sellerMessage: sellerMessage({ tier, status, codDecision, shipmentDecision }),
    automation: {
      status,
      total: input.autonomousActions.length,
      pendingApproval: input.autonomousActions.filter((action) => action.requiresApproval && action.status === "PENDING").length,
      executed: input.autonomousActions.filter((action) => action.status === "EXECUTED").length,
      timeline: actionTimeline
    },
    communications: communicationTimeline
  };
}

export async function buildSellerSafeOrderDecision(orderId: string, merchantId: string, client: Db = prisma) {
  const order = await client.order.findFirst({
    where: { id: orderId, merchantId },
    include: {
      shipmentDetails: true,
      orderIntelligence: true
    }
  });

  if (!order) throw new HttpError(404, "ORDER_NOT_FOUND");

  const [autonomousActions, buyerCommunicationEvents, actionOutcomes, courierRecommendation] = await Promise.all([
    client.autonomousAction.findMany({
      where: { orderId: order.id, merchantId },
      orderBy: { createdAt: "desc" },
      take: 50
    }),
    client.buyerCommunicationEvent.findMany({
      where: { orderId: order.id, merchantId },
      orderBy: { createdAt: "desc" },
      take: 50
    }),
    client.actionOutcome.findMany({
      where: { orderId: order.id, merchantId },
      orderBy: { createdAt: "desc" },
      take: 50
    }),
    client.courierRecommendation.findFirst({
      where: { orderId: order.id, merchantId },
      orderBy: { createdAt: "desc" }
    })
  ]);

  return buildSellerSafeOrderDecisionFromRecords({
    order,
    shipmentDetails: order.shipmentDetails,
    orderIntelligence: order.orderIntelligence,
    autonomousActions,
    buyerCommunicationEvents,
    actionOutcomes,
    courierRecommendation
  });
}
