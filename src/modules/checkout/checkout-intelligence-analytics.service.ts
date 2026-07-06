import { prisma } from "../../lib/prisma.js";

type DbClient = typeof prisma | any;

export type CheckoutIntelligenceAnalyticsFilters = {
  dateFrom?: Date | undefined;
  dateTo?: Date | undefined;
  merchantId?: string | undefined;
  sellerId?: string | undefined;
  paymentMethod?: string | undefined;
  gatewayUsed?: string | undefined;
  deviceType?: string | undefined;
  failureStage?: string | undefined;
  failureReason?: string | undefined;
  errorCode?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
};

const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_CURRENCY = "INR";
const CHECKOUT_ABANDONED = "checkout_abandoned";
const CHECKOUT_ABANDONED_FAILURE_CODE = "CHECKOUT_ABANDONED";
const REFUND_DUE_FAILURE_CODE = "CHECKOUT_PAYMENT_REFUND_DUE";

const frontendFunnelStages = [
  "cart_viewed",
  "checkout_started",
  "checkout_contact_captured",
  "checkout_address_submitted",
  "checkout_address_verified",
  "shipping_method_selected",
  "payment_method_selected"
] as const;

const backendFunnelStages = [
  "order_placed",
  "payment_attempt_started",
  "payment_succeeded",
  "payment_failed",
  CHECKOUT_ABANDONED
] as const;

const codTelemetryEvents = [
  "cod_selected",
  "checkout_cod_otp_requested",
  "checkout_cod_otp_verified",
  "checkout_cod_otp_failed",
  "checkout_cod_otp_abandoned"
] as const;

const funnelAvailabilityNote = "Current funnel is backend/order-payment weighted. True pre-order funnel stages require future frontend telemetry ingestion.";
const codAvailabilityNote = "Checkout COD OTP telemetry is not instrumented yet; only COD order placed is currently derived from authoritative checkout order mode.";
const conversionAvailabilityNote = "partial_current_sessions_begin_at_order_placement";

function trimToNull(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function serializeDate(value: unknown) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function minorToBigInt(value: unknown) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return BigInt(value.trim());
  return 0n;
}

function minorToString(value: unknown) {
  return minorToBigInt(value).toString();
}

function currencyOf(value: unknown) {
  const normalized = String(value || DEFAULT_CURRENCY).trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : DEFAULT_CURRENCY;
}

function addMinor(values: unknown[]) {
  let total = 0n;
  for (const value of values) total += minorToBigInt(value);
  return total.toString();
}

function ratio(numerator: number, denominator: number) {
  if (!denominator) return 0;
  return numerator / denominator;
}

function byKey<T>(rows: T[], keyFor: (row: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyFor(row);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return grouped;
}

const unsafePayloadKey = /email|phone|mobile|whatsapp|address|customer|buyer|ip|token|secret|cookie|password|authorization|header/i;
const emailLike = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;

function containsPhoneLike(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

export function sanitizeCheckoutIntelligencePayload(value: unknown): unknown {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.slice(0, 20).map(sanitizeCheckoutIntelligencePayload);
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      if (unsafePayloadKey.test(key)) continue;
      output[key] = sanitizeCheckoutIntelligencePayload(child);
    }
    return output;
  }
  if (typeof value === "string" && (emailLike.test(value) || containsPhoneLike(value))) return "[redacted]";
  return value;
}

function maybeAttempt(row: any) {
  return row?.telemetryPaymentAttempt ?? null;
}

function failureErrorCode(row: any) {
  return row?.failureCode ?? maybeAttempt(row)?.errorCode ?? "unknown";
}

function failureMatchesPostFilters(row: any, filters: CheckoutIntelligenceAnalyticsFilters) {
  const attempt = maybeAttempt(row);
  if (filters.paymentMethod && attempt?.paymentMethod !== filters.paymentMethod) return false;
  if (filters.gatewayUsed && attempt?.gatewayUsed !== filters.gatewayUsed) return false;
  if (filters.errorCode && row?.failureCode !== filters.errorCode && attempt?.errorCode !== filters.errorCode) return false;
  return true;
}

