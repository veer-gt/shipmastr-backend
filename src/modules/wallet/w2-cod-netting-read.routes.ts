import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../../lib/httpError.js";
import { w2CodReadinessService } from "./w2a-cod-netting.service.js";
import {
  w2bAdminBatchListQuerySchema,
  w2bCodNettingReadService,
  w2bExportPreviewQuerySchema,
  w2bSellerBatchListQuerySchema
} from "./w2-cod-netting-read.service.js";

export const internalW2CodNettingRouter = Router();
export const adminW2CodNettingRouter = Router();
export const sellerW2CodNettingRouter = Router();

const sellerOrgIdSchema = z.string().trim().min(1).max(160);

export function sellerOrgIdFromW2CodAuth(auth: Express.Request["auth"]) {
  return sellerOrgIdSchema.parse(auth?.merchantId);
}

export function assertW2CodSellerQueryScope(querySellerOrgId: string | undefined, authSellerOrgId: string) {
  if (querySellerOrgId && querySellerOrgId !== authSellerOrgId) {
    throw new HttpError(403, "W2B_SELLER_SCOPE_ONLY");
  }
}

internalW2CodNettingRouter.get("/readiness", async (_req, res) => {
  res.json({
    ...w2CodReadinessService.getReadiness(),
    phase: "W2B",
    readOnlySurfacesAvailable: true,
    movementExecuted: false,
    custodyCreated: false,
    payoutExecuted: false,
    settlementExecuted: false
  });
});

adminW2CodNettingRouter.get("/batches", async (req, res) => {
  const query = w2bAdminBatchListQuerySchema.parse(req.query);
  res.json(await w2bCodNettingReadService.listBatches(query));
});

adminW2CodNettingRouter.get("/batches/:batchId", async (req, res) => {
  res.json(await w2bCodNettingReadService.getBatchDetail(req.params.batchId ?? ""));
});

adminW2CodNettingRouter.get("/batches/:batchId/export-preview", async (req, res) => {
  const query = w2bExportPreviewQuerySchema.parse(req.query);
  const preview = await w2bCodNettingReadService.exportPreview(req.params.batchId ?? "", query.format);
  if ("csv" in preview) {
    res.type("text/csv").send(preview.csv);
    return;
  }
  res.json(preview);
});

sellerW2CodNettingRouter.get("/summary", async (req, res) => {
  const sellerOrgId = sellerOrgIdFromW2CodAuth(req.auth);
  res.json(await w2bCodNettingReadService.sellerSummary(sellerOrgId));
});

sellerW2CodNettingRouter.get("/batches", async (req, res) => {
  const sellerOrgId = sellerOrgIdFromW2CodAuth(req.auth);
  const query = w2bSellerBatchListQuerySchema.parse(req.query);
  assertW2CodSellerQueryScope(query.sellerOrgId, sellerOrgId);
  res.json(await w2bCodNettingReadService.listBatches({ ...query, sellerOrgId }));
});
