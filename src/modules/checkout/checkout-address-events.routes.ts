import { Router } from "express";
import { z } from "zod";

import {
  CHECKOUT_ADDRESS_SESSION_TOKEN_HEADER,
  requireCheckoutAddressSession,
  type CheckoutAddressSessionContext
} from "./checkout-address-session.service.js";
import {
  ADDRESS_EVENTS,
  ADDRESS_EVENTS_BATCH_LIMIT,
  checkoutAddressTelemetryService,
  type AddressEventInput,
  type CheckoutAddressTelemetryService
} from "./checkout-address-telemetry.service.js";

type SessionResolver = (sessionToken: string) => Promise<CheckoutAddressSessionContext>;

const addressEventSchema = z.object({
  sessionId: z.string().trim().min(1).max(180).optional(),
  shopperId: z.string().trim().min(1).max(180).optional(),
  merchantId: z.string().trim().min(1).max(180).optional(),
  event: z.enum(ADDRESS_EVENTS),
  meta: z.record(z.string(), z.unknown()).optional()
}).strict();

const addressEventsBatchSchema = z.object({
  events: z.array(addressEventSchema).min(1).max(ADDRESS_EVENTS_BATCH_LIMIT)
}).strict();

function checkoutSessionToken(req: { get(header: string): string | undefined }) {
  return req.get(CHECKOUT_ADDRESS_SESSION_TOKEN_HEADER)?.trim() || "";
}

export function createCheckoutAddressEventsRouter(input: {
  service?: CheckoutAddressTelemetryService | undefined;
  sessionResolver?: SessionResolver | undefined;
} = {}) {
  const router = Router();
  const service = input.service ?? checkoutAddressTelemetryService;
  const sessionResolver = input.sessionResolver ?? requireCheckoutAddressSession;

  router.post("/", async (req, res) => {
    const body = addressEventsBatchSchema.parse(req.body);
    const token = checkoutSessionToken(req);
    const session = token ? await sessionResolver(token) : null;

    const events: AddressEventInput[] = body.events.map((event) => ({
      sessionId: session?.sessionId ?? event.sessionId ?? "",
      shopperId: event.shopperId ?? null,
      merchantId: session?.merchantId ?? event.merchantId ?? "",
      event: event.event,
      meta: event.meta ?? {}
    }));

    await service.recordAddressEventsBatch(events);
    return res.status(204).send();
  });

  return router;
}

export const checkoutAddressEventsRouter = createCheckoutAddressEventsRouter();