export class CheckoutIntelligenceAnalyticsService {
  constructor(
    private readonly client: DbClient = prisma,
    private readonly now: () => Date = () => new Date()
  ) {}

  async getOverview(filters: CheckoutIntelligenceAnalyticsFilters = {}) {
    const range = this.dateRange(filters);
    const [checkoutStartedSessions, orderPlaced, paymentSucceeded, paymentFailed, checkoutAbandoned, failures] = await Promise.all([
      this.client.checkoutTelemetrySession.count({ where: this.sessionWhere(filters, range) }),
      this.countEvents("order_placed", filters, range),
      this.countEvents("payment_succeeded", filters, range),
      this.countEvents("payment_failed", filters, range),
      this.countEvents(CHECKOUT_ABANDONED, filters, range),
      this.findFailures(filters, range)
    ]);

    const abandonmentFailures = failures.filter((failure) => failure.failureCode === CHECKOUT_ABANDONED_FAILURE_CODE);
    const paymentFailures = failures.filter((failure) =>
      failure.failureStage === "PAYMENT" && failure.failureCode !== CHECKOUT_ABANDONED_FAILURE_CODE
    );

    return {
      dateRange: this.serializeRange(range),
      metrics: {
        checkoutStartedSessions,
        orderPlaced,
        paymentSucceeded,
        paymentFailed,
        checkoutAbandoned,
        checkoutConversionRate: ratio(orderPlaced, checkoutStartedSessions),
        conversionRateMeaningful: false,
        abandonedCheckoutValueMinor: addMinor(abandonmentFailures.map((failure) => failure.amountAtRiskMinor)),
        paymentFailureValueMinor: addMinor(paymentFailures.map((failure) => failure.amountAtRiskMinor)),
        checkoutCodOtpDropoffValueMinor: "0",
        paidButOrderFailedValueMinor: "0",
        futureLogisticsHandoffLeakageValueMinor: "0"
      },
      dataAvailability: {
        checkoutConversionRate: conversionAvailabilityNote,
        conversionRateMeaningful: false,
        refundDue: `${REFUND_DUE_FAILURE_CODE} is payment leakage; it is not counted as payment success or abandonment`,
        checkoutCodOtpDropoffValueMinor: "checkout_cod_otp_* events are not instrumented yet",
        paidButOrderFailedValueMinor: "not instrumented in C14",
        futureLogisticsHandoffLeakageValueMinor: "shipment handoff telemetry is future-only"
      }
    };
  }

  async getFunnel(filters: CheckoutIntelligenceAnalyticsFilters = {}) {
    const range = this.dateRange(filters);
    const frontendCounts = await Promise.all(frontendFunnelStages.map((stage) => this.countEvents(stage, filters, range)));
    const backendCounts = await Promise.all(backendFunnelStages.map((stage) => this.countEvents(stage, filters, range)));
    const paymentFailureValueMinor = await this.failureValueMinor(filters, range, (failure) =>
      failure.failureStage === "PAYMENT" && failure.failureCode !== CHECKOUT_ABANDONED_FAILURE_CODE
    );
    const abandonmentValueMinor = await this.failureValueMinor(filters, range, (failure) =>
      failure.failureCode === CHECKOUT_ABANDONED_FAILURE_CODE
    );

    const stages = [
      ...frontendFunnelStages.map((stage, index) => ({
        key: stage,
        count: frontendCounts[index] ?? 0,
        instrumented: false,
        revenueAtRiskMinor: "0",
        dataAvailability: "frontend_stage_not_instrumented"
      })),
      ...backendFunnelStages.map((stage, index) => ({
        key: stage,
        count: backendCounts[index] ?? 0,
        instrumented: true,
        revenueAtRiskMinor: stage === "payment_failed"
          ? paymentFailureValueMinor
          : stage === CHECKOUT_ABANDONED
            ? abandonmentValueMinor
            : "0",
        dataAvailability: "backend_authoritative_telemetry"
      }))
    ];

    return {
      dateRange: this.serializeRange(range),
      stages: stages.map((stage, index) => {
        const previous = index > 0 ? stages[index - 1]?.count ?? 0 : stage.count;
        return {
          ...stage,
          conversionRateFromPrevious: index === 0 ? 1 : ratio(stage.count, previous),
          dropoffRateFromPrevious: index === 0 ? 0 : previous ? 1 - ratio(stage.count, previous) : 0
        };
      }),
      dataAvailability: {
        note: funnelAvailabilityNote,
        frontendStages: "not_instrumented_until_future_frontend_telemetry_ingestion"
      }
    };
  }

