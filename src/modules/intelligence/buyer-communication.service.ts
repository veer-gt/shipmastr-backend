import type {
  AutonomousActionStatus,
  AutonomousActionType,
  BuyerCommunicationEvent,
  BuyerCommunicationResponse,
  CommunicationChannel,
  CommunicationStatus,
  Order,
  Prisma
} from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { getOrCreateMerchantAutomationPolicy } from "./action-policy.service.js";
import { scoreAddressConfidence } from "./address-intelligence.service.js";
import { addressHash, phoneHash } from "./fingerprint.js";

type Db = Prisma.TransactionClient | typeof prisma;

export type BuyerCommunicationInput = {
  orderId: string;
  merchantId: string;
  phoneHash?: string | null | undefined;
  channel: CommunicationChannel;
  template: string;
  status?: CommunicationStatus | undefined;
  response?: BuyerCommunicationResponse | null | undefined;
  providerMessageId?: string | null | undefined;
  metadata?: Prisma.InputJsonValue | undefined;
  actionType?: AutonomousActionType | undefined;
};

export type BuyerCommunicationCallbackInput = {
  orderId: string;
  phone?: string | undefined;
  response: BuyerCommunicationResponse;
  providerMessageId?: string | undefined;
  metadata?: Prisma.InputJsonObject | undefined;
  actionType?: AutonomousActionType | undefined;
  template?: string | undefined;
};

export type CommunicationQueueFilters = {
  channel?: CommunicationChannel | undefined;
  status?: CommunicationStatus | undefined;
  limit?: number | undefined;
};

const successResponses = new Set<BuyerCommunicationResponse>([
  "OTP_VERIFIED",
  "ADDRESS_CONFIRMED",
  "ADDRESS_CORRECTED",
  "PREPAID_CONVERTED",
  "BUYER_CONFIRMED_REATTEMPT"
]);

