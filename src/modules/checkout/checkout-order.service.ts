import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../../lib/httpError.js";
import {
  CHECKOUT_MODES,
  parseMinorUnit,
  quoteOptionsFromJson,
  type CheckoutMode
} from "./checkout-quote.service.js";
import { serializeBuyerOrder, serializeCheckoutPayment } from "./checkout-serializers.js";

type DbClient = typeof prisma | any;

export type CheckoutCustomerInput = {
  name: string;
  phone: string;
  email?: string | undefined;
};

export type CheckoutAddressInput = {
  line1?: string | undefined;
  line2?: string | undefined;
  city?: string | undefined;
  state?: string | undefined;
  pincode?: string | undefined;
};

export type CreateCheckoutOrderInput = {
  quoteId: string;
  mode: CheckoutMode;
  customer: CheckoutCustomerInput;
  shippingAddress?: CheckoutAddressInput | undefined;
  idempotencyKey: string;
};

export type IdempotencyReplayPointer = {
  kind: "checkout_order_created" | "checkout_payment_capture";
  orderId?: string | undefined;
  paymentId?: string | undefined;
  orderToken?: string | undefined;
  alreadyCaptured?: boolean | undefined;
};

const TOKEN_VERSION = "c1";
const ORDER_CREATE_OPERATION = "checkout_order_create";
const TOKEN_SECRET_FALLBACK = "checkout-c1-mock-sandbox-token-secret";

function checkoutTokenSecret() {
  return process.env.CHECKOUT_ORDER_TOKEN_SECRET || process.env.APP_SECRET_PEPPER || TOKEN_SECRET_FALLBACK;
}

function base64urlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stableNormalize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, current]) => [key, stableNormalize(current)]));
  }
  return value;
}

export function checkoutRequestHash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(stableNormalize(value))).digest("hex");
}