  async getRevenueLeakage(filters: CheckoutIntelligenceAnalyticsFilters = {}) {
    const range = this.dateRange(filters);
    const failures = await this.findFailures(filters, range);
    const merchantNames = await this.merchantNames(failures.map((failure) => failure.merchantId));

    return {
      dateRange: this.serializeRange(range),
      totalFailures: failures.length,
      totalAmountAtRiskMinor: addMinor(failures.map((failure) => failure.amountAtRiskMinor)),
      byFailureStage: this.groupFailures(failures, (failure) => failure.failureStage),
      byMerchant: this.groupFailures(failures, (failure) => failure.merchantId, (key) => ({
        merchantId: key,
        merchantName: merchantNames.get(key) ?? null
      })),
      byPaymentMethod: this.groupFailures(failures, (failure) => maybeAttempt(failure)?.paymentMethod ?? "unknown"),
      byGateway: this.groupFailures(failures, (failure) => maybeAttempt(failure)?.gatewayUsed ?? "unknown"),
      byErrorCode: this.groupFailures(failures, failureErrorCode),
      dataAvailability: {
        refundDue: `${REFUND_DUE_FAILURE_CODE} is payment leakage; it is not counted as payment success or abandonment`
      }
    };
  }

  async getPaymentFailures(filters: CheckoutIntelligenceAnalyticsFilters = {}) {
    const range = this.dateRange(filters);
    const [attempts, failures] = await Promise.all([
      this.client.checkoutTelemetryPaymentAttempt.count({ where: this.attemptWhere(filters, range) }),
      this.findFailures({ ...filters, failureStage: "PAYMENT" }, range)
    ]);
    const paymentFailures = failures.filter((failure) => failure.failureCode !== CHECKOUT_ABANDONED_FAILURE_CODE);

    return {
      dateRange: this.serializeRange(range),
      totalAttempts: attempts,
      failedAttempts: paymentFailures.length,
      failureRate: ratio(paymentFailures.length, attempts),
      totalAmountAtRiskMinor: addMinor(paymentFailures.map((failure) => failure.amountAtRiskMinor)),
      byPaymentMethod: this.groupFailures(paymentFailures, (failure) => maybeAttempt(failure)?.paymentMethod ?? "unknown"),
      byGateway: this.groupFailures(paymentFailures, (failure) => maybeAttempt(failure)?.gatewayUsed ?? "unknown"),
      byErrorCode: this.groupFailures(paymentFailures, failureErrorCode),
      refundDueFailureCode: REFUND_DUE_FAILURE_CODE,
      dataAvailability: {
        refundDue: `${REFUND_DUE_FAILURE_CODE} remains a payment_failed revenue leakage case`
      }
    };
  }