const responseActionType: Partial<Record<BuyerCommunicationResponse, AutonomousActionType>> = {
  OTP_VERIFIED: "SEND_COD_OTP",
  OTP_FAILED: "SEND_COD_OTP",
  ADDRESS_CONFIRMED: "SEND_ADDRESS_CORRECTION_LINK",
  ADDRESS_CORRECTED: "SEND_ADDRESS_CORRECTION_LINK",
  PREPAID_CONVERTED: "SEND_PREPAID_LINK",
  BUYER_CONFIRMED_REATTEMPT: "SEND_NDR_RECOVERY_MESSAGE"
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonObject(value: unknown): Prisma.InputJsonObject | undefined {
  return isObject(value) ? value as Prisma.InputJsonObject : undefined;
}

function mergeMetadata(
  existing: Prisma.JsonValue | null | undefined,
  next: Prisma.InputJsonValue | undefined,
  additions: Prisma.InputJsonObject = {}
): Prisma.InputJsonObject | undefined {
  const merged = {
    ...(jsonObject(existing) ?? {}),
    ...(jsonObject(next) ?? {}),
    ...additions
  };

  return Object.keys(merged).length ? merged : undefined;
}

function templateActionType(template: string): AutonomousActionType | null {
  const normalized = template.toLowerCase();
  if (normalized.includes("cod_otp") || normalized.includes("otp")) return "SEND_COD_OTP";
  if (normalized.includes("address")) return "SEND_ADDRESS_CORRECTION_LINK";
  if (normalized.includes("prepaid")) return "SEND_PREPAID_LINK";
  if (normalized.includes("ndr")) return "SEND_NDR_RECOVERY_MESSAGE";
  return null;
}

function actionTypeForResponse(input: {
  response: BuyerCommunicationResponse;
  template?: string | null | undefined;
  actionType?: AutonomousActionType | null | undefined;
}) {
  return input.actionType
    ?? (input.template ? templateActionType(input.template) : null)
    ?? responseActionType[input.response]
    ?? null;
}

function responseWorked(response: BuyerCommunicationResponse) {
  if (successResponses.has(response)) return true;
  return false;
}

function actionStatusForResponse(response: BuyerCommunicationResponse): AutonomousActionStatus {
  return successResponses.has(response) ? "EXECUTED" : "FAILED";
}

function communicationTimestampPatch(status: CommunicationStatus, now: Date) {
  return {
    ...(status === "SENT" ? { sentAt: now } : {}),
    ...(status === "DELIVERED" ? { deliveredAt: now } : {}),
    ...(status === "READ" ? { readAt: now } : {}),
    ...(status === "RESPONDED" ? { respondedAt: now } : {})
  };
}

function preferredChannel(policy: {
  allowBuyerWhatsappMessages: boolean;
  allowBuyerSmsMessages: boolean;
}): CommunicationChannel {
  return policy.allowBuyerWhatsappMessages ? "WHATSAPP" : policy.allowBuyerSmsMessages ? "SMS" : "EMAIL";
}

async function upsertLatestActionOutcome(input: {
  orderId: string;
  merchantId: string;
  actionType: AutonomousActionType;
  expectedOutcome: string;
  actualOutcome?: string | null | undefined;
  worked?: boolean | null | undefined;
}, client: Db) {
  const outcome = await client.actionOutcome.findFirst({
    where: { orderId: input.orderId, actionType: input.actionType },
    orderBy: { createdAt: "desc" }
  });

  const worked = input.worked !== undefined
    ? input.worked
    : input.actualOutcome
      ? input.actualOutcome === input.expectedOutcome
      : null;

  if (!outcome) {
    return client.actionOutcome.create({
      data: {
        orderId: input.orderId,
        merchantId: input.merchantId,
        actionType: input.actionType,
        expectedOutcome: input.expectedOutcome,
        actualOutcome: input.actualOutcome ?? null,
        worked
      }
    });
  }

  return client.actionOutcome.update({
    where: { id: outcome.id },
    data: {
      expectedOutcome: outcome.expectedOutcome || input.expectedOutcome,
      actualOutcome: input.actualOutcome ?? null,
      worked
    }
  });
}

async function markCommunicationActionResponse(input: {
  orderId: string;
  merchantId: string;
  actionType: AutonomousActionType;
  response: BuyerCommunicationResponse;
  providerMessageId?: string | null | undefined;
  now: Date;
}, client: Db) {
  const status = actionStatusForResponse(input.response);
  const action = await client.autonomousAction.findFirst({
    where: {
      orderId: input.orderId,
      actionType: input.actionType,
      status: { in: ["PENDING", "EXECUTED", "APPROVED", "FAILED"] }
    },
    orderBy: { createdAt: "desc" }
  });

  if (action) {
    await client.autonomousAction.update({
      where: { id: action.id },
      data: {
        status,
        ...(status === "EXECUTED" ? { executedAt: input.now } : { failedAt: input.now }),
        resultSnapshot: {
          response: input.response,
          providerMessageId: input.providerMessageId ?? null
        }
      }
    });
  }

  await upsertLatestActionOutcome({
    orderId: input.orderId,
    merchantId: input.merchantId,
    actionType: input.actionType,
    expectedOutcome: input.response,
    actualOutcome: input.response,
    worked: responseWorked(input.response)
  }, client);
}

async function applyExecutedActionSideEffect(orderId: string, actionType: AutonomousActionType, client: Db) {
  if (actionType === "RELEASE_SHIPMENT") {
    await client.shipmentDetails.updateMany({
      where: { orderId },
      data: { shipmentStatus: "READY_TO_SHIP" }
    });
  }

  if (actionType === "REQUEST_NDR_REATTEMPT") {
    await client.shipmentDetails.updateMany({
      where: { orderId },
      data: { ndrStatus: "REATTEMPT_REQUESTED" }
    });
  }
}

async function ensureExecutedAction(input: {
  orderId: string;
  merchantId: string;
  actionType: AutonomousActionType;
  reason: string;
  expectedOutcome: string;
  actualOutcome: string;
  now: Date;
  worked?: boolean | null | undefined;
}, client: Db) {
  const existing = await client.autonomousAction.findFirst({
    where: {
      orderId: input.orderId,
      actionType: input.actionType,
      status: { notIn: ["REJECTED", "CANCELLED", "EXPIRED"] }
    },
    orderBy: { createdAt: "desc" }
  });

  if (existing) {
    await client.autonomousAction.update({
      where: { id: existing.id },
      data: {
        status: "EXECUTED",
        executedAt: input.now,
        resultSnapshot: { response: input.actualOutcome }
      }
    });
  } else {
    await client.autonomousAction.create({
      data: {
        orderId: input.orderId,
        merchantId: input.merchantId,
        actionType: input.actionType,
        automationLevel: "AUTO_EXECUTE_NOTIFY",
        status: "EXECUTED",
        reason: input.reason,
        executedAt: input.now,
        resultSnapshot: { response: input.actualOutcome }
      }
    });
  }

  await upsertLatestActionOutcome({
    orderId: input.orderId,
    merchantId: input.merchantId,
    actionType: input.actionType,
    expectedOutcome: input.expectedOutcome,
    actualOutcome: input.actualOutcome,
    worked: input.worked
  }, client);
  await applyExecutedActionSideEffect(input.orderId, input.actionType, client);
}

async function ensureSellerApprovalAction(input: {
  orderId: string;
  merchantId: string;
  reason: string;
  now: Date;
}, client: Db) {
  const existing = await client.autonomousAction.findFirst({
    where: {
      orderId: input.orderId,
      actionType: "REQUEST_SELLER_APPROVAL",
      status: "PENDING"
    }
  });

  if (existing) return existing;

  const action = await client.autonomousAction.create({
    data: {
      orderId: input.orderId,
      merchantId: input.merchantId,
      actionType: "REQUEST_SELLER_APPROVAL",
      automationLevel: "REQUIRE_SELLER_APPROVAL",
      reason: input.reason,
      requiresApproval: true
    }
  });

  await upsertLatestActionOutcome({
    orderId: input.orderId,
    merchantId: input.merchantId,
    actionType: "REQUEST_SELLER_APPROVAL",
    expectedOutcome: "SELLER_DECISION"
  }, client);

  return action;
}

async function ensureQueuedCommunicationAction(input: {
  order: Pick<Order, "id" | "merchantId">;
  actionType: AutonomousActionType;
  reason: string;
  expectedOutcome: string;
  phoneHash?: string | null | undefined;
  channel: CommunicationChannel;
  now: Date;
}, client: Db) {
  const existing = await client.autonomousAction.findFirst({
    where: {
      orderId: input.order.id,
      actionType: input.actionType,
      status: { in: ["PENDING", "EXECUTED", "APPROVED"] }
    },
    orderBy: { createdAt: "desc" }
  });

  const action = existing ?? await client.autonomousAction.create({
    data: {
      orderId: input.order.id,
      merchantId: input.order.merchantId,
      actionType: input.actionType,
      automationLevel: "AUTO_EXECUTE_NOTIFY",
      reason: input.reason
    }
  });

  await upsertLatestActionOutcome({
    orderId: input.order.id,
    merchantId: input.order.merchantId,
    actionType: input.actionType,
    expectedOutcome: input.expectedOutcome
  }, client);

  await recordBuyerCommunication({
    orderId: input.order.id,
    merchantId: input.order.merchantId,
    phoneHash: input.phoneHash ?? null,
    channel: input.channel,
    template: input.actionType.toLowerCase(),
    status: "QUEUED",
    metadata: { actionId: action.id },
    actionType: input.actionType
  }, client);

  return client.autonomousAction.update({
    where: { id: action.id },
    data: {
      status: "EXECUTED",
      executedAt: input.now,
      resultSnapshot: { queued: true }
    }
  });
}

async function updateMatchedCommunicationEvents(input: {
  orderId: string;
  phoneHash?: string | null | undefined;
  template: string;
  response: BuyerCommunicationResponse;
  providerMessageId?: string | null | undefined;
  metadata?: Prisma.InputJsonValue | undefined;
  now: Date;
}, client: Db) {
  const where: Prisma.BuyerCommunicationEventWhereInput = {
    orderId: input.orderId,
    status: { in: ["QUEUED", "SENT", "DELIVERED", "READ"] },
    ...(input.providerMessageId ? { providerMessageId: input.providerMessageId } : {
      template: input.template,
      ...(input.phoneHash ? { phoneHash: input.phoneHash } : {})
    })
  };

  const events = await client.buyerCommunicationEvent.findMany({ where, take: 10 });
  await Promise.all(events.map((event) => client.buyerCommunicationEvent.update({
    where: { id: event.id },
    data: (() => {
      const metadata = mergeMetadata(event.metadata, input.metadata, { responseEventAt: input.now.toISOString() });
      return {
        status: "RESPONDED",
        response: input.response,
        respondedAt: input.now,
        ...(input.providerMessageId ? { providerMessageId: input.providerMessageId } : {}),
        ...(metadata !== undefined ? { metadata } : {})
      };
    })()
  })));
}

async function releaseAllowed(input: {
  order: Pick<Order, "id" | "merchantId" | "orderValue" | "codAmount" | "paymentMode" | "status">;
  prepaidConverted?: boolean | undefined;
}, client: Db) {
  if (["CANCELLED", "RTO"].includes(input.order.status)) return false;

  const [intelligence, signals, policy, blockingAction, pendingAddress] = await Promise.all([
    client.orderIntelligence.findUnique({ where: { orderId: input.order.id } }),
    client.orderDataSignals.findUnique({ where: { orderId: input.order.id } }),
    getOrCreateMerchantAutomationPolicy(input.order.merchantId, client),
    client.autonomousAction.findFirst({
      where: {
        orderId: input.order.id,
        actionType: { in: ["ESCALATE_INTERNAL_REVIEW", "REQUEST_SELLER_APPROVAL"] },
        status: "PENDING"
      }
    }),
    client.autonomousAction.findFirst({
      where: {
        orderId: input.order.id,
        actionType: "SEND_ADDRESS_CORRECTION_LINK",
        status: { in: ["PENDING", "FAILED"] }
      }
    })
  ]);

  if (blockingAction) return false;
  if (pendingAddress && (intelligence?.addressConfidenceScore ?? 0) < 70) return false;
  if ((intelligence?.overallRiskScore ?? 0) >= 75) return false;
  if (intelligence?.shipmentDecision === "DO_NOT_SHIP") return false;
  if (policy.maxAutoHoldOrderValue !== null && input.order.orderValue > Number(policy.maxAutoHoldOrderValue)) return false;
  if (input.order.paymentMode === "COD" && policy.maxAutoCodAmount !== null && input.order.codAmount > Number(policy.maxAutoCodAmount)) return false;

  const otpStillRequired = input.order.paymentMode === "COD"
    && intelligence?.consigneeTier === "BRONZE"
    && !signals?.otpVerified
    && input.prepaidConverted !== true;

  return !otpStillRequired;
}

async function releaseIfAllowed(input: {
  order: Order;
  reason: string;
  now: Date;
  prepaidConverted?: boolean | undefined;
}, client: Db) {
  if (!await releaseAllowed(input, client)) return false;

  await ensureExecutedAction({
    orderId: input.order.id,
    merchantId: input.order.merchantId,
    actionType: "RELEASE_SHIPMENT",
    reason: input.reason,
    expectedOutcome: "SHIPMENT_RELEASED",
    actualOutcome: "SHIPMENT_RELEASED",
    worked: true,
    now: input.now
  }, client);

  await client.orderIntelligence.updateMany({
    where: { orderId: input.order.id },
    data: { shipmentDecision: "SHIP" }
  });

  return true;
}

function correctedAddressFromMetadata(metadata?: Prisma.InputJsonObject | undefined) {
  const source = jsonObject(metadata?.correctedAddress)
    ?? jsonObject(metadata?.address)
    ?? metadata;
  if (!source) return {};

  return {
    ...(typeof source.addressLine1 === "string" ? { addressLine1: source.addressLine1 } : {}),
    ...(typeof source.addressLine2 === "string" ? { addressLine2: source.addressLine2 } : {}),
    ...(typeof source.city === "string" ? { city: source.city } : {}),
    ...(typeof source.state === "string" ? { state: source.state } : {}),
    ...(typeof source.pincode === "string" ? { pincode: source.pincode } : {})
  };
}

async function rescoreAddress(input: {
  order: Order;
  response: BuyerCommunicationResponse;
  metadata?: Prisma.InputJsonObject | undefined;
}, client: Db) {
  const patch = correctedAddressFromMetadata(input.metadata);
  const order = Object.keys(patch).length
    ? await client.order.update({ where: { id: input.order.id }, data: patch })
    : input.order;
  const confidence = scoreAddressConfidence(order);
  const confirmedScore = input.response === "ADDRESS_CONFIRMED" || input.response === "ADDRESS_CORRECTED"
    ? Math.max(confidence.score, 80)
    : confidence.score;

  await Promise.all([
    client.orderDataSignals.updateMany({
      where: { orderId: order.id },
      data: { addressEditedAfterCreation: true }
    }),
    client.shipmentDetails.updateMany({
      where: { orderId: order.id },
      data: {
        pincode: order.pincode,
        city: order.city,
        state: order.state,
        addressHash: confidence.addressHash
      }
    }),
    client.orderIntelligence.updateMany({
      where: { orderId: order.id },
      data: {
        addressHash: confidence.addressHash,
        addressConfidenceScore: confirmedScore,
        overallRiskScore: { decrement: 5 },
        dataSnapshot: {
          addressRescore: {
            addressHash: confidence.addressHash,
            addressConfidenceScore: confirmedScore,
            reasons: confidence.reasons
          }
        }
      }
    })
  ]);

  return client.order.findUniqueOrThrow({ where: { id: order.id } });
}

async function handleOtpFailure(input: {
  order: Order;
  phoneHash?: string | null | undefined;
  response: BuyerCommunicationResponse;
  now: Date;
}, client: Db) {
  await client.shipmentDetails.updateMany({
    where: { orderId: input.order.id },
    data: { shipmentStatus: "HELD" }
  });

  await client.orderIntelligence.updateMany({
    where: { orderId: input.order.id },
    data: { shipmentDecision: "VERIFY_BEFORE_SHIP" }
  });

  const policy = await getOrCreateMerchantAutomationPolicy(input.order.merchantId, client);
  if (policy.allowPrepaidConversionMessage && (policy.allowBuyerWhatsappMessages || policy.allowBuyerSmsMessages)) {
    await ensureQueuedCommunicationAction({
      order: input.order,
      actionType: "SEND_PREPAID_LINK",
      reason: input.response === "NO_RESPONSE" ? "OTP verification timed out; offer prepaid conversion" : "OTP verification failed; offer prepaid conversion",
      expectedOutcome: "PREPAID_CONVERTED",
      phoneHash: input.phoneHash ?? null,
      channel: preferredChannel(policy),
      now: input.now
    }, client);
    return;
  }

  await ensureSellerApprovalAction({
    orderId: input.order.id,
    merchantId: input.order.merchantId,
    reason: "OTP verification failed and prepaid conversion messaging is unavailable",
    now: input.now
  }, client);
}

async function handleResponseSideEffects(input: {
  order: Order;
  response: BuyerCommunicationResponse;
  actionType: AutonomousActionType | null;
  phoneHash?: string | null | undefined;
  metadata?: Prisma.InputJsonObject | undefined;
  now: Date;
}, client: Db) {
  if (input.response === "OTP_VERIFIED") {
    await client.orderDataSignals.updateMany({
      where: { orderId: input.order.id },
      data: { otpVerified: true }
    });
    await client.orderIntelligence.updateMany({
      where: { orderId: input.order.id },
      data: {
        codRiskScore: 5,
        overallRiskScore: { decrement: 10 }
      }
    });
    await releaseIfAllowed({
      order: input.order,
      reason: "OTP verification succeeded",
      now: input.now
    }, client);
  }

  if (input.response === "OTP_FAILED" || input.response === "NO_RESPONSE") {
    await handleOtpFailure({
      order: input.order,
      phoneHash: input.phoneHash,
      response: input.response,
      now: input.now
    }, client);
  }

  if (input.response === "ADDRESS_CONFIRMED" || input.response === "ADDRESS_CORRECTED") {
    const updatedOrder = await rescoreAddress({
      order: input.order,
      response: input.response,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {})
    }, client);

    if (updatedOrder.status === "NDR") {
      await ensureExecutedAction({
        orderId: updatedOrder.id,
        merchantId: updatedOrder.merchantId,
        actionType: "REQUEST_NDR_REATTEMPT",
        reason: "Corrected address confirmed for NDR shipment",
        expectedOutcome: "DELIVERED_AFTER_REATTEMPT",
        actualOutcome: "REATTEMPT_REQUESTED",
        worked: null,
        now: input.now
      }, client);
    } else {
      await releaseIfAllowed({
        order: updatedOrder,
        reason: "Address correction confirmed",
        now: input.now
      }, client);
    }
  }

  if (input.response === "PREPAID_CONVERTED") {
    await client.orderDataSignals.updateMany({
      where: { orderId: input.order.id },
      data: { paymentModeChangedAfterCreation: true }
    });
    await client.orderIntelligence.updateMany({
      where: { orderId: input.order.id },
      data: {
        codDecision: "ALLOW_COD",
        codRiskScore: 0,
        overallRiskScore: { decrement: 15 }
      }
    });
    await releaseIfAllowed({
      order: input.order,
      reason: "Prepaid conversion confirmed",
      prepaidConverted: true,
      now: input.now
    }, client);
  }

  if (input.response === "BUYER_CONFIRMED_REATTEMPT") {
    await ensureExecutedAction({
      orderId: input.order.id,
      merchantId: input.order.merchantId,
      actionType: "REQUEST_NDR_REATTEMPT",
      reason: "Buyer confirmed NDR delivery reattempt",
      expectedOutcome: "DELIVERED_AFTER_REATTEMPT",
      actualOutcome: "REATTEMPT_REQUESTED",
      worked: null,
      now: input.now
    }, client);
  }

  if (input.response === "BUYER_REFUSED" || input.response === "INVALID_RESPONSE") {
    await ensureSellerApprovalAction({
      orderId: input.order.id,
      merchantId: input.order.merchantId,
      reason: input.response === "BUYER_REFUSED" ? "Buyer refused automated recovery flow" : "Buyer returned invalid automated response",
      now: input.now
    }, client);
  }
}

