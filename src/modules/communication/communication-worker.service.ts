import type {
  BuyerCommunicationEvent,
  CommunicationChannel,
  CommunicationStatus,
  MerchantAutomationPolicy,
  Prisma
} from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { audit } from "../audit/audit.service.js";
import { getOrCreateMerchantAutomationPolicy } from "../intelligence/action-policy.service.js";
import {
  listQueuedBuyerCommunications,
  updateBuyerCommunicationStatus
} from "../intelligence/buyer-communication.service.js";
import { createCommunicationProvider } from "./communication-provider.factory.js";
import type {
  CommunicationProvider,
  CommunicationTemplate,
  SendMessageInput
} from "./communication-provider.types.js";
import {
  communicationTemplateRegistry,
  validateTemplateData
} from "./communication-template.registry.js";

type Db = Prisma.TransactionClient | typeof prisma;

const sentLikeStatuses = new Set<CommunicationStatus>(["SENT", "DELIVERED", "READ", "RESPONDED"]);
const permanentFailureReasons = new Set(["MISSING_RECIPIENT", "TEMPLATE_INVALID", "UNSUPPORTED_CHANNEL", "COMMUNICATION_DISABLED", "CHANNEL_DISABLED"]);
const transientFailureReasons = new Set(["PROVIDER_SEND_FAILED", "DAILY_CAP_EXCEEDED", "QUIET_HOURS"]);
const deliveryStatuses = new Set<Extract<CommunicationStatus, "SENT" | "DELIVERED" | "READ" | "FAILED">>([
  "SENT",
  "DELIVERED",
  "READ",
  "FAILED"
]);

export type CommunicationProcessResult = {
  id: string;
  status: BuyerCommunicationEvent["status"];
  providerMessageId: string | null;
  skipped: boolean;
  reason?: string | undefined;
};