  async getCodRisk(filters: CheckoutIntelligenceAnalyticsFilters = {}) {
    const range = this.dateRange(filters);
    const eventCounts = await Promise.all(codTelemetryEvents.map((eventName) => this.countEvents(eventName, filters, range)));
    const codOrderPlaced = filters.sellerId ? 0 : await this.client.checkoutOrder.count({
      where: {
        ...(filters.merchantId ? { merchantId: filters.merchantId } : {}),
        mode: { in: ["partial_cod", "full_cod"] },
        createdAt: { gte: range.dateFrom, lte: range.dateTo }
      }
    });

    return {
      dateRange: this.serializeRange(range),
      metrics: {
        codSelected: eventCounts[0] ?? 0,
        checkoutCodOtpRequested: eventCounts[1] ?? 0,
        checkoutCodOtpVerified: eventCounts[2] ?? 0,
        checkoutCodOtpFailed: eventCounts[3] ?? 0,
        checkoutCodOtpAbandoned: eventCounts[4] ?? 0,
        codOrderPlaced
      },
      dataAvailability: {
        note: codAvailabilityNote,
        codSelected: "not_instrumented_yet",
        checkoutCodOtpRequested: "not_instrumented_yet",
        checkoutCodOtpVerified: "not_instrumented_yet",
        checkoutCodOtpFailed: "not_instrumented_yet",
        checkoutCodOtpAbandoned: "not_instrumented_yet",
        codOrderPlaced: "derived_from_authoritative_checkout_order_mode",
        sellerId: filters.sellerId ? "sellerId filter only matches populated telemetry rows; authoritative checkout orders are not seller-attributed in C14" : undefined
      }
    };
  }

  async getMerchantBreakdown(filters: CheckoutIntelligenceAnalyticsFilters = {}) {
    const range = this.dateRange(filters);
    const [sessions, events, failures] = await Promise.all([
      this.client.checkoutTelemetrySession.findMany({ where: this.sessionWhere(filters, range) }),
      this.client.checkoutTelemetryEvent.findMany({ where: this.eventWhere(filters, range) }),
      this.findFailures(filters, range)
    ]);
    const merchantIds = Array.from(new Set([
      ...sessions.map((session: any) => session.merchantId),
      ...events.map((event: any) => event.merchantId),
      ...failures.map((failure) => failure.merchantId)
    ].filter(Boolean)));
    const merchantNames = await this.merchantNames(merchantIds);

    return {
      dateRange: this.serializeRange(range),
      merchants: merchantIds.map((merchantId) => {
        const merchantSessions = sessions.filter((session: any) => session.merchantId === merchantId);
        const merchantEvents = events.filter((event: any) => event.merchantId === merchantId);
        const merchantFailures = failures.filter((failure) => failure.merchantId === merchantId);
        const orderPlaced = merchantEvents.filter((event: any) => event.eventName === "order_placed").length;
        return {
          merchantId,
          merchantName: merchantNames.get(merchantId) ?? null,
          checkoutStartedSessions: merchantSessions.length,
          orderPlaced,
          paymentSucceeded: merchantEvents.filter((event: any) => event.eventName === "payment_succeeded").length,
          paymentFailed: merchantEvents.filter((event: any) => event.eventName === "payment_failed").length,
          checkoutAbandoned: merchantEvents.filter((event: any) => event.eventName === CHECKOUT_ABANDONED).length,
          amountAtRiskMinor: addMinor(merchantFailures.map((failure) => failure.amountAtRiskMinor)),
          checkoutConversionRate: ratio(orderPlaced, merchantSessions.length),
          conversionRateMeaningful: false
        };
      }),
      dataAvailability: {
        breakdownScope: "merchant_only",
        sellerId: "nullable_future_facing_only; no seller attribution is inferred"
      }
    };
  }

  async getAbandonedCheckouts(filters: CheckoutIntelligenceAnalyticsFilters = {}) {
    const range = this.dateRange(filters);
    const limit = filters.limit ?? 50;
    const sessions = await this.client.checkoutTelemetrySession.findMany({
      where: {
        ...this.sessionWhere(filters, range),
        status: "ABANDONED"
      },
      orderBy: [{ abandonedAt: "desc" }, { startedAt: "desc" }],
      take: limit + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {})
    });
    const pageRows = sessions.slice(0, limit);
    const failures = await this.findFailures({ ...filters, failureStage: undefined, errorCode: CHECKOUT_ABANDONED_FAILURE_CODE }, range);
    const failureBySession = new Map(failures.map((failure) => [failure.telemetrySessionId, failure]));
    const merchantNames = await this.merchantNames(pageRows.map((session: any) => session.merchantId));

