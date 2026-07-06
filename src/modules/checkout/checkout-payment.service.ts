import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../lib/httpError.js";
import { serializeBuyerOrder, serializeCheckoutPayment } from "./checkout-serializers.js";
import { CheckoutOrderService, checkoutRequestHash, type IdempotencyReplayPointer } from "./checkout-order.service.js";
import { CheckoutTelemetryService } from "./checkout-telemetry.service.js";
import {
  checkoutTelemetryCartSize,
  checkoutTelemetryContactFromCustomer,
  checkoutTelemetryGateway,
  checkoutTelemetryPaymentMethod,
  checkoutTelemetrySessionIdForOrder
} from "./checkout-telemetry-instrumentation.js";

type DbClient = typeof prisma | any;

function captureOperation(paymentId: string) {
  return `checkout_payment_capture:${paymentId}`;
}

async function runTransaction<T>(client: DbClient, callback: (tx: DbClient) => Promise<T>) {
  if (typeof client.$transaction === "function") return client.$transaction(callback);
  return callback(client);
}

async function findPaymentWithOrder(client: DbClient, paymentId: string) {
  return client.checkoutPayment.findUnique({
    where: { id: paymentId },
    include: {
      order: {
        include: {
          timeline: { orderBy: { createdAt: "asc" } },
          payments: { orderBy: { createdAt: "asc" } }
        }
      }
    }
  });
}

export class CheckoutPaymentService {
  private readonly orderService: CheckoutOrderService;
  private readonly telemetry: CheckoutTelemetryService;

  constructor(
    private readonly client: DbClient = prisma,
    private readonly now: () => Date = () => new Date()
  ) {
    this.orderService = new CheckoutOrderService(client, now);
    this.telemetry = new CheckoutTelemetryService(client, now);
  }

  async initiatePayment(paymentId: string, orderToken: string) {
    const payment = await findPaymentWithOrder(this.client, paymentId);
    if (!payment) throw new HttpError(404, "CHECKOUT_PAYMENT_NOT_FOUND");
    this.orderService.assertOrderToken(payment.order, orderToken);

    let nextPayment = payment;
    if (payment.state === "created") {
      nextPayment = await runTransaction(this.client, async (tx) => {
        const initiated = await tx.checkoutPayment.update({
          where: { id: payment.id },
          data: { state: "initiated" }
        });
        await this.recordPaymentAttemptStarted(tx, { ...initiated, order: payment.order });
        return initiated;
      });
    }

    return {
      payment: serializeCheckoutPayment(nextPayment),
      mockGateway: {
        gateway: "mock",
        orderRef: nextPayment.gatewayOrderRef,
        intentRef: nextPayment.gatewayIntentRef,
        amount: serializeCheckoutPayment(nextPayment).amount,
        currency: nextPayment.currency
      }
    };
  }

  async mockComplete(input: {
    paymentId: string;
    orderToken: string;
    outcome: "success" | "failure";
    idempotencyKey: string;
  }) {
    const payment = await findPaymentWithOrder(this.client, input.paymentId);
    if (!payment) throw new HttpError(404, "CHECKOUT_PAYMENT_NOT_FOUND");
    this.orderService.assertOrderToken(payment.order, input.orderToken);
    const requestHash = checkoutRequestHash({
      paymentId: input.paymentId,
      outcome: input.outcome
    });

    return this.orderService.withIdempotency({
      merchantId: payment.merchantId,
      operation: captureOperation(input.paymentId),
      idempotencyKey: input.idempotencyKey,
      requestHash,
      execute: async (tx) => this.captureInTransaction(tx, payment.id, input.outcome),
      hydrate: async (pointer) => this.hydrateCaptureReplay(pointer)
    });
  }

  private async hydrateCaptureReplay(pointer: IdempotencyReplayPointer) {
    if (pointer.kind !== "checkout_payment_capture" || !pointer.paymentId) {
      throw new HttpError(409, "CHECKOUT_IDEMPOTENCY_REPLAY_INVALID");
    }
    const payment = await findPaymentWithOrder(this.client, pointer.paymentId);
    if (!payment) throw new HttpError(404, "CHECKOUT_PAYMENT_NOT_FOUND");
    return {
      statusCode: 200,
      body: {
        payment: serializeCheckoutPayment(payment),
        alreadyCaptured: pointer.alreadyCaptured ?? true,
        order: serializeBuyerOrder(payment.order)
      }
    };
  }