export type ProviderDeliveryCallbackInput = {
  providerMessageId: string;
  status: Extract<CommunicationStatus, "SENT" | "DELIVERED" | "READ" | "FAILED">;
  errorCode?: string | undefined;
  metadata?: Prisma.InputJsonObject | undefined;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonObject(value: unknown): Prisma.InputJsonObject | undefined {
  return isObject(value) ? value as Prisma.InputJsonObject : undefined;
}

function metadataString(value: unknown, key: string): string | null {
  if (!isObject(value)) return null;
  const candidate = value[key];
  return typeof candidate === "string" && candidate.trim() ? candidate : null;
}

function metadataBoolean(value: unknown, key: string) {
  return isObject(value) && typeof value[key] === "boolean" ? value[key] as boolean : null;
}

function templateFromEvent(event: Pick<BuyerCommunicationEvent, "template">): CommunicationTemplate {
  const normalized = event.template.toLowerCase();
  if (normalized.includes("cod_otp") || normalized.includes("otp")) return "COD_OTP";
  if (normalized.includes("address")) return "ADDRESS_CORRECTION";
  if (normalized.includes("prepaid")) return "PREPAID_LINK";
  if (normalized.includes("ndr")) return "NDR_RECOVERY";
  return "ORDER_CONFIRMATION";
}

function idempotencyKeyFor(event: Pick<BuyerCommunicationEvent, "id" | "channel">, template: CommunicationTemplate) {
  return `buyer-communication:${event.id}:${template}:${event.channel}`;
}

function recipientPhoneFromMetadata(metadata: Prisma.InputJsonObject | undefined): string | null {
  return metadataString(metadata, "recipientPhone")
    ?? metadataString(metadata?.providerPayload, "recipientPhone")
    ?? metadataString(metadata?.secure, "recipientPhone")
    ?? metadataString(metadata?.securePayload, "recipientPhone");
}

async function recipientPhoneForEvent(event: BuyerCommunicationEvent, client: Db) {
  const metadata = jsonObject(event.metadata);
  const fromMetadata = recipientPhoneFromMetadata(metadata);
  if (fromMetadata) return fromMetadata;

  const order = await client.order.findUnique({
    where: { id: event.orderId },
    select: { buyerPhone: true }
  });

  return order?.buyerPhone ?? null;
}

function retryCount(metadata: Prisma.InputJsonObject | undefined) {
  const value = metadata?.retryCount;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function templateDataForEvent(event: BuyerCommunicationEvent, metadata: Prisma.InputJsonObject | undefined) {
  const template = templateFromEvent(event);
  const definition = communicationTemplateRegistry[template];

  return {
    orderId: event.orderId,
    communicationEventId: event.id,
    template: event.template,
    fallbackText: definition.fallbackText,
    ...(jsonObject(metadata?.templateData) ?? {})
  } satisfies Prisma.InputJsonObject;
}

function nextBackoffAt(now: Date, retryAttempt: number) {
  const baseMs = 5 * 60 * 1000;
  const delayMs = Math.min(baseMs * (2 ** Math.max(retryAttempt - 1, 0)), 60 * 60 * 1000);
  return new Date(now.getTime() + delayMs);
}

function parseTime(value: string | null | undefined) {
  if (!value) return null;
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function minutesSinceMidnight(value: Date) {
  return value.getHours() * 60 + value.getMinutes();
}

function quietHoursDecision(policy: MerchantAutomationPolicy, template: CommunicationTemplate, now: Date) {
  const start = parseTime(policy.buyerMessageQuietHoursStart);
  const end = parseTime(policy.buyerMessageQuietHoursEnd);
  if (start === null || end === null || start === end) return { blocked: false, nextAttemptAt: null };

  const current = minutesSinceMidnight(now);
  const blocked = start < end
    ? current >= start && current < end
    : current >= start || current < end;

  if (!blocked) return { blocked: false, nextAttemptAt: null };

  const definition = communicationTemplateRegistry[template];
  if (definition.critical && policy.autoOtpForBronzeEnabled) {
    return { blocked: false, nextAttemptAt: null };
  }

  const nextAttemptAt = new Date(now);
  nextAttemptAt.setHours(Math.floor(end / 60), end % 60, 0, 0);
  if (nextAttemptAt <= now) nextAttemptAt.setDate(nextAttemptAt.getDate() + 1);

  return { blocked: true, nextAttemptAt };
}

function startOfUtcDay(now: Date) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function channelLimit(policy: MerchantAutomationPolicy, channel: CommunicationChannel) {
  if (channel === "WHATSAPP") return policy.dailyWhatsappLimit;
  if (channel === "SMS") return policy.dailySmsLimit;
  return null;
}

function channelEnabled(policy: MerchantAutomationPolicy, channel: CommunicationChannel) {
  if (!policy.communicationEnabled) return false;
  if (channel === "WHATSAPP") return policy.allowBuyerWhatsappMessages;
  if (channel === "SMS") return policy.allowBuyerSmsMessages;
  return false;
}

async function dailySentCount(event: BuyerCommunicationEvent, now: Date, client: Db) {
  return client.buyerCommunicationEvent.count({
    where: {
      merchantId: event.merchantId,
      channel: event.channel,
      status: { in: ["SENT", "DELIVERED", "READ", "RESPONDED"] },
      sentAt: { gte: startOfUtcDay(now) }
    }
  });
}

function failureMetadata(input: {
  event: BuyerCommunicationEvent;
  template: CommunicationTemplate;
  reason: string;
  idempotencyKey: string;
  metadata: Prisma.InputJsonObject | undefined;
  now: Date;
  maxRetries: number;
  transient?: boolean | undefined;
  nextAttemptAt?: Date | null | undefined;
  extra?: Prisma.InputJsonObject | undefined;
}) {
  const nextRetryCount = retryCount(input.metadata) + 1;
  const permanent = permanentFailureReasons.has(input.reason) || input.transient === false;
  const transient = input.transient ?? (!permanent && transientFailureReasons.has(input.reason));
  const canRetry = transient && nextRetryCount < input.maxRetries;
  const nextAttemptAt = input.nextAttemptAt ?? (canRetry ? nextBackoffAt(input.now, nextRetryCount) : null);

  return {
    failureReason: input.reason,
    transientFailure: transient && !permanent && Boolean(nextAttemptAt),
    retryCount: nextRetryCount,
    communicationEventId: input.event.id,
    communicationTemplate: input.template,
    idempotencyKey: input.idempotencyKey,
    ...(nextAttemptAt ? { nextAttemptAt: nextAttemptAt.toISOString() } : {}),
    ...(input.extra ?? {})
  } satisfies Prisma.InputJsonObject;
}

function isRetryEligible(event: BuyerCommunicationEvent, metadata: Prisma.InputJsonObject | undefined, now: Date, maxRetries: number) {
  if (event.status !== "FAILED") return false;
  if (event.providerMessageId) return false;
  if (metadataBoolean(metadata, "transientFailure") !== true) return false;
  if (retryCount(metadata) >= maxRetries) return false;
  const nextAttemptAt = metadataString(metadata, "nextAttemptAt");
  if (!nextAttemptAt) return true;
  const dueAt = new Date(nextAttemptAt);
  return Number.isNaN(dueAt.getTime()) || dueAt <= now;
}

function isSendableChannel(channel: CommunicationChannel) {
  return channel === "WHATSAPP" || channel === "SMS";
}

function providerInput(
  event: BuyerCommunicationEvent,
  recipientPhone: string,
  idempotencyKey: string,
  metadata: Prisma.InputJsonObject | undefined
): SendMessageInput {
  return {
    communicationEventId: event.id,
    idempotencyKey,
    orderId: event.orderId,
    merchantId: event.merchantId,
    phoneHash: event.phoneHash,
    recipientPhone,
    channel: event.channel,
    template: templateFromEvent(event),
    templateData: templateDataForEvent(event, metadata),
    ...(metadata !== undefined ? { metadata } : {})
  };
}

async function logCommunicationAttempt(input: {
  event: BuyerCommunicationEvent;
  template: CommunicationTemplate;
  status: CommunicationStatus;
  provider: string;
  errorCode?: string | undefined;
  idempotencyKey: string;
}, client: Db) {
  return audit({
    merchantId: input.event.merchantId,
    action: "BUYER_COMMUNICATION_OUTBOUND_ATTEMPT",
    entityType: "BuyerCommunicationEvent",
    entityId: input.event.id,
    metadata: {
      eventId: input.event.id,
      merchantId: input.event.merchantId,
      channel: input.event.channel,
      template: input.template,
      status: input.status,
      provider: input.provider,
      idempotencyKey: input.idempotencyKey,
      ...(input.errorCode ? { errorCode: input.errorCode } : {})
    }
  }, client);
}

async function failEvent(input: {
  event: BuyerCommunicationEvent;
  template: CommunicationTemplate;
  idempotencyKey: string;
  reason: string;
  provider: string;
  metadata: Prisma.InputJsonObject | undefined;
  now: Date;
  maxRetries: number;
  client: Db;
  transient?: boolean | undefined;
  nextAttemptAt?: Date | null | undefined;
  extra?: Prisma.InputJsonObject | undefined;
}) {
  const failed = await updateBuyerCommunicationStatus({
    id: input.event.id,
    status: "FAILED",
    metadata: failureMetadata({
      event: input.event,
      template: input.template,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata,
      now: input.now,
      maxRetries: input.maxRetries,
      transient: input.transient,
      nextAttemptAt: input.nextAttemptAt,
      extra: {
        provider: input.provider,
        ...(input.extra ?? {})
      }
    })
  }, input.client);

  await logCommunicationAttempt({
    event: input.event,
    template: input.template,
    status: "FAILED",
    provider: input.provider,
    errorCode: input.reason,
    idempotencyKey: input.idempotencyKey
  }, input.client);

  return failed;
}

export async function processCommunicationEvent(
  event: BuyerCommunicationEvent,
  options: {
    provider?: CommunicationProvider | undefined;
    client?: Db | undefined;
    now?: Date | undefined;
    maxRetries?: number | undefined;
  } = {}
): Promise<CommunicationProcessResult> {
  const client = options.client ?? prisma;
  const now = options.now ?? new Date();
  const maxRetries = Math.max(options.maxRetries ?? 3, 1);
  const metadata = jsonObject(event.metadata);
  const template = templateFromEvent(event);
  const idempotencyKey = metadataString(metadata, "idempotencyKey") ?? idempotencyKeyFor(event, template);

  if (sentLikeStatuses.has(event.status)) {
    return {
      id: event.id,
      status: event.status,
      providerMessageId: event.providerMessageId,
      skipped: true,
      reason: "ALREADY_SENT"
    };
  }

  if (event.providerMessageId) {
    const updated = event.status === "QUEUED"
      ? await updateBuyerCommunicationStatus({
          id: event.id,
          status: "SENT",
          providerMessageId: event.providerMessageId,
          metadata: { idempotencyKey }
        }, client)
      : event;

    return {
      id: updated.id,
      status: updated.status,
      providerMessageId: updated.providerMessageId,
      skipped: true,
      reason: "ALREADY_HAS_PROVIDER_MESSAGE"
    };
  }

  if (event.status !== "QUEUED" && !isRetryEligible(event, metadata, now, maxRetries)) {
    return {
      id: event.id,
      status: event.status,
      providerMessageId: event.providerMessageId,
      skipped: true,
      reason: "NOT_RETRY_ELIGIBLE"
    };
  }

  const provider = options.provider ?? createCommunicationProvider(event.channel);

  if (!isSendableChannel(event.channel)) {
    const failed = await failEvent({
      event,
      template,
      idempotencyKey,
      reason: "UNSUPPORTED_CHANNEL",
      provider: provider.name,
      metadata,
      now,
      maxRetries,
      client,
      transient: false
    });

    return { id: failed.id, status: failed.status, providerMessageId: failed.providerMessageId, skipped: false, reason: "UNSUPPORTED_CHANNEL" };
  }

  const policy = await getOrCreateMerchantAutomationPolicy(event.merchantId, client);
  if (!channelEnabled(policy, event.channel)) {
    const reason = policy.communicationEnabled ? "CHANNEL_DISABLED" : "COMMUNICATION_DISABLED";
    const failed = await failEvent({
      event,
      template,
      idempotencyKey,
      reason,
      provider: provider.name,
      metadata,
      now,
      maxRetries,
      client,
      transient: false
    });

    return { id: failed.id, status: failed.status, providerMessageId: failed.providerMessageId, skipped: false, reason };
  }

  const templateData = templateDataForEvent(event, metadata);
  const templateValidation = validateTemplateData(template, templateData);
  if (!templateValidation.ok) {
    const failed = await failEvent({
      event,
      template,
      idempotencyKey,
      reason: "TEMPLATE_INVALID",
      provider: provider.name,
      metadata,
      now,
      maxRetries,
      client,
      transient: false,
      extra: { missingVariables: templateValidation.missingVariables }
    });

    return { id: failed.id, status: failed.status, providerMessageId: failed.providerMessageId, skipped: false, reason: "TEMPLATE_INVALID" };
  }

  const quietHours = quietHoursDecision(policy, template, now);
  if (quietHours.blocked) {
    const failed = await failEvent({
      event,
      template,
      idempotencyKey,
      reason: "QUIET_HOURS",
      provider: provider.name,
      metadata,
      now,
      maxRetries,
      client,
      transient: true,
      nextAttemptAt: quietHours.nextAttemptAt
    });

    return { id: failed.id, status: failed.status, providerMessageId: failed.providerMessageId, skipped: false, reason: "QUIET_HOURS" };
  }

  const limit = channelLimit(policy, event.channel);
  if (limit !== null && limit !== undefined) {
    const count = await dailySentCount(event, now, client);
    if (count >= limit) {
      const nextAttemptAt = new Date(startOfUtcDay(now).getTime() + 24 * 60 * 60 * 1000);
      const failed = await failEvent({
        event,
        template,
        idempotencyKey,
        reason: "DAILY_CAP_EXCEEDED",
        provider: provider.name,
        metadata,
        now,
        maxRetries,
        client,
        transient: true,
        nextAttemptAt
      });

      return { id: failed.id, status: failed.status, providerMessageId: failed.providerMessageId, skipped: false, reason: "DAILY_CAP_EXCEEDED" };
    }
  }

  const recipientPhone = await recipientPhoneForEvent(event, client);
  if (!recipientPhone) {
    const failed = await failEvent({
      event,
      template,
      idempotencyKey,
      reason: "MISSING_RECIPIENT",
      provider: provider.name,
      metadata,
      now,
      maxRetries,
      client,
      transient: false
    });

    return { id: failed.id, status: failed.status, providerMessageId: failed.providerMessageId, skipped: false, reason: "MISSING_RECIPIENT" };
  }

  try {
    const result = await provider.sendMessage(providerInput(event, recipientPhone, idempotencyKey, metadata));
    if (result.status === "FAILED") {
      const failed = await failEvent({
        event,
        template,
        idempotencyKey,
        reason: "PROVIDER_SEND_FAILED",
        provider: provider.name,
        metadata,
        now,
        maxRetries,
        client,
        transient: true,
        extra: {
          providerMessageId: result.providerMessageId,
          ...(result.rawResponse !== undefined ? { rawResponse: result.rawResponse } : {})
        }
      });

      return { id: failed.id, status: failed.status, providerMessageId: failed.providerMessageId, skipped: false, reason: "PROVIDER_SEND_FAILED" };
    }

    const updated = await updateBuyerCommunicationStatus({
      id: event.id,
      status: "SENT",
      providerMessageId: result.providerMessageId,
      metadata: {
        provider: provider.name,
        communicationTemplate: template,
        idempotencyKey,
        ...(result.rawResponse !== undefined ? { rawResponse: result.rawResponse } : {})
      }
    }, client);

    await logCommunicationAttempt({
      event,
      template,
      status: "SENT",
      provider: provider.name,
      idempotencyKey
    }, client);

    return {
      id: updated.id,
      status: updated.status,
      providerMessageId: updated.providerMessageId,
      skipped: false
    };
  } catch (err) {
    const failed = await failEvent({
      event,
      template,
      idempotencyKey,
      reason: "PROVIDER_SEND_FAILED",
      provider: provider.name,
      metadata,
      now,
      maxRetries,
      client,
      transient: !(err instanceof Error && err.message.includes("NOT_CONFIGURED")),
      extra: {
        error: err instanceof Error ? err.message : "UNKNOWN_PROVIDER_ERROR"
      }
    });

    return {
      id: failed.id,
      status: failed.status,
      providerMessageId: failed.providerMessageId,
      skipped: false,
      reason: "PROVIDER_SEND_FAILED"
    };
  }
}

async function retryableFailedCommunications(limit: number, now: Date, maxRetries: number, client: Db) {
  const candidates = await client.buyerCommunicationEvent.findMany({
    where: {
      status: "FAILED",
      providerMessageId: null
    },
    orderBy: { updatedAt: "asc" },
    take: Math.min(limit * 5, 500)
  });

  return candidates.filter((event) => isRetryEligible(event, jsonObject(event.metadata), now, maxRetries)).slice(0, limit);
}

export async function processQueuedBuyerCommunications(input: {
  limit?: number | undefined;
  provider?: CommunicationProvider | undefined;
  now?: Date | undefined;
  maxRetries?: number | undefined;
} = {}, client: Db = prisma) {
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 200);
  const now = input.now ?? new Date();
  const maxRetries = Math.max(input.maxRetries ?? 3, 1);
  const queued = await listQueuedBuyerCommunications({ status: "QUEUED", limit }, client);
  const retryable = queued.length >= limit
    ? []
    : await retryableFailedCommunications(limit - queued.length, now, maxRetries, client);
  const communications = [...queued, ...retryable];
  const results: CommunicationProcessResult[] = [];

  for (const event of communications) {
    results.push(await processCommunicationEvent(event, {
      provider: input.provider,
      client,
      now,
      maxRetries
    }));
  }

  return {
    processed: results.filter((result) => !result.skipped).length,
    sent: results.filter((result) => result.status === "SENT").length,
    failed: results.filter((result) => result.status === "FAILED").length,
    skipped: results.filter((result) => result.skipped).length,
    results
  };
}

export async function handleProviderDeliveryCallback(input: ProviderDeliveryCallbackInput, client: Db = prisma) {
  if (!deliveryStatuses.has(input.status)) {
    throw new HttpError(400, "INVALID_COMMUNICATION_STATUS");
  }

  const event = await client.buyerCommunicationEvent.findFirst({
    where: { providerMessageId: input.providerMessageId },
    orderBy: { createdAt: "desc" }
  });

  if (!event) throw new HttpError(404, "COMMUNICATION_EVENT_NOT_FOUND");

  const metadata = {
    providerCallbackAt: new Date().toISOString(),
    providerCallback: input.metadata ?? {},
    ...(input.errorCode ? { errorCode: input.errorCode } : {})
  } satisfies Prisma.InputJsonObject;

  const updated = await updateBuyerCommunicationStatus({
    id: event.id,
    status: input.status,
    providerMessageId: input.providerMessageId,
    metadata
  }, client);

  await audit({
    merchantId: event.merchantId,
    action: "BUYER_COMMUNICATION_PROVIDER_CALLBACK",
    entityType: "BuyerCommunicationEvent",
    entityId: event.id,
    metadata: {
      eventId: event.id,
      providerMessageId: input.providerMessageId,
      channel: event.channel,
      template: templateFromEvent(event),
      status: input.status,
      ...(input.errorCode ? { errorCode: input.errorCode } : {})
    }
  }, client);

  return updated;
}