export function buildCommunicationQueueWhere(filters: CommunicationQueueFilters) {
  return {
    status: filters.status ?? "QUEUED",
    ...(filters.channel ? { channel: filters.channel } : {})
  } satisfies Prisma.BuyerCommunicationEventWhereInput;
}

export async function listQueuedBuyerCommunications(filters: CommunicationQueueFilters, client: Db = prisma) {
  return client.buyerCommunicationEvent.findMany({
    where: buildCommunicationQueueWhere(filters),
    orderBy: { createdAt: "asc" },
    take: Math.min(Math.max(filters.limit ?? 50, 1), 200)
  });
}

export async function updateBuyerCommunicationStatus(input: {
  id: string;
  status: Extract<CommunicationStatus, "SENT" | "DELIVERED" | "READ" | "FAILED">;
  providerMessageId?: string | undefined;
  metadata?: Prisma.InputJsonObject | undefined;
}, client: Db = prisma) {
  const now = new Date();
  const event = await client.buyerCommunicationEvent.findUniqueOrThrow({ where: { id: input.id } });
  const metadata = mergeMetadata(event.metadata, input.metadata, {
    statusUpdatedAt: now.toISOString(),
    ...(input.providerMessageId ? { providerMessageId: input.providerMessageId } : {})
  });

  return client.buyerCommunicationEvent.update({
    where: { id: input.id },
    data: {
      status: input.status,
      ...communicationTimestampPatch(input.status, now),
      ...(input.providerMessageId !== undefined ? { providerMessageId: input.providerMessageId } : {}),
      ...(metadata !== undefined ? { metadata } : {})
    }
  });
}