  private async captureInTransaction(tx: DbClient, paymentId: string, outcome: "success" | "failure") {
    return runTransaction(tx, async (client) => {
      const payment = await findPaymentWithOrder(client, paymentId);
      if (!payment) throw new HttpError(404, "CHECKOUT_PAYMENT_NOT_FOUND");

      if (payment.state === "captured" || payment.state === "refund_due") {
        return {
          statusCode: 200,
          body: {
            payment: serializeCheckoutPayment(payment),
            alreadyCaptured: true,
            order: serializeBuyerOrder(payment.order)
          },
          pointer: {
            kind: "checkout_payment_capture" as const,
            paymentId,
            alreadyCaptured: true
          }
        };
      }

      if (outcome === "failure") {
        const failed = await client.checkoutPayment.update({
          where: { id: payment.id },
          data: { state: "failed" }
        });
        await this.recordPaymentFailed(client, { ...failed, order: payment.order }, {
          failureCode: "PAYMENT_CAPTURE_FAILED",
          failureReason: "payment_capture_failed",
          payload: {
            paymentState: "failed",
            outcome: "failure"
          }
        });
        const order = await client.checkoutOrder.findUnique({
          where: { id: payment.orderId },
          include: { timeline: { orderBy: { createdAt: "asc" } }, payments: { orderBy: { createdAt: "asc" } } }
        });
        return {
          statusCode: 200,
          body: {
            payment: serializeCheckoutPayment(failed),
            alreadyCaptured: false,
            order: serializeBuyerOrder(order)
          },
          pointer: {
            kind: "checkout_payment_capture" as const,
            paymentId,
            alreadyCaptured: false
          }
        };
      }

      if (["cancelled", "expired", "refund_due"].includes(payment.order.state)) {
        const orderStateAtCapture = payment.order.state;
        const refundDue = await client.checkoutPayment.update({
          where: { id: payment.id },
          data: {
            state: "refund_due",
            gatewayPaymentRef: `mock_pay_${randomUUID()}`,
            capturedAt: this.now()
          }
        });
        await client.checkoutOrder.update({
          where: { id: payment.orderId },
          data: { state: "refund_due" }
        });
        await client.checkoutAccountingEvent.create({
          data: {
            merchantId: payment.merchantId,
            orderId: payment.orderId,
            paymentId: payment.id,
            eventType: payment.purpose === "advance" ? "advance_captured" : "full_payment_captured",
            sourceRef: `cp_${payment.id}`,
            amountMinor: payment.amountMinor,
            currency: payment.currency,
            metadata: { gateway: "mock", late: true }
          }
        });
        const refundAccountingEvent = await client.checkoutAccountingEvent.create({
          data: {
            merchantId: payment.merchantId,
            orderId: payment.orderId,
            paymentId: payment.id,
            eventType: "payment_refund_due",
            sourceRef: `cp_${payment.id}`,
            amountMinor: payment.amountMinor,
            currency: payment.currency,
            metadata: { reason: "late_capture_after_terminal_order_state" }
          }
        });
        await this.recordPaymentFailed(client, { ...refundDue, order: payment.order }, {
          failureCode: "CHECKOUT_PAYMENT_REFUND_DUE",
          failureReason: "late_capture_refund_due",
          accountingEventId: refundAccountingEvent.id,
          payload: {
            paymentState: "refund_due",
            orderStateAtCapture,
            reason: "late_capture_refund_due"
          }
        });
        const order = await client.checkoutOrder.findUnique({
          where: { id: payment.orderId },
          include: { timeline: { orderBy: { createdAt: "asc" } }, payments: { orderBy: { createdAt: "asc" } } }
        });
        return {
          statusCode: 200,
          body: {
            payment: serializeCheckoutPayment(refundDue),
            alreadyCaptured: false,
            order: serializeBuyerOrder(order)
          },
          pointer: {
            kind: "checkout_payment_capture" as const,
            paymentId,
            alreadyCaptured: false
          }
        };
      }

      const capturedAt = this.now();
      const captured = await client.checkoutPayment.update({
        where: { id: payment.id },
        data: {
          state: "captured",
          gatewayPaymentRef: `mock_pay_${randomUUID()}`,
          capturedAt
        }
      });
      await client.checkoutOrder.update({
        where: { id: payment.orderId },
        data: {
          state: "confirmed",
          advancePaidMinor: payment.purpose === "advance" ? payment.amountMinor : payment.order.advancePaidMinor
        }
      });
      const timeline = await client.checkoutOrderTimeline.create({
        data: {
          merchantId: payment.merchantId,
          orderId: payment.orderId,
          type: "payment",
          message: payment.purpose === "advance" ? "Advance payment confirmed" : "Payment confirmed",
          actor: "buyer"
        }
      });
      const capturedAccountingEvent = await client.checkoutAccountingEvent.create({
        data: {
          merchantId: payment.merchantId,
          orderId: payment.orderId,
          paymentId: payment.id,
          eventType: payment.purpose === "advance" ? "advance_captured" : "full_payment_captured",
          sourceRef: `cp_${payment.id}`,
          amountMinor: payment.amountMinor,
          currency: payment.currency,
          metadata: { gateway: "mock" }
        }
      });
      await client.checkoutAccountingEvent.create({
        data: {
          merchantId: payment.merchantId,
          orderId: payment.orderId,
          paymentId: payment.id,
          eventType: "order_confirmed",
          sourceRef: `co_${payment.orderId}`,
          amountMinor: payment.order.grandTotalMinor,
          currency: payment.currency,
          metadata: { via: payment.purpose }
        }
      });
      await this.recordPaymentSucceeded(client, { ...captured, order: payment.order }, {
        timelineEntryId: timeline.id,
        accountingEventId: capturedAccountingEvent.id
      });
      const order = await client.checkoutOrder.findUnique({
        where: { id: payment.orderId },
        include: { timeline: { orderBy: { createdAt: "asc" } }, payments: { orderBy: { createdAt: "asc" } } }
      });
      return {
        statusCode: 200,
        body: {
          payment: serializeCheckoutPayment(captured),
          alreadyCaptured: false,
          order: serializeBuyerOrder(order)
        },
        pointer: {
          kind: "checkout_payment_capture" as const,
          paymentId,
          alreadyCaptured: false
        }
      };
    });
  }

