import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../lib/httpError.js";
import { serializeBuyerOrder, serializeCheckoutPayment } from "./checkout-serializers.js";
import { CheckoutOrderService, checkoutRequestHash, type IdempotencyReplayPointer } from "./checkout-order.service.js";

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

  constructor(
    private readonly client: DbClient = prisma,
    private readonly now: () => Date = () => new Date()
  ) {
    this.orderService = new CheckoutOrderService(client, now);
  }

  async initiatePayment(paymentId: string, orderToken: string) {
    const payment = await findPaymentWithOrder(this.client, paymentId);
    if (!payment) throw new HttpError(404, "CHECKOUT_PAYMENT_NOT_FOUND");
    this.orderService.assertOrderToken(payment.order, orderToken);

    let nextPayment = payment;
    if (payment.state === "created") {
      nextPayment = await this.client.checkoutPayment.update({
        where: { id: payment.id },
        data: { state: "initiated" }
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
        await client.checkoutAccountingEvent.create({
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
      await client.checkoutOrderTimeline.create({
        data: {
          merchantId: payment.merchantId,
          orderId: payment.orderId,
          type: "payment",
          message: payment.purpose === "advance" ? "Advance payment confirmed" : "Payment confirmed",
          actor: "buyer"
        }
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
}
