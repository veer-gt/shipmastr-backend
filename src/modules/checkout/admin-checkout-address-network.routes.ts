import { Router } from "express";
import { z } from "zod";

import {
  checkoutAddressNetworkService,
  type CheckoutAddressNetworkService
} from "./checkout-address-network.service.js";

const metricsQuerySchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(365).optional()
}).strict();

export function createAdminCheckoutAddressNetworkRouter(
  service: CheckoutAddressNetworkService = checkoutAddressNetworkService
) {
  const router = Router();

  router.get("/metrics", async (req, res) => {
    const query = metricsQuerySchema.parse(req.query);
    const data = await service.getAddressNetworkMetrics({ windowDays: query.windowDays });
    return res.json(data);
  });

  return router;
}

export const adminCheckoutAddressNetworkRouter = createAdminCheckoutAddressNetworkRouter();
