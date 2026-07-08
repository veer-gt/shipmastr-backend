import { Prisma } from "@prisma/client";
import { HttpError } from "../../lib/httpError.js";
import { prisma } from "../../lib/prisma.js";
import { CheckoutQuoteService, type CheckoutItemInput } from "../checkout/checkout-quote.service.js";

// SF5 Layer 3 — server-authoritative checkout for the storefront (public, shopper-facing)
// path. This is additive: it does NOT modify the existing generic /checkout/quote route
// (checkout.routes.ts), which other internal callers may depend on and which is out of
// scope for this hardening pass (that route's client-supplied priceMinor is a separate,
// pre-existing, flagged issue — see final report).
//
// Instead, this endpoint accepts only { storefrontId, productId, quantity } per item and
// a pincode. price/currency/name are always resolved from StorefrontProduct by
// (storefrontId, productId) — a client can never influence what it pays by tampering with
// the request body. The resolved merchantId (never a client-supplied one) is what gets
// passed into the shared quote engine, which is also where shipping/COD-eligibility rules
// are already resolved server-side from the merchant's own CheckoutRulesVersion.

const quoteService = new CheckoutQuoteService();

export type StorefrontCheckoutQuoteItemInput = {
  productId: string;
  quantity: number;
};

export type CreateStorefrontCheckoutQuoteInput = {
  storefrontId: string;
  items: StorefrontCheckoutQuoteItemInput[];
  pincode: string;
};

export async function createStorefrontCheckoutQuote(input: CreateStorefrontCheckoutQuoteInput) {
  const storefront = await prisma.storefront.findUnique({
    where: { id: input.storefrontId },
    select: { id: true, merchantId: true }
  });
  if (!storefront) throw new HttpError(404, "STOREFRONT_NOT_FOUND");

  if (input.items.length === 0) throw new HttpError(400, "STOREFRONT_CHECKOUT_ITEMS_REQUIRED");

  const productIds = input.items.map((item) => item.productId);
  const products = await prisma.storefrontProduct.findMany({
    where: {
      id: { in: productIds },
      storefrontId: storefront.id
    }
  });

  const productsById = new Map(products.map((product) => [product.id, product]));

  const items: CheckoutItemInput[] = input.items.map((requested) => {
    const product = productsById.get(requested.productId);
    if (!product) {
      throw new HttpError(400, "STOREFRONT_PRODUCT_NOT_FOUND_OR_NOT_OWNED");
    }
    if (!product.isActive) {
      throw new HttpError(409, "STOREFRONT_PRODUCT_INACTIVE");
    }
    // priceMinor comes ONLY from the DB row keyed by (storefrontId, productId) — never
    // from the client payload. This is the entire point of this endpoint existing.
    return {
      id: product.id,
      name: product.name,
      quantity: requested.quantity,
      priceMinor: product.priceMinor
    };
  });

  const quote = await quoteService.createQuote({
    merchantId: storefront.merchantId,
    items,
    pincode: input.pincode
  });

  return quote;
}

export type DbClient = Prisma.TransactionClient | typeof prisma;