export function hashCheckoutOrderToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function createCheckoutOrderToken(orderId: string, merchantId: string, issuedAt: Date) {
  const payload = base64urlJson({
    v: TOKEN_VERSION,
    orderId,
    merchantId,
    iat: issuedAt.toISOString()
  });
  const signature = createHmac("sha256", checkoutTokenSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyCheckoutOrderToken(token: string, expectedOrderId: string, expectedMerchantId: string) {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  const expected = createHmac("sha256", checkoutTokenSecret()).update(payload).digest("base64url");
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return false;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    return parsed.v === TOKEN_VERSION && parsed.orderId === expectedOrderId && parsed.merchantId === expectedMerchantId;
  } catch {
    return false;
  }
}

function isUniqueConflict(error: unknown) {
  return Boolean(error && typeof error === "object" && (error as { code?: string }).code === "P2002");
}

async function runTransaction<T>(client: DbClient, callback: (tx: DbClient) => Promise<T>) {
  if (typeof client.$transaction === "function") return client.$transaction(callback);
  return callback(client);
}

function cleanText(value: string | undefined, field: string, max = 240) {
  const next = value?.trim();
  if (!next) throw new HttpError(400, "CHECKOUT_CUSTOMER_INVALID", { field });
  if (next.length > max) throw new HttpError(400, "CHECKOUT_CUSTOMER_INVALID", { field });
  return next;
}

function cleanOptionalText(value: string | undefined, max = 500) {
  const next = value?.trim();
  if (!next) return null;
  if (next.length > max) throw new HttpError(400, "CHECKOUT_FIELD_TOO_LONG");
  return next;
}

function normalizeCustomer(input: CheckoutCustomerInput) {
  const customer = {
    name: cleanText(input.name, "name", 180),
    phone: cleanText(input.phone, "phone", 40),
    email: cleanOptionalText(input.email, 220)
  };
  if (customer.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) {
    throw new HttpError(400, "CHECKOUT_CUSTOMER_EMAIL_INVALID");
  }
  return customer;
}

function normalizeAddress(input: CheckoutAddressInput | undefined) {
  if (!input) return null;
  return {
    line1: cleanOptionalText(input.line1),
    line2: cleanOptionalText(input.line2),
    city: cleanOptionalText(input.city, 120),
    state: cleanOptionalText(input.state, 120),
    pincode: cleanOptionalText(input.pincode, 20)
  };
}

async function findOrderForBuyer(client: DbClient, orderId: string) {
  return client.checkoutOrder.findUnique({
    where: { id: orderId },
    include: {
      timeline: { orderBy: { createdAt: "asc" } },
      payments: { orderBy: { createdAt: "asc" } }
    }
  });
}

async function persistCheckoutIdempotency(input: {
  client: DbClient;
  merchantId: string;
  operation: string;
  idempotencyKey: string;
  requestHash: string;
  statusCode: number;
  responsePointer: IdempotencyReplayPointer;
}) {
  return input.client.checkoutIdempotencyKey.create({
    data: {
      merchantId: input.merchantId,
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      responseJson: input.responsePointer,
      statusCode: input.statusCode
    }
  });
}

export class CheckoutOrderService {
  constructor(
    private readonly client: DbClient = prisma,
    private readonly now: () => Date = () => new Date()
  ) {}

  async createOrder(input: CreateCheckoutOrderInput) {
    const quote = await this.client.checkoutQuote.findUnique({ where: { id: input.quoteId } });
    if (!quote) throw new HttpError(404, "CHECKOUT_QUOTE_NOT_FOUND");
    const requestHash = checkoutRequestHash({
      quoteId: input.quoteId,
      mode: input.mode,
      customer: input.customer,
      shippingAddress: input.shippingAddress ?? null
    });

    return this.withIdempotency({
      merchantId: quote.merchantId,
      operation: ORDER_CREATE_OPERATION,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      execute: async (tx) => this.createOrderFromQuote(tx, quote, input),
      hydrate: async (pointer) => this.hydrateOrderCreateReplay(pointer)
    });
  }

  async getBuyerOrder(orderId: string, orderToken: string) {
    const order = await findOrderForBuyer(this.client, orderId);
    if (!order) throw new HttpError(404, "CHECKOUT_ORDER_NOT_FOUND");
    this.assertOrderToken(order, orderToken);
    return { order: serializeBuyerOrder(order) };
  }

  assertOrderToken(order: { id: string; merchantId: string; orderTokenHash: string }, orderToken: string | undefined) {
    if (!orderToken || hashCheckoutOrderToken(orderToken) !== order.orderTokenHash || !verifyCheckoutOrderToken(orderToken, order.id, order.merchantId)) {
      throw new HttpError(401, "CHECKOUT_ORDER_TOKEN_REQUIRED");
    }
  }

  async withIdempotency(input: {
    merchantId: string;
    operation: string;
    idempotencyKey: string;
    requestHash: string;
    execute: (tx: DbClient) => Promise<{ statusCode: number; body: unknown; pointer: IdempotencyReplayPointer }>;
    hydrate: (pointer: IdempotencyReplayPointer) => Promise<{ statusCode: number; body: unknown }>;
  }) {
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey) throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED");

    const existing = await this.client.checkoutIdempotencyKey.findUnique({
      where: {
        merchantId_operation_idempotencyKey: {
          merchantId: input.merchantId,
          operation: input.operation,
          idempotencyKey
        }
      }
    });
    if (existing) {
      if (existing.requestHash !== input.requestHash) throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
      return input.hydrate(existing.responseJson as IdempotencyReplayPointer);
    }

    try {
      return await runTransaction(this.client, async (tx) => {
        const result = await input.execute(tx);
        await persistCheckoutIdempotency({
          client: tx,
          merchantId: input.merchantId,
          operation: input.operation,
          idempotencyKey,
          requestHash: input.requestHash,
          statusCode: result.statusCode,
          responsePointer: result.pointer
        });
        return { statusCode: result.statusCode, body: result.body };
      });
    } catch (error) {
      if (!isUniqueConflict(error)) throw error;
      const raced = await this.client.checkoutIdempotencyKey.findUnique({
        where: {
          merchantId_operation_idempotencyKey: {
            merchantId: input.merchantId,
            operation: input.operation,
            idempotencyKey
          }
        }
      });
      if (raced?.requestHash === input.requestHash) return input.hydrate(raced.responseJson as IdempotencyReplayPointer);
      throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
    }
  }

  private async hydrateOrderCreateReplay(pointer: IdempotencyReplayPointer) {
    if (pointer.kind !== "checkout_order_created" || !pointer.orderId || !pointer.orderToken) {
      throw new HttpError(409, "CHECKOUT_IDEMPOTENCY_REPLAY_INVALID");
    }
    const order = await findOrderForBuyer(this.client, pointer.orderId);
    if (!order) throw new HttpError(404, "CHECKOUT_ORDER_NOT_FOUND");
    const payment = pointer.paymentId ? order.payments?.find((item: any) => item.id === pointer.paymentId) ?? null : null;
    return {
      statusCode: 201,
      body: {
        order: serializeBuyerOrder(order),
        payment: payment ? serializeCheckoutPayment(payment) : null,
        orderToken: pointer.orderToken
      }
    };
  }

  private async createOrderFromQuote(tx: DbClient, quote: any, input: CreateCheckoutOrderInput) {
    if (!CHECKOUT_MODES.includes(input.mode)) throw new HttpError(400, "CHECKOUT_MODE_INVALID");
    if (quote.expiresAt.getTime() <= this.now().getTime()) throw new HttpError(410, "CHECKOUT_QUOTE_EXPIRED");

    const options = quoteOptionsFromJson(quote.optionsJson);
    const selected = options[input.mode];
    if (!selected.available) throw new HttpError(400, "CHECKOUT_MODE_UNAVAILABLE", { reason: selected.reason });

    const customer = normalizeCustomer(input.customer);
    const shippingAddress = normalizeAddress(input.shippingAddress);
    const orderId = randomUUID();
    const issuedAt = this.now();
    const orderToken = createCheckoutOrderToken(orderId, quote.merchantId, issuedAt);
    const state = input.mode === "full_cod" ? "confirmed" : input.mode === "partial_cod" ? "pending_advance" : "pending_payment";
    const codCollectionStatus = selected.payOnDelivery > 0n ? "pending" : "none";
    const advanceExpiresAt = input.mode === "partial_cod" ? new Date(issuedAt.getTime() + 30 * 60 * 1000) : null;

    const order = await tx.checkoutOrder.create({
      data: {
        id: orderId,
        merchantId: quote.merchantId,
        quoteId: quote.id,
        mode: input.mode,
        state,
        currency: quote.currency,
        pincode: quote.pincode,
        itemsJson: quote.itemsJson,
        customerJson: customer,
        shippingAddressJson: shippingAddress,
        itemsTotalMinor: quote.itemsTotalMinor,
        codFeeMinor: selected.codFee,
        discountMinor: selected.discount,
        grandTotalMinor: selected.total,
        payNowMinor: selected.payNow,
        payOnDeliveryMinor: selected.payOnDelivery,
        advancePaidMinor: 0n,
        codCollectionStatus,
        codCollectionAmountMinor: selected.payOnDelivery,
        orderTokenHash: hashCheckoutOrderToken(orderToken),
        tokenIssuedAt: issuedAt,
        advanceExpiresAt
      }
    });

    const timeline = await tx.checkoutOrderTimeline.create({
      data: {
        merchantId: quote.merchantId,
        orderId,
        type: "order",
        message: `Order placed — ${input.mode === "partial_cod" ? "Partial COD" : input.mode === "full_cod" ? "Full COD" : "Prepaid"}`,
        actor: "buyer"
      }
    });
    await tx.checkoutAccountingEvent.create({
      data: {
        merchantId: quote.merchantId,
        orderId,
        eventType: "checkout_order_created",
        sourceRef: `co_${orderId}`,
        amountMinor: selected.total,
        currency: quote.currency,
        metadata: {
          mode: input.mode
        }
      }
    });

    let payment: any = null;
    if (selected.payNow > 0n) {
      const paymentId = randomUUID();
      payment = await tx.checkoutPayment.create({
        data: {
          id: paymentId,
          merchantId: quote.merchantId,
          orderId,
          amountMinor: selected.payNow,
          currency: quote.currency,
          purpose: input.mode === "partial_cod" ? "advance" : "full_payment",
          gateway: "mock",
          state: "created",
          gatewayIntentRef: `mock_intent_${paymentId}`,
          gatewayOrderRef: `mock_order_${paymentId}`
        }
      });
      await tx.checkoutAccountingEvent.create({
        data: {
          merchantId: quote.merchantId,
          orderId,
          paymentId,
          eventType: "payment_intent_created",
          sourceRef: `cp_${paymentId}`,
          amountMinor: selected.payNow,
          currency: quote.currency,
          metadata: {
            gateway: "mock",
            purpose: payment.purpose
          }
        }
      });
    } else {
      await tx.checkoutAccountingEvent.create({
        data: {
          merchantId: quote.merchantId,
          orderId,
          eventType: "order_confirmed",
          sourceRef: `co_${orderId}`,
          amountMinor: selected.total,
          currency: quote.currency,
          metadata: {
            mode: input.mode,
            payment: "cod_only"
          }
        }
      });
    }

    const orderForBuyer = {
      ...order,
      timeline: [timeline],
      payments: payment ? [payment] : []
    };
    return {
      statusCode: 201,
      body: {
        order: serializeBuyerOrder(orderForBuyer),
        payment: payment ? serializeCheckoutPayment(payment) : null,
        orderToken
      },
      pointer: {
        kind: "checkout_order_created" as const,
        orderId,
        paymentId: payment?.id,
        orderToken
      }
    };
  }
}

export function parseCheckoutMode(value: string): CheckoutMode {
  if (!CHECKOUT_MODES.includes(value as CheckoutMode)) throw new HttpError(400, "CHECKOUT_MODE_INVALID");
  return value as CheckoutMode;
}

export function parseStoredMinor(value: unknown, field: string) {
  if (typeof value === "bigint") return value;
  return parseMinorUnit(String(value ?? "0"), field);
}
