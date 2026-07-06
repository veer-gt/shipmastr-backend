import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { env } from "../../config/env.js";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { phoneHash } from "../intelligence/fingerprint.js";
import { parseMinorUnit } from "./checkout-quote.service.js";

type DbClient = typeof prisma | Prisma.TransactionClient | any;

export const CHECKOUT_TELEMETRY_DEVICE_TYPES = ["MOBILE", "DESKTOP", "TABLET", "BOT", "UNKNOWN"] as const;
export const CHECKOUT_TELEMETRY_SESSION_STATUSES = ["STARTED", "COMPLETED", "ABANDONED"] as const;
export const CHECKOUT_TELEMETRY_EVENT_SOURCES = [
  "FRONTEND",
  "BACKEND",
  "PAYMENT_WEBHOOK",
  "COD_ENGINE",
  "ORDER_SERVICE",
  "CHECKOUT_ACCOUNTING",
  "CHECKOUT_TIMELINE",
  "WORKER",
  "FUTURE_SHIPPING_SERVICE"
] as const;
export const CHECKOUT_TELEMETRY_PAYMENT_ATTEMPT_STATUSES = ["STARTED", "SUCCEEDED", "FAILED", "ABANDONED"] as const;
export const CHECKOUT_TELEMETRY_FAILURE_STAGES = [
  "ADDRESS_VERIFICATION",
  "SHIPPING_METHOD",
  "PAYMENT",
  "CHECKOUT_COD_OTP",
  "ORDER_CREATION",
  "INVENTORY",
  "RISK_ENGINE",
  "LOGISTICS_HANDOFF_FUTURE",
  "WEBHOOK",
  "UNKNOWN"
] as const;

export type CheckoutTelemetryDeviceType = (typeof CHECKOUT_TELEMETRY_DEVICE_TYPES)[number];
export type CheckoutTelemetrySessionStatus = (typeof CHECKOUT_TELEMETRY_SESSION_STATUSES)[number];
export type CheckoutTelemetryEventSource = (typeof CHECKOUT_TELEMETRY_EVENT_SOURCES)[number];
export type CheckoutTelemetryPaymentAttemptStatus = (typeof CHECKOUT_TELEMETRY_PAYMENT_ATTEMPT_STATUSES)[number];
export type CheckoutTelemetryFailureStage = (typeof CHECKOUT_TELEMETRY_FAILURE_STAGES)[number];

type ServiceOptions = {
  client?: DbClient | undefined;
};

export type CheckoutTelemetrySessionInput = {
  merchantId: string;
  sessionId: string;
  sellerId?: string | null | undefined;
  checkoutOrderId?: string | null | undefined;
  cartId?: string | null | undefined;
  quoteId?: string | null | undefined;
  userId?: string | null | undefined;
  anonymousId?: string | null | undefined;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  emailHash?: string | null | undefined;
  phoneHash?: string | null | undefined;
  userAgent?: string | null | undefined;
  deviceType?: CheckoutTelemetryDeviceType | null | undefined;
  trafficSource?: string | null | undefined;
  utmSource?: string | null | undefined;
  utmMedium?: string | null | undefined;
  utmCampaign?: string | null | undefined;
  cartValueMinor?: string | number | bigint | null | undefined;
  currency?: string | null | undefined;
  cartSize?: number | null | undefined;
  status?: CheckoutTelemetrySessionStatus | null | undefined;
  startedAt?: Date | null | undefined;
  completedAt?: Date | null | undefined;
  abandonedAt?: Date | null | undefined;
};

export type CheckoutTelemetryEventInput = {
  eventName: string;
  telemetrySessionId: string;
  merchantId: string;
  sellerId?: string | null | undefined;
  checkoutOrderId?: string | null | undefined;
  checkoutPaymentId?: string | null | undefined;
  accountingEventId?: string | null | undefined;
  timelineEntryId?: string | null | undefined;
  requestId?: string | null | undefined;
  idempotencyKey?: string | null | undefined;
  source: CheckoutTelemetryEventSource;
  occurredAt?: Date | null | undefined;
  payloadJson?: unknown;
};

