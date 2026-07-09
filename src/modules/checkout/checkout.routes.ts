import { Router } from "express";
import { z } from "zod";

import { HttpError } from "../../lib/httpError.js";
import { CheckoutQuoteService } from "./checkout-quote.service.js";
import { CheckoutOrderService, parseCheckoutMode } from "./checkout-order.service.js";
import { CheckoutPaymentService } from "./checkout-payment.service.js";
import { checkoutAddressSessionRouter } from "./checkout-address-session.routes.js";
import {
  CHECKOUT_ADDRESS_SESSION_TOKEN_HEADER,
  requireCheckoutAddressSession,
  type CheckoutAddressSessionContext
} from "./checkout-address-session.service.js";
import { checkoutAddressGraphRouter } from "./checkout-address-graph.routes.js";
import { checkoutAddressPrefillRouter } from "./checkout-address-prefill.routes.js";
import { checkoutPlacesRouter } from "./checkout-places.routes.js";
import { serializeCheckoutQuote } from "./checkout-serializers.js";
import { quotePriceSourceRequiresCheckoutSession, resolveQuotePriceSource, type QuotePriceSource } from "../../config/quote-price-source.js";

const priceMinorSchema = z.union([
  z.string().trim().regex(/^\d+$/),
  z.number().int().nonnegative()
]);

const quoteItemSchema = z.object({
  id: z.string().trim().min(1).max(160),
  name: z.string().trim().min(1).max(240).optional(),
  quantity: z.number().int().positive().max(1000),
  priceMinor: priceMinorSchema.optional()
}).strict();

const quoteSchema = z.object({
  merchantId: z.string().trim().min(1).max(160),
  items: z.array(quoteItemSchema).min(1).max(200),
  pincode: z.string().trim().regex(/^\d{6}$/)
}).strict();

const customerSchema = z.object({
  name: z.string().trim().min(1).max(180),
  phone: z.string().trim().min(6).max(40),
  email: z.string().trim().email().max(220).optional()
}).strict();

const shippingAddressSchema = z.object({
  line1: z.string().trim().max(500).optional(),
  line2: z.string().trim().max(500).optional(),
  city: z.string().trim().max(120).optional(),
  state: z.string().trim().max(120).optional(),
  pincode: z.string().trim().max(20).optional()
}).strict();

const orderSchema = z.object({
  quoteId: z.string().trim().min(1).max(160),
  mode: z.string().trim(),
  customer: customerSchema,
  shippingAddress: shippingAddressSchema.optional()
}).passthrough();

const mockCompleteSchema = z.object({
  outcome: z.enum(["success", "failure"]).default("success")
}).strict();

type CheckoutSessionResolver = (sessionToken: string) => Promise<CheckoutAddressSessionContext>;

type CheckoutRouterOptions = {
  quoteService?: CheckoutQuoteService | undefined;
  orderService?: CheckoutOrderService | undefined;
  paymentService?: CheckoutPaymentService | undefined;
  quotePriceSource?: (() => QuotePriceSource) | undefined;
  checkoutSessionResolver?: CheckoutSessionResolver | undefined;
};

function idempotencyKey(req: { get(header: string): string | undefined }) {
  return req.get("Idempotency-Key")?.trim() || "";
}

function orderToken(req: { get(header: string): string | undefined }) {
  return req.get("x-order-token")?.trim() || "";
}

function checkoutSessionToken(req: { get(header: string): string | undefined }) {
  return req.get(CHECKOUT_ADDRESS_SESSION_TOKEN_HEADER)?.trim() || "";
}

async function strictCheckoutSession(input: {
  req: { get(header: string): string | undefined };
  merchantId?: string | undefined;
  source: QuotePriceSource;
  resolver: CheckoutSessionResolver;
}) {
  if (!quotePriceSourceRequiresCheckoutSession(input.source)) return null;
  const session = await input.resolver(checkoutSessionToken(input.req));
  if (input.merchantId && session.merchantId !== input.merchantId) {
    throw new Error("CHECKOUT_SESSION_MERCHANT_MISMATCH");
  }
  return session;
}

function throwMerchantMismatch(error: unknown): never {
  if (error instanceof Error && error.message === "CHECKOUT_SESSION_MERCHANT_MISMATCH") {
    throw new HttpError(404, "CHECKOUT_QUOTE_NOT_FOUND");
  }
  throw error;
}

export function createCheckoutRouter(input: CheckoutRouterOptions = {}) {
  const checkoutRouter = Router();
  const quoteService = input.quoteService ?? new CheckoutQuoteService();
  const orderService = input.orderService ?? new CheckoutOrderService();
  const paymentService = input.paymentService ?? new CheckoutPaymentService();
  const quotePriceSource = input.quotePriceSource ?? (() => resolveQuotePriceSource(process.env));
  const checkoutSessionResolver = input.checkoutSessionResolver ?? requireCheckoutAddressSession;

  checkoutRouter.use("/", checkoutAddressSessionRouter);
  checkoutRouter.use("/", checkoutAddressGraphRouter);
  checkoutRouter.use("/", checkoutAddressPrefillRouter);
  checkoutRouter.use("/", checkoutPlacesRouter);

  checkoutRouter.post("/quote", async (req, res) => {
    const source = quotePriceSource();
    const merchantId = z.object({ merchantId: z.string().trim().min(1).max(160) }).passthrough().parse(req.body).merchantId;
    try {
      await strictCheckoutSession({ req, merchantId, source, resolver: checkoutSessionResolver });
    } catch (error) {
      throwMerchantMismatch(error);
    }
    const body = quoteSchema.parse(req.body);
    const quote = await quoteService.createQuote(body);
    return res.status(201).json(serializeCheckoutQuote(quote));
  });

  checkoutRouter.post("/orders", async (req, res) => {
    const body = orderSchema.parse(req.body);
    const source = quotePriceSource();
    const session = await strictCheckoutSession({ req, source, resolver: checkoutSessionResolver });
    const result = await orderService.createOrder({
      quoteId: body.quoteId,
      mode: parseCheckoutMode(body.mode),
      customer: body.customer,
      shippingAddress: body.shippingAddress,
      idempotencyKey: idempotencyKey(req),
      expectedMerchantId: session?.merchantId ?? undefined
    });
    return res.status(result.statusCode).json(result.body);
  });

  checkoutRouter.get("/orders/:orderId", async (req, res) => {
    const result = await orderService.getBuyerOrder(req.params.orderId, orderToken(req));
    return res.json(result);
  });

  checkoutRouter.post("/payments/:paymentId/initiate", async (req, res) => {
    const result = await paymentService.initiatePayment(req.params.paymentId, orderToken(req));
    return res.json(result);
  });

  checkoutRouter.post("/payments/:paymentId/mock-complete", async (req, res) => {
    const body = mockCompleteSchema.parse(req.body);
    const result = await paymentService.mockComplete({
      paymentId: req.params.paymentId,
      orderToken: orderToken(req),
      outcome: body.outcome,
      idempotencyKey: idempotencyKey(req)
    });
    return res.status(result.statusCode).json(result.body);
  });

  return checkoutRouter;
}

export const checkoutRouter = createCheckoutRouter();