    return {
      dateRange: this.serializeRange(range),
      abandonedCheckouts: pageRows.map((session: any) => {
        const failure = failureBySession.get(session.id);
        return {
          telemetrySessionId: session.id,
          merchantId: session.merchantId,
          merchantName: merchantNames.get(session.merchantId) ?? null,
          sellerId: session.sellerId ?? null,
          checkoutOrderId: session.checkoutOrderId ?? null,
          sessionId: session.sessionId,
          deviceType: session.deviceType,
          cartValueMinor: minorToString(session.cartValueMinor),
          currency: currencyOf(session.currency),
          startedAt: serializeDate(session.startedAt),
          abandonedAt: serializeDate(session.abandonedAt),
          failureStage: failure?.failureStage ?? null,
          failureReason: failure?.failureReason ?? null,
          failureCode: failure?.failureCode ?? null,
          amountAtRiskMinor: failure ? minorToString(failure.amountAtRiskMinor) : minorToString(session.cartValueMinor)
        };
      }),
      limit,
      hasMore: sessions.length > limit,
      nextCursor: sessions.length > limit ? sessions[limit]?.id ?? null : null,
      dataAvailability: {
        refundDue: "refund_due payment sessions are excluded by the C13 worker and should not appear as abandoned"
      }
    };
  }

  async getEventLog(filters: CheckoutIntelligenceAnalyticsFilters = {}) {
    const range = this.dateRange(filters);
    const limit = filters.limit ?? 50;
    const events = await this.client.checkoutTelemetryEvent.findMany({
      where: this.eventWhere(filters, range),
      orderBy: { occurredAt: "desc" },
      take: limit + 1,
      ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {})
    });
    const pageRows = events.slice(0, limit);
    const merchantNames = await this.merchantNames(pageRows.map((event: any) => event.merchantId));

    return {
      dateRange: this.serializeRange(range),
      events: pageRows.map((event: any) => ({
        id: event.id,
        eventName: event.eventName,
        telemetrySessionId: event.telemetrySessionId,
        merchantId: event.merchantId,
        merchantName: merchantNames.get(event.merchantId) ?? null,
        sellerId: event.sellerId ?? null,
        checkoutOrderId: event.checkoutOrderId ?? null,
        checkoutPaymentId: event.checkoutPaymentId ?? null,
        source: event.source,
        occurredAt: serializeDate(event.occurredAt),
        payload: sanitizeCheckoutIntelligencePayload(event.payloadJson)
      })),
      limit,
      hasMore: events.length > limit,
      nextCursor: events.length > limit ? events[limit]?.id ?? null : null,
      dataAvailability: {
        pii: "payloads are sanitized before admin analytics serialization"
      }
    };
  }

  private dateRange(filters: CheckoutIntelligenceAnalyticsFilters) {
    const dateTo = filters.dateTo ?? this.now();
    const dateFrom = filters.dateFrom ?? new Date(dateTo.getTime() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60_000);
    return { dateFrom, dateTo };
  }

  private serializeRange(range: { dateFrom: Date; dateTo: Date }) {
    return {
      dateFrom: range.dateFrom.toISOString(),
      dateTo: range.dateTo.toISOString()
    };
  }

  private sessionWhere(filters: CheckoutIntelligenceAnalyticsFilters, range: { dateFrom: Date; dateTo: Date }) {
    return {
      startedAt: { gte: range.dateFrom, lte: range.dateTo },
      ...(filters.merchantId ? { merchantId: filters.merchantId } : {}),
      ...(filters.sellerId ? { sellerId: filters.sellerId } : {}),
      ...(filters.deviceType ? { deviceType: filters.deviceType } : {})
    };
  }

  private eventWhere(filters: CheckoutIntelligenceAnalyticsFilters, range: { dateFrom: Date; dateTo: Date }, eventName?: string) {
    return {
      occurredAt: { gte: range.dateFrom, lte: range.dateTo },
      ...(eventName ? { eventName } : {}),
      ...(filters.merchantId ? { merchantId: filters.merchantId } : {}),
      ...(filters.sellerId ? { sellerId: filters.sellerId } : {})
    };
  }

  private attemptWhere(filters: CheckoutIntelligenceAnalyticsFilters, range: { dateFrom: Date; dateTo: Date }) {
    return {
      createdAt: { gte: range.dateFrom, lte: range.dateTo },
      ...(filters.merchantId ? { merchantId: filters.merchantId } : {}),
      ...(filters.sellerId ? { sellerId: filters.sellerId } : {}),
      ...(filters.paymentMethod ? { paymentMethod: filters.paymentMethod } : {}),
      ...(filters.gatewayUsed ? { gatewayUsed: filters.gatewayUsed } : {}),
      ...(filters.errorCode ? { errorCode: filters.errorCode } : {})
    };
  }

  private failureWhere(filters: CheckoutIntelligenceAnalyticsFilters, range: { dateFrom: Date; dateTo: Date }) {
    return {
      createdAt: { gte: range.dateFrom, lte: range.dateTo },
      ...(filters.merchantId ? { merchantId: filters.merchantId } : {}),
      ...(filters.sellerId ? { sellerId: filters.sellerId } : {}),
      ...(filters.failureStage ? { failureStage: filters.failureStage } : {}),
      ...(filters.failureReason ? { failureReason: filters.failureReason } : {})
    };
  }

  private async countEvents(eventName: string, filters: CheckoutIntelligenceAnalyticsFilters, range: { dateFrom: Date; dateTo: Date }) {
    return this.client.checkoutTelemetryEvent.count({
      where: this.eventWhere(filters, range, eventName)
    });
  }

  private async findFailures(filters: CheckoutIntelligenceAnalyticsFilters, range: { dateFrom: Date; dateTo: Date }) {
    const rows = await this.client.checkoutTelemetryFailure.findMany({
      where: this.failureWhere(filters, range),
      include: { telemetryPaymentAttempt: true },
      orderBy: { createdAt: "desc" }
    });
    const hydratedRows = await this.attachAttempts(rows);
    return hydratedRows.filter((row) => failureMatchesPostFilters(row, filters));
  }

  private async attachAttempts(failures: any[]) {
    const missingAttemptIds = Array.from(new Set(failures
      .filter((failure) => failure.telemetryPaymentAttemptId && !failure.telemetryPaymentAttempt)
      .map((failure) => failure.telemetryPaymentAttemptId)));

    if (!missingAttemptIds.length) return failures;

    const attempts = await this.client.checkoutTelemetryPaymentAttempt.findMany({
      where: { id: { in: missingAttemptIds } }
    });
    const attemptsById = new Map(attempts.map((attempt: any) => [attempt.id, attempt]));
    return failures.map((failure) => ({
      ...failure,
      telemetryPaymentAttempt: failure.telemetryPaymentAttempt ?? attemptsById.get(failure.telemetryPaymentAttemptId) ?? null
    }));
  }

  private async failureValueMinor(
    filters: CheckoutIntelligenceAnalyticsFilters,
    range: { dateFrom: Date; dateTo: Date },
    predicate: (failure: any) => boolean
  ) {
    const failures = await this.findFailures(filters, range);
    return addMinor(failures.filter(predicate).map((failure) => failure.amountAtRiskMinor));
  }

  private async merchantNames(merchantIds: Array<string | null | undefined>) {
    const ids = Array.from(new Set(merchantIds.filter((id): id is string => Boolean(id))));
    if (!ids.length) return new Map<string, string>();

    const merchants = await this.client.merchant.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true }
    });
    return new Map(merchants.map((merchant: { id: string; name: string }) => [merchant.id, merchant.name]));
  }

  private groupFailures(
    failures: any[],
    keyFor: (failure: any) => string,
    decorate: (key: string) => Record<string, unknown> = (key) => ({ key })
  ) {
    return Array.from(byKey(failures, (failure) => trimToNull(keyFor(failure)) ?? "unknown").entries())
      .map(([key, rows]) => ({
        ...decorate(key),
        count: rows.length,
        amountAtRiskMinor: addMinor(rows.map((row) => row.amountAtRiskMinor)),
        currencies: Array.from(new Set(rows.map((row) => currencyOf(row.currency))))
      }))
      .sort((left, right) => right.count - left.count);
  }
}