export async function recordBuyerCommunication(input: BuyerCommunicationInput, client: Db = prisma) {
  const now = new Date();
  const event = await client.buyerCommunicationEvent.create({
    data: {
      orderId: input.orderId,
      merchantId: input.merchantId,
      phoneHash: input.phoneHash ?? null,
      channel: input.channel,
      template: input.template,
      status: input.status ?? "QUEUED",
      response: input.response ?? null,
      providerMessageId: input.providerMessageId ?? null,
      sentAt: input.status && input.status !== "QUEUED" ? now : null,
      respondedAt: input.response ? now : null,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {})
    }
  });

  const response = input.response ?? null;
  const actionType = response
    ? actionTypeForResponse({ response, template: input.template, actionType: input.actionType })
    : null;

  if (response) {
    await updateMatchedCommunicationEvents({
      orderId: input.orderId,
      phoneHash: input.phoneHash,
      template: input.template,
      response,
      providerMessageId: input.providerMessageId,
      metadata: input.metadata,
      now
    }, client);

    if (actionType) {
      await markCommunicationActionResponse({
        orderId: input.orderId,
        merchantId: input.merchantId,
        actionType,
        response,
        providerMessageId: input.providerMessageId,
        now
      }, client);
    }
  }

  if (input.channel === "WHATSAPP" && response && response !== "NO_RESPONSE") {
    await client.orderDataSignals.updateMany({
      where: { orderId: input.orderId },
      data: { whatsappConfirmed: true }
    });
  }

  const order = response
    ? await client.order.findUnique({ where: { id: input.orderId } })
    : null;

  if (order && response) {
    await handleResponseSideEffects({
      order,
      response,
      actionType,
      phoneHash: input.phoneHash,
      metadata: jsonObject(input.metadata),
      now
    }, client);
  }

  return event;
}