export type CheckoutTelemetryPaymentAttemptInput = {
  telemetrySessionId: string;
  merchantId: string;
  sellerId?: string | null | undefined;
  checkoutOrderId?: string | null | undefined;
  checkoutPaymentId?: string | null | undefined;
  paymentMethod: string;
  gatewayUsed?: string | null | undefined;
  amountMinor?: string | number | bigint | null | undefined;
  currency?: string | null | undefined;
  status: CheckoutTelemetryPaymentAttemptStatus;
  gatewayPaymentId?: string | null | undefined;
  gatewayOrderId?: string | null | undefined;
  errorCode?: string | null | undefined;
  errorMessage?: string | null | undefined;
  attemptNumber?: number | null | undefined;
  startedAt?: Date | null | undefined;
  completedAt?: Date | null | undefined;
};

export type CheckoutTelemetryFailureInput = {
  telemetrySessionId: string;
  merchantId: string;
  sellerId?: string | null | undefined;
  checkoutOrderId?: string | null | undefined;
  checkoutPaymentId?: string | null | undefined;
  telemetryPaymentAttemptId?: string | null | undefined;
  failureStage: CheckoutTelemetryFailureStage;
  failureReason: string;
  failureCode?: string | null | undefined;
  failureMessage?: string | null | undefined;
  amountAtRiskMinor?: string | number | bigint | null | undefined;
  currency?: string | null | undefined;
  isRecoverable?: boolean | null | undefined;
  source: CheckoutTelemetryEventSource;
};

function nonEmpty(value: string | null | undefined, field: string) {
  const trimmed = value?.trim();
  if (!trimmed) throw new HttpError(400, "CHECKOUT_TELEMETRY_FIELD_REQUIRED", { field });
  return trimmed;
}

function optionalText(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed || null;
}

function requiredNonNegativeInt(value: number | null | undefined, fallback: number, field: string) {
  const next = value ?? fallback;
  if (!globalThis.Number.isSafeInteger(next) || next < 0) {
    throw new HttpError(400, "CHECKOUT_TELEMETRY_INTEGER_INVALID", { field });
  }
  return next;
}

function requiredPositiveInt(value: number | null | undefined, fallback: number, field: string) {
  const next = value ?? fallback;
  if (!globalThis.Number.isSafeInteger(next) || next <= 0) {
    throw new HttpError(400, "CHECKOUT_TELEMETRY_INTEGER_INVALID", { field });
  }
  return next;
}

function assertOneOf<T extends readonly string[]>(value: string, allowed: T, field: string): T[number] {
  if (!allowed.includes(value)) throw new HttpError(400, "CHECKOUT_TELEMETRY_VALUE_INVALID", { field });
  return value as T[number];
}

function normalizeCurrency(value: string | null | undefined) {
  return optionalText(value)?.toUpperCase() ?? "INR";
}

function normalizeMinor(value: string | number | bigint | null | undefined, field: string) {
  return parseMinorUnit(value ?? "0", field);
}

function isUniqueConflict(error: unknown) {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "P2002");
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function hashCheckoutTelemetryEmail(value: string) {
  return sha256(`email:${value.trim().toLowerCase()}${env.APP_SECRET_PEPPER}`);
}

export function hashCheckoutTelemetryPhone(value: string) {
  return phoneHash(value);
}

export function deriveCheckoutTelemetryDeviceType(userAgent?: string | null): CheckoutTelemetryDeviceType {
  const raw = userAgent?.trim();
  if (!raw) return "UNKNOWN";
  const ua = raw.toLowerCase();

  if (/bot|crawler|spider|slurp|bingpreview|facebookexternalhit|whatsapp|telegrambot|duckduckbot|baiduspider/u.test(ua)) {
    return "BOT";
  }

  if (/ipad|tablet|kindle|silk|playbook|nexus 7|nexus 9|sm-t|tab\b/u.test(ua)) {
    return "TABLET";
  }

  if (/mobi|iphone|ipod|android.*mobile|windows phone|opera mini/u.test(ua)) {
    return "MOBILE";
  }

  if (/windows nt|macintosh|x11|linux x86_64|cros/u.test(ua)) {
    return "DESKTOP";
  }

  return "UNKNOWN";
}

const unsafeRawContactKey = /email|phone|mobile|whatsapp/i;
const safeHashOrMaskKey = /hash|masked|mask/i;
const emailLike = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;