  private async ensureTelemetrySession(client: DbClient, payment: any, status: "STARTED" | "COMPLETED" = "STARTED") {
    const contact = checkoutTelemetryContactFromCustomer(payment.order?.customerJson);
    return this.telemetry.createOrUpdateSession({
      merchantId: payment.merchantId,
      sessionId: checkoutTelemetrySessionIdForOrder(payment.orderId),
      checkoutOrderId: payment.orderId,
      quoteId: payment.order?.quoteId,
      email: contact.email,
      phone: contact.phone,
      cartValueMinor: payment.order?.grandTotalMinor ?? payment.amountMinor,
      currency: payment.currency,
      cartSize: checkoutTelemetryCartSize(payment.order?.itemsJson),
      status
    }, { client });
  }

  private async recordPaymentAttemptStarted(client: DbClient, payment: any) {
    const session = await this.ensureTelemetrySession(client, payment);
    await this.telemetry.upsertPaymentAttemptForCheckoutPayment({
      telemetrySessionId: session.id,
      merchantId: payment.merchantId,
      checkoutOrderId: payment.orderId,
      checkoutPaymentId: payment.id,
      paymentMethod: checkoutTelemetryPaymentMethod(payment),
      gatewayUsed: checkoutTelemetryGateway(payment),
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      status: "STARTED",
      gatewayOrderId: payment.gatewayOrderRef,
      gatewayPaymentId: payment.gatewayPaymentRef,
      attemptNumber: 1,
      startedAt: payment.createdAt ?? this.now()
    }, { client });
    await this.telemetry.recordEvent({
      telemetrySessionId: session.id,
      merchantId: payment.merchantId,
      checkoutOrderId: payment.orderId,
      checkoutPaymentId: payment.id,
      eventName: "payment_attempt_started",
      idempotencyKey: `payment_attempt_started:${payment.id}`,
      source: "BACKEND",
      payloadJson: {
        paymentState: "initiated",
        paymentPurpose: payment.purpose,
        gateway: payment.gateway,
        amountMinor: payment.amountMinor,
        currency: payment.currency
      }
    }, { client });
  }