export async function handleBuyerCommunicationCallback(input: BuyerCommunicationCallbackInput, client: Db = prisma) {
  const order = await client.order.findUniqueOrThrow({ where: { id: input.orderId } });
  const pHash = input.phone ? phoneHash(input.phone) : null;
  const latest = await client.buyerCommunicationEvent.findFirst({
    where: {
      orderId: input.orderId,
      ...(pHash ? { phoneHash: pHash } : {}),
      ...(input.providerMessageId ? { providerMessageId: input.providerMessageId } : {})
    },
    orderBy: { createdAt: "desc" }
  });
  const actionType = actionTypeForResponse({
    response: input.response,
    template: input.template ?? latest?.template,
    actionType: input.actionType
  });
  const template = input.template ?? latest?.template ?? actionType?.toLowerCase() ?? "buyer_response";
  const event = await recordBuyerCommunication({
    orderId: order.id,
    merchantId: order.merchantId,
    phoneHash: pHash ?? latest?.phoneHash ?? null,
    channel: latest?.channel ?? "WHATSAPP",
    template,
    status: "RESPONDED",
    response: input.response,
    providerMessageId: input.providerMessageId ?? latest?.providerMessageId ?? null,
    metadata: input.metadata,
    ...(actionType ? { actionType } : {})
  }, client);
  const actions = await client.autonomousAction.findMany({
    where: { orderId: order.id },
    orderBy: { createdAt: "desc" },
    take: 10
  });

  return {
    event,
    actionType,
    actions
  };
}

export function sellerSafeCommunicationEvent(event: BuyerCommunicationEvent) {
  return {
    id: event.id,
    orderId: event.orderId,
    merchantId: event.merchantId,
    phoneHash: event.phoneHash,
    channel: event.channel,
    template: event.template,
    status: event.status,
    response: event.response,
    providerMessageId: event.providerMessageId,
    sentAt: event.sentAt,
    deliveredAt: event.deliveredAt,
    readAt: event.readAt,
    respondedAt: event.respondedAt,
    createdAt: event.createdAt
  };
}