function containsPhoneLikeValue(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

function sanitizeTelemetryValue(value: unknown): unknown {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(sanitizeTelemetryValue);
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (unsafeRawContactKey.test(key) && !safeHashOrMaskKey.test(key)) continue;
      output[key] = sanitizeTelemetryValue(child);
    }
    return output;
  }
  if (typeof value === "string" && (emailLike.test(value) || containsPhoneLikeValue(value))) return "[redacted]";
  return value;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(sanitizeTelemetryValue(value ?? {}))) as Prisma.InputJsonValue;
}

function assertAuthoritativeCheckoutLinks(
  eventName: string,
  checkoutOrderId: string | null,
  checkoutPaymentId: string | null
) {
  if (eventName === "order_placed" && !checkoutOrderId) {
    throw new HttpError(400, "CHECKOUT_TELEMETRY_AUTHORITATIVE_LINK_REQUIRED", { field: "checkoutOrderId" });
  }
  if (eventName === "payment_succeeded") {
    if (!checkoutOrderId) {
      throw new HttpError(400, "CHECKOUT_TELEMETRY_AUTHORITATIVE_LINK_REQUIRED", { field: "checkoutOrderId" });
    }
    if (!checkoutPaymentId) {
      throw new HttpError(400, "CHECKOUT_TELEMETRY_AUTHORITATIVE_LINK_REQUIRED", { field: "checkoutPaymentId" });
    }
  }
}

export class CheckoutTelemetryService {
  constructor(
    private readonly client: DbClient = prisma,
    private readonly now: () => Date = () => new Date()
  ) {}

  private db(options?: ServiceOptions) {
    return options?.client ?? this.client;
  }

  async createOrUpdateSession(input: CheckoutTelemetrySessionInput, options: ServiceOptions = {}) {
    const client = this.db(options);
    const merchantId = nonEmpty(input.merchantId, "merchantId");
    const sessionId = nonEmpty(input.sessionId, "sessionId");
    const deviceType = input.deviceType
      ? assertOneOf(input.deviceType, CHECKOUT_TELEMETRY_DEVICE_TYPES, "deviceType")
      : deriveCheckoutTelemetryDeviceType(input.userAgent);
    const status = input.status
      ? assertOneOf(input.status, CHECKOUT_TELEMETRY_SESSION_STATUSES, "status")
      : "STARTED";

    const data = {
      merchantId,
      sellerId: optionalText(input.sellerId),
      checkoutOrderId: optionalText(input.checkoutOrderId),
      cartId: optionalText(input.cartId),
      quoteId: optionalText(input.quoteId),
      userId: optionalText(input.userId),
      sessionId,
      anonymousId: optionalText(input.anonymousId),
      emailHash: optionalText(input.emailHash) ?? (input.email ? hashCheckoutTelemetryEmail(input.email) : null),
      phoneHash: optionalText(input.phoneHash) ?? (input.phone ? hashCheckoutTelemetryPhone(input.phone) : null),
      deviceType,
      trafficSource: optionalText(input.trafficSource),
      utmSource: optionalText(input.utmSource),
      utmMedium: optionalText(input.utmMedium),
      utmCampaign: optionalText(input.utmCampaign),
      cartValueMinor: normalizeMinor(input.cartValueMinor, "cartValueMinor"),
      currency: normalizeCurrency(input.currency),
      cartSize: requiredNonNegativeInt(input.cartSize, 0, "cartSize"),
      status,
      startedAt: input.startedAt ?? this.now(),
      completedAt: input.completedAt ?? null,
      abandonedAt: input.abandonedAt ?? null
    };

    return client.checkoutTelemetrySession.upsert({
      where: {
        merchantId_sessionId: {
          merchantId,
          sessionId
        }
      },
      create: data,
      update: {
        ...data,
        startedAt: input.startedAt ?? undefined
      }
    });
  }

