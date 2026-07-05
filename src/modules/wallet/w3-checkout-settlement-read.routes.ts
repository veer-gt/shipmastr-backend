import { Router } from "express";
import { z } from "zod";
import { HttpError } from "../../lib/httpError.js";
import {
  w3bAdminPreviewListQuerySchema,
  w3bCheckoutPreviewReadService,
  w3bCheckoutReadiness,
  w3bExportPreviewQuerySchema,
  w3bSellerPreviewListQuerySchema
} from "./w3-checkout-settlement-read.service.js";

export const internalW3CheckoutPreviewRouter = Router();
export const adminW3CheckoutPreviewRouter = Router();
export const sellerW3CheckoutPreviewRouter = Router();

const sellerOrgIdSchema = z.string().trim().min(1).max(160);

export function sellerOrgIdFromW3CheckoutAuth(auth: Express.Request["auth"]) {
  return sellerOrgIdSchema.parse(auth?.merchantId);
}

export function assertW3CheckoutSellerQueryScope(querySellerOrgId: string | undefined, authSellerOrgId: string) {
  if (querySellerOrgId && querySellerOrgId !== authSellerOrgId) {
    throw new HttpError(403, "W3B_SELLER_SCOPE_ONLY");
  }
}

internalW3CheckoutPreviewRouter.get("/readiness", async (_req, res) => {
  res.json(w3bCheckoutReadiness());
});

adminW3CheckoutPreviewRouter.get("/previews", async (req, res) => {
  const query = w3bAdminPreviewListQuerySchema.parse(req.query);
  res.json(await w3bCheckoutPreviewReadService.listBatches(query));
});

adminW3CheckoutPreviewRouter.get("/previews/:batchId", async (req, res) => {
  res.json(await w3bCheckoutPreviewReadService.getBatchDetail(req.params.batchId ?? ""));
});

adminW3CheckoutPreviewRouter.get("/previews/:batchId/export-preview", async (req, res) => {
  const query = w3bExportPreviewQuerySchema.parse(req.query);
  const preview = await w3bCheckoutPreviewReadService.exportPreview(req.params.batchId ?? "", query.format);
  if ("csv" in preview) {
    res.type("text/csv").send(preview.csv);
    return;
  }
  res.json(preview);
});

sellerW3CheckoutPreviewRouter.get("/summary", async (req, res) => {
  const sellerOrgId = sellerOrgIdFromW3CheckoutAuth(req.auth);
  res.json(await w3bCheckoutPreviewReadService.sellerSummary(sellerOrgId));
});

sellerW3CheckoutPreviewRouter.get("/previews", async (req, res) => {
  const sellerOrgId = sellerOrgIdFromW3CheckoutAuth(req.auth);
  const query = w3bSellerPreviewListQuerySchema.parse(req.query);
  assertW3CheckoutSellerQueryScope(query.sellerOrgId, sellerOrgId);
  res.json(await w3bCheckoutPreviewReadService.listBatches({ ...query, sellerOrgId }));
});
