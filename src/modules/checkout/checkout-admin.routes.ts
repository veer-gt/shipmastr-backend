import { Router } from "express";
import { z } from "zod";

import { CheckoutAdminService } from "./checkout-admin.service.js";

export const adminCheckoutRouter = Router();

const priceMinorSchema = z.union([
  z.string().trim().regex(/^\d+$/),
  z.number().int().nonnegative()
]);

const rulesUpdateSchema = z.object({
  merchantId: z.string().trim().min(1).max(160),
  rules: z.unknown(),
  quoteTtlSeconds: z.number().int().positive().max(86400).optional()
}).strict();

const rollbackSchema = z.object({
  merchantId: z.string().trim().min(1).max(160),
  versionId: z.string().trim().min(1).max(160)
}).strict();

const orderListQuerySchema = z.object({
  merchantId: z.string().trim().min(1).max(160).optional(),
  state: z.string().trim().min(1).max(80).optional(),
  mode: z.string().trim().min(1).max(80).optional(),
  pincode: z.string().trim().regex(/^\d{6}$/).optional(),
  createdFrom: z.string().trim().optional(),
  createdTo: z.string().trim().optional(),
  limit: z.string().trim().optional(),
  cursor: z.string().trim().optional()
}).strict();

const codCollectionSchema = z.object({
  method: z.string().trim().min(1).max(40).optional(),
  reference: z.string().trim().min(1).max(160).optional(),
  amountMinor: priceMinorSchema.optional(),
  collectedAt: z.string().trim().datetime().optional()
}).strict();

const transitionSchema = z.object({
  merchantId: z.string().trim().min(1).max(160).optional(),
  state: z.string().trim().min(1).max(80),
  codCollection: codCollectionSchema.optional()
}).strict();

const auditQuerySchema = z.object({
  merchantId: z.string().trim().min(1).max(160).optional(),
  orderId: z.string().trim().min(1).max(160).optional(),
  action: z.string().trim().min(1).max(160).optional(),
  limit: z.string().trim().optional(),
  cursor: z.string().trim().optional()
}).strict();

const service = new CheckoutAdminService();

function actorId(req: { auth?: { userId?: string } }) {
  return req.auth?.userId ?? "admin";
}

adminCheckoutRouter.get("/rules", async (req, res) => {
  const query = z.object({
    merchantId: z.string().trim().min(1).max(160)
  }).strict().parse(req.query);
  res.json(await service.getRules(query.merchantId));
});

adminCheckoutRouter.post("/rules", async (req, res) => {
  const body = rulesUpdateSchema.parse(req.body);
  const version = await service.updateRules({
    merchantId: body.merchantId,
    rules: body.rules as never,
    quoteTtlSeconds: body.quoteTtlSeconds,
    actorId: actorId(req)
  });
  res.status(201).json({ version });
});

adminCheckoutRouter.get("/rules/versions", async (req, res) => {
  const query = z.object({
    merchantId: z.string().trim().min(1).max(160),
    limit: z.string().trim().optional()
  }).strict().parse(req.query);
  res.json(await service.listRuleVersions(query));
});

adminCheckoutRouter.post("/rules/rollback", async (req, res) => {
  const body = rollbackSchema.parse(req.body);
  const version = await service.rollbackRules({
    merchantId: body.merchantId,
    versionId: body.versionId,
    actorId: actorId(req)
  });
  res.status(201).json({ version });
});

adminCheckoutRouter.get("/orders", async (req, res) => {
  const query = orderListQuerySchema.parse(req.query);
  res.json(await service.listOrders(query));
});

adminCheckoutRouter.get("/orders/:orderId", async (req, res) => {
  const query = z.object({
    merchantId: z.string().trim().min(1).max(160).optional()
  }).strict().parse(req.query);
  res.json(await service.getOrderDetail(req.params.orderId, query.merchantId));
});

adminCheckoutRouter.post("/orders/:orderId/transition", async (req, res) => {
  const body = transitionSchema.parse(req.body);
  const result = await service.transitionOrder({
    orderId: req.params.orderId,
    merchantId: body.merchantId,
    toState: body.state,
    codCollection: body.codCollection,
    actorId: actorId(req)
  });
  res.json(result);
});

adminCheckoutRouter.get("/audit", async (req, res) => {
  const query = auditQuerySchema.parse(req.query);
  res.json(await service.listAudit(query));
});
