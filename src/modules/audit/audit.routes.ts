import { Router, type Response } from "express";
import { z } from "zod";
import { getSellerAuditSummary, listSellerAuditLogs } from "./audit.service.js";

export const auditRouter = Router();

const listAuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional()
});

function sendNoStoreJson(res: Response, body: unknown) {
  res.set({
    "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
    "Pragma": "no-cache",
    "Expires": "0",
    "ETag": `W/"audit-${Date.now()}-${Math.random().toString(36).slice(2)}"`
  });
  res.json(body);
}

auditRouter.get("/", async (req, res) => {
  const merchantId = req.auth!.merchantId;
  const query = listAuditQuerySchema.parse(req.query);
  const logs = await listSellerAuditLogs(merchantId, query);
  sendNoStoreJson(res, logs);
});

auditRouter.get("/summary", async (req, res) => {
  const merchantId = req.auth!.merchantId;
  const summary = await getSellerAuditSummary(merchantId);
  sendNoStoreJson(res, summary);
});