  async recordEvent(input: CheckoutTelemetryEventInput, options: ServiceOptions = {}) {
    const client = this.db(options);
    const eventName = nonEmpty(input.eventName, "eventName");
    const telemetrySessionId = nonEmpty(input.telemetrySessionId, "telemetrySessionId");
    const merchantId = nonEmpty(input.merchantId, "merchantId");
    const idempotencyKey = optionalText(input.idempotencyKey);
    const source = assertOneOf(input.source, CHECKOUT_TELEMETRY_EVENT_SOURCES, "source");
    const checkoutOrderId = optionalText(input.checkoutOrderId);
    const checkoutPaymentId = optionalText(input.checkoutPaymentId);
    assertAuthoritativeCheckoutLinks(eventName, checkoutOrderId, checkoutPaymentId);

    try {
      return await client.checkoutTelemetryEvent.create({
        data: {
          eventName,
          telemetrySessionId,
          merchantId,
          sellerId: optionalText(input.sellerId),
          checkoutOrderId,
          checkoutPaymentId,
          accountingEventId: optionalText(input.accountingEventId),
          timelineEntryId: optionalText(input.timelineEntryId),
          requestId: optionalText(input.requestId),
          idempotencyKey,
          source,
          occurredAt: input.occurredAt ?? this.now(),
          payloadJson: toJson(input.payloadJson)
        }
      });
    } catch (error) {
      if (!idempotencyKey || !isUniqueConflict(error)) throw error;
      const existing = await client.checkoutTelemetryEvent.findUnique({
        where: {
          telemetrySessionId_eventName_idempotencyKey: {
            telemetrySessionId,
            eventName,
            idempotencyKey
          }
        }
      });
      if (existing) return existing;
      throw error;
    }
  }

  async createPaymentAttempt(input: CheckoutTelemetryPaymentAttemptInput, options: ServiceOptions = {}) {
    const client = this.db(options);
    return client.checkoutTelemetryPaymentAttempt.create({
      data: {
        telemetrySessionId: nonEmpty(input.telemetrySessionId, "telemetrySessionId"),
        merchantId: nonEmpty(input.merchantId, "merchantId"),
        sellerId: optionalText(input.sellerId),
        checkoutOrderId: optionalText(input.checkoutOrderId),
        checkoutPaymentId: optionalText(input.checkoutPaymentId),
        paymentMethod: nonEmpty(input.paymentMethod, "paymentMethod"),
        gatewayUsed: optionalText(input.gatewayUsed),
        amountMinor: normalizeMinor(input.amountMinor, "amountMinor"),
        currency: normalizeCurrency(input.currency),
        status: assertOneOf(input.status, CHECKOUT_TELEMETRY_PAYMENT_ATTEMPT_STATUSES, "status"),
        gatewayPaymentId: optionalText(input.gatewayPaymentId),
        gatewayOrderId: optionalText(input.gatewayOrderId),
        errorCode: optionalText(input.errorCode),
        errorMessage: optionalText(input.errorMessage),
        attemptNumber: requiredPositiveInt(input.attemptNumber, 1, "attemptNumber"),
        startedAt: input.startedAt ?? this.now(),
        completedAt: input.completedAt ?? null
      }
    });
  }

  async createFailure(input: CheckoutTelemetryFailureInput, options: ServiceOptions = {}) {
    const client = this.db(options);
    return client.checkoutTelemetryFailure.create({
      data: {
        telemetrySessionId: nonEmpty(input.telemetrySessionId, "telemetrySessionId"),
        merchantId: nonEmpty(input.merchantId, "merchantId"),
        sellerId: optionalText(input.sellerId),
        checkoutOrderId: optionalText(input.checkoutOrderId),
        checkoutPaymentId: optionalText(input.checkoutPaymentId),
        telemetryPaymentAttemptId: optionalText(input.telemetryPaymentAttemptId),
        failureStage: assertOneOf(input.failureStage, CHECKOUT_TELEMETRY_FAILURE_STAGES, "failureStage"),
        failureReason: nonEmpty(input.failureReason, "failureReason"),
        failureCode: optionalText(input.failureCode),
        failureMessage: optionalText(input.failureMessage),
        amountAtRiskMinor: normalizeMinor(input.amountAtRiskMinor, "amountAtRiskMinor"),
        currency: normalizeCurrency(input.currency),
        isRecoverable: Boolean(input.isRecoverable),
        source: assertOneOf(input.source, CHECKOUT_TELEMETRY_EVENT_SOURCES, "source")
      }
    });
  }
}