  private async recordPaymentSucceeded(
    client: DbClient,
    payment: any,
    links: { timelineEntryId?: string | null; accountingEventId?: string | null }
  ) {
    const session = await this.ensureTelemetrySession(client, payment, "COMPLETED");
    await this.telemetry.upsertPaymentAttemptForCheckoutPayment({
      telemetrySessionId: session.id,
      merchantId: payment.merchantId,
      checkoutOrderId: payment.orderId,
      checkoutPaymentId: payment.id,
      paymentMethod: checkoutTelemetryPaymentMethod(payment),
      gatewayUsed: checkoutTelemetryGateway(payment),
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      status: "SUCCEEDED",
      gatewayOrderId: payment.gatewayOrderRef,
      gatewayPaymentId: payment.gatewayPaymentRef,
      attemptNumber: 1,
      startedAt: payment.createdAt ?? this.now(),
      completedAt: payment.capturedAt ?? this.now()
    }, { client });
    await this.telemetry.recordEvent({
      telemetrySessionId: session.id,
      merchantId: payment.merchantId,
      checkoutOrderId: payment.orderId,
      checkoutPaymentId: payment.id,
      timelineEntryId: links.timelineEntryId,
      accountingEventId: links.accountingEventId,
      eventName: "payment_succeeded",
      idempotencyKey: `payment_succeeded:${payment.id}`,
      source: "BACKEND",
      payloadJson: {
        paymentState: "captured",
        orderState: "confirmed",
        paymentPurpose: payment.purpose,
        gateway: payment.gateway,
        amountMinor: payment.amountMinor,
        currency: payment.currency
      }
    }, { client });
  }

  private async recordPaymentFailed(
    client: DbClient,
    payment: any,
    input: {
      failureCode: string;
      failureReason: string;
      accountingEventId?: string | null;
      payload?: Record<string, unknown>;
    }
  ) {
    const session = await this.ensureTelemetrySession(client, payment);
    const attempt = await this.telemetry.upsertPaymentAttemptForCheckoutPayment({
      telemetrySessionId: session.id,
      merchantId: payment.merchantId,
      checkoutOrderId: payment.orderId,
      checkoutPaymentId: payment.id,
      paymentMethod: checkoutTelemetryPaymentMethod(payment),
      gatewayUsed: checkoutTelemetryGateway(payment),
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      status: "FAILED",
      gatewayOrderId: payment.gatewayOrderRef,
      gatewayPaymentId: payment.gatewayPaymentRef,
      errorCode: input.failureCode,
      errorMessage: input.failureReason,
      attemptNumber: 1,
      startedAt: payment.createdAt ?? this.now(),
      completedAt: payment.capturedAt ?? this.now()
    }, { client });
    await this.telemetry.recordEvent({
      telemetrySessionId: session.id,
      merchantId: payment.merchantId,
      checkoutOrderId: payment.orderId,
      checkoutPaymentId: payment.id,
      accountingEventId: input.accountingEventId,
      eventName: "payment_failed",
      idempotencyKey: `payment_failed:${payment.id}:${input.failureCode}`,
      source: "BACKEND",
      payloadJson: {
        paymentPurpose: payment.purpose,
        gateway: payment.gateway,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        ...input.payload
      }
    }, { client });
    await this.telemetry.createFailure({
      telemetrySessionId: session.id,
      merchantId: payment.merchantId,
      checkoutOrderId: payment.orderId,
      checkoutPaymentId: payment.id,
      telemetryPaymentAttemptId: attempt.id,
      failureStage: "PAYMENT",
      failureReason: input.failureReason,
      failureCode: input.failureCode,
      amountAtRiskMinor: payment.amountMinor,
      currency: payment.currency,
      isRecoverable: true,
      source: "BACKEND"
    }, { client });
  }
}
