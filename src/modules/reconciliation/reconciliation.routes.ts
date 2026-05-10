import { Router } from "express";
import { z } from "zod";
import {
  listReconciliationDisputes,
  listReconciliationResults,
  listReconciliationRuns,
  exportReconciliationDisputes,
  runReconciliation,
  updateReconciliationDispute
} from "./reconciliation.service.js";

export const reconciliationRouter = Router();

const reconciliationStatuses = [
  "AUTO_APPROVED",
  "PARTIAL_MATCH",
  "COD_SHORTFALL",
  "COD_DELAYED",
  "INVOICE_MISMATCH",
  "WEIGHT_DISPUTE",
  "ZONE_DISPUTE",
  "DUPLICATE_BILLING",
  "MISSING_REMITTANCE",
  "RTO_CHARGE_REVIEW",
  "FAKE_ATTEMPT_REVIEW",
  "MANUAL_REVIEW",
  "PAYMENT_HOLD",
  "SETTLED"
] as const;
const disputeTypes = [
  "INVOICE_MISMATCH",
  "COD_SHORTFALL",
  "COD_DELAY",
  "DUPLICATE_BILLING",
  "UNKNOWN_AWB",
  "WEIGHT_DISPUTE",
  "ZONE_DISPUTE",
  "RTO_CHARGE_ISSUE",
  "FAKE_ATTEMPT_NDR_ISSUE"
] as const;
const disputeStatuses = ["OPEN", "UNDER_REVIEW", "APPROVED", "REJECTED", "RESOLVED"] as const;

reconciliationRouter.post("/run", async (req, res) => {
  const body = z.object({
    periodStart: z.coerce.date().optional(),
    periodEnd: z.coerce.date().optional()
  }).parse(req.body ?? {});
  const result = await runReconciliation({
    merchantId: req.auth!.merchantId,
    periodStart: body.periodStart,
    periodEnd: body.periodEnd
  });

  res.status(201).json(result);
});

reconciliationRouter.get("/runs", async (req, res) => {
  const runs = await listReconciliationRuns(req.auth!.merchantId);

  res.json({ runs });
});

reconciliationRouter.get("/results", async (req, res) => {
  const query = z.object({
    status: z.enum(reconciliationStatuses).optional()
  }).parse(req.query);
  const results = await listReconciliationResults({
    merchantId: req.auth!.merchantId,
    status: query.status
  });

  res.json({ results });
});

reconciliationRouter.get("/disputes", async (req, res) => {
  const query = z.object({
    status: z.enum(disputeStatuses).optional(),
    type: z.enum(disputeTypes).optional()
  }).parse(req.query);
  const disputes = await listReconciliationDisputes({
    merchantId: req.auth!.merchantId,
    status: query.status,
    type: query.type
  });

  res.json({ disputes });
});

reconciliationRouter.get("/disputes/export", async (req, res) => {
  const query = z.object({
    format: z.enum(["csv", "json"]).default("csv")
  }).parse(req.query);
  const exported = await exportReconciliationDisputes({
    merchantId: req.auth!.merchantId,
    format: query.format
  });

  res.type(exported.contentType).send(exported.body);
});

reconciliationRouter.patch("/disputes/:id", async (req, res) => {
  const params = z.object({ id: z.string().min(1) }).parse(req.params);
  const body = z.object({
    status: z.enum(disputeStatuses).optional(),
    resolution: z.record(z.string(), z.any()).optional()
  }).parse(req.body);
  const dispute = await updateReconciliationDispute({
    id: params.id,
    merchantId: req.auth!.merchantId,
    status: body.status,
    resolution: body.resolution
  });

  res.json({ dispute });
});
